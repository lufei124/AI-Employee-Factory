import path from 'node:path';
import type { AuthorityLayer } from '../schemas/agent-schema.js';
import type { TranscriptSummary } from './transcript.js';

// OP1 Stage D：ExperienceExtractor。从 transcript 摘要提取可复用经验，写回 knowledge/lessons/。
// 写回经 documentFile 的 assertInside+realpath+symlink 硬约束模式（与 knowledgeWrite 复用同一 root）。
// 默认 no-op，用户显式 opt-in（agent.yaml.memory.experience_extraction=true）。
// 硬约束：仅当 transcript_persist=true（Stage C 落地）时才生效，Stage D 不独立启用。
//
// D-041 P1-2：经验两级化。
//  - 一级（始终写）：transcript 落盘即同步写 `knowledge/lessons/raw/<date>-<agent>.md`——
//    DefaultExperienceExtractor 保留作原始记录格式化器，不依赖任何开关（防丢现场）。
//  - 二级（importance 触发）：reflection.ts 累积信号 + experience-refiner.ts 提炼，由
//    experience_extraction / reflection_enabled 控制（见 reflection.ts）。

/** 一条可写回知识的记忆资产。 */
export interface MemoryAsset {
  /** 写回目标目录（当前仅支持 knowledge/ 下）。 */
  targetScope: 'knowledge';
  /** 相对知识根目录的路径（如 `lessons/2026-08-04-feishu-setup.md`），须在 knowledge/ 树内。 */
  relPath: string;
  content: string;
  authorityLayer: AuthorityLayer;
}

/** 从 transcript 摘要中提取经验条目的策略（零 I/O 纯函数，便于单元测试）。 */
export interface ExperienceExtractor {
  /** 从一条会话摘要提取记忆资产（best-effort，无可提取时返回空数组）。 */
  extract(summary: TranscriptSummary): MemoryAsset[];
}

/** 默认提取器：把摘要的 decisions/lessons 字段收敛为一条经验记录。 */
export class DefaultExperienceExtractor implements ExperienceExtractor {
  constructor(private readonly options: { agentId: string }) {}

  extract(summary: TranscriptSummary): MemoryAsset[] {
    const decisions = summary.decisions.filter((line) => line.trim().length > 0);
    const lessons = summary.lessons.filter((line) => line.trim().length > 0);
    if (decisions.length === 0 && lessons.length === 0) return [];

    const body: string[] = [];
    if (summary.topics.length > 0) {
      body.push('## 主题', ...summary.topics.map((topic) => `- ${topic}`), '');
    }
    if (decisions.length > 0) {
      body.push('## 决策', ...decisions.map((decision) => `- ${decision}`), '');
    }
    if (lessons.length > 0) {
      body.push('## 经验', ...lessons.map((lesson) => `- ${lesson}`), '');
    }
    const content = [
      '---',
      'title: 会话经验摘要',
      'summary: 自动提取自 transcript（OP1 Stage D）',
      'keywords: [经验, 教训, 决策]',
      'authority_layer: knowledge',
      `updated_at: ${summary.finished_at.slice(0, 10)}`,
      '---',
      '',
      ...body,
    ].join('\n');

    const date = summary.finished_at.slice(0, 10) || 'unknown-date';
    const slug = `${date}-${sanitizeSlug(this.options.agentId)}`;
    return [
      {
        targetScope: 'knowledge',
        relPath: path.posix.join('lessons', `${slug}.md`),
        content,
        authorityLayer: 'knowledge',
      },
    ];
  }
}

/** 把 agentId 等标识收敛为文件 slug 安全片段（小写字母数字与短横线）。 */
export function sanitizeSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return normalized || 'agent';
}

// D-041 P1-2 一级：原始经验记录始终落盘。transcript 摘要一到（runJob/飞书消息）即同步写
// `knowledge/lessons/raw/<date>-<agent>.md`——不依赖 experience_extraction 开关（防丢现场）。
// 原始记录是二级提炼的证据源（experience-refiner 的 `because of raw/<file>:<line>`）。

/** 渲染原始经验记录全文（frontmatter + 主题/决策/经验/尾行）。 */
export function renderRawExperience(
  summary: TranscriptSummary,
  options: { agentId: string },
): string {
  const body: string[] = [];
  if (summary.topics.length > 0) {
    body.push('## 主题', ...summary.topics.map((topic) => `- ${topic}`), '');
  }
  if (summary.decisions.length > 0) {
    body.push('## 决策', ...summary.decisions.map((decision) => `- ${decision}`), '');
  }
  if (summary.lessons.length > 0) {
    body.push('## 经验', ...summary.lessons.map((lesson) => `- ${lesson}`), '');
  }
  if (summary.tail.length > 0) {
    body.push('## 输出尾行（脱敏）', ...summary.tail.map((line) => `- \`${line}\``), '');
  }
  return [
    '---',
    'title: 原始会话经验',
    'summary: 自动记录自 transcript（D-041 P1-2 一级，始终落盘）',
    'keywords: [经验, 原始, transcript]',
    'authority_layer: knowledge',
    `updated_at: ${summary.finished_at.slice(0, 10)}`,
    `source_agent: ${options.agentId}`,
    `source_transcript: ${summary.operation} @ ${summary.finished_at}`,
    '---',
    '',
    ...body,
  ].join('\n');
}

/** 原始记录相对 knowledge/ 的路径：`lessons/raw/<date>-<agent>.md`。 */
export function rawExperienceRelPath(
  summary: TranscriptSummary,
  options: { agentId: string },
): string {
  const date = summary.finished_at.slice(0, 10) || 'unknown-date';
  const slug = sanitizeSlug(options.agentId);
  return path.posix.join('lessons', 'raw', `${date}-${slug}.md`);
}
