import { z } from 'zod';
import { agentIdSchema, portableRelativePathSchema } from './agent-schema.js';

// T04（Chief 编排底座）：Todo 任务状态机（7+2 态）。
// 主跑道：pending → queued → planning → awaiting_confirmation → developing → awaiting_review → completed。
// 外加终止态 failed / cancelled。schema 为 source of truth，task-store.ts 镜像复用。
export const TASK_ITEM_STATES = [
  'pending',
  'queued',
  'planning',
  'awaiting_confirmation',
  'developing',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskItemState = (typeof TASK_ITEM_STATES)[number];

// 合法状态转移表。终止态（completed/failed/cancelled）无出边。
// - planning/dev 阶段可被中断标记为 failed（编排器死亡/孤儿 reconcile）。
// - awaiting_confirmation 可回退到 developing（改计划重审）或 cancelled（人类否决）。
// - awaiting_review 可回退到 developing（Chief 打回返工）。
export const TASK_ITEM_TRANSITIONS: Record<TaskItemState, readonly TaskItemState[]> = {
  pending: ['queued', 'cancelled'],
  queued: ['planning', 'failed', 'cancelled'],
  planning: ['awaiting_confirmation', 'failed', 'cancelled'],
  awaiting_confirmation: ['developing', 'failed', 'cancelled'],
  developing: ['awaiting_review', 'failed', 'cancelled'],
  awaiting_review: ['completed', 'developing', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

// 纯函数：判定 from→to 是否合法转移。
export function canTransition(from: TaskItemState, to: TaskItemState): boolean {
  return TASK_ITEM_TRANSITIONS[from].includes(to);
}

export const taskItemSchema = z.object({
  id: agentIdSchema,
  title: z.string().min(1),
  // 执行员工 id（worker）。任务项由该员工在其自有 repo 中执行。
  agent: agentIdSchema,
  prompt: z.string().min(1),
  status: z.enum(TASK_ITEM_STATES),
  // 依赖的任务项 id（本计划内）。语义：全部依赖 completed 后才可进入 developing。
  dependencies: z.array(agentIdSchema).default([]),
  // 执行结果（worker 进程退出码）。
  exit_code: z.number().int().optional(),
  // 产物引用（相对员工 workspace 的路径，如 diff 工件/结论文件）。
  artifact: portableRelativePathSchema.optional(),
  // Chief 交叉审查结论（单向搬运，D-017）。
  review: z
    .object({
      verdict: z.enum(['approved', 'rejected']),
      note: z.string().optional(),
    })
    .optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
});

export type TaskItem = z.infer<typeof taskItemSchema>;

export const taskPlanSchema = z.object({
  schema_version: z.literal(1).default(1),
  id: agentIdSchema,
  name: z.string().min(1),
  // 创建者（Chief 员工 id 或人工录入 id）。
  creator: agentIdSchema,
  // 计划级状态：draft（草稿，未派发）/ active（已派发）/ completed / cancelled。
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).default('draft'),
  items: z.array(taskItemSchema),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type TaskPlan = z.infer<typeof taskPlanSchema>;
