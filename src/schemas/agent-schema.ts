import path from 'node:path';
import { z } from 'zod';

export const agentIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Agent ID 只允许小写字母、数字和单个短横线分隔。');

export const portableRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      if (path.isAbsolute(value)) return false;
      const normalized = path.normalize(value);
      return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
    },
    { message: '必须是不包含路径穿越的相对路径。' },
  );

export const runtimeProviderSchema = z.enum(['claude', 'codex']);

export const agentConfigSchema = z.object({
  schema_version: z.literal(1),
  id: agentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  runtime: z.object({
    provider: runtimeProviderSchema,
    locked: z.literal(true),
    model: z.string().min(1).optional(),
  }),
  identity: z.object({
    role_file: portableRelativePathSchema,
    goals_file: portableRelativePathSchema,
    operating_system_file: portableRelativePathSchema,
    policies_file: portableRelativePathSchema,
    current_state_file: portableRelativePathSchema,
  }),
  memory: z.object({
    isolation: z.literal('strict'),
    native_memory: z.boolean(),
    portable_memory: z.boolean(),
    authority_order: z.array(
      z.enum(['agent', 'knowledge', 'decisions', 'skills', 'native_memory', 'session']),
    ),
  }),
  feishu: z.object({
    enabled: z.boolean(),
    mode: z.enum(['dedicated_bot', 'disabled']),
    bridge_profile: agentIdSchema.optional(),
  }),
  permissions: z.object({
    level: z.literal('workspace'),
    production_write: z.literal('approval_required'),
    external_publish: z.literal('approval_required'),
  }),
  lifecycle: z.object({
    status: z.enum(['active', 'archived']),
    created_at: z.string().datetime(),
    archived_at: z.string().datetime().nullable(),
  }),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;
