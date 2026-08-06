// D-041 P1-2 二级：经验提炼器。把累积的原始经验信号（reflection-signals）收敛为一条
// 「已提炼经验」，写回 `knowledge/lessons/refined/<date>-<slug>.md`。
//
// 复用 employee-generator（D-029）/ skill-generator（D-034）的「本地 Claude CLI →
// 结构化 JSON → Zod 校验」范式。关键约束：evidence 必须引用一级原始记录的具体文件/行
// （`because of: knowledge/lessons/raw/<file>:<line>`），保证提炼有据可查（对齐
// Generative Agents 的 `insight (because of 1,5,3)` 证据引用模式）。
//
// 安全：prompt 仅含 transcript 摘要（已脱敏，D-006），不读秘密；模型被要求只输出 JSON；
// 产出的 writeup 被系统提示锁定为 workspace 内经验，禁止越权/敏感数据。

import fs from 'fs-extra';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { AgentCtlError } from './errors.js';
import { buildSafeBaseEnvironment } from './runtime.js';
import { parseStructuredResult } from './usage.js';
import { extractJson } from './employee-generator.js';
import { sanitizeSlug } from './experience.js';
import type { ReflectionSignal } from './reflection.js';

export const refinedExperienceSchema = z.object({
  insight: z.string().min(1),
  /** 证据引用：相对 knowledge/ 的路径（lessons/raw/<file>），可带 :行号。 */
  evidence: z.array(z.string().min(1)).default([]),
  writeup: z.string().min(1),
});

export type RefinedExperience = z.infer<typeof refinedExperienceSchema>;

export interface RefineExperienceOptions {
  /** 覆盖生成所用 Claude 模型（如 sonnet/opus）。缺省用 claude 默认模型。 */
  model?: string;
  /** 生成超时（毫秒）。默认 120 秒。 */
  timeoutMs?: number;
}

/** 把信号摘要拼成生成器输入：只含脱敏后的主题/决策/经验/尾行，不含原始全文。 */
export function renderRefineBrief(signals: ReflectionSignal[]): string {
  const lines: string[] = [];
  for (const signal of signals) {
    lines.push(
      `- [${signal.date}] 主题=${signal.topics.join(',') || '-'}，` +
        `决策=${signal.decisions?.join('；') || '-'}，` +
        `经验=${signal.lessons?.join('；') || '-'}，` +
        `transcript=${signal.transcriptFile}`,
    );
  }
  return lines.join('\n');
}

const REFINE_SYSTEM_PROMPT = `你是一名「AI 员工经验提炼师」。根据一名 AI 员工过去一段时间积累的会话经验信号，提炼出几条有长期价值的经验教训。

只输出一个 JSON 对象，不要输出任何其他文字、markdown 代码块或解释。JSON 模式如下：
{
  "insight": "一句话核心洞察（20-60 字），总结这批经验最重要的教训",
  "evidence": ["引用支撑该洞察的原始记录，格式：knowledge/lessons/raw/<文件名> 或 knowledge/lessons/raw/<文件名>:<行号>，1-3 条"],
  "writeup": "经验正文（markdown，200-500 字）：含适用场景、关键做法、常见坑、下一步。用 ## 小节组织"
}

安全约束（必须遵守）：只提炼与工作方法、流程、产品知识相关的经验。不得提炼或重复任何秘密、个人敏感信息或越权操作细节。writeup 必须在工作区沙箱场景内。

经验信号：
`;

/**
 * 用本地 Claude CLI 把累积经验信号提炼为一条经验。失败抛 AgentCtlError（OPERATION_FAILED），
 * remediation 提示重试或降级（原始记录仍在 raw/，不丢现场）。
 */
export async function refineExperience(
  brief: string,
  options: RefineExperienceOptions = {},
): Promise<RefinedExperience> {
  const args = ['-p', `${REFINE_SYSTEM_PROMPT}\n${brief}`, '--output-format', 'json'];
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
    throw new AgentCtlError('OPERATION_FAILED', '经验提炼失败：本地 Claude CLI 调用出错。', {
      remediation: '请确认本机 claude 已安装并登录，然后重试（原始记录仍在 raw/）。',
      cause: error,
    });
  }
  const text = parseStructuredResult('claude', stdout);
  if (!text) {
    throw new AgentCtlError('OPERATION_FAILED', '经验提炼失败：未能从模型输出中解析结果。', {
      remediation: '请重试，或降级（原始记录仍在 raw/）。',
    });
  }
  try {
    return refinedExperienceSchema.parse(extractJson(text));
  } catch (error) {
    throw new AgentCtlError('OPERATION_FAILED', '经验提炼结果不符合预期格式。', {
      remediation: '请重试，或降级（原始记录仍在 raw/）。',
      cause: error,
    });
  }
}

/** 提炼结果相对 knowledge/ 的路径：`lessons/refined/<date>-<slug>.md`。 */
export function refinedExperienceRelPath(input: { agentId: string; date?: string }): string {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const slug = sanitizeSlug(input.agentId);
  return `lessons/refined/${date}-${slug}.md`;
}

/** 最近一次提炼的 ISO 时间（供 shouldReflect 的保底触发用）。
 *  按 refined 目录内文件名日期取最新文件，解析其 frontmatter `updated_at`；
 *  无提炼记录返回 null（触发首次保底）。best-effort：目录缺失/解析失败按无记录处理。 */
export async function readLastRefinedAt(workspace: string): Promise<string | null> {
  const refinedDir = path.join(workspace, 'knowledge', 'lessons', 'refined');
  const files = await fs
    .readdir(refinedDir)
    .catch(() => [] as string[])
    .then((names) => names.filter((name) => name.endsWith('.md')).sort());
  if (files.length === 0) return null;
  // 文件名日期前缀即提炼日期，取最新者（字典序最大）。
  const latest = files[files.length - 1]!;
  const content = await fs.readFile(path.join(refinedDir, latest), 'utf8').catch(() => '');
  const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const updatedAt = fm.match(/updated_at:\s*([^\n]+)/)?.[1]?.trim();
  return updatedAt || latest.slice(0, 10) || null;
}

/** 渲染提炼结果全文（frontmatter + insight + evidence + writeup，证据带 because of）。 */
export function renderRefinedExperience(
  refined: RefinedExperience,
  options: { agentId: string; date?: string },
): string {
  const evidenceLines = refined.evidence
    .map((evidence) => `- \`because of: ${evidence}\``)
    .join('\n');
  return [
    '---',
    'title: 提炼经验',
    'summary: ' + refined.insight,
    'keywords: [经验, 提炼]',
    'authority_layer: knowledge',
    `updated_at: ${options.date ?? new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
    `# ${refined.insight}`,
    '',
    '## 证据引用',
    '',
    evidenceLines,
    '',
    '## 经验正文',
    '',
    refined.writeup.trim(),
    '',
  ].join('\n');
}
