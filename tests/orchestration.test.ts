import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { OperationStore } from '../src/core/operation-store.js';
import { TaskStore } from '../src/core/task-store.js';
import type { LoggedRunResult } from '../src/core/process-runner.js';
import type { TaskItem } from '../src/schemas/task-schema.js';

// 编排核心闭环测试（spec-chief-orchestration，issue 01-04）。
// 唯一 seam = FactoryApplication.runAgent：测试用 vi.spyOn 注入假 runAgent（返回带 stdoutFile
// 的 LoggedRunResult），worker/Chief 均不真正 spawn。规划门脏审计、派发、审查门、拆解、顶层
// orchestrate 全部在真实 FactoryApplication + 落盘 TaskStore 上验证。

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

function now(): string {
  return new Date().toISOString();
}

async function setupApp() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-orch-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  await app.initialize();
  await app.createAgent({
    id: 'chief',
    name: '主管',
    runtime: 'claude',
    preset: 'user-operations',
    feishu: 'disabled',
    role: 'chief',
  });
  await app.createAgent({
    id: 'worker-a',
    name: '员工 A',
    runtime: 'claude',
    preset: 'user-operations',
    feishu: 'disabled',
  });
  await app.createAgent({
    id: 'worker-b',
    name: '员工 B',
    runtime: 'claude',
    preset: 'user-operations',
    feishu: 'disabled',
  });
  return { root, paths, app };
}

// 构造一个假 runAgent 结果：把 stdout 内容写入临时 stdoutFile，返回 LoggedRunResult。
function fakeResult(stdout: string): LoggedRunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-orch-stdout-'));
  roots.push(dir);
  const stdoutFile = path.join(dir, 'stdout.log');
  fs.writeFileSync(stdoutFile, stdout);
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    logDir: dir,
    stdoutFile,
    stderrFile: path.join(dir, 'stderr.log'),
    metadataFile: path.join(dir, 'metadata.json'),
    startedAt: now(),
    finishedAt: now(),
  };
}

// Chief 拆解/评审走 claude provider，stdout 须为 `{"result":"<JSON 字符串>"}`。
function claudeResult(text: string): LoggedRunResult {
  return fakeResult(JSON.stringify({ result: text }));
}

// runTaskPlan 现返回 OperationDto（后台派发）；此助手走完整同步视角：发起 → 等终态 → 取最终计划。
async function runPlan(
  app: FactoryApplication,
  ownerId: string,
  planId: string,
  options?: { concurrency?: number },
): Promise<Awaited<ReturnType<typeof app.getTaskPlan>>> {
  const operation = await app.runTaskPlan(ownerId, planId, options);
  await app.waitOperation(operation.id);
  return app.getTaskPlan(ownerId, planId);
}

// 通用 mock runAgent：按 task 签名路由到 planning/review/decompose/developing。
// onPlanning 可在规划阶段插入副作用（如脏写工作区）以测脏审计。
function mockRunAgent(
  app: FactoryApplication,
  opts: {
    devExitCode?: (id: string) => number;
    reviewText?: string;
    decomposeText?: string;
    onPlanning?: (id: string) => void;
  } = {},
) {
  vi.spyOn(app, 'runAgent').mockImplementation(async (id, task) => {
    if (task.includes('交叉审查')) {
      return claudeResult(opts.reviewText ?? '{"verdict":"approved","note":"符合预期"}');
    }
    if (task.includes('拆解')) {
      return claudeResult(opts.decomposeText ?? '[]');
    }
    if (task.includes('规划阶段')) {
      opts.onPlanning?.(id);
      return fakeResult('计划：分两步完成。');
    }
    // developing 实际执行
    const exitCode = opts.devExitCode?.(id) ?? 0;
    return { ...fakeResult('完成。'), exitCode };
  });
}

async function makeActivePlan(app: FactoryApplication, items: TaskItem[]): Promise<string> {
  const planId = 'plan-1';
  await app.createTaskPlan('chief', { id: planId, name: '示例计划' });
  for (const item of items) {
    await app.addTaskItem('chief', planId, {
      id: item.id,
      title: item.title,
      agent: item.agent,
      prompt: item.prompt,
      ...(item.dependencies && item.dependencies.length > 0
        ? { dependencies: item.dependencies }
        : {}),
    });
  }
  await app.confirmPlan('chief', planId);
  return planId;
}

describe('TaskStore 扩展 (addItem/updateItem/setPlanStatus)', () => {
  it('addItem appends a pending item with timestamps; conflicting id throws', async () => {
    const { app } = await setupApp();
    const planId = await makeActivePlan(app, []);
    const store = new TaskStore(path.join(app.paths.workspaceRoot, 'chief'));
    expect((await store.get(planId)).items).toHaveLength(0);

    await app.addTaskItem('chief', planId, {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
    });
    const item = (await store.get(planId)).items[0]!;
    expect(item.status).toBe('pending');
    expect(item.created_at).toBeTruthy();
    expect(item.finished_at).toBeNull();

    await expect(
      app.addTaskItem('chief', planId, { id: 't1', title: '重名', agent: 'worker-a', prompt: 'x' }),
    ).rejects.toThrow('已存在');
  });

  it('updateItem edits editable fields without changing status; rejects terminal items', async () => {
    const { app } = await setupApp();
    const store = new TaskStore(path.join(app.paths.workspaceRoot, 'chief'));
    const planId = await makeActivePlan(app, []);
    await app.addTaskItem('chief', planId, {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
    });

    const updated = await store.updateItem(planId, 't1', { title: '新标题' });
    expect(updated.items[0]?.title).toBe('新标题');
    expect(updated.items[0]?.status).toBe('pending');

    // 终态项拒绝编辑
    await store.transitionItem(planId, 't1', 'cancelled');
    await expect(store.updateItem(planId, 't1', { title: '终态' })).rejects.toThrow('不可编辑');
  });

  it('setPlanStatus enforces the draft→active→cancelled table', async () => {
    const { app } = await setupApp();
    const store = new TaskStore(path.join(app.paths.workspaceRoot, 'chief'));
    const planId = await makeActivePlan(app, []);
    // makeActivePlan 已 confirm → active；active 不能回 draft
    await expect(store.setPlanStatus(planId, 'draft')).rejects.toThrow('非法计划状态转移');
    await store.setPlanStatus(planId, 'cancelled');
    expect((await store.get(planId)).status).toBe('cancelled');
    // cancelled 无出边
    await expect(store.setPlanStatus(planId, 'active')).rejects.toThrow('非法计划状态转移');
  });
});

describe('FactoryApplication 编排动作 (create/add/confirm/reject)', () => {
  it('createTaskPlan starts as draft; confirm→active; reject also cancels an active plan', async () => {
    const { app } = await setupApp();
    const planId = 'plan-x';
    await app.createTaskPlan('chief', { id: planId, name: '计划 X' });
    expect((await app.getTaskPlan('chief', planId)).status).toBe('draft');

    await app.confirmPlan('chief', planId);
    expect((await app.getTaskPlan('chief', planId)).status).toBe('active');

    // active 计划也可取消（rejectPlan 走 setPlanStatus active→cancelled）
    await app.rejectPlan('chief', planId);
    expect((await app.getTaskPlan('chief', planId)).status).toBe('cancelled');
    // 终态 cancelled 无出边：不能重新 confirm
    await expect(app.confirmPlan('chief', planId)).rejects.toThrow('非法计划状态转移');
  });

  it('rejectPlan on a draft cancels it (with optional note)', async () => {
    const { app } = await setupApp();
    await app.createTaskPlan('chief', { id: 'plan-y', name: '计划 Y' });
    await app.rejectPlan('chief', 'plan-y', '方向不对，重定目标');
    const plan = await app.getTaskPlan('chief', 'plan-y');
    expect(plan.status).toBe('cancelled');
    expect(plan.note).toBe('方向不对，重定目标');
    // cancelled 计划不可 run
    await expect(app.runTaskPlan('chief', 'plan-y')).rejects.toThrow('计划未确认');
  });

  it('addTaskItem validates the executing agent exists', async () => {
    const { app } = await setupApp();
    const planId = await makeActivePlan(app, []);
    await expect(
      app.addTaskItem('chief', planId, {
        id: 't1',
        title: 'x',
        agent: 'ghost',
        prompt: 'p',
      }),
    ).rejects.toThrow('Agent 不存在：ghost');
  });
});

describe('runTaskPlan 派发 (serial/concurrency/deps/skip/fail)', () => {
  it('runs a single item through planning→developing→awaiting_review', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const item: TaskItem = {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
      status: 'pending',
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    };
    const planId = await makeActivePlan(app, [item]);
    const plan = await runPlan(app, 'chief', planId);
    expect(plan.items[0]?.status).toBe('awaiting_review');
    expect(plan.items[0]?.exit_code).toBe(0);
  });

  it('blocks a dependent item until its dependency completes', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const items: TaskItem[] = [
      {
        id: 'a',
        title: 'A',
        agent: 'worker-a',
        prompt: '执行 A',
        status: 'pending',
        dependencies: [],
        created_at: now(),
        updated_at: now(),
        finished_at: null,
      },
      {
        id: 'b',
        title: 'B',
        agent: 'worker-b',
        prompt: '执行 B',
        status: 'pending',
        dependencies: ['a'],
        created_at: now(),
        updated_at: now(),
        finished_at: null,
      },
    ];
    const planId = await makeActivePlan(app, items);
    const plan = await runPlan(app, 'chief', planId);
    expect(plan.items.find((i) => i.id === 'a')?.status).toBe('awaiting_review');
    // b 依赖 a，a 未到 completed 前 b 不启动
    expect(plan.items.find((i) => i.id === 'b')?.status).toBe('pending');
  });

  it('marks a failed item failed (terminal) and does not block its sibling', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, { devExitCode: (id) => (id === 'worker-a' ? 1 : 0) });
    const items: TaskItem[] = ['a', 'b'].map((id) => ({
      id,
      title: id,
      agent: id === 'a' ? 'worker-a' : 'worker-b',
      prompt: `执行 ${id}`,
      status: 'pending' as const,
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    }));
    const planId = await makeActivePlan(app, items);
    const plan = await runPlan(app, 'chief', planId);
    expect(plan.items.find((i) => i.id === 'a')?.status).toBe('failed');
    expect(plan.items.find((i) => i.id === 'b')?.status).toBe('awaiting_review');
  });

  it('runs concurrently within a wave and advances all items', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const items: TaskItem[] = ['w1', 'w2', 'w3'].map((id, idx) => ({
      id,
      title: id,
      agent: idx === 2 ? 'worker-b' : 'worker-a',
      prompt: `执行 ${id}`,
      status: 'pending' as const,
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    }));
    const planId = await makeActivePlan(app, items);
    const plan = await runPlan(app, 'chief', planId, { concurrency: 8 });
    for (const item of plan.items) expect(item.status).toBe('awaiting_review');
  });

  it('runs independent workers genuinely in parallel within a wave (not serialized)', async () => {
    const { app } = await setupApp();
    // developing 执行阶段用共享闸门：两个 worker 都进入后才放行。若被计划锁串行化，二者不会
    // 同时阻塞在闸门上（maxActive 恒为 1）；真正并发则 maxActive === 2。
    let active = 0;
    let maxActive = 0;
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    vi.spyOn(app, 'runAgent').mockImplementation(async (id, task) => {
      if (task.includes('规划阶段')) return fakeResult('计划');
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { ...fakeResult('完成。'), exitCode: 0 };
    });
    const items: TaskItem[] = [
      { id: 'w1', agent: 'worker-a' },
      { id: 'w2', agent: 'worker-b' },
    ].map((base) => ({
      id: base.id,
      title: base.id,
      agent: base.agent,
      prompt: `执行 ${base.id}`,
      status: 'pending' as const,
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    }));
    const planId = await makeActivePlan(app, items);
    const operation = await app.runTaskPlan('chief', planId, { concurrency: 2 });
    // 等两个 worker 都进入 developing 并发窗口（阻塞在闸门上）再放行。
    await vi.waitFor(() => expect(active).toBe(2), { timeout: 5000 });
    releaseAll();
    await app.waitOperation(operation.id);
    expect(maxActive).toBe(2);
  });

  it('reconciles orphaned in-flight items to failed on run (restart recovery)', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const planId = await makeActivePlan(app, []);
    await app.addTaskItem('chief', planId, {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
    });
    // 模拟编排器中断：把 t1 人为推进到 developing（孤儿在途态）。
    const store = new TaskStore(path.join(app.paths.workspaceRoot, 'chief'));
    for (const to of ['queued', 'planning', 'awaiting_confirmation', 'developing']) {
      await store.transitionItem(planId, 't1', to as never);
    }
    // runTaskPlan 开头 reconcile：孤儿 developing → failed，随后跳过（终态）。
    const plan = await runPlan(app, 'chief', planId);
    const item = plan.items.find((i) => i.id === 't1')!;
    expect(item.status).toBe('failed');
    expect(item.review?.note).toContain('孤儿');
  });
});

describe('规划门脏审计 (T02)', () => {
  it('fails the item when planning phase mutates the worker workspace', async () => {
    const { app, paths } = await setupApp();
    const workerWs = path.join(paths.workspaceRoot, 'worker-a');
    mockRunAgent(app, {
      onPlanning: (id) => {
        if (id === 'worker-a') {
          fs.writeFileSync(path.join(workerWs, 'planning-dirty.txt'), '违反只读');
        }
      },
    });
    const item: TaskItem = {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
      status: 'pending',
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    };
    const planId = await makeActivePlan(app, [item]);
    const plan = await runPlan(app, 'chief', planId);
    expect(plan.items[0]?.status).toBe('failed');
    expect(plan.items[0]?.review?.verdict).toBe('rejected');
  });

  it('does not dirty-audit-fail when planning leaves the workspace untouched', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const item: TaskItem = {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
      status: 'pending',
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    };
    const planId = await makeActivePlan(app, [item]);
    const plan = await runPlan(app, 'chief', planId);
    expect(plan.items[0]?.status).toBe('awaiting_review');
  });
});

describe('审查门 (T03, D-017 单向搬运)', () => {
  it('reads worker diff + result, redacts secrets, writes Chief verdict', async () => {
    const { app, paths } = await setupApp();
    mockRunAgent(app, { reviewText: '{"verdict":"approved","note":"很好"}' });
    const workerWs = path.join(paths.workspaceRoot, 'worker-a');
    // 在 worker 工作区制造一个未提交变更，供审查门读 diff。
    fs.writeFileSync(
      path.join(workerWs, 'README.md'),
      '# 改动\nsecret=sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ\n',
    );

    const item: TaskItem = {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
      status: 'pending',
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    };
    const planId = await makeActivePlan(app, [item]);
    await runPlan(app, 'chief', planId);
    const reviewed = await app.reviewTaskPlan('chief', 'chief', planId);
    expect(reviewed.items[0]?.review).toEqual({ verdict: 'approved', note: '很好' });
    // 审查后仍停留 awaiting_review（待人工确认合并）
    expect(reviewed.items[0]?.status).toBe('awaiting_review');
  });

  it('falls back to rejected when review output is unparseable', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, { reviewText: '不是 JSON' });
    const item: TaskItem = {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
      status: 'pending',
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    };
    const planId = await makeActivePlan(app, [item]);
    await runPlan(app, 'chief', planId);
    const reviewed = await app.reviewTaskPlan('chief', 'chief', planId);
    expect(reviewed.items[0]?.review?.verdict).toBe('rejected');
  });

  it('confirmReview merges → completed; rejectReview returns to developing', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const items: TaskItem[] = ['t1', 't2'].map((id, idx) => ({
      id,
      title: id,
      agent: idx === 0 ? 'worker-a' : 'worker-b',
      prompt: `执行 ${id}`,
      status: 'pending' as const,
      dependencies: [],
      created_at: now(),
      updated_at: now(),
      finished_at: null,
    }));
    const planId = await makeActivePlan(app, items);
    await runPlan(app, 'chief', planId);
    await app.reviewTaskPlan('chief', 'chief', planId);

    const merged = await app.confirmReview('chief', planId, 't1');
    expect(merged.items.find((i) => i.id === 't1')?.status).toBe('completed');

    // 对另一项驳回返工 → developing
    const reworked = await app.rejectReview('chief', planId, 't2', '需要返工');
    expect(reworked.items.find((i) => i.id === 't2')?.status).toBe('developing');
    expect(reworked.items.find((i) => i.id === 't2')?.review).toEqual({
      verdict: 'rejected',
      note: '需要返工',
    });
  });
});

describe('planWithChief 拆解', () => {
  it('creates items from Chief decompose output and reports source chief', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, {
      decomposeText: JSON.stringify([
        { title: '任务一', agent: 'worker-a', prompt: '执行 A' },
        { title: '任务二', agent: 'worker-b', prompt: '执行 B', dependencies: ['item-1'] },
        { title: '幽灵任务', agent: 'ghost', prompt: '跳过未知员工' },
      ]),
    });
    const { plan, source } = await app.planWithChief('chief', '建一个网站');
    expect(source).toBe('chief');
    expect(plan.items.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    expect(plan.items.find((i) => i.id === 'item-2')?.dependencies).toEqual(['item-1']);
    // 未知员工被跳过
    expect(plan.items.some((i) => i.agent === 'ghost')).toBe(false);
  });

  it('falls back to an editable empty plan on unparseable decompose output', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, { decomposeText: '乱码' });
    const { plan, source } = await app.planWithChief('chief', '随便做点什么');
    expect(source).toBe('manual-fallback');
    expect(plan.items).toHaveLength(0);
    expect(plan.status).toBe('draft');
  });
});

describe('orchestrate 顶层一句话闭环', () => {
  it('runs decompose → confirm → dispatch → cross-review end to end', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, {
      decomposeText: JSON.stringify([{ title: '任务一', agent: 'worker-a', prompt: '执行 A' }]),
      reviewText: '{"verdict":"approved","note":"通过"}',
    });
    const { plan, source, confirmed } = await app.orchestrate('chief', '实现一个功能', {
      concurrency: 2,
    });
    expect(source).toBe('chief');
    expect(confirmed).toBe(true);
    expect(plan.items[0]?.status).toBe('awaiting_review');
    expect(plan.items[0]?.review).toEqual({ verdict: 'approved', note: '通过' });
  });

  it('stops at the confirmation gate when confirm returns false', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, {
      decomposeText: JSON.stringify([{ title: '任务一', agent: 'worker-a', prompt: '执行 A' }]),
    });
    const { plan, confirmed } = await app.orchestrate('chief', '先不确认', {
      confirm: async () => false,
    });
    expect(confirmed).toBe(false);
    // 拆解已落盘任务项，但计划停在 draft 确认门，未派发
    expect(plan.status).toBe('draft');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.status).toBe('pending');
  });
});

describe('编排 Operation 可观测性 (spec user story 16)', () => {
  it('runTaskPlan 返回 OperationDto 并注册进 OperationManager（可查/可等）', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const planId = await makeActivePlan(app, [
      { id: 't1', title: '任务一', agent: 'worker-a', prompt: '执行', status: 'pending' as const },
    ]);
    const operation = await app.runTaskPlan('chief', planId);
    expect(operation.id).toBeTruthy();
    expect(operation.type).toBe('task_plan');
    expect(operation.agentId).toBe('chief');
    expect(operation.state).toBe('queued'); // 后台派发，立即返回排队态

    // 同一实例可查、可等终态
    await app.waitOperation(operation.id);
    const after = app.operationManager.get(operation.id);
    expect(after.state).toBe('succeeded');
    expect(app.operationManager.list().some((op) => op.id === operation.id)).toBe(true);
    // 派发结果仍可经原本的 getTaskPlan 取回
    const plan = await app.getTaskPlan('chief', planId);
    expect(plan.items[0]?.status).toBe('awaiting_review');
  });

  it('编排派发落盘一条 operation 摘要到 OperationStore（可审计）', async () => {
    const { app } = await setupApp();
    mockRunAgent(app);
    const planId = await makeActivePlan(app, [
      { id: 't1', title: '任务一', agent: 'worker-a', prompt: '执行', status: 'pending' as const },
    ]);
    const operation = await app.runTaskPlan('chief', planId);
    await app.waitOperation(operation.id);

    const summaries = await new OperationStore(app.paths.logsDir).query({ kind: 'task_plan' });
    const record = summaries.find((s) => s.operation_id === operation.id);
    expect(record).toBeTruthy();
    expect(record?.agent_id).toBe('chief');
    expect(record?.exit_code).toBe(0);
  });

  it('orchestrate 返回 operation 句柄（confirmed 时）', async () => {
    const { app } = await setupApp();
    mockRunAgent(app, {
      decomposeText: JSON.stringify([{ title: '任务一', agent: 'worker-a', prompt: '执行 A' }]),
      reviewText: '{"verdict":"approved","note":"通过"}',
    });
    const result = await app.orchestrate('chief', '实现一个功能');
    expect(result.confirmed).toBe(true);
    expect(result.operation?.type).toBe('task_plan');
    expect(result.operation?.state).toBe('succeeded');
  });

  it('把父 task_plan 的 traceId 穿给各 worker 的 runAgent（observability 关联）', async () => {
    const { app } = await setupApp();
    const workerTraceIds: string[] = [];
    vi.spyOn(app, 'runAgent').mockImplementation(async (id, task, _timeout, options) => {
      if (!task.includes('规划阶段')) workerTraceIds.push(options?.traceId ?? '');
      return { ...fakeResult('完成。'), exitCode: 0 };
    });
    const planId = await makeActivePlan(app, [
      { id: 't1', title: '任务一', agent: 'worker-a', prompt: '执行', status: 'pending' as const },
      { id: 't2', title: '任务二', agent: 'worker-b', prompt: '执行', status: 'pending' as const },
    ]);
    const operation = await app.runTaskPlan('chief', planId);
    await app.waitOperation(operation.id);

    expect(workerTraceIds.length).toBeGreaterThan(0);
    // 每个 worker 的 developing 运行都沿用父操作 trace（而非各自随机 trace）
    expect(workerTraceIds.every((t) => t === operation.traceId)).toBe(true);
  });

  it('cancel(id) 取消运行中的派发，waitOperation 抛 CANCELLED', async () => {
    const { app } = await setupApp();
    let releaseAll!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    vi.spyOn(app, 'runAgent').mockImplementation(async (id, task) => {
      if (task.includes('规划阶段')) return fakeResult('计划');
      await gate; // 阻塞在 developing 并发窗口，模拟进行中
      return { ...fakeResult('完成。'), exitCode: 0 };
    });
    const planId = await makeActivePlan(app, [
      { id: 't1', title: '任务一', agent: 'worker-a', prompt: '执行', status: 'pending' as const },
    ]);
    const operation = await app.runTaskPlan('chief', planId);
    await vi.waitFor(() => expect(app.operationManager.get(operation.id).state).toBe('running'), {
      timeout: 5000,
    });
    app.operationManager.cancel(operation.id);
    releaseAll();
    await expect(app.waitOperation(operation.id)).rejects.toThrow('已取消');
    expect(app.operationManager.get(operation.id).state).toBe('cancelled');
  });
});
