import path from 'node:path';
import type { AuthorityLayer } from '../schemas/agent-schema.js';
import type { TranscriptSummary } from './transcript.js';

// OP1 Stage D：ExperienceExtractor。从 transcript 摘要提取可复用经验，写回 knowledge/lessons/。
// 写回经 documentFile 的 assertInside+realpath+symlink 硬约束模式（与 knowledgeWrite 复用同一 root）。
// 默认 no-op，用户显式 opt-in（agent.yaml.memory.experience_extraction=true）。
// 硬约束：仅当 transcript_persist=true（Stage C 落地）时才生效，Stage D 不独立启用。

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
