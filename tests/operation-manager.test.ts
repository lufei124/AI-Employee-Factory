import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import { OperationStore } from '../src/core/operation-store.js';
import { OperationManager } from '../src/web/operation-manager.js';

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
});
