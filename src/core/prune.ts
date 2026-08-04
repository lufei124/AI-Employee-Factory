import fs from 'fs-extra';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import { OperationStore } from './operation-store.js';
import { assertInsideReal, type FactoryPaths } from './paths.js';

// OP4-D：按分类清理的中心化 prune 服务。前置 Stage A（operations.jsonl 持久化）已就绪，
// 满足 OP4「先持久化再 prune」硬依赖。所有删除目标均经 assertInsideReal 二次校验，
// 永不删除受管根本身；symlink 逃逸项被跳过而非跟随。prune 是破坏性操作，由 CLI 层
// --dry-run / --yes 把关，不在 preAction 自动跑（区别于 trash 7 天自动 purge）。

export type PruneScope = 'logs' | 'registry-backups' | 'archives' | 'operations';

export interface PruneOptions {
  logs?: boolean;
  registryBackups?: boolean;
  archives?: boolean;
  operations?: boolean;
  dryRun?: boolean;
  keepDays?: number;
  keepCount?: number;
}

export interface PruneScopeResult {
  scope: PruneScope;
  /** 已删除（实跑）或将删除（dry-run）的绝对路径；operations 轮转为空，见 detail。 */
  paths: string[];
  freedBytes: number;
  detail?: string;
}

export interface PruneResult {
  dryRun: boolean;
  scopes: PruneScopeResult[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  logsKeepDays: 30,
  archivesKeepDays: 90,
  operationsKeepDays: 30,
  registryBackupsKeepCount: 20,
} as const;

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

export class PruneService {
  constructor(private readonly paths: FactoryPaths) {}

  async run(options: PruneOptions): Promise<PruneResult> {
    const scopes: PruneScope[] = [];
    if (options.logs) scopes.push('logs');
    if (options.registryBackups) scopes.push('registry-backups');
    if (options.archives) scopes.push('archives');
    if (options.operations) scopes.push('operations');
    if (scopes.length === 0) {
      throw new AgentCtlError(
        'VALIDATION_ERROR',
        '请至少指定一个清理范围：--logs/--registry-backups/--archives/--operations。',
      );
    }
    const dryRun = options.dryRun === true;
    const results: PruneScopeResult[] = [];
    for (const scope of scopes) {
      if (scope === 'logs') {
        results.push(await this.pruneLogs(options.keepDays ?? DEFAULTS.logsKeepDays, dryRun));
      } else if (scope === 'registry-backups') {
        results.push(
          await this.pruneRegistryBackups(
            options.keepCount ?? DEFAULTS.registryBackupsKeepCount,
            dryRun,
          ),
        );
      } else if (scope === 'archives') {
        results.push(
          await this.pruneArchives(options.keepDays ?? DEFAULTS.archivesKeepDays, dryRun),
        );
      } else {
        results.push(
          await this.pruneOperations(options.keepDays ?? DEFAULTS.operationsKeepDays, dryRun),
        );
      }
    }
    return { dryRun, scopes: results };
  }

  /** run 日志：按 slug 目录 mtime 判龄，删除整个 slug 目录；不动 <id> 根与 operations.jsonl。 */
  private async pruneLogs(keepDays: number, dryRun: boolean): Promise<PruneScopeResult> {
    const cutoff = Date.now() - keepDays * DAY_MS;
    if (!(await fs.pathExists(this.paths.logsDir))) {
      return { scope: 'logs', paths: [], freedBytes: 0 };
    }
    const removed: string[] = [];
    let freedBytes = 0;
    for (const agentEntry of await fs.readdir(this.paths.logsDir, { withFileTypes: true })) {
      if (!agentEntry.isDirectory()) continue; // 跳过 operations.jsonl 等文件
      const runsDir = path.join(this.paths.logsDir, agentEntry.name, 'runs');
      if (!(await fs.pathExists(runsDir))) continue;
      for (const runEntry of await fs.readdir(runsDir, { withFileTypes: true })) {
        // isDirectory() 对 symlink 为 false -> symlink 逃逸项被跳过，不跟随删除。
        if (!runEntry.isDirectory()) continue;
        const runDir = path.join(runsDir, runEntry.name);
        const stat = await fs.stat(runDir);
        if (stat.mtimeMs >= cutoff) continue;
        const size = await dirSize(runDir);
        const safe = await this.safeRemove(this.paths.logsDir, runDir, 'run 日志目录', dryRun);
        if (safe !== undefined) {
          removed.push(safe);
          freedBytes += size;
        }
      }
    }
    return { scope: 'logs', paths: removed, freedBytes };
  }

  /** registry 备份：按 mtime 倒序保留最近 keepCount 份，余删除。 */
  private async pruneRegistryBackups(
    keepCount: number,
    dryRun: boolean,
  ): Promise<PruneScopeResult> {
    const backupDir = path.join(path.dirname(this.paths.registryFile), 'backups');
    if (!(await fs.pathExists(backupDir))) {
      return { scope: 'registry-backups', paths: [], freedBytes: 0 };
    }
    const statted = await Promise.all(
      (await fs.readdir(backupDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^agents-.*\.yaml$/i.test(entry.name))
        .map(async (entry) => {
          const full = path.join(backupDir, entry.name);
          const stat = await fs.stat(full);
          return { full, mtimeMs: stat.mtimeMs, size: stat.size };
        }),
    );
    statted.sort((left, right) => right.mtimeMs - left.mtimeMs); // 最新在前
    const removed: string[] = [];
    let freedBytes = 0;
    for (const candidate of statted.slice(keepCount)) {
      const safe = await this.safeRemove(
        this.paths.registryDir,
        candidate.full,
        'registry 备份',
        dryRun,
      );
      if (safe !== undefined) {
        removed.push(safe);
        freedBytes += candidate.size;
      }
    }
    return { scope: 'registry-backups', paths: removed, freedBytes };
  }

  /** 员工备份归档：按 mtime 判龄删旧（.tar.gz/.aief.enc/.enc）。 */
  private async pruneArchives(keepDays: number, dryRun: boolean): Promise<PruneScopeResult> {
    const cutoff = Date.now() - keepDays * DAY_MS;
    if (!(await fs.pathExists(this.paths.backupsDir))) {
      return { scope: 'archives', paths: [], freedBytes: 0 };
    }
    const removed: string[] = [];
    let freedBytes = 0;
    for (const entry of await fs.readdir(this.paths.backupsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/(?:\.tar\.gz|\.aief\.enc|\.enc)$/i.test(entry.name)) continue;
      const full = path.join(this.paths.backupsDir, entry.name);
      const stat = await fs.stat(full);
      if (stat.mtimeMs >= cutoff) continue;
      const safe = await this.safeRemove(this.paths.backupsDir, full, '员工备份归档', dryRun);
      if (safe !== undefined) {
        removed.push(safe);
        freedBytes += stat.size;
      }
    }
    return { scope: 'archives', paths: removed, freedBytes };
  }

  /** operations.jsonl：读全量，丢弃早于 keepDays 的行，原子重写保 0o600。 */
  private async pruneOperations(keepDays: number, dryRun: boolean): Promise<PruneScopeResult> {
    const file = path.join(this.paths.logsDir, 'operations.jsonl');
    if (!(await fs.pathExists(file))) {
      return { scope: 'operations', paths: [], freedBytes: 0, detail: 'operations.jsonl 不存在' };
    }
    const all = await new OperationStore(this.paths.logsDir).query({
      limit: Number.MAX_SAFE_INTEGER,
    });
    const cutoff = Date.now() - keepDays * DAY_MS;
    const kept: string[] = [];
    let dropped = 0;
    let droppedBytes = 0;
    for (const entry of all) {
      const startedAt = Date.parse(entry.started_at);
      if (Number.isFinite(startedAt) && startedAt < cutoff) {
        dropped += 1;
        droppedBytes += Buffer.byteLength(`${JSON.stringify(entry)}\n`, 'utf8');
      } else {
        kept.push(JSON.stringify(entry));
      }
    }
    if (dropped === 0) {
      return { scope: 'operations', paths: [], freedBytes: 0, detail: '无过期记录' };
    }
    if (!dryRun) {
      const content = kept.length > 0 ? `${kept.join('\n')}\n` : '';
      await atomicWriteFile(file, content, 0o600);
    }
    return {
      scope: 'operations',
      paths: [],
      freedBytes: droppedBytes,
      detail: `丢弃 ${dropped} 行，保留 ${kept.length} 行`,
    };
  }

  /**
   * 删除前置 assertInsideReal 二次校验（realpath + 拒 symlink）；越界或 symlink 逃逸项
   * 被跳过（返回 undefined）而非中止整批。dry-run 时只校验不删除。
   */
  private async safeRemove(
    root: string,
    candidate: string,
    label: string,
    dryRun: boolean,
  ): Promise<string | undefined> {
    try {
      const safe = await assertInsideReal(root, candidate, label);
      if (!dryRun) await fs.remove(safe);
      return safe;
    } catch {
      return undefined;
    }
  }
}
