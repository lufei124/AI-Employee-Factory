import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessRunner } from '../src/core/process-runner.js';
import type { ExecutionContext } from '../src/runtimes/runtime-adapter.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-procrunner-'));
  roots.push(root);
  return { root, runner: new ProcessRunner(root) };
}

function context(): ExecutionContext {
  return {
    operation: 'run',
    command: process.execPath,
    args: ['-e', "console.log('hi')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
  };
}

describe('ProcessRunner (OP4-B trace enrichment)', () => {
  it('writes operation_id/trace_id/span_id to metadata.json when provided', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged('agent-1', context(), {
      operationId: 'op-123',
      traceId: 'trace-abc',
      mirror: false,
    });
    const meta = await fs.readJson(result.metadataFile);
    expect(meta.operation_id).toBe('op-123');
    expect(meta.trace_id).toBe('trace-abc');
    expect(meta.span_id).toEqual(expect.any(String));
    expect(meta.exit_code).toBe(0);
  });

  it('omits trace fields when not provided (backward compatible)', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged('agent-1', context(), { mirror: false });
    const meta = await fs.readJson(result.metadataFile);
    expect(meta).not.toHaveProperty('operation_id');
    expect(meta).not.toHaveProperty('trace_id');
    expect(meta).not.toHaveProperty('span_id');
    expect(meta.exit_code).toBe(0);
  });

  it('returns startedAt/finishedAt ISO strings', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged('agent-1', context(), { mirror: false });
    expect(new Date(result.startedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(result.finishedAt).toString()).not.toBe('Invalid Date');
    expect(new Date(result.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(result.startedAt).getTime(),
    );
  });
});
