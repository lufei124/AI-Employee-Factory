import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import { TaskStore } from '../src/core/task-store.js';
import { canTransition, type TaskPlan } from '../src/schemas/task-schema.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

function now(): string {
  return new Date().toISOString();
}

function makePlan(id: string, overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    schema_version: 1,
    id,
    name: `${id} 计划`,
    creator: 'chief',
    status: 'active',
    items: [
      {
        id: 'task-a',
        title: '任务 A',
        agent: 'worker-a',
        prompt: '执行 A',
        status: 'pending',
        dependencies: [],
        created_at: now(),
        updated_at: now(),
        finished_at: null,
      },
    ],
    created_at: now(),
    updated_at: now(),
    ...overrides,
  };
}

async function setupStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-taskstore-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  await fs.ensureDir(path.join(workspace, 'tasks'));
  return new TaskStore(workspace);
}

describe('TaskStore (T04)', () => {
  it('creates, reads, and removes a task plan with atomic persistence', async () => {
    const store = await setupStore();
    const plan = makePlan('plan-1');
    await store.create(plan);

    expect((await store.list()).map((p) => p.id)).toEqual(['plan-1']);
    expect((await store.get('plan-1')).name).toBe('plan-1 计划');

    await store.remove('plan-1');
    expect(await store.list()).toHaveLength(0);
    await expect(store.get('plan-1')).rejects.toThrow('不存在');
  });

  it('rejects duplicate plan creation', async () => {
    const store = await setupStore();
    await store.create(makePlan('dup'));
    await expect(store.create(makePlan('dup'))).rejects.toThrow('已存在');
  });

  it('walks the full legal progression through the 7-state flow', async () => {
    const store = await setupStore();
    const plan = makePlan('flow');
    await store.create(plan);

    const steps: Array<[string, string]> = [
      ['task-a', 'queued'],
      ['task-a', 'planning'],
      ['task-a', 'awaiting_confirmation'],
      ['task-a', 'developing'],
      ['task-a', 'awaiting_review'],
      ['task-a', 'completed'],
    ];
    for (const [, to] of steps) {
      await store.transitionItem('flow', 'task-a', to as never);
    }

    const item = (await store.get('flow')).items[0]!;
    expect(item.status).toBe('completed');
    expect(item.finished_at).toBeTruthy();
    // 全部完成 → 计划级 completed
    expect((await store.get('flow')).status).toBe('completed');
  });

  it('sets plan status to active when a plan has mixed terminal items', async () => {
    const store = await setupStore();
    const plan = makePlan('mixed', {
      items: [
        {
          id: 'task-a',
          title: '任务 A',
          agent: 'worker-a',
          prompt: '执行 A',
          status: 'pending',
          dependencies: [],
          created_at: now(),
          updated_at: now(),
          finished_at: null,
        },
        {
          id: 'task-b',
          title: '任务 B',
          agent: 'worker-b',
          prompt: '执行 B',
          status: 'pending',
          dependencies: [],
          created_at: now(),
          updated_at: now(),
          finished_at: null,
        },
      ],
    });
    await store.create(plan);
    for (const to of [
      'queued',
      'planning',
      'awaiting_confirmation',
      'developing',
      'awaiting_review',
    ]) {
      await store.transitionItem('mixed', 'task-a', to as never);
    }
    await store.transitionItem('mixed', 'task-a', 'completed');
    await store.transitionItem('mixed', 'task-b', 'queued');
    await store.transitionItem('mixed', 'task-b', 'failed');
    // 一个完成一个失败 → 计划保持 active（待人工决策）
    expect((await store.get('mixed')).status).toBe('active');
  });

  it('rejects an illegal transition', async () => {
    const store = await setupStore();
    await store.create(makePlan('illegal'));
    // pending → awaiting_review 非法
    await expect(store.transitionItem('illegal', 'task-a', 'awaiting_review')).rejects.toThrow(
      AgentCtlError,
    );
    await expect(store.transitionItem('illegal', 'task-a', 'awaiting_review')).rejects.toThrow(
      '非法状态转移',
    );
  });

  it('allows rework from awaiting_review back to developing, then re-approve', async () => {
    const store = await setupStore();
    await store.create(makePlan('rework'));
    for (const to of [
      'queued',
      'planning',
      'awaiting_confirmation',
      'developing',
      'awaiting_review',
    ]) {
      await store.transitionItem('rework', 'task-a', to as never);
    }
    // Chief 打回返工
    await store.transitionItem('rework', 'task-a', 'developing');
    await store.transitionItem('rework', 'task-a', 'awaiting_review');
    await store.transitionItem('rework', 'task-a', 'completed');
    expect((await store.get('rework')).items[0]?.status).toBe('completed');
  });

  it('attaches execution result and review verdict on terminal transitions', async () => {
    const store = await setupStore();
    await store.create(makePlan('result'));
    for (const to of [
      'queued',
      'planning',
      'awaiting_confirmation',
      'developing',
      'awaiting_review',
    ]) {
      await store.transitionItem('result', 'task-a', to as never);
    }
    await store.transitionItem('result', 'task-a', 'completed', {
      exit_code: 0,
      artifact: 'tasks/plans/result/diff.txt',
      review: { verdict: 'approved', note: '符合预期' },
    });
    const item = (await store.get('result')).items[0]!;
    expect(item.exit_code).toBe(0);
    expect(item.artifact).toBe('tasks/plans/result/diff.txt');
    expect(item.review).toEqual({ verdict: 'approved', note: '符合预期' });
  });

  it('reconcilies orphaned in-flight items (planning/developing) to failed on restart', async () => {
    const store = await setupStore();
    const plan = makePlan('orphan', {
      items: [
        {
          id: 'task-a',
          title: '任务 A',
          agent: 'worker-a',
          prompt: '执行 A',
          status: 'developing',
          dependencies: [],
          created_at: now(),
          updated_at: now(),
          finished_at: null,
        },
        {
          id: 'task-b',
          title: '任务 B',
          agent: 'worker-b',
          prompt: '执行 B',
          status: 'completed',
          dependencies: [],
          created_at: now(),
          updated_at: now(),
          finished_at: null,
        },
      ],
    });
    await store.create(plan);

    const changed = await store.reconcile();
    expect(changed).toHaveLength(1);
    const items = (await store.get('orphan')).items;
    expect(items.find((i) => i.id === 'task-a')?.status).toBe('failed');
    expect(items.find((i) => i.id === 'task-b')?.status).toBe('completed');
  });

  it('persists plans under tasks/plans (not colliding with BACKLOG.md/ACTIVE.md)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-taskstore-path-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    await fs.ensureDir(path.join(workspace, 'tasks'));
    await fs.writeFile(path.join(workspace, 'tasks', 'BACKLOG.md'), '# Backlog\n');
    await fs.writeFile(path.join(workspace, 'tasks', 'ACTIVE.md'), '# Active\n');

    const store = new TaskStore(workspace);
    await store.create(makePlan('path-plan'));
    const files = await fs.readdir(path.join(workspace, 'tasks', 'plans'));
    expect(files).toEqual(['path-plan.yaml']);
    // 既有文件不被触碰
    expect(await fs.readFile(path.join(workspace, 'tasks', 'BACKLOG.md'), 'utf8')).toBe(
      '# Backlog\n',
    );
  });
});

describe('canTransition (T04 状态机纯函数)', () => {
  it('accepts the legal main-track transitions', () => {
    expect(canTransition('pending', 'queued')).toBe(true);
    expect(canTransition('queued', 'planning')).toBe(true);
    expect(canTransition('planning', 'awaiting_confirmation')).toBe(true);
    expect(canTransition('awaiting_confirmation', 'developing')).toBe(true);
    expect(canTransition('developing', 'awaiting_review')).toBe(true);
    expect(canTransition('awaiting_review', 'completed')).toBe(true);
  });

  it('rejects illegal skips and terminal exits', () => {
    expect(canTransition('pending', 'developing')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('completed', 'developing')).toBe(false);
    expect(canTransition('failed', 'pending')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });

  it('allows cancellation and failure from in-flight states', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('queued', 'cancelled')).toBe(true);
    expect(canTransition('planning', 'failed')).toBe(true);
    expect(canTransition('developing', 'cancelled')).toBe(true);
  });
});
