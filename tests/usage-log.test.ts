import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageDb, USAGE_DB_MAX_ROWS } from '../src/core/usage-log.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-usage-'));
  roots.push(root);
  const dbFile = path.join(root, 'logs', 'usage.db');
  const db = new UsageDb(dbFile);
  return { db, dbFile };
}

function record(
  db: UsageDb,
  overrides: Partial<Parameters<UsageDb['record']>[0]> = {},
): ReturnType<UsageDb['record']> {
  return db.record({
    agentId: 'ops',
    provider: 'claude',
    startedAt: '2026-08-06T10:00:00.000Z',
    finishedAt: '2026-08-06T10:01:00.000Z',
    exitCode: 0,
    prompt: '帮我写周报',
    ...overrides,
  });
}

describe('UsageDb (D-036)', () => {
  it('records a message and queries it back', async () => {
    const { db } = await setup();
    record(db, {
      agentId: 'ops',
      prompt: '总结这周进展',
      args: ['--output-format', 'json'],
      usage: {
        model: 'claude-opus-4-8',
        inputTokens: 100,
        outputTokens: 50,
        totalCostUsd: 0.02,
      },
      topics: ['周报', '进展'],
    });

    const [row] = db.query();
    expect(row).toMatchObject({
      agentId: 'ops',
      provider: 'claude',
      durationMs: 60000,
      exitCode: 0,
      prompt: '总结这周进展',
      promptChars: 6,
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 50,
      totalCostUsd: 0.02,
    });
    expect(row?.argsJson).toBe(JSON.stringify(['--output-format', 'json']));
    expect(JSON.parse(row?.topicsJson ?? '[]')).toEqual(['周报', '进展']);
  });

  it('redacts secrets in prompt (D-006)', async () => {
    const { db } = await setup();
    record(db, { prompt: '用 token sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ 登录' });
    const [row] = db.query();
    expect(row?.prompt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(row?.prompt).toContain('[REDACTED]');
  });

  it('queries by agentId, since, until and limit', async () => {
    const { db } = await setup();
    record(db, { agentId: 'a', startedAt: '2026-08-01T00:00:00.000Z' });
    record(db, { agentId: 'a', startedAt: '2026-08-03T00:00:00.000Z' });
    record(db, { agentId: 'b', startedAt: '2026-08-04T00:00:00.000Z' });

    expect(db.query({ agentId: 'a' })).toHaveLength(2);
    expect(db.query({ since: '2026-08-03T00:00:00.000Z' })).toHaveLength(2);
    expect(db.query({ since: '2026-08-04T00:00:00.000Z' })).toHaveLength(1);
    expect(db.query({ limit: 1 }).map((r) => r.agentId)).toEqual(['b']);
  });

  it('computes summary bucketed by day and agent', async () => {
    const { db } = await setup();
    record(db, {
      agentId: 'ops',
      startedAt: '2026-08-06T10:00:00.000Z',
      usage: { totalCostUsd: 0.1 },
    });
    record(db, { agentId: 'ops', startedAt: '2026-08-06T11:00:00.000Z', exitCode: 1 });
    record(db, { agentId: 'growth', startedAt: '2026-08-06T12:00:00.000Z' });

    const rows = db.summary();
    expect(rows).toHaveLength(2);
    const ops = rows.find((r) => r.agentId === 'ops');
    expect(ops).toMatchObject({
      day: '2026-08-06',
      count: 2,
      avgDurationMs: 30000,
      totalCostUsd: 0.1,
      errorCount: 1,
    });
    const growth = rows.find((r) => r.agentId === 'growth');
    expect(growth).toMatchObject({ count: 1, totalCostUsd: 0, errorCount: 0 });
  });

  it('returns empty arrays when the db file does not exist yet', async () => {
    const { db } = await setup();
    expect(db.query()).toEqual([]);
    expect(db.summary()).toEqual([]);
  });

  it('records D-046 message metadata and queries it back', async () => {
    const { db } = await setup();
    record(db, {
      agentId: 'ops',
      chatType: 'group',
      source: 'im',
      chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
      msgId: 'om_x100b68608bb51480b4835804ba4f6fd',
      senderId: 'ou_fcbf2b9cb3ed94e76158d62d44fbe15c',
      runId: 'c9f7ab7a-a7e0-4810-ae54-8065c9de753c',
    });
    const [row] = db.query();
    expect(row).toMatchObject({
      agentId: 'ops',
      chatType: 'group',
      source: 'im',
      chatId: 'oc_2ffedace5f97b2e60824cc3b07851c82',
      msgId: 'om_x100b68608bb51480b4835804ba4f6fd',
      senderId: 'ou_fcbf2b9cb3ed94e76158d62d44fbe15c',
      runId: 'c9f7ab7a-a7e0-4810-ae54-8065c9de753c',
    });
    // 未提供元数据时全 null（不伪造）。
    record(db, { agentId: 'growth' });
    const [plain] = db.query({ agentId: 'growth' });
    expect(plain?.chatId).toBeNull();
    expect(plain?.runId).toBeNull();
  });

  it('migrates an old D-036 db: missing columns are added idempotently', async () => {
    const { dbFile } = await setup();
    // 手工构造旧版（D-036）schema 并写一条老记录。
    const Database = (await import('better-sqlite3')).default;
    await fs.ensureDir(path.dirname(dbFile));
    const old = new Database(dbFile);
    old.exec(`
      CREATE TABLE messages (
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
      INSERT INTO messages (agent_id, provider, started_at, finished_at, duration_ms, exit_code, prompt, prompt_chars)
      VALUES ('legacy', 'claude', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z', 60000, 0, '老消息', 3);
    `);
    old.close();

    // 旧 UsageDb 打开 → 自动补列 + 老记录仍可读。
    const db = new UsageDb(dbFile);
    const legacy = db.query({ agentId: 'legacy' });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.prompt).toBe('老消息');
    expect(legacy[0]!.chatId).toBeNull();

    // 补列后带元数据写入 + 读回。
    record(db, {
      agentId: 'ops',
      chatType: 'p2p',
      chatId: 'oc_abc',
      senderId: 'ou_def',
      runId: 'run-1',
    });
    const [row] = db.query({ agentId: 'ops' });
    expect(row).toMatchObject({
      chatType: 'p2p',
      chatId: 'oc_abc',
      senderId: 'ou_def',
      runId: 'run-1',
    });
    db.close();

    // 幂等：再次打开不再报错、不重复加列。
    const reopened = new UsageDb(dbFile);
    record(reopened, { agentId: 'ops', msgId: 'om_x' });
    const rows = reopened.query({ agentId: 'ops' });
    expect(rows).toHaveLength(2);
    reopened.close();
  });

  it('persists across re-open (separate instance reads same file)', async () => {
    const { db, dbFile } = await setup();
    record(db, { agentId: 'persist' });
    db.close();
    const reopened = new UsageDb(dbFile);
    expect(reopened.query({ agentId: 'persist' })).toHaveLength(1);
    reopened.close();
  });

  it('caps the table at USAGE_DB_MAX_ROWS, dropping the oldest rows', async () => {
    const { db } = await setup();
    const cap = USAGE_DB_MAX_ROWS;
    // 插入 cap + 5 条，started_at 逐秒递增（合法 ISO，随 id 单调）。
    for (let i = 1; i <= cap + 5; i++) {
      const t = new Date(Date.UTC(2026, 7, 6, 0, 0, 0) + i * 1000).toISOString();
      record(db, { agentId: 'ops', startedAt: t, finishedAt: t });
    }
    const rows = db.query({ limit: cap + 10 });
    expect(rows).toHaveLength(cap);
    // 最旧 5 条被删，剩余 id 从 6 起。
    expect(rows[rows.length - 1]?.id).toBe(6);
    expect(rows[0]?.id).toBe(cap + 5);
  });
});
