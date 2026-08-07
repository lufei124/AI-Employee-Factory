// TASK-050（D-046）：bridge-audit parser 测试。
// 覆盖：路径/截断助手、JSONL 事件累积合并（intake→run→agent→card）、命令记录、容错（缺失/坏行）、
// since/limit 过滤、matchBridgeRunMeta 时间近邻匹配。

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeLogsDir,
  matchBridgeRunMeta,
  readBridgeAudit,
  shortId,
  truncatePreview,
} from '../src/core/bridge-audit.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-bridge-audit-'));
  roots.push(root);
  const dir = path.join(root, 'bridges', 'ops', 'profiles', 'ops', 'logs');
  await fs.ensureDir(dir);
  return { root, dir };
}

// 以真实 bridge 0.5.9 JSONL 格式构造一条完整消息（intake→run→agent→card）。
const LINE_ENTER = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-07T11:09:12.205+08:00',
    level: 'info',
    phase: 'intake',
    event: 'enter',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    msgId: 'om_x100b68608bb51480b4835804ba4f6fd',
    traceId: 'czj97raq',
    scope: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    chatType: 'p2p',
    chatMode: 'p2p',
    resolvedMode: 'p2p',
    _msgId: 'om_x100b68608bb51480b4835804ba4f6fd',
    sender: 'ou_fcbf2b9cb3ed94e76158d62d44fbe15c',
    preview: '今天定时任务执行了吗',
    resources: 0,
    ...over,
  });

const LINE_RUN_STARTED = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-07T11:09:12.827+08:00',
    level: 'info',
    phase: 'run',
    event: 'started',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    traceId: 'lx6zlbi6',
    runId: 'c9f7ab7a-a7e0-4810-ae54-8065c9de753c',
    profile: 'ops',
    agent: 'claude',
    scope: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    source: 'im',
    stage: 'submit',
    queueWaitMs: 1,
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    ...over,
  });

const LINE_RUN_COMPLETED = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-07T11:09:57.192+08:00',
    level: 'info',
    phase: 'run',
    event: 'completed',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    traceId: 'lx6zlbi6',
    runId: 'c9f7ab7a-a7e0-4810-ae54-8065c9de753c',
    profile: 'ops',
    agent: 'claude',
    scope: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    source: 'im',
    stage: 'submit',
    result: 'normal',
    durationMs: 44370,
    ...over,
  });

const LINE_AGENT_EXIT = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-07T11:09:58.541+08:00',
    level: 'info',
    phase: 'agent',
    event: 'exit',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    traceId: 'lx6zlbi6',
    pid: 48635,
    code: 0,
    signal: null,
    ...over,
  });

const LINE_USAGE = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-07T11:09:57.192+08:00',
    level: 'info',
    phase: 'agent',
    event: 'usage',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    traceId: 'lx6zlbi6',
    costUsd: 0.5289,
    inputTokens: '[REDACTED]',
    outputTokens: '[REDACTED]',
    ...over,
  });

const LINE_CARD_FINAL = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: '2026-08-07T11:09:57.196+08:00',
    level: 'info',
    phase: 'card',
    event: 'final',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    traceId: 'lx6zlbi6',
    scope: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    terminal: 'done',
    interrupted: false,
    ...over,
  });

describe('bridge-audit 助手', () => {
  it('bridgeLogsDir 落在 bridge home 内', () => {
    expect(bridgeLogsDir('/x/bridges/ops', 'ops')).toBe(
      path.join('/x/bridges/ops', 'profiles', 'ops', 'logs'),
    );
  });
  it('shortId 只留末 6 位，短 ID 原样', () => {
    expect(shortId('ou_fcbf2b9cb3ed94e76158d62d44fbe15c')).toBe('…fbe15c');
    expect(shortId('abc')).toBe('abc');
  });
  it('truncatePreview 超长截断 + 省略号', () => {
    expect(truncatePreview('你好'.repeat(30), 10)).toBe('你好你好你好你好你好…');
    expect(truncatePreview('短文本', 10)).toBe('短文本');
  });
});

describe('readBridgeAudit（D-046）', () => {
  it('合并一条完整消息：intake→run→agent→card 各字段就位', async () => {
    const { dir } = await setup();
    await fs.writeFile(
      path.join(dir, 'bridge-20260807.jsonl'),
      [
        LINE_ENTER(),
        LINE_RUN_STARTED(),
        LINE_RUN_COMPLETED(),
        LINE_USAGE(),
        LINE_AGENT_EXIT(),
        LINE_CARD_FINAL(),
      ].join('\n'),
    );
    const records = await readBridgeAudit(dir);
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ts).toBe('2026-08-07T11:09:12.205+08:00');
    expect(r.chatId).toBe('oc_2ffedace5f97b2e60824cc3b07851c82');
    expect(r.chatType).toBe('p2p');
    expect(r.source).toBe('im');
    expect(r.senderId).toBe('ou_fcbf2b9cb3ed94e76158d62d44fbe15c');
    expect(r.msgId).toBe('om_x100b68608bb51480b4835804ba4f6fd');
    expect(r.runId).toBe('c9f7ab7a-a7e0-4810-ae54-8065c9de753c');
    expect(r.preview).toBe('今天定时任务执行了吗');
    expect(r.kind).toBe('message');
    expect(r.result).toBe('normal');
    expect(r.durationMs).toBe(44370);
    expect(r.costUsd).toBe(0.5289);
    expect(r.exitCode).toBe(0);
    expect(r.interrupted).toBe(false);
    expect(r.accessMode).toBe('workspace');
    expect(r.queueWaitMs).toBe(1);
  });

  it('斜杠命令（intake.enter + intake.command）→ kind=command 且无 run 数据', async () => {
    const { dir } = await setup();
    await fs.writeFile(
      path.join(dir, 'bridge-20260807.jsonl'),
      [LINE_ENTER({ preview: '/new' }), LINE_COMMAND()].join('\n'),
    );
    const records = await readBridgeAudit(dir);
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe('command');
    expect(records[0]!.result).toBeNull();
  });

  it('无目录 / 空目录 / 全坏行 → 空数组不抛错', async () => {
    const { root, dir } = await setup();
    expect(await readBridgeAudit(path.join(root, 'missing'))).toEqual([]);
    await fs.writeFile(path.join(dir, 'bridge-20260807.jsonl'), 'not-json\n{broken\n\n');
    expect(await readBridgeAudit(dir)).toEqual([]);
  });

  it('since 按日期过滤（本地 YYYY-MM-DD），limit 截断最新', async () => {
    const { dir } = await setup();
    await fs.writeFile(
      path.join(dir, 'bridge-20260807.jsonl'),
      [
        LINE_ENTER({ ts: '2026-08-07T10:00:00+08:00', preview: '昨天之后' }),
        LINE_RUN_STARTED(),
        LINE_RUN_COMPLETED(),
        LINE_CARD_FINAL(),
        LINE_ENTER({ ts: '2026-08-06T23:00:00+08:00', preview: '昨天' }),
        LINE_RUN_STARTED(),
        LINE_RUN_COMPLETED(),
        LINE_CARD_FINAL(),
      ].join('\n'),
    );
    const all = await readBridgeAudit(dir);
    expect(all).toHaveLength(2);
    expect(all[0]!.preview).toBe('昨天之后');
    const since = await readBridgeAudit(dir, { since: '2026-08-07' });
    expect(since).toHaveLength(1);
    expect(since[0]!.preview).toBe('昨天之后');
    const limited = await readBridgeAudit(dir, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.preview).toBe('昨天之后');
  });

  it('跨文件时间序合并（两天文件各自独立记录，倒序输出）', async () => {
    const { dir } = await setup();
    for (const day of ['20260806', '20260807']) {
      await fs.writeFile(
        path.join(dir, `bridge-${day}.jsonl`),
        [
          LINE_ENTER({
            ts: `2026-08-${day === '20260806' ? '06' : '07'}T09:00:00+08:00`,
            preview: day,
          }),
          LINE_RUN_STARTED(),
          LINE_RUN_COMPLETED(),
          LINE_CARD_FINAL(),
        ].join('\n'),
      );
    }
    const records = await readBridgeAudit(dir);
    expect(records.map((r) => r.preview)).toEqual(['20260807', '20260806']);
  });
});

function LINE_COMMAND(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    ts: '2026-08-07T11:09:05.622+08:00',
    level: 'info',
    phase: 'intake',
    event: 'command',
    chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    msgId: 'om_x100b68608a3184a0b251316fbe0957a',
    traceId: 'ouw94o1z',
    scope: 'oc_2ffedace5f97b2e60824cc3b07851c82',
    droppedPending: 0,
    ...over,
  });
}

describe('matchBridgeRunMeta（runBridgeMessage 埋点）', () => {
  it('时间近邻匹配到当前 run 的完整元数据', async () => {
    const { dir } = await setup();
    await fs.writeFile(
      path.join(dir, 'bridge-20260807.jsonl'),
      [
        LINE_ENTER({ ts: '2026-08-07T11:09:04+08:00', preview: '旧消息' }),
        LINE_RUN_STARTED({ ts: '2026-08-07T11:09:04.500+08:00', runId: 'old-run' }),
        LINE_RUN_COMPLETED({ ts: '2026-08-07T11:09:50+08:00' }),
        LINE_CARD_FINAL({ ts: '2026-08-07T11:09:51+08:00' }),
        LINE_ENTER({ ts: '2026-08-07T11:10:00+08:00', preview: '当前消息' }),
        LINE_RUN_STARTED({ ts: '2026-08-07T11:10:00.500+08:00', runId: 'cur-run' }),
        LINE_RUN_COMPLETED({ ts: '2026-08-07T11:10:30+08:00' }),
        LINE_CARD_FINAL({ ts: '2026-08-07T11:10:31+08:00' }),
      ].join('\n'),
    );
    const startedAtMs = Date.parse('2026-08-07T11:10:00.800+08:00');
    const meta = await matchBridgeRunMeta(dir, startedAtMs);
    expect(meta).toEqual({
      chatType: 'p2p',
      source: 'im',
      chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
      scope: 'oc_2ffedace5f97b2e60824cc3b07851c82',
      msgId: 'om_x100b68608bb51480b4835804ba4f6fd',
      senderId: 'ou_fcbf2b9cb3ed94e76158d62d44fbe15c',
      runId: 'cur-run',
    });
  });

  it('时间窗口外（>60s）→ null；目录缺失 → null', async () => {
    const { root, dir } = await setup();
    await fs.writeFile(
      path.join(dir, 'bridge-20260807.jsonl'),
      [LINE_ENTER(), LINE_RUN_STARTED(), LINE_RUN_COMPLETED(), LINE_CARD_FINAL()].join('\n'),
    );
    expect(await matchBridgeRunMeta(dir, Date.parse('2026-08-07T12:00:00+08:00'))).toBeNull();
    expect(await matchBridgeRunMeta(path.join(root, 'missing'), Date.now())).toBeNull();
  });
});
