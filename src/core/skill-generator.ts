import { execa } from 'execa';
import { z } from 'zod';
import { AgentCtlError } from './errors.js';
import { buildSafeBaseEnvironment } from './runtime.js';
import { parseStructuredResult } from './usage.js';
import { extractJson } from './employee-generator.js';

// D-034：员工自建 Skill 的生成器。复用 employee-generator（D-029）的
// 「本地 Claude CLI → 结构化 JSON → Zod 校验」范式，把一段可复用能力描述
// 收敛为一个 Claude Code Skill 蓝图（SKILL.md 内容）。
//
// 安全：prompt 仅含员工/用户提供的 `brief` 描述，不读秘密；模型被要求只输出 JSON；
// 生成的 instructions 被系统提示锁定为 workspace 沙箱内，禁止越权/敏感数据/破坏性命令。

export const generatedSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'name 须为英文小写 kebab-case'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .default('0.0.1'),
  short_description: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  triggers: z.array(z.string().min(1)).default([]),
});

export type GeneratedSkill = z.infer<typeof generatedSkillSchema>;

export interface GenerateSkillOptions {
  /** 覆盖生成所用 Claude 模型（如 sonnet/opus）。缺省用 claude 默认模型。 */
  model?: string;
  /** 生成超时（毫秒）。默认 120 秒。 */
  timeoutMs?: number;
}

const GEN_SYSTEM_PROMPT = `你是一名「AI 员工 Skill 设计师」。根据员工描述的一个可复用能力，为它生成一个 Claude Code Skill。

只输出一个 JSON 对象，不要输出任何其他文字、markdown 代码块或解释。JSON 模式如下：
{
  "name": "英文小写 kebab-case 的 skill 名（如 periodic-report，对应 SKILL.md 文件名）",
  "version": "semver 版本号，如 1.0.0",
  "short_description": "一句话（20-40 字），说明这个 Skill 解决什么问题",
  "description": "2-3 句详细描述，说明适用场景与能力边界",
  "instructions": "Skill 使用说明正文（markdown，不含 frontmatter；含执行步骤、输入、输出、注意事项）",
  "triggers": ["触发该 Skill 的典型任务描述，2-4 条，每条一句话"]
}

安全约束（必须遵守）：该 Skill 是本地工作区沙箱内运行的 AI 助手能力。instructions 中不得包含：访问或删除本机敏感数据、越出沙箱、对外网络外发秘密、执行破坏性命令（如 git reset --hard、rm -rf）的指令。所有命令必须限定在 workspace 内。

员工描述的可复用能力：
`;

/**
 * 用本地 Claude CLI 生成一个 Skill 蓝图。失败抛 AgentCtlError（OPERATION_FAILED），
 * remediation 提示重试或改用手动编写。
 */
export async function generateSkill(
  brief: string,
  options: GenerateSkillOptions = {},
): Promise<GeneratedSkill> {
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
    throw new AgentCtlError('OPERATION_FAILED', 'Skill 生成失败：本地 Claude CLI 调用出错。', {
      remediation: '请确认本机 claude 已安装并登录，然后重试。',
      cause: error,
    });
  }
  const text = parseStructuredResult('claude', stdout);
  if (!text) {
    throw new AgentCtlError('OPERATION_FAILED', 'Skill 生成失败：未能从模型输出中解析结果。', {
      remediation: '请重试，或改用 --brief 手动描述后重试。',
    });
  }
  try {
    return generatedSkillSchema.parse(extractJson(text));
  } catch (error) {
    throw new AgentCtlError('OPERATION_FAILED', 'Skill 生成结果不符合预期格式。', {
      remediation: '请重试，或改用 --brief 手动描述后重试。',
      cause: error,
    });
  }
}

/** 把 Skill 蓝图渲染为合法 SKILL.md 文本（frontmatter + instructions）。
 *  供 upsert 前的写盘与 CLI --dry-run 预览使用。 */
export function renderSkillFile(skill: GeneratedSkill): string {
  const frontmatter = [
    '---',
    `name: ${skill.name}`,
    `version: ${skill.version}`,
    `description: ${skill.short_description}`,
    '---',
    '',
  ].join('\n');
  return `${frontmatter}\n${skill.instructions.trim()}\n`;
}
