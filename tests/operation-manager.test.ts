import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import { OperationStore } from '../src/core/operation-store.js';
import type { ObservabilitySink, Span, SpanAttrs } from '../src/core/observability.js';
import { OperationManager } from '../src/web/operation-manager.js';

class RecordingSink implements ObservabilitySink {
  readonly spans: {
    name: string;
    attrs: SpanAttrs;
    ended: boolean;
    endAttrs?: Partial<SpanAttrs>;
  }[] = [];
  spanStart(name: string, attrs: SpanAttrs): Span {
    const record = {
      name,
      attrs,
      ended: false,
      endAttrs: undefined as Partial<SpanAttrs> | undefined,
    };
    this.spans.push(record);
    return {
      end: (endAttrs?: Partial<SpanAttrs>) => {
        record.ended = true;
        record.endAttrs = endAttrs;
      },
    };
  }
}

describe('OperationManager', () => {
  it('records progress and a successful terminal state without storing task inputs', async () => {
    const manager = new OperationManager();
    const operation = manager.start('doctor', 'user-operations', async ({ emit }) => {
      emit({ kind: 'progress', progress: 50, message: '检查中' });
      return { exitCode: 0 };
    });

    await manager.wait(operation.id);
    expect(manager.get(operation.id)).toMatchObject({
      id: operation.id,
      type: 'doctor',
      agentId: 'user-operations',
      state: 'succeeded',
      progress: 100,
      exitCode: 0,
    });
    expect(manager.events(operation.id).map((event) => event.kind)).toContain('progress');
    expect(JSON.stringify(manager.get(operation.id))).not.toContain('检查中');
  });

  it('maps domain failures to a stable API error', async () => {
    const manager = new OperationManager();
    const operation = manager.start('backup', 'ops', async () => {
      throw new AgentCtlError('CONFLICT', '目标已存在', { remediation: '换一个 ID' });
    });

    await manager.wait(operation.id);
    expect(manager.get(operation.id)).toMatchObject({
      state: 'failed',
      error: {
        code: 'CONFLICT',
        message: '目标已存在',
        exitCode: 4,
        remediation: '换一个 ID',
      },
    });
  });

  it('aborts running work on shutdown and retains at most 200 operations', async () => {
    const manager = new OperationManager({ maxOperations: 200 });
    const blocked = manager.start('run', 'ops', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      return { exitCode: 130 };
    });
    manager.cancelAll();
    await manager.wait(blocked.id);
    expect(manager.get(blocked.id).state).toBe('cancelled');

    for (let index = 0; index < 201; index += 1) {
      const operation = manager.start('doctor', undefined, async () => ({ exitCode: 0 }));
      await manager.wait(operation.id);
    }
    expect(manager.list()).toHaveLength(200);
  });

  it('retains only the configured tail of operation events', async () => {
    const manager = new OperationManager({ maxEventsPerOperation: 3 });
    const operation = manager.start('run', 'ops', async ({ emit }) => {
      for (let index = 1; index <= 5; index += 1) {
        emit({ kind: 'output', message: `line-${index}` });
      }
    });

    await manager.wait(operation.id);
    expect(manager.events(operation.id)).toHaveLength(3);
    expect(manager.events(operation.id).map((event) => event.message)).toEqual([
      'line-4',
      'line-5',
      'succeeded',
    ]);
  });

  it('persists terminal-state summaries to an injected OperationStore (OP4-A)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-opmgr-'));
    try {
      const store = new OperationStore(path.join(root, 'logs'));
      const manager = new OperationManager({ store });

      const succeeded = manager.start('chat', 'user-operations', async () => ({ exitCode: 0 }));
      await manager.wait(succeeded.id);

      const failed = manager.start('run', 'ops', async () => {
        throw new AgentCtlError('CONFLICT', 'leaked sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ');
      });
      await manager.wait(failed.id);

      let releaseStart!: () => void;
      const started = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const cancelled = manager.start('doctor', undefined, async ({ signal }) => {
        releaseStart();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return { exitCode: 130 };
      });
      await started; // 确保任务进入 running（startedAt 已写入）再取消，避免走「未启动即取消」分支
      manager.cancelAll();
      await manager.wait(cancelled.id);

      const summaries = await store.query({ limit: 10 });
      expect(summaries).toHaveLength(3);
      expect(summaries.find((s) => s.operation_id === succeeded.id)).toMatchObject({
        kind: 'chat',
        agent_id: 'user-operations',
        exit_code: 0,
      });
      expect(summaries.find((s) => s.operation_id === failed.id)).toMatchObject({
        kind: 'run',
        agent_id: 'ops',
        exit_code: 4,
      });
      expect(summaries.find((s) => s.operation_id === failed.id)?.error_summary).not.toContain(
        'sk-abcdef',
      );
      expect(summaries.find((s) => s.operation_id === cancelled.id)).toMatchObject({
        kind: 'doctor',
        exit_code: 130,
      });
    } finally {
      await fs.remove(root);
    }
  });

  it('does not error when no OperationStore is injected (OP4-A backward compat)', async () => {
    const manager = new OperationManager();
    const operation = manager.start('doctor', undefined, async () => ({ exitCode: 0 }));
    await manager.wait(operation.id);
    expect(manager.get(operation.id).state).toBe('succeeded');
  });

  it('generates traceId, threads operationId/traceId to task context, and persists trace_id (OP4-B)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-opmgr-trace-'));
    try {
      const store = new OperationStore(path.join(root, 'logs'));
      const manager = new OperationManager({ store });
      let captured!: { operationId: string; traceId: string };
      const operation = manager.start('run', 'ops', async (ctx) => {
        captured = { operationId: ctx.operationId, traceId: ctx.traceId };
        return { exitCode: 0 };
      });
      expect(operation.traceId).toEqual(expect.any(String));
      await manager.wait(operation.id);
      expect(captured.operationId).toBe(operation.id);
      expect(captured.traceId).toBe(operation.traceId);
      const [summary] = await store.query({ limit: 1 });
      expect(summary?.trace_id).toBe(operation.traceId);
    } finally {
      await fs.remove(root);
    }
  });

  it('wraps execution in an injected ObservabilitySink span (OP4-B)', async () => {
    const sink = new RecordingSink();
    const manager = new OperationManager({ sink });
    const operation = manager.start('doctor', 'ops', async () => ({ exitCode: 0 }));
    await manager.wait(operation.id);
    expect(sink.spans).toHaveLength(1);
    expect(sink.spans[0]!.name).toBe('operation');
    expect(sink.spans[0]!.attrs).toMatchObject({
      operation_id: operation.id,
      kind: 'doctor',
      trace_id: operation.traceId,
      agent_id: 'ops',
    });
    expect(sink.spans[0]!.ended).toBe(true);
  });

  it('reports task usage as gen_ai.* span attrs on end (OP4-C)', async () => {
    const sink = new RecordingSink();
    const manager = new OperationManager({ sink });
    const operation = manager.start('run', 'ops', async () => ({
      exitCode: 0,
      usage: { inputTokens: 100, outputTokens: 20, model: 'claude-opus-4-8', totalCostUsd: 0.5 },
    }));
    await manager.wait(operation.id);
    expect(sink.spans[0]!.endAttrs).toMatchObject({
      'gen_ai.request.model': 'claude-opus-4-8',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cost_usd': 0.5,
    });
  });

  it('emits no gen_ai attrs when the task has no usage (OP4-C backward compatible)', async () => {
    const sink = new RecordingSink();
    const manager = new OperationManager({ sink });
    const operation = manager.start('doctor', 'ops', async () => ({ exitCode: 0 }));
    await manager.wait(operation.id);
    expect(sink.spans[0]!.endAttrs).toEqual({});
  });
});
