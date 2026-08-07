// D-046：飞书消息元数据审计——解析外部 lark-channel-bridge 的结构化 JSONL。
//
// bridge 0.5.9 把每条飞书消息写成 `~/.ai-employees/bridges/<id>/profiles/<profile>/logs/bridge-YYYYMMDD.jsonl`
// （Factory 自己的 bridge home，0700 受管），含 chatId/msgId/sender/chatType/source/runId/durationMs/result/costUsd
// + 带时区时间戳（已实测）。D-036 的「该元数据在外部 bridge 内，本层不可达」前提作废——元数据其实一直在
// Factory 磁盘上，只是 bridge 私有格式、不可查询。本模块把这份 JSONL 解析成可查询的审计记录
// （BridgeMessageAudit），供 `usage audit` CLI / Web 审计列表 / runBridgeMessage 埋点共享。
//
// 容错：malformed 行跳过、文件缺失/空返回 []、不抛异常（读取失败仅告警）。
// 隐私：记录字段为完整 ID（chatId/senderId/msgId）；展示用 shortId() 截断（仿 bridge stdout `…xxxxxx` 风格），
// CLI/Web 一律走展示截断，完整 ID 仅存于 bridge JSONL 与 usage.db（0600，与 bridge 同信任域）。

import fs from 'fs-extra';
import path from 'node:path';

/** bridge 结构化日志目录：<bridgeHome>/profiles/<profile>/logs。 */
export function bridgeLogsDir(bridgeHome: string, profile: string): string {
  return path.join(bridgeHome, 'profiles', profile, 'logs');
}

/** 截断展示 ID：长 ID 只留末尾 6 位（仿 bridge stdout `...fbe15c` 风格）。 */
export function shortId(id: string, len = 6): string {
  if (!id || id.length <= len) return id;
  return `…${id.slice(-len)}`;
}

/** 截断单行文本到 max 字符。 */
export function truncatePreview(text: string, max = 40): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** 一条飞书消息的审计记录（完整 ID；展示前用 shortId 截断）。 */
export interface BridgeMessageAudit {
  /** 消息进入时间（intake.enter，ISO 带时区）。 */
  ts: string;
  /** 完整会话 id（chatId）。 */
  chatId: string;
  /** 会话 id（与 chatId 同值，bridge 用 scope 称呼）。 */
  scope: string;
  /** 会话类型：p2p / group 等。 */
  chatType: string;
  /** 消息来源（bridge run.source：im 等）。 */
  source: string;
  /** 发送者 openId（完整）。 */
  senderId: string;
  /** 消息 id（完整）。 */
  msgId: string;
  /** bridge run UUID（内部关联键，非敏感）。 */
  runId: string | null;
  /** 消息预览（已截断）。 */
  preview: string;
  /** message=触发了 agent run；command=斜杠命令（无 run）。 */
  kind: 'message' | 'command';
  /** run 结果：normal / error / interrupted 等。 */
  result: string | null;
  durationMs: number | null;
  costUsd: number | null;
  /** agent 进程退出码。 */
  exitCode: number | null;
  interrupted: boolean | null;
  /** run 权限模式（accessMode：workspace 等）。 */
  accessMode: string | null;
  queueWaitMs: number | null;
}

export interface BridgeAuditFilter {
  /** 只返回该日期（本地 `YYYY-MM-DD`）及之后的记录。 */
  since?: string;
  limit?: number;
}

const JSONL_NAME = /^bridge-\d{8}\.jsonl$/;

interface Accumulator {
  record: BridgeMessageAudit;
}

async function listJsonl(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => JSONL_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

function flushScope(
  scopes: Map<string, Accumulator>,
  key: string,
  out: BridgeMessageAudit[],
): void {
  const acc = scopes.get(key);
  if (acc) {
    out.push(acc.record);
    scopes.delete(key);
  }
}

function freshRecord(evt: Record<string, unknown>): BridgeMessageAudit {
  const ts = String(evt.ts ?? '');
  return {
    ts,
    chatId: String(evt.chatId ?? evt.scope ?? ''),
    scope: String(evt.scope ?? evt.chatId ?? ''),
    chatType: String(evt.chatType ?? evt.chatMode ?? ''),
    source: '',
    senderId: String(evt.sender ?? ''),
    msgId: String(evt.msgId ?? ''),
    runId: null,
    preview: truncatePreview(String(evt.preview ?? '')),
    kind: 'message',
    result: null,
    durationMs: null,
    costUsd: null,
    exitCode: null,
    interrupted: null,
    accessMode: null,
    queueWaitMs: null,
  };
}

/** 对一组 JSONL 行做事件累积，产出审计记录（按文件内时间序、以 scope 为桶）。 */
async function parseFiles(files: string[], dir: string): Promise<BridgeMessageAudit[]> {
  const scopes = new Map<string, Accumulator>();
  const done: BridgeMessageAudit[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const phase = evt.phase;
      const event = evt.event;
      if (typeof phase !== 'string' || typeof event !== 'string') continue;
      const key = String(evt.scope ?? evt.chatId ?? '');
      if (phase === 'intake' && event === 'enter') {
        flushScope(scopes, key, done);
        scopes.set(key, { record: freshRecord(evt) });
        continue;
      }
      const acc = scopes.get(key);
      if (!acc) continue;
      const tag = `${phase}.${event}`;
      switch (tag) {
        case 'intake.command':
          // 斜杠命令：无 agent run，立即收尾。
          acc.record.kind = 'command';
          flushScope(scopes, key, done);
          break;
        case 'run.started':
          acc.record.source = String(evt.source ?? acc.record.source);
          acc.record.accessMode = String(evt.accessMode ?? acc.record.accessMode);
          acc.record.queueWaitMs =
            typeof evt.queueWaitMs === 'number' ? evt.queueWaitMs : acc.record.queueWaitMs;
          if (evt.runId) acc.record.runId = String(evt.runId);
          break;
        case 'run.completed':
          acc.record.result = String(evt.result ?? acc.record.result);
          acc.record.durationMs =
            typeof evt.durationMs === 'number' ? evt.durationMs : acc.record.durationMs;
          break;
        case 'agent.exit':
          acc.record.exitCode = typeof evt.code === 'number' ? evt.code : acc.record.exitCode;
          break;
        case 'agent.usage':
          acc.record.costUsd = typeof evt.costUsd === 'number' ? evt.costUsd : acc.record.costUsd;
          break;
        case 'card.final':
          acc.record.interrupted =
            typeof evt.interrupted === 'boolean' ? evt.interrupted : acc.record.interrupted;
          flushScope(scopes, key, done);
          break;
      }
    }
  }
  for (const acc of scopes.values()) done.push(acc.record);
  // 按时间倒序（最新在前）。
  return done.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

/** 解析某员工 bridge 日志目录全部 JSONL → 审计记录（倒序）。文件缺失/空 → []。 */
export async function readBridgeAudit(
  dir: string,
  filter: BridgeAuditFilter = {},
): Promise<BridgeMessageAudit[]> {
  const files = await listJsonl(dir);
  if (files.length === 0) return [];
  let records = await parseFiles(files, dir);
  if (filter.since) {
    records = records.filter((r) => r.ts.slice(0, 10) >= filter.since!);
  }
  if (filter.limit !== undefined && filter.limit >= 0) {
    records = records.slice(0, filter.limit);
  }
  return records;
}

/** 供 usage.db 埋点用的 run 元数据（完整 ID）。 */
export interface BridgeRunMeta {
  chatType: string;
  source: string;
  chatId: string;
  scope: string;
  msgId: string;
  senderId: string;
  runId: string | null;
}

/**
 * runBridgeMessage 埋点用：读最新一个 JSONL，按时间近邻（|ts - startedAt| ≤ 60s）匹配当前 run 的审计记录，
 * 返回其消息元数据。匹配失败 → null（与既有 best-effort 一致，不阻断主流程）。
 */
export async function matchBridgeRunMeta(
  dir: string,
  startedAtMs: number,
): Promise<BridgeRunMeta | null> {
  const files = await listJsonl(dir);
  if (files.length === 0) return null;
  const records = await parseFiles([files[files.length - 1]!], dir);
  let best: BridgeMessageAudit | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const t = Date.parse(record.ts);
    if (!Number.isFinite(t)) continue;
    const diff = Math.abs(t - startedAtMs);
    if (diff <= 60_000 && diff < bestDiff) {
      best = record;
      bestDiff = diff;
    }
  }
  if (!best) return null;
  return {
    chatType: best.chatType,
    source: best.source,
    chatId: best.chatId,
    scope: best.scope,
    msgId: best.msgId,
    senderId: best.senderId,
    runId: best.runId,
  };
}
