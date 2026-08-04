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

// OP1 Stage A：authority_order 的层枚举。schema 为 source of truth，authority.ts 镜像复用。
export const AUTHORITY_LAYERS = [
  'agent',
  'knowledge',
  'decisions',
  'skills',
  'native_memory',
  'session',
] as const;
export type AuthorityLayer = (typeof AUTHORITY_LAYERS)[number];

// OP3-B：当前 agent.yaml schema 版本。版本化只读 reader 据此显式分派；v1=identity。
export const CURRENT_AGENT_CONFIG_SCHEMA_VERSION = 1;

// OP2-F：便携记忆 schema 的显式类型导出（data-only 契约，供未来扩展点引用）。
// 与 agentConfigSchema.memory 同构，作为 memory 块的权威类型，避免扩展点误用整份配置。
export const portableMemorySchema = z.object({
  isolation: z.literal('strict'),
  native_memory: z.boolean(),
  portable_memory: z.boolean(),
  authority_order: z.array(z.enum(AUTHORITY_LAYERS)),
  // OP1 Stage A：true 时 prepareRuntime 运行前强制校验 authority_order 不变量（W1 收敛）。
  // optional 向后兼容旧 agent.yaml（缺失视为未启用，doctor warn 引导补齐）；false 为显式降级逃生口。
  enforced: z.boolean().optional(),
  // OP1 Stage C：true 时 chat/run/job 结束后把会话摘要写入 transcript.jsonl（0600，摘要非全量原文，
  // secret 经 SECRET_PATTERN 过滤）。optional 向后兼容旧 agent.yaml（缺失视为未启用）。
  transcript_persist: z.boolean().optional(),
  // OP1 Stage D：true 时从 transcript 摘要提取可复用经验，写回 knowledge/lessons/（复用 documentFile
  // 的 assertInside+realpath+symlink 硬约束）。optional 向后兼容旧 agent.yaml（缺失视为未启用）。
  // 硬约束：仅当 transcript_persist=true（Stage C 落地）时才生效，Stage D 不独立启用。
  experience_extraction: z.boolean().optional(),
});
export type PortableMemorySchema = z.infer<typeof portableMemorySchema>;

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
  memory: portableMemorySchema,
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
