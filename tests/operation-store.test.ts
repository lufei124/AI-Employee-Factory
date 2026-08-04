import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationStore } from '../src/core/operation-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-opstore-'));
  roots.push(root);
  const logsDir = path.join(root, 'logs');
  return { store: new OperationStore(logsDir), file: path.join(logsDir, 'operations.jsonl') };
}

describe('OperationStore (OP4-A)', () => {
  it('appends summaries to a 0o600 jsonl file', async () => {
    const { store, file } = await setup();
    await store.record({
      operation_id: 'op-1',
      kind: 'chat',
      started_at: '2026-08-04T10:00:00.000Z',
      finished_at: '2026-08-04T10:01:00.000Z',
      exit_code: 0,
    });
    await store.record({
      operation_id: 'op-2',
      agent_id: 'user-operations',
      kind: 'run',
      started_at: '2026-08-04T10:02:00.000Z',
      finished_at: '2026-08-04T10:03:00.000Z',
      exit_code: 1,
      error_message: 'boom',
    });

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      operation_id: 'op-1',
      kind: 'chat',
      exit_code: 0,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      operation_id: 'op-2',
      agent_id: 'user-operations',
      error_summary: 'boom',
    });
  });

  it('redacts secrets in error_summary (D-006)', async () => {
    const { store, file } = await setup();
    await store.record({
      operation_id: 'op-1',
      kind: 'run',
      started_at: '2026-08-04T10:00:00.000Z',
      finished_at: '2026-08-04T10:01:00.000Z',
      exit_code: 1,
      error_message: 'leaked sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ in args',
    });

    const content = await fs.readFile(file, 'utf8');
    expect(content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(content).toContain('[REDACTED]');
  });

  it('queries by agentId, kind, since, and limit', async () => {
    const { store } = await setup();
    await store.record({
      operation_id: 'a1',
      agent_id: 'ops',
      kind: 'chat',
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:01:00.000Z',
      exit_code: 0,
    });
    await store.record({
      operation_id: 'a2',
      agent_id: 'ops',
      kind: 'run',
      started_at: '2026-08-03T00:00:00.000Z',
      finished_at: '2026-08-03T00:01:00.000Z',
      exit_code: 0,
    });
    await store.record({
      operation_id: 'a3',
      agent_id: 'growth',
      kind: 'chat',
      started_at: '2026-08-04T00:00:00.000Z',
      finished_at: '2026-08-04T00:01:00.000Z',
      exit_code: 0,
    });

    expect((await store.query({ agentId: 'ops' })).map((s) => s.operation_id)).toEqual([
      'a1',
      'a2',
    ]);
    expect((await store.query({ kind: 'chat' })).map((s) => s.operation_id)).toEqual(['a1', 'a3']);
    expect(
      (await store.query({ since: '2026-08-03T00:00:00.000Z' })).map((s) => s.operation_id),
    ).toEqual(['a2', 'a3']);
    expect((await store.query({ limit: 1 })).map((s) => s.operation_id)).toEqual(['a3']);
  });

  it('returns [] when the jsonl file does not exist', async () => {
    const { store } = await setup();
    expect(await store.query()).toEqual([]);
  });
});
