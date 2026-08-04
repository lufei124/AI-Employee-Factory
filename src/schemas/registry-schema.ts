import { z } from 'zod';
import { agentIdSchema, runtimeProviderSchema } from './agent-schema.js';

export const registryAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  status: z.enum(['stopped', 'running', 'error', 'archived']),
  archived: z.boolean(),
  runtime: z.object({
    provider: runtimeProviderSchema,
    locked: z.literal(true),
    model: z.string().min(1).optional(),
  }),
  workspace: z.object({ path: z.string().min(1), git_repository: z.boolean() }),
  runtime_home: z.object({ path: z.string().min(1) }),
  bridge: z.object({
    enabled: z.boolean(),
    profile: agentIdSchema.optional(),
    home: z.string().min(1),
    mode: z.enum(['dedicated_bot', 'disabled']),
    authorization: z.enum(['pending', 'ready', 'error']),
  }),
  permissions: z.object({
    level: z.literal('workspace'),
    production_write: z.literal('approval_required'),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  // OP3-A：agent.yaml runtime 块的 sha256（派生缓存指纹）。optional 向后兼容既有无 hash 条目；
  // 缺失时 doctor 报 config-drift warn，agentctl repair 补齐。
  config_hash: z.string().optional(),
});

export const registrySchema = z.object({
  version: z.literal(1),
  agents: z.array(registryAgentSchema),
});

export type Registry = z.infer<typeof registrySchema>;
export type RegistryAgent = z.infer<typeof registryAgentSchema>;
