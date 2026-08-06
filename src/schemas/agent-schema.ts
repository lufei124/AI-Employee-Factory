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

// T08：员工角色。chief=编排主管（复用完整生命周期，编排中扮演主管）；worker=执行者（默认）。
export const agentRoleSchema = z.enum(['worker', 'chief']);
export type AgentRole = z.infer<typeof agentRoleSchema>;

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
  // D-034：true 时从 transcript 检测重复出现的可复用模式（skill_self_creation），达到阈值后
  // 自动生成并注册 Skill（best-effort，失败不阻断 runJob）。optional 向后兼容旧 agent.yaml。
  // 硬约束：仅当 transcript_persist=true（信号来源）时才生效，不独立启用。
  skill_self_creation: z.boolean().optional(),
  // D-041 P1-4：二级经验提炼开关。true/undefined 时按重要性累积触发提炼（reflection-signals +
  // experience-refiner）；false 时仅一级原始记录落盘（raw/），不提炼。optional 向后兼容。
  reflection_enabled: z.boolean().optional(),
  // D-041 P1-4：身份修订协议。'advisory'（默认，warn+拒提交留现场）/ 'enforced'（违规文件拒提交 +
  // CURRENT_STATE 记录）。optional 向后兼容。
  identity_protocol: z.enum(['advisory', 'enforced']).optional(),
  // D-041 P1-4：身份编辑方式。'proposal_required'（核心身份改动须提案批准）/ 'direct'（用户聊天直接
  // 授权可直改）。本批仅声明，M3 提案对账时生效。
  identity_edits: z.enum(['proposal_required', 'direct']).optional(),
});
export type PortableMemorySchema = z.infer<typeof portableMemorySchema>;

export const agentConfigSchema = z.object({
  schema_version: z.literal(1),
  id: agentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  // T08：角色（worker 默认 / chief）。optional 向后兼容旧 agent.yaml（缺失视为 worker）。
  role: agentRoleSchema.default('worker'),
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

// D-041 P1-1：三个自进化开关的默认值。新建员工显式写 true；存量员工 agent.yaml 缺失
// （undefined）时按此默认启用（resolveMemoryFlags 归一）。显式 false 尊重用户关闭意图，不回填。
export const DEFAULT_MEMORY_FLAGS = {
  transcript_persist: true,
  experience_extraction: true,
  skill_self_creation: true,
} as const;

/**
 * 归一记忆开关：undefined → 默认 true，显式值原样保留。
 * 所有读取自进化开关的调用点都应经此函数，避免散落的 `=== true` 判定漏掉默认开。
 * 返回浅拷贝，不修改原对象。
 * 注：返回类型写具体对象而非 `Required<Pick<...>>`——exactOptionalPropertyTypes 下
 * Required 只去 `?` 不剥离 undefined，会让调用点（如 runLogged 的 transcript 布尔）
 * 出现 `boolean | undefined` 类型不兼容。
 */
export function resolveMemoryFlags(memory: PortableMemorySchema): {
  transcript_persist: boolean;
  experience_extraction: boolean;
  skill_self_creation: boolean;
} {
  return {
    transcript_persist: memory.transcript_persist ?? DEFAULT_MEMORY_FLAGS.transcript_persist,
    experience_extraction:
      memory.experience_extraction ?? DEFAULT_MEMORY_FLAGS.experience_extraction,
    skill_self_creation: memory.skill_self_creation ?? DEFAULT_MEMORY_FLAGS.skill_self_creation,
  };
}
