import fs from 'fs-extra';
import path from 'node:path';
import { redactSecrets } from './secrets.js';

// OP4-A：操作摘要持久化。append-only 写 logs/operations.jsonl（0o600），
// 供 `agentctl operations query` 事后审计。不存 stdout/stderr 全量（D-006），
// error_summary 经 redactSecrets 脱敏。

export interface OperationSummary {
  operation_id: string;
  agent_id?: string;
  kind: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  error_summary?: string;
  trace_id?: string;
}

export interface OperationFilter {
  agentId?: string;
  kind?: string;
  since?: string; // ISO 时间，按 started_at 过滤
  until?: string;
  limit?: number;
}

// record 输入：由 OperationManager 从 DTO 映射而来；error_message 为原始消息，
// 由 store 统一脱敏后落盘为 error_summary。
export interface OperationRecordInput {
  operation_id: string;
  agent_id?: string;
  kind: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  error_message?: string;
  trace_id?: string;
}

export class OperationStore {
  private readonly file: string;

  constructor(logsDir: string) {
    this.file = path.join(logsDir, 'operations.jsonl');
  }

  async record(input: OperationRecordInput): Promise<void> {
    await fs.ensureDir(path.dirname(this.file), { mode: 0o700 });
    const summary: OperationSummary = {
      operation_id: input.operation_id,
      ...(input.agent_id ? { agent_id: input.agent_id } : {}),
      kind: input.kind,
      started_at: input.started_at,
      finished_at: input.finished_at,
      exit_code: input.exit_code,
      ...(input.error_message ? { error_summary: redactSecrets(input.error_message) } : {}),
      ...(input.trace_id ? { trace_id: input.trace_id } : {}),
    };
    // appendFile 的 mode 仅在创建时生效；随后 chmod 收紧，防止外部以宽松权限创建。
    await fs.appendFile(this.file, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  async query(filter: OperationFilter = {}): Promise<OperationSummary[]> {
    if (!(await fs.pathExists(this.file))) return [];
    const raw = await fs.readFile(this.file, 'utf8');
    const sinceMs = filter.since ? Date.parse(filter.since) : undefined;
    const untilMs = filter.until ? Date.parse(filter.until) : undefined;
    const matched: OperationSummary[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: OperationSummary;
      try {
        entry = JSON.parse(line) as OperationSummary;
      } catch {
        continue; // 跳过损坏行
      }
      if (filter.agentId !== undefined && entry.agent_id !== filter.agentId) continue;
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue;
      const startedMs = Date.parse(entry.started_at);
      if (
        sinceMs !== undefined &&
        Number.isFinite(sinceMs) &&
        Number.isFinite(startedMs) &&
        startedMs < sinceMs
      )
        continue;
      if (
        untilMs !== undefined &&
        Number.isFinite(untilMs) &&
        Number.isFinite(startedMs) &&
        startedMs > untilMs
      )
        continue;
      matched.push(entry);
    }
    const limit = filter.limit ?? 100;
    return limit > 0 ? matched.slice(-limit) : matched;
  }
}
