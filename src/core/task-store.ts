import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import { assertInside } from './paths.js';
import { agentIdSchema } from '../schemas/agent-schema.js';
import {
  canTransition,
  taskPlanSchema,
  type TaskItem,
  type TaskItemState,
  type TaskPlan,
} from '../schemas/task-schema.js';

// T04：Todo 任务计划持久化 + 状态机底座（Chief 编排/Web Todo 标签页的存储层）。
// 遵循既有 JobStore 套路：YAML + 原子写 + 路径包含校验。计划存于员工工作区
// workspace/tasks/plans/<id>.yaml——与 tasks/ 根下的 BACKLOG.md/ACTIVE.md 语义区分开，
// 避免与既有工作区文件撞名。
//
// 事实来源：任务项状态只以落盘的 plan 文件为准（父操作状态不作唯一事实源）。每个状态
// 变更读改写原子落盘；重启后由 reconcile() 把在途（planning/developing）孤儿任务项标记失败。

export class TaskStore {
  readonly plansDir: string;

  constructor(readonly workspace: string) {
    this.plansDir = path.join(workspace, 'tasks', 'plans');
  }

  async list(): Promise<TaskPlan[]> {
    if (!(await fs.pathExists(this.plansDir))) return [];
    const files = (await fs.readdir(this.plansDir)).filter((file) => /\.ya?ml$/i.test(file)).sort();
    return Promise.all(files.map((file) => this.readFile(path.join(this.plansDir, file))));
  }

  async get(id: string): Promise<TaskPlan> {
    agentIdSchema.parse(id);
    const file = await this.fileFor(id);
    return this.readFile(file);
  }

  async create(input: TaskPlan): Promise<TaskPlan> {
    const parsed = taskPlanSchema.parse(input);
    await fs.ensureDir(this.plansDir);
    const target = path.join(this.plansDir, `${parsed.id}.yaml`);
    if (await fs.pathExists(target))
      throw new AgentCtlError('CONFLICT', `任务计划已存在：${parsed.id}`);
    await atomicWriteFile(target, YAML.stringify(parsed), 0o644);
    return parsed;
  }

  // 原子状态转移：把 planId 下 itemId 任务项合法地转移到 to 状态。
  // 非法转移抛 VALIDATION_ERROR（7+2 状态机约束）。可选 overrides 携带执行结果
  // （exit_code/artifact/review）；入终态时写 finished_at。
  async transitionItem(
    planId: string,
    itemId: string,
    to: TaskItemState,
    overrides: Partial<Pick<TaskItem, 'exit_code' | 'artifact' | 'review'>> = {},
  ): Promise<TaskPlan> {
    const file = await this.fileFor(planId);
    const current = taskPlanSchema.parse(YAML.parse(await fs.readFile(file, 'utf8')));
    const item = current.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new AgentCtlError('NOT_FOUND', `任务项不存在：${itemId}`);
    if (!canTransition(item.status, to)) {
      throw new AgentCtlError(
        'VALIDATION_ERROR',
        `非法状态转移：任务项 ${itemId} 不能从 ${item.status} 转到 ${to}。`,
      );
    }
    const now = new Date().toISOString();
    const nextItem: TaskItem = {
      ...item,
      status: to,
      ...(overrides.exit_code !== undefined ? { exit_code: overrides.exit_code } : {}),
      ...(overrides.artifact !== undefined ? { artifact: overrides.artifact } : {}),
      ...(overrides.review !== undefined ? { review: overrides.review } : {}),
      updated_at: now,
      finished_at: to === 'completed' || to === 'failed' || to === 'cancelled' ? now : null,
    };
    const nextItems = current.items.map((candidate) =>
      candidate.id === itemId ? nextItem : candidate,
    );
    const next: TaskPlan = {
      ...current,
      status: this.derivePlanStatus(current, nextItems),
      items: nextItems,
      updated_at: now,
    };
    await atomicWriteFile(file, YAML.stringify(next), 0o644);
    return next;
  }

  async remove(id: string): Promise<void> {
    const file = await this.fileFor(id);
    const archiveDir = path.join(this.plansDir, '.archive');
    await fs.ensureDir(archiveDir);
    await fs.move(file, path.join(archiveDir, `${id}-${Date.now()}.yaml`));
  }

  // 重启后孤儿 reconcile：在途（planning/developing）任务项没有活着的父操作（编排器随进程
  // 死亡），标记为 failed——持久化的任务项状态是唯一事实来源，不让父操作悬空欺骗 UI。
  async reconcile(): Promise<TaskPlan[]> {
    const plans = await this.list();
    const changed: TaskPlan[] = [];
    for (const plan of plans) {
      const orphans = plan.items.filter(
        (item) => item.status === 'planning' || item.status === 'developing',
      );
      if (orphans.length === 0) continue;
      let next = plan;
      for (const orphan of orphans) {
        next = await this.transitionItem(plan.id, orphan.id, 'failed', {
          review: { verdict: 'rejected', note: '编排器中断，孤儿操作被 reconcile 标记失败' },
        });
      }
      changed.push(next);
    }
    return changed;
  }

  // 计划级状态派生：全部任务项终态时收紧计划状态。cancelled 计划保持 cancelled；
  // mixed 终止（部分 failed/cancelled）保持 active 待人工决策。
  private derivePlanStatus(current: TaskPlan, nextItems: TaskItem[]): TaskPlan['status'] {
    if (current.status === 'cancelled') return current.status;
    const allTerminal = nextItems.every((item) =>
      ['completed', 'failed', 'cancelled'].includes(item.status),
    );
    if (!allTerminal) return 'active';
    const allCompleted = nextItems.every((item) => item.status === 'completed');
    return allCompleted ? 'completed' : current.status;
  }

  private async fileFor(id: string): Promise<string> {
    for (const extension of ['yaml', 'yml']) {
      const file = path.join(this.plansDir, `${id}.${extension}`);
      if (await fs.pathExists(file)) return file;
    }
    throw new AgentCtlError('NOT_FOUND', `任务计划不存在：${id}`);
  }

  private async readFile(file: string): Promise<TaskPlan> {
    const parsed = taskPlanSchema.parse(YAML.parse(await fs.readFile(file, 'utf8')));
    // 路径包含校验：计划文件必须位于员工 workspace 内。
    assertInside(this.workspace, file, '任务计划文件');
    return parsed;
  }
}
