import { z } from 'zod';
import { agentIdSchema, runtimeProviderSchema } from './agent-schema.js';

export const REGISTRY_VERSION = 2 as const;

// --- v2：Registry 不再持有 runtime 块（provider/locked/model），agent.yaml 为唯一来源。 ---
export const registryAgentSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  status: z.enum(['stopped', 'running', 'error', 'archived']),
  archived: z.boolean(),
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
  // OP3-A：agent.yaml runtime 块的 sha256（派生缓存指纹）。缺失视为漂移，doctor 报 fail，agentctl repair 补齐。
  config_hash: z.string().optional(),
});

export const registrySchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  agents: z.array(registryAgentSchema),
});

// --- v1：读旧文件用（含 runtime 块）。read() 内存中规范化为 v2，不丢数据。 ---
export const registryAgentV1Schema = registryAgentSchema.extend({
  runtime: z.object({
    provider: runtimeProviderSchema,
    locked: z.literal(true),
    model: z.string().min(1).optional(),
  }),
});

export const registrySchemaV1 = z.object({
  version: z.literal(1),
  agents: z.array(registryAgentV1Schema),
});

export type Registry = z.infer<typeof registrySchema>;
export type RegistryAgent = z.infer<typeof registryAgentSchema>;
export type RegistryV1 = z.infer<typeof registrySchemaV1>;
export type RegistryAgentV1 = z.infer<typeof registryAgentV1Schema>;
