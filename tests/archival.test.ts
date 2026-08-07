// TASK-049（D-045）：archival local-sqlite 后端测试。
// 覆盖：表创建 + WAL + 0600、archive 幂等、redactSecrets 兜底、路径形状校验拒绝、
// 白名单/软链逃逸拒绝（assertArchivableWorkspacePath）、query/list 过滤、CLI surface。

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { createProgram } from '../src/cli-program.js';
import {
  archiveDbFile,
  assertArchivableWorkspacePath,
  LocalSqliteArchivalBackend,
  validateArchivalRelPath,
} from '../src/core/archival-local-sqlite.js';
import { initializeFactory } from '../src/core/config.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import type { ArchivalEntry } from '../src/core/archival.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-archival-'));
  roots.push(root);
  const logsDir = path.join(root, 'logs');
  const dbFile = archiveDbFile(logsDir, 'ops');
  const backend = new LocalSqliteArchivalBackend(dbFile);
  return { root, logsDir, dbFile, backend };
}

function entry(overrides: Partial<ArchivalEntry> = {}): ArchivalEntry {
  return {
    relPath: 'knowledge/lessons/2026-08-04-ops.md',
    content: '经验：桥接授权前先看版本兼容性。',
    authorityLayer: 'knowledge',
    createdAt: '2026-08-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('LocalSqliteArchivalBackend (D-045)', () => {
  it('建表 + WAL + DB 文件 0600', async () => {
    const { dbFile, backend } = await setup();
    // 先触发一次写（懒打开建目录 + 建表），再关闭重开验证文件态。
    await backend.archive(entry());
    backend.close();
    const db = new Database(dbFile);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('archive_entries');
    db.close();
    const stat = await fs.stat(dbFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('archive 幂等：同 relPath 二次归档 no-op，返回既有 reference', async () => {
    const { backend } = await setup();
    const first = await backend.archive(entry());
    const second = await backend.archive(entry({ content: '改变的内容不覆盖' }));
    expect(second.reference).toBe(first.reference);
    expect(backend.list()).toHaveLength(1);
  });

  it('redactSecrets 兜底：sk-xxx 二次脱敏后落盘，bytes 按脱敏后字节数', async () => {
    const { backend } = await setup();
    const result = await backend.archive(
      entry({ content: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz0123456789，别外传。' }),
    );
    expect(result.bytes).toBe(Buffer.byteLength('我的 key 是 [REDACTED]，别外传。', 'utf8'));
    expect(backend.list()[0]?.relPath).toBe('knowledge/lessons/2026-08-04-ops.md');
  });

  it('路径形状校验拒绝：绝对路径 / ../ 穿越 / 白名单外', () => {
    expect(() => validateArchivalRelPath('/etc/passwd')).toThrow(/绝对路径/);
    expect(() => validateArchivalRelPath('../outside.md')).toThrow(/穿越/);
    expect(() => validateArchivalRelPath('../../runtimes/ops/claude/settings.json')).toThrow(
      /穿越/,
    );
    expect(() => validateArchivalRelPath('runtimes/ops/claude/settings.json')).toThrow(
      /仅可归档 knowledge\/\*\* 或 agent\//,
    );
    expect(() => validateArchivalRelPath('automation/jobs/job.yaml')).toThrow(/仅可归档/);
  });

  it('query/list 过滤：layer 过滤 + limit + id 排序', async () => {
    const { backend } = await setup();
    await backend.archive(
      entry({
        relPath: 'knowledge/lessons/2026-08-01-a.md',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    await backend.archive(
      entry({
        relPath: 'agent/POLICIES.md',
        authorityLayer: 'agent',
        createdAt: '2026-08-02T00:00:00.000Z',
      }),
    );
    await backend.archive(
      entry({ relPath: 'knowledge/decisions/d-001.md', createdAt: '2026-08-03T00:00:00.000Z' }),
    );
    const all = backend.list();
    expect(all).toHaveLength(3);
    // list：id 升序（归档顺序）。
    expect(all.map((r) => r.relPath)).toEqual([
      'knowledge/lessons/2026-08-01-a.md',
      'agent/POLICIES.md',
      'knowledge/decisions/d-001.md',
    ]);
    // query：layer 过滤（decisions 层——顶层目录推断，调用方显式传入）。
    const knowledgeOnly = backend.query({ authorityLayer: 'knowledge' });
    expect(knowledgeOnly.map((r) => r.relPath)).toEqual([
      'knowledge/decisions/d-001.md',
      'knowledge/lessons/2026-08-01-a.md',
    ]);
    // query：relPath 精确 + limit。
    const one = backend.query({ relPath: 'agent/POLICIES.md', limit: 5 });
    expect(one).toHaveLength(1);
    const limited = backend.query({ limit: 2 });
    expect(limited).toHaveLength(2);
    // reference 稳定引用格式。
    expect(all[0]?.reference).toBe('archive_entries/1');
  });
});

describe('assertArchivableWorkspacePath (D-014 invariant ③)', () => {
  it('白名单内真实文件通过；白名单外 / 不存在 / 软链逃逸拒绝', async () => {
    const { root } = await setup();
    const workspaceRoot = path.join(root, 'agents');
    const workspace = path.join(workspaceRoot, 'ops');
    await fs.ensureDir(path.join(workspace, 'knowledge', 'lessons'));
    await fs.ensureDir(path.join(workspace, 'agent'));
    await fs.writeFile(path.join(workspace, 'knowledge', 'lessons', 'a.md'), '内容');
    await fs.writeFile(path.join(workspace, 'agent', 'POLICIES.md'), '红线');
    // 软链逃逸：指向工作区外。
    await fs.writeFile(path.join(root, 'outside.md'), '外部文件');
    await fs.symlink(path.join(root, 'outside.md'), path.join(workspace, 'knowledge', 'link.md'));

    await expect(
      assertArchivableWorkspacePath(workspaceRoot, workspace, 'knowledge/lessons/a.md'),
    ).resolves.toBe('knowledge/lessons/a.md');
    await expect(
      assertArchivableWorkspacePath(workspaceRoot, workspace, 'agent/POLICIES.md'),
    ).resolves.toBe('agent/POLICIES.md');
    // 白名单外（automation/ 等）→ VALIDATION_ERROR。
    await expect(
      assertArchivableWorkspacePath(workspaceRoot, workspace, 'automation/jobs/job.yaml'),
    ).rejects.toThrow(/仅可归档/);
    // 不存在 → NOT_FOUND。
    await expect(
      assertArchivableWorkspacePath(workspaceRoot, workspace, 'knowledge/lessons/missing.md'),
    ).rejects.toThrow(/不存在/);
    // 软链逃逸 → 拒绝（assertInsideReal 解析真实路径后判定在外）。
    await expect(
      assertArchivableWorkspacePath(workspaceRoot, workspace, 'knowledge/link.md'),
    ).rejects.toThrow(/软链接|必须位于/);
  });

  it('范围隔离（app 层）：../../runtimes/... 与 bridge 相对路径拒绝', async () => {
    const { root, logsDir } = await setup();
    const workspaceRoot = path.join(root, 'agents');
    const workspace = path.join(workspaceRoot, 'ops');
    await fs.ensureDir(workspace);
    // 模拟 runtime_home 与 bridge 位于受管目录。
    await fs.ensureDir(path.join(root, 'runtimes', 'ops', 'claude'));
    await fs.ensureDir(path.join(root, 'bridges', 'ops'));
    for (const evil of ['../../runtimes/ops/claude/settings.json', '../../logs/archives/ops.db']) {
      await expect(assertArchivableWorkspacePath(workspaceRoot, workspace, evil)).rejects.toThrow(
        /穿越|仅可归档/,
      );
    }
    // logsDir 内另一员工库不受影响（本测试仅验证拒绝路径）。
    expect(path.dirname(archiveDbFile(logsDir, 'other'))).toContain('archives');
  });
});

describe('CLI surface', () => {
  it('archival 顶层组含 add/list/query', () => {
    const program = createProgram();
    const group = program.commands.find((command) => command.name() === 'archival');
    expect(group).toBeDefined();
    const names = group?.commands.map((command) => command.name()) ?? [];
    expect(names).toEqual(expect.arrayContaining(['add', 'list', 'query']));
  });
});

describe('app 层 archivalAdd（FactoryApplication）', () => {
  it('端到端：knowledge 文件归档进 logs/archives/<id>.db，layer 按 frontmatter 推断', async () => {
    const { root } = await setup();
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'ops',
      name: '运营员工',
      runtime: 'claude',
      description: '负责运营',
      goals: ['完成运营任务'],
      feishu: 'disabled',
    });
    const application = new FactoryApplication(paths, registry);
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // seed 一条带 frontmatter 的知识文件。
    const rel = 'knowledge/lessons/2026-08-07-ops.md';
    await fs.writeFile(
      path.join(agent.workspace.path, ...rel.split('/')),
      '---\ntitle: 经验\nauthority_layer: knowledge\n---\n# 经验正文',
    );

    const record = await application.archivalAdd(agent.id, rel);
    expect(record.relPath).toBe(rel);
    expect(record.authorityLayer).toBe('knowledge');
    expect(record.reference).toMatch(/^archive_entries\/\d+$/);

    // list 可见；query 按 layer 过滤命中。
    const rows = await application.archivalList(agent.id);
    expect(rows).toHaveLength(1);
    const hits = await application.archivalQuery(agent.id, { authorityLayer: 'knowledge' });
    expect(hits).toHaveLength(1);

    // 重复 add 幂等（返回既有引用）。
    const again = await application.archivalAdd(agent.id, rel);
    expect(again.reference).toBe(record.reference);

    // DB 文件确实落在 logs/archives/<id>.db。
    expect(await fs.pathExists(path.join(paths.logsDir, 'archives', `${agent.id}.db`))).toBe(true);
  });

  it('app 层范围隔离：../../runtimes/... 拒绝', async () => {
    const { root } = await setup();
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'ops',
      name: '运营员工',
      runtime: 'claude',
      description: '负责运营',
      goals: ['完成运营任务'],
      feishu: 'disabled',
    });
    const application = new FactoryApplication(paths, registry);
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    await expect(
      application.archivalAdd(agent.id, '../../runtimes/ops/claude/settings.json'),
    ).rejects.toThrow(/穿越|仅可归档/);
  });
});
