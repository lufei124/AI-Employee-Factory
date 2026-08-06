import fs from 'fs-extra';
import path from 'node:path';
import Database from 'better-sqlite3';
import { redactSecrets } from './secrets.js';
import type { RunUsage } from './usage.js';

// D-036：飞书实际使用日志（本地 SQLite）。每条飞书消息（bridge-run）落一行到
// `~/.ai-employees/logs/usage.db`，供 `agentctl usage query/summary` 事后分析产品使用。
// 数据口径：prompt 经 redactSecrets 脱敏后落盘（守 D-006），token/成本来自 structured 输出的
// RunUsage（best-effort，bridge 非 JSON 输出则为空）。record 一律 best-effort——写失败仅告警，
// 绝不阻断消息/settle 链。DB 上限 USAGE_DB_MAX_ROWS 条，超限自动删最旧（保最近 N 条）。

/** usage.db 记录上限：最多保留最近 N 条消息，超限自动删最旧。 */
export const USAGE_DB_MAX_ROWS = 10000;

export interface UsageMessageInput {
  agentId: string;
  provider: 'claude' | 'codex';
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  /** 原始 prompt（stdin）。存入前经 redactSecrets 脱敏。 */
  prompt: string;
  /** bridge 传给 claude 的 argv（stdin 之外的参数，如 `--output-format json`）。 */
  args?: string[];
  /** structured 解析出的 token/成本（best-effort，可为空）。 */
  usage?: RunUsage;
  /** transcript 摘要的主题关键词（best-effort）。 */
  topics?: string[];
  transcriptFile?: string;
}

export interface UsageMessage {
  id: number;
  agentId: string;
  provider: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  prompt: string;
  promptChars: number;
  argsJson: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalCostUsd: number | null;
  topicsJson: string | null;
  transcriptFile: string | null;
}

export interface UsageFilter {
  agentId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface UsageSummaryRow {
  day: string;
  agentId: string;
  count: number;
  avgDurationMs: number;
  totalCostUsd: number;
  errorCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  provider TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  exit_code INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  args_json TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  total_cost_usd REAL,
  topics_json TEXT,
  transcript_file TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_agent_started ON messages (agent_id, started_at);
`;

export class UsageDb {
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
      this.db = db;
    } catch (error) {
      this.openFailed = true;
      this.db = null;
      console.warn(`[usage] 打开 ${this.file} 失败，跳过 usage 记录：`, error);
    }
    return this.db;
  }

  /** 记录一条飞书消息。best-effort：任何失败仅告警，不抛出。 */
  record(input: UsageMessageInput): void {
    const db = this.ensure();
    if (!db) return;
    try {
      const startedMs = Date.parse(input.startedAt);
      const finishedMs = Date.parse(input.finishedAt);
      const durationMs =
        Number.isFinite(startedMs) && Number.isFinite(finishedMs)
          ? Math.max(0, finishedMs - startedMs)
          : 0;
      const prompt = redactSecrets(input.prompt);
      const usage = input.usage;
      db.prepare(
        `INSERT INTO messages (
          agent_id, provider, started_at, finished_at, duration_ms, exit_code,
          prompt, prompt_chars, args_json, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          total_cost_usd, topics_json, transcript_file
        ) VALUES (
          @agentId, @provider, @startedAt, @finishedAt, @durationMs, @exitCode,
          @prompt, @promptChars, @argsJson, @model,
          @inputTokens, @outputTokens, @cacheReadInputTokens, @cacheCreationInputTokens,
          @totalCostUsd, @topicsJson, @transcriptFile
        )`,
      ).run({
        agentId: input.agentId,
        provider: input.provider,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        durationMs,
        exitCode: input.exitCode,
        prompt,
        promptChars: prompt.length,
        argsJson: input.args && input.args.length > 0 ? JSON.stringify(input.args) : null,
        model: usage?.model ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
        totalCostUsd: usage?.totalCostUsd ?? null,
        topicsJson: input.topics && input.topics.length > 0 ? JSON.stringify(input.topics) : null,
        transcriptFile: input.transcriptFile ?? null,
      });
      // 上限裁剪：保留最近 USAGE_DB_MAX_ROWS 条。子查询在行数未超限时返回 NULL，`id <= NULL` 为假 → 空操作。
      db.prepare(
        `DELETE FROM messages WHERE id <= (
           SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ${USAGE_DB_MAX_ROWS}
         )`,
      ).run();
    } catch (error) {
      console.warn(`[usage] 写入 usage.db 记录失败：`, error);
    }
  }

  /** 按骨架/时间过滤查询消息记录（默认最近 100 条）。 */
  query(filter: UsageFilter = {}): UsageMessage[] {
    const db = this.ensure();
    if (!db) return [];
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.agentId !== undefined) {
      clauses.push('agent_id = @agentId');
      params.agentId = filter.agentId;
    }
    if (filter.since !== undefined) {
      clauses.push('started_at >= @since');
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      clauses.push('started_at <= @until');
      params.until = filter.until;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = db
      .prepare(`SELECT * FROM messages ${where} ORDER BY started_at DESC LIMIT @limit`)
      .all({ ...params, limit }) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /** 聚合统计：按天 + 员工分桶（消息数、平均耗时、总成本、错误数）。 */
  summary(filter: UsageFilter = {}): UsageSummaryRow[] {
    const db = this.ensure();
    if (!db) return [];
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.agentId !== undefined) {
      clauses.push('agent_id = @agentId');
      params.agentId = filter.agentId;
    }
    if (filter.since !== undefined) {
      clauses.push('started_at >= @since');
      params.since = filter.since;
    }
    if (filter.until !== undefined) {
      clauses.push('started_at <= @until');
      params.until = filter.until;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT
           substr(started_at, 1, 10) AS day,
           agent_id AS agentId,
           COUNT(*) AS count,
           CAST(AVG(duration_ms) AS INTEGER) AS avgDurationMs,
           SUM(total_cost_usd) AS totalCostUsd,
           SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END) AS errorCount
         FROM messages ${where}
         GROUP BY day, agent_id
         ORDER BY day DESC, agentId ASC`,
      )
      .all(params) as Record<string, unknown>[];
    return rows.map((row) => ({
      day: row.day as string,
      agentId: row.agentId as string,
      count: Number(row.count),
      avgDurationMs: Number(row.avgDurationMs),
      totalCostUsd: row.totalCostUsd === null ? 0 : Number(row.totalCostUsd),
      errorCount: Number(row.errorCount),
    }));
  }

  /** 关闭 DB（测试用）。 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private mapRow(row: Record<string, unknown>): UsageMessage {
    return {
      id: Number(row.id),
      agentId: String(row.agent_id),
      provider: row.provider === null ? null : String(row.provider),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      durationMs: Number(row.duration_ms),
      exitCode: Number(row.exit_code),
      prompt: String(row.prompt),
      promptChars: Number(row.prompt_chars),
      argsJson: row.args_json === null ? null : String(row.args_json),
      model: row.model === null ? null : String(row.model),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      cacheReadInputTokens:
        row.cache_read_input_tokens === null ? null : Number(row.cache_read_input_tokens),
      cacheCreationInputTokens:
        row.cache_creation_input_tokens === null ? null : Number(row.cache_creation_input_tokens),
      totalCostUsd: row.total_cost_usd === null ? null : Number(row.total_cost_usd),
      topicsJson: row.topics_json === null ? null : String(row.topics_json),
      transcriptFile: row.transcript_file === null ? null : String(row.transcript_file),
    };
  }
}
