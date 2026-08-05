import { z } from 'zod';
import { agentIdSchema, portableRelativePathSchema } from './agent-schema.js';

const executionBase = {
  timeout_seconds: z.number().int().positive().max(86_400).default(900),
  concurrency: z.literal('forbid').default('forbid'),
};

const precheckSchema = z.object({
  script_file: portableRelativePathSchema,
  interpreter: z.enum(['node', 'bash', 'direct']).default('node'),
  args: z.array(z.string()).default([]),
  no_data_exit_code: z.number().int().min(1).max(255).default(3),
});

export const jobConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  id: agentIdSchema,
  enabled: z.boolean(),
  // D-028：任务来源。employee = 员工自我配置（任务后自动 reconcile 调度）；缺省 admin。
  managed_by: z.enum(['admin', 'employee']).default('admin'),
  schedule: z.object({
    type: z.literal('daily'),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间必须使用 HH:mm。'),
  }),
  execution: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('script'),
      script_file: portableRelativePathSchema,
      interpreter: z.enum(['node', 'bash', 'direct']).default('node'),
      args: z.array(z.string()).default([]),
      ...executionBase,
    }),
    z.object({
      type: z.literal('agent'),
      prompt_file: portableRelativePathSchema,
      precheck: precheckSchema.optional(),
      ...executionBase,
    }),
  ]),
});

export type JobConfig = z.infer<typeof jobConfigSchema>;
