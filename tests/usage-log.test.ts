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
