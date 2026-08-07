// TASK-049（D-045）：archival local-sqlite 后端——D-014 frozen 契约的唯一本地实现。
//
// 背景：src/core/archival.ts 只定义了 ArchivalBackend 契约（kind 默认 'none'，零调用点）。
// 本模块实现 'local-sqlite' 变体：单员工单库 `~/.ai-employees/logs/archives/<agent-id>.db`
// （usage.db 同款布局：logsDir 受管 0700，DB 文件显式 0600，WAL 侧文件由目录权限保护）。
//
// D-014 四条 invariants 落实：
// ① archive() 内二次 redactSecrets（后端不信任调用方，禁止原始 Secret 落盘）；
// ② per-entry 显式授权在 CLI 入口（archival add <id> <rel-path>，rel-path 参数即授权）；
// ③ 仅接受 workspace 内 knowledge/** 或 agent/ 身份文档（assertInsideReal 防软链逃逸 + 白名单）；
// ④ local-sqlite 无网络面；external 仍须安全评审（D-045 注明）。
//
// 对齐 usage-log.ts 全部模式：懒打开 ensure()（WAL + CREATE TABLE IF NOT EXISTS + 失败降级）、
// named-param prepared statements、best-effort 不抛异常、close()。

import fs from 'fs-extra';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AgentCtlError } from './errors.js';
import { assertInsideReal } from './paths.js';
import { redactSecrets } from './secrets.js';
import { AUTHORITY_LAYERS, type AuthorityLayer } from '../schemas/agent-schema.js';
import type { ArchivalBackend, ArchivalEntry, ArchivalResult } from './archival.js';

/** 归档库目录（logsDir 下，与 usage.db 同受管）。 */
export function archivesDirOf(logsDir: string): string {
  return path.join(logsDir, 'archives');
}

/** 单员工归档库路径：<logsDir>/archives/<agent-id>.db。 */
export function archiveDbFile(logsDir: string, agentId: string): string {
  return path.join(archivesDirOf(logsDir), `${agentId}.db`);
}

/** 归档白名单：仅可迁移身份知识（knowledge/**）与身份文档（agent/）。 */
const ARCHIVABLE_TOP_LEVELS = ['knowledge', 'agent'] as const;

/**
 * 校验 relPath 形状：相对、无穿越、白名单顶层目录（knowledge/ 或 agent/）。
 * 不触碰磁盘；形状校验独立于存在性（调用方另行确认文件真实存在）。
 */
export function validateArchivalRelPath(relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new AgentCtlError('VALIDATION_ERROR', `归档路径不能是绝对路径：${relPath}`);
  }
  const normalized = path.normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new AgentCtlError('VALIDATION_ERROR', `归档路径不能穿越工作区：${relPath}`);
  }
  const top = normalized.split(path.sep)[0] ?? '';
  if (!(ARCHIVABLE_TOP_LEVELS as readonly string[]).includes(top)) {
    throw new AgentCtlError(
      'VALIDATION_ERROR',
      `仅可归档 knowledge/** 或 agent/ 身份文档：${relPath}`,
    );
  }
  return normalized;
}

/**
 * 校验可归档工作区路径（app 层入口）：assertInsideReal 防软链逃逸 + 白名单 + 必须存在。
 * @param workspaceRoot 受管工作区根（真实路径解析基准）。
 * @param workspace 员工工作区路径。
 * @param relPath 相对工作区的路径（POSIX 风格，如 knowledge/lessons/foo.md）。
 */
export async function assertArchivableWorkspacePath(
  workspaceRoot: string,
  workspace: string,
  relPath: string,
): Promise<string> {
  const normalized = validateArchivalRelPath(relPath);
  const candidate = await assertInsideReal(
    workspaceRoot,
    path.join(workspace, ...normalized.split('/')),
    '归档文件',
  );
  if (!(await fs.pathExists(candidate))) {
    throw new AgentCtlError('NOT_FOUND', `归档文件不存在：${relPath}`);
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isFile()) {
    throw new AgentCtlError('VALIDATION_ERROR', `归档目标不是普通文件：${relPath}`);
  }
  return normalized;
}

/** 归档库记录（审计/查询展示用，content 已脱敏）。 */
export interface ArchivalRecord {
  id: number;
  relPath: string;
  authorityLayer: AuthorityLayer;
  createdAt: string;
  archivedAt: string;
  bytes: number;
  reference: string;
}

export interface ArchivalQuery {
  relPath?: string;
  authorityLayer?: AuthorityLayer;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS archive_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path TEXT NOT NULL UNIQUE,
  authority_layer TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reference TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archive_entries_layer ON archive_entries (authority_layer);
`;

export class LocalSqliteArchivalBackend implements ArchivalBackend {
  readonly kind = 'local-sqlite' as const;
  private db: Database.Database | null = null;
  private openFailed = false;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** 懒打开 DB（WAL + 建表）。失败置 null 并告警一次，后续调用走降级。 */
  private ensure(): Database.Database | null {
    if (this.db) return this.db;
    if (this.openFailed) return null;
    try {
      fs.ensureDirSync(path.dirname(this.file));
      const db = new Database(this.file);
      db.pragma('journal_mode = WAL');
      db.exec(SCHEMA);
      // 显式收紧文件权限（0600），目录 0700 已受管，双保险。
      fs.chmodSync(this.file, 0o600);
      this.db = db;
    } catch (error) {
      this.openFailed = true;
      this.db = null;
      console.warn(`[archival] 打开 ${this.file} 失败，跳过归档：`, error);
    }
    return this.db;
  }

  /**
   * 归档一条内容。幂等：同 relPath 重复归档 no-op（INSERT OR IGNORE），返回既有行引用。
   * ① 落盘前二次 redactSecrets（D-014 invariant ①，后端不信任调用方）。
   */
  async archive(entry: ArchivalEntry): Promise<ArchivalResult> {
    const db = this.ensure();
    if (!db) throw new AgentCtlError('OPERATION_FAILED', `归档库不可用：${this.file}`);
    const relPath = validateArchivalRelPath(entry.relPath);
    if (!(AUTHORITY_LAYERS as readonly string[]).includes(entry.authorityLayer)) {
      throw new AgentCtlError('VALIDATION_ERROR', `非法 authority_layer：${entry.authorityLayer}`);
    }
    const content = redactSecrets(entry.content);
    const bytes = Buffer.byteLength(content, 'utf8');
    const archivedAt = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO archive_entries (
        rel_path, authority_layer, content, created_at, archived_at, bytes, reference
      ) VALUES (
        @relPath, @authorityLayer, @content, @createdAt, @archivedAt, @bytes, @reference
      )`,
    ).run({
      relPath,
      authorityLayer: entry.authorityLayer,
      content,
      createdAt: entry.createdAt,
      archivedAt,
      bytes,
      reference: '', // 先占位，下面按实际行 id 回填。
    });
    const row = db
      .prepare(`SELECT id FROM archive_entries WHERE rel_path = @relPath`)
      .get({ relPath }) as { id: number } | undefined;
    if (!row) throw new AgentCtlError('OPERATION_FAILED', `归档写入失败：${relPath}`);
    const reference = `archive_entries/${row.id}`;
    db.prepare(`UPDATE archive_entries SET reference = @reference WHERE id = @id`).run({
      reference,
      id: row.id,
    });
    return { reference, bytes };
  }

  /** 列出全部归档条目（审计，按 id 升序即归档顺序）。 */
  list(): ArchivalRecord[] {
    const db = this.ensure();
    if (!db) return [];
    return this.mapRows(
      db.prepare(`SELECT * FROM archive_entries ORDER BY id ASC`).all() as Record<
        string,
        unknown
      >[],
    );
  }

  /** 过滤查询（layer / relPath 精确过滤 + limit，默认 100）。非法 layer → VALIDATION_ERROR。 */
  query(filter: ArchivalQuery = {}): ArchivalRecord[] {
    const db = this.ensure();
    if (!db) return [];
    if (filter.authorityLayer !== undefined) {
      if (!(AUTHORITY_LAYERS as readonly string[]).includes(filter.authorityLayer)) {
        throw new AgentCtlError(
          'VALIDATION_ERROR',
          `非法 authority_layer：${filter.authorityLayer}`,
        );
      }
    }
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.relPath !== undefined) {
      clauses.push('rel_path = @relPath');
      params.relPath = filter.relPath;
    }
    if (filter.authorityLayer !== undefined) {
      clauses.push('authority_layer = @authorityLayer');
      params.authorityLayer = filter.authorityLayer;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    return this.mapRows(
      db
        .prepare(`SELECT * FROM archive_entries ${where} ORDER BY id DESC LIMIT @limit`)
        .all({ ...params, limit }) as Record<string, unknown>[],
    );
  }

  /** 关闭 DB（测试用）。 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private mapRows(rows: Record<string, unknown>[]): ArchivalRecord[] {
    return rows.map((row) => ({
      id: Number(row.id),
      relPath: String(row.rel_path),
      authorityLayer: String(row.authority_layer) as AuthorityLayer,
      createdAt: String(row.created_at),
      archivedAt: String(row.archived_at),
      bytes: Number(row.bytes),
      reference: String(row.reference),
    }));
  }
}
