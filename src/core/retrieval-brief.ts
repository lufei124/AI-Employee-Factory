import type { KnowledgeRecallHit } from './knowledge.js';

// D-042 Part B：运行时 RAG 便签渲染。每次 run/Job/飞书消息前，Factory 把按当前任务召回的记忆
// 写入员工工作区 `knowledge/.retrieved.md`（dot 前缀 + 无 frontmatter + .gitignore）：
//  - 模型开场即读（ENTRY 模板引导），不用自己翻整个 knowledge/；
//  - 永不进 .index.json（scan 跳过点文件）、永不进 git（commitSelfEvolution 不列 gitignored 文件）、
//    归档不碰（archiveStaleKnowledge 只扫 lessons/{raw,refined}）；
//  - 每次运行覆盖写 = 最后一次任务的缓存，模型可引用其中的 relPath，可审计。

/** RAG 便签文件名（相对 knowledge/；dot 前缀 → scan/git 双隔离）。 */
export const RETRIEVED_BRIEF_FILE = '.retrieved.md';

/** 便签开启/结束标记（ENSURE_RUNTIME_PROMPT 幂等判定用：缺标记才重渲 ENTRY）。 */
export const RETRIEVED_BRIEF_MARKER = '<!-- factory:retrieved -->';
export const RETRIEVED_BRIEF_END_MARKER = '<!-- factory:retrieved-end -->';

/** 渲染一条命中的摘要行（保留条目完整路径，模型可据此读正式文件）。 */
function renderHit(hit: KnowledgeRecallHit): string {
  const lines: string[] = [];
  const pathLine = `- [[${hit.entry.title}]](${hit.entry.relPath}) [${hit.score.toFixed(2)}]`;
  lines.push(pathLine);
  if (hit.entry.summary) lines.push(`  - ${hit.entry.summary}`);
  if (hit.snippet) {
    const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
    if (snippet.length > 0) lines.push(`  - 片段：${snippet}`);
  }
  if (hit.evidence && hit.evidence.length > 0) {
    lines.push(`  - 证据：${hit.evidence.join('；')}`);
  }
  return lines.join('\n');
}

/** 渲染 RAG 便签全文（无 frontmatter，包裹在系统标记内）。 */
export function renderRetrievalBrief(input: {
  query: string;
  hits: KnowledgeRecallHit[];
  generatedAt: string;
}): string {
  const { query, hits, generatedAt } = input;
  return [
    RETRIEVED_BRIEF_MARKER,
    '# 按当前任务召回的参考记忆（系统自动生成）',
    '',
    `> 本文件由系统在每次任务开始时按任务内容自动生成，覆盖写入。` +
      `内容仅供**参考**，以 \`knowledge/\` 下的正式文件为准；请勿编辑、请勿当作正式知识提交。`,
    '',
    `- 任务查询：${query}`,
    `- 生成时间：${generatedAt}`,
    '',
    `## 命中（${hits.length} 条）`,
    '',
    ...hits.map(renderHit),
    '',
    RETRIEVED_BRIEF_END_MARKER,
    '',
  ].join('\n');
}
