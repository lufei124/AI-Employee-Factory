import { execa } from 'execa';
import { z } from 'zod';
import { AgentCtlError } from './errors.js';
import { buildSafeBaseEnvironment } from './runtime.js';
import { parseStructuredResult } from './usage.js';

// D-029：创建阶段「描述 → 生成员工蓝图」。用户给一句话描述，本地 Claude CLI
// （claude -p --output-format json，用户默认环境）生成结构化员工蓝图，供 Web/CLI
// 预填可编辑表单后创建。生成发生在员工建立之前，故不设 CLAUDE_CONFIG_DIR——
// 用用户默认 Claude 环境，与员工隔离 runtime 无关。
//
// 安全：prompt 仅含用户本人输入的描述，不读秘密；模型被要求只输出 JSON；蓝图的
// 权限边界（policies）由系统提示锁定为 workspace 沙箱内 + 高危操作人工审批。

export const generatedProfileSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  responsibilities: z.array(z.string().min(1)).default([]),
  policies: z.array(z.string().min(1)).default([]),
  escalation_conditions: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string()).default([]),
});

export type GeneratedProfile = z.infer<typeof generatedProfileSchema>;

// D-041 M3（决策② 骨架模板）：创建阶段收敛为「基础岗位骨架」——只产出岗位名/id/
// description/goals（更开放、更少字段）。responsibilities/policies/escalation 不再由 AI
// 生成：responsibilities 缺省为 [description]、policies 缺省为红线模板、escalation 缺省为
// 通用上报。保留 generatedProfileSchema 兼容（Web 仍可用完整蓝图，但骨架化创建不再要求）。
export const generatedSkeletonSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  skills: z.array(z.string()).default([]),
});

export type GeneratedSkeleton = z.infer<typeof generatedSkeletonSchema>;

// D-029：完整蓝图 prompt（Web 仍可用 AI 生成完整可编辑蓝图；骨架化创建是收敛默认路径）。
const GEN_SYSTEM_PROMPT = `你是一名「AI 员工蓝图设计师」。根据用户对一名 AI 员工用法的一句话描述，为它生成一份完整、可执行的员工蓝图。

只输出一个 JSON 对象，不要输出任何其他文字、markdown 代码块或解释。JSON 模式如下：
{
  "id": "英文小写 kebab-case 的 Agent ID（如 product-ops），用于工作区与终端命令",
  "name": "中文岗位名（2-6 字，如 内容运营）",
  "description": "一句话职责定位（20-40 字）",
  "goals": ["3-5 条核心目标，每条一句话、可度量"],
  "responsibilities": ["长期职责，3-6 条"],
  "policies": ["权限边界与上报规则，2-4 条，必须包含：生产写入、对外发布、Git push 和删除数据必须经人工审批"],
  "escalation_conditions": ["需要上报或申请更高权限的情形，2-3 条"],
  "skills": ["为完成职责所需的技能名（英文 kebab-case，如 customer-feedback），0-3 个，不确定则空数组"]
}

安全约束（必须遵守）：该员工是本地工作区沙箱内运行的 AI 助手，权限 level=workspace，生产写入、对外发布、推送 Git、删除数据均需人工审批。生成的目标和职责必须符合这些约束，不得生成涉及越权、越出沙箱、访问或删除本机敏感数据的目标。

用户描述：
`;

const SKELETON_SYSTEM_PROMPT = `你是一名「AI 员工蓝图设计师」。根据用户对一名 AI 员工用法的一句话描述，生成一份**基础岗位骨架**——只要岗位定位与目标，职责/权限等细节由员工在使用中自进化沉淀。

只输出一个 JSON 对象，不要输出任何其他文字、markdown 代码块或解释。JSON 模式如下：
{
  "id": "英文小写 kebab-case 的 Agent ID（如 product-ops），用于工作区与终端命令",
  "name": "中文岗位名（2-6 字，如 内容运营）",
  "description": "一句话职责定位（20-40 字）",
  "goals": ["1-3 条核心目标，每条一句话、可度量"],
  "skills": ["为完成职责所需的技能名（英文 kebab-case，如 customer-feedback），0-2 个，不确定则空数组"]
}

安全约束（必须遵守）：该员工是本地工作区沙箱内运行的 AI 助手，权限 level=workspace，生产写入、对外发布、推送 Git、删除数据均需人工审批。生成的目标必须符合这些约束，不得生成涉及越权、越出沙箱、访问或删除本机敏感数据的目标。

用户描述：
`;

export interface GenerateEmployeeOptions {
  /** 覆盖生成所用 Claude 模型（如 sonnet/opus）。缺省用 claude 默认模型。 */
  model?: string;
  /** 生成超时（毫秒）。默认 120 秒。 */
  timeoutMs?: number;
}

/**
 * 生成基础岗位骨架（D-041 M3）：字段收敛为 id/name/description/goals/skills，其余
 * 由系统按红线模板播种。失败抛 AgentCtlError（OPERATION_FAILED）。
 */
export async function generateEmployeeSkeleton(
  brief: string,
  options: GenerateEmployeeOptions = {},
): Promise<GeneratedSkeleton> {
  const args = ['-p', `${SKELETON_SYSTEM_PROMPT}\n${brief}`, '--output-format', 'json'];
  if (options.model) args.push('--model', options.model);
  let stdout: string;
  try {
    const result = await execa('claude', args, {
      shell: false,
      env: buildSafeBaseEnvironment(process.env),
      timeout: options.timeoutMs ?? 120_000,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new AgentCtlError('OPERATION_FAILED', 'AI 骨架生成失败：本地 Claude CLI 调用出错。', {
      remediation: '请确认本机 claude 已安装并登录，然后重试。',
      cause: error,
    });
  }
  const text = parseStructuredResult('claude', stdout);
  if (!text) {
    throw new AgentCtlError('OPERATION_FAILED', 'AI 骨架生成失败：未能从模型输出中解析结果。', {
      remediation: '请重试，或改用 --description/--goal 手动填写。',
    });
  }
  try {
    return generatedSkeletonSchema.parse(extractJson(text));
  } catch (error) {
    throw new AgentCtlError('OPERATION_FAILED', 'AI 骨架生成结果不符合预期格式。', {
      remediation: '请重试，或改用 --description/--goal 手动填写。',
      cause: error,
    });
  }
}

/**
 * 用本地 Claude CLI 生成员工蓝图。失败抛 AgentCtlError（OPERATION_FAILED），
 * remediation 提示重试或改用 --description/--goal 手动填写。
 */
export async function generateEmployeeProfile(
  brief: string,
  options: GenerateEmployeeOptions = {},
): Promise<GeneratedProfile> {
  const args = ['-p', `${GEN_SYSTEM_PROMPT}\n${brief}`, '--output-format', 'json'];
  if (options.model) args.push('--model', options.model);
  let stdout: string;
  try {
    const result = await execa('claude', args, {
      shell: false,
      env: buildSafeBaseEnvironment(process.env),
      timeout: options.timeoutMs ?? 120_000,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new AgentCtlError('OPERATION_FAILED', 'AI 蓝图生成失败：本地 Claude CLI 调用出错。', {
      remediation: '请确认本机 claude 已安装并登录，然后重试。',
      cause: error,
    });
  }
  const text = parseStructuredResult('claude', stdout);
  if (!text) {
    throw new AgentCtlError('OPERATION_FAILED', 'AI 蓝图生成失败：未能从模型输出中解析结果。', {
      remediation: '请重试，或改用 --description/--goal 手动填写。',
    });
  }
  try {
    return generatedProfileSchema.parse(extractJson(text));
  } catch (error) {
    throw new AgentCtlError('OPERATION_FAILED', 'AI 蓝图生成结果不符合预期格式。', {
      remediation: '请重试，或改用 --description/--goal 手动填写。',
      cause: error,
    });
  }
}

/** 从模型输出中提取 JSON 对象：剥离 markdown 代码围栏（模型常包裹 ```json … ```）。
 *  导出供 skill-generator 复用（D-034）。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = JSON.parse((fenced[1] ?? '').trim());
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return JSON.parse(trimmed);
}
