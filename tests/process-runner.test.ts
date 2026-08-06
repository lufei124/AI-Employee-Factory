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

  it('parses structured usage into metadata.json and result when enabled (OP4-C)', async () => {
    const { runner } = await setup();
    const claudeCtx: ExecutionContext = {
      operation: 'run',
      command: process.execPath,
      args: [
        '-e',
        'console.log(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01 }))',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    };
    const result = await runner.runLogged('agent-1', claudeCtx, {
      mirror: false,
      provider: 'claude',
      structured: true,
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 });
    const meta = await fs.readJson(result.metadataFile);
    expect(meta.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01 });
  });

  it('omits usage when structured not enabled (backward compatible)', async () => {
    const { runner } = await setup();
    const result = await runner.runLogged('agent-1', context(), { mirror: false });
    expect(result.usage).toBeUndefined();
    const meta = await fs.readJson(result.metadataFile);
    expect(meta).not.toHaveProperty('usage');
  });

  // D-035：runLogged 支持显式 stdin——飞书 bridge 逐消息把 prompt 喂给真实 claude。
  it('forwards stdin to the child when provided (D-035)', async () => {
    const { runner } = await setup();
    const echoCtx: ExecutionContext = {
      operation: 'run',
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', d => process.stdout.write('echo:' + d))"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
    };
    const result = await runner.runLogged('agent-1', echoCtx, {
      mirror: false,
      stdin: 'hello-stdin',
    });
    expect(result.exitCode).toBe(0);
    const stdout = await fs.readFile(result.stdoutFile, 'utf8');
    expect(stdout).toContain('echo:hello-stdin');
  });
});
