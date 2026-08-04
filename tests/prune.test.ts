import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationStore } from '../src/core/operation-store.js';
import { PruneService } from '../src/core/prune.js';
import { resolveFactoryPaths } from '../src/core/paths.js';

// OP4-D：按分类 prune 的回归测试。覆盖 4 个 scope 的分类与保留策略、
// dry-run 不落地、symlink 逃逸项被跳过、operations.jsonl 轮转保 0o600 且可再查、
// 无 scope flag 报 VALIDATION_ERROR、多 scope 组合。

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));
const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-prune-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  return { root, paths };
}

async function ageDays(target: string, days: number): Promise<void> {
  const ts = (Date.now() - days * DAY_MS) / 1000;
  await fs.utimes(target, ts, ts);
}

describe('PruneService (OP4-D)', () => {
  it('prunes old run-log dirs by mtime while keeping recent ones (logs)', async () => {
    const { paths } = await setup();
    const runsDir = path.join(paths.logsDir, 'agent-1', 'runs');
    const oldDir = path.join(runsDir, 'old-run');
    const newDir = path.join(runsDir, 'new-run');
    await fs.ensureDir(oldDir);
    await fs.writeFile(path.join(oldDir, 'log.txt'), 'x'.repeat(100));
    await fs.ensureDir(newDir);
    await fs.writeFile(path.join(newDir, 'log.txt'), 'y'.repeat(100));
    await ageDays(oldDir, 10);

    const result = await new PruneService(paths).run({ logs: true, keepDays: 1 });
    const logsResult = result.scopes[0]!;
    expect(logsResult.scope).toBe('logs');
    expect(logsResult.paths).toHaveLength(1);
    expect(logsResult.freedBytes).toBeGreaterThan(0);
    expect(await fs.pathExists(oldDir)).toBe(false);
    expect(await fs.pathExists(newDir)).toBe(true);
  });

  it('keeps the newest registry backups by count (registry-backups)', async () => {
    const { paths } = await setup();
    const backupDir = path.join(paths.registryDir, 'backups');
    await fs.ensureDir(backupDir);
    const base = Date.now() / 1000;
    for (let i = 0; i < 25; i += 1) {
      const file = path.join(backupDir, `agents-${String(i).padStart(3, '0')}.yaml`);
      await fs.writeFile(file, `entry-${i}`);
      // i=0 最旧，i=24 最新；按 mtime 倒序保留最新 keepCount 份。
      await fs.utimes(file, base - (25 - i) * 3600, base - (25 - i) * 3600);
    }

    const result = await new PruneService(paths).run({ registryBackups: true, keepCount: 5 });
    const rb = result.scopes[0]!;
    expect(rb.scope).toBe('registry-backups');
    expect(rb.paths).toHaveLength(20);
    expect(rb.freedBytes).toBeGreaterThan(0);
    const remaining = (await fs.readdir(backupDir)).sort();
    expect(remaining).toEqual([
      'agents-020.yaml',
      'agents-021.yaml',
      'agents-022.yaml',
      'agents-023.yaml',
      'agents-024.yaml',
    ]);
  });

  it('prunes old archive files by mtime (archives)', async () => {
    const { paths } = await setup();
    await fs.ensureDir(paths.backupsDir);
    const oldFile = path.join(paths.backupsDir, 'old.tar.gz');
    const newFile = path.join(paths.backupsDir, 'new.aief.enc');
    await fs.writeFile(oldFile, 'x'.repeat(50));
    await fs.writeFile(newFile, 'y'.repeat(50));
    await ageDays(oldFile, 10);

    const result = await new PruneService(paths).run({ archives: true, keepDays: 1 });
    const ar = result.scopes[0]!;
    expect(ar.scope).toBe('archives');
    expect(ar.paths).toHaveLength(1);
    expect(await fs.pathExists(oldFile)).toBe(false);
    expect(await fs.pathExists(newFile)).toBe(true);
  });

  it('rotates operations.jsonl by started_at age, preserving 0o600 and keeping recent rows (operations)', async () => {
    const { paths } = await setup();
    const store = new OperationStore(paths.logsDir);
    await store.record({
      operation_id: 'old-1',
      kind: 'chat',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: '2020-01-01T00:01:00.000Z',
      exit_code: 0,
    });
    await store.record({
      operation_id: 'old-2',
      kind: 'run',
      started_at: '2020-02-01T00:00:00.000Z',
      finished_at: '2020-02-01T00:01:00.000Z',
      exit_code: 1,
      error_message: 'boom',
    });
    const nowIso = new Date().toISOString();
    await store.record({
      operation_id: 'new-1',
      kind: 'chat',
      started_at: nowIso,
      finished_at: nowIso,
      exit_code: 0,
    });
    await store.record({
      operation_id: 'new-2',
      kind: 'chat',
      started_at: nowIso,
      finished_at: nowIso,
      exit_code: 0,
    });
    const file = path.join(paths.logsDir, 'operations.jsonl');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const result = await new PruneService(paths).run({ operations: true, keepDays: 1 });
    const op = result.scopes[0]!;
    expect(op.scope).toBe('operations');
    expect(op.freedBytes).toBeGreaterThan(0);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const remaining = (await store.query({ limit: Number.MAX_SAFE_INTEGER })).map(
      (s) => s.operation_id,
    );
    expect(remaining).toEqual(['new-1', 'new-2']);
  });

  it('dry-run previews without deleting (logs)', async () => {
    const { paths } = await setup();
    const runsDir = path.join(paths.logsDir, 'agent-1', 'runs');
    const oldDir = path.join(runsDir, 'old-run');
    await fs.ensureDir(oldDir);
    await fs.writeFile(path.join(oldDir, 'log.txt'), 'x'.repeat(100));
    await ageDays(oldDir, 10);

    const result = await new PruneService(paths).run({ logs: true, keepDays: 1, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.scopes[0]!.paths).toHaveLength(1);
    expect(await fs.pathExists(oldDir)).toBe(true);
  });

  it('skips symlinked run dirs so outside targets are preserved (symlink escape)', async () => {
    const { root, paths } = await setup();
    const outsideDir = path.join(root, 'outside-target');
    await fs.ensureDir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'precious');
    const runsDir = path.join(paths.logsDir, 'agent-1', 'runs');
    await fs.ensureDir(runsDir);
    await fs.symlink(outsideDir, path.join(runsDir, 'escaped-run'), 'dir');

    const result = await new PruneService(paths).run({ logs: true, keepDays: 1 });
    const logsResult = result.scopes[0]!;
    // isDirectory() 对 symlink 为 false -> 逃逸项在枚举阶段即跳过，不进入 safeRemove。
    expect(logsResult.paths).toHaveLength(0);
    expect(await fs.pathExists(path.join(outsideDir, 'secret.txt'))).toBe(true);
    expect(await fs.pathExists(outsideDir)).toBe(true);
  });

  it('throws VALIDATION_ERROR when no scope is selected', async () => {
    const { paths } = await setup();
    await expect(new PruneService(paths).run({})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('runs multiple scopes in one call', async () => {
    const { paths } = await setup();
    const runsDir = path.join(paths.logsDir, 'agent-1', 'runs');
    const oldRun = path.join(runsDir, 'old-run');
    await fs.ensureDir(oldRun);
    await fs.writeFile(path.join(oldRun, 'log.txt'), 'x');
    await ageDays(oldRun, 10);
    await fs.ensureDir(paths.backupsDir);
    const oldArchive = path.join(paths.backupsDir, 'old.tar.gz');
    await fs.writeFile(oldArchive, 'x');
    await ageDays(oldArchive, 10);

    const result = await new PruneService(paths).run({ logs: true, archives: true, keepDays: 1 });
    expect(result.scopes.map((s) => s.scope)).toEqual(['logs', 'archives']);
    expect(await fs.pathExists(oldRun)).toBe(false);
    expect(await fs.pathExists(oldArchive)).toBe(false);
  });
});
