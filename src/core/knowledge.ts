import { AUTHORITY_LAYERS, type AuthorityLayer } from '../schemas/agent-schema.js';

// OP1 Stage B：knowledge/ 轻量索引层（非向量）。把 knowledge/**/*.md 解析为可 recall 的条目，
// 派生 .index.json 供未来阶段/工具消费。默认 no-op，可配置启用（MemoryConfig 见 agent-schema）。

/** 单个知识条目的 frontmatter。缺省字段由 ingest 对无 frontmatter 旧文件补默认值。 */
export interface KnowledgeEntry {
  /** 相对 knowledge/ 的文件路径（如 `decisions/d-013.md`），与顶层 knowledge/ 目录命名去重。 */
  relPath: string;
  title: string;
  summary: string;
  keywords: string[];
  updatedAt: string;
  authorityLayer: AuthorityLayer;
}

export interface KnowledgeIndexResult {
  entries: number;
  indexFile: string;
  updatedAt: string;
}

export interface KnowledgeRecallHit {
  entry: KnowledgeEntry;
  score: number;
  /** 命中的关键词（便于调用方高亮/解释）。 */
  matchedKeywords: string[];
  /** D-041 P3-3：证据引用（`because of: knowledge/lessons/raw/<file>:<line>`），
   *  提炼经验经证据可回溯到一级原始记录（refined 命中才有）。 */
  evidence?: string[];
  /** D-042：正文命中片段（首个命中点前后 ~200 字符，剥 markdown）。CLI/Web/运行时便签展示用。 */
  snippet?: string;
}

export interface KnowledgeRecallResult {
  query: string;
  hits: KnowledgeRecallHit[];
}

export interface KnowledgeDriftIssue {
  kind: 'missing-index' | 'stale-index' | 'stale-entry' | 'orphan-entry' | 'invalid-frontmatter';
  relPath?: string;
  detail: string;
}

export interface KnowledgeConsistency {
  ok: boolean;
  issues: KnowledgeDriftIssue[];
}

/** knowledge/ 索引的派生文件（gitignored）。 */
export const KNOWLEDGE_INDEX_FILE = '.index.json';

/** 顶层 knowledge/ 目录名到 AuthorityLayer 的默认映射（decisions 子目录归 'decisions' 层，其余归 'knowledge' 层）。 */
const DIR_TO_LAYER: Record<string, AuthorityLayer> = {
  decisions: 'decisions',
  lessons: 'knowledge',
  metrics: 'knowledge',
  product: 'knowledge',
  references: 'knowledge',
};

/** 未显式声明 authority_layer 时，按顶层目录推断默认层。 */
export function defaultLayerFor(relPath: string, metaLayer?: unknown): AuthorityLayer {
  if (
    typeof metaLayer === 'string' &&
    (AUTHORITY_LAYERS as readonly string[]).includes(metaLayer)
  ) {
    return metaLayer as AuthorityLayer;
  }
  const top = relPath.split('/')[0] ?? '';
  return DIR_TO_LAYER[top] ?? 'knowledge';
}

export interface KnowledgeIndex {
  /** 扫描 knowledge/**\/*.md，重建/增量写 .index.json。 */
  ingest(): Promise<KnowledgeIndexResult>;
  /** 关键词倒排召回：分词 → AND/OR 提升 → 别名映射 → 关键词命中数降序。 */
  recall(query: string): Promise<KnowledgeRecallResult>;
  /** 重建索引（写新 .index.json，原子替换）。 */
  compact(): Promise<KnowledgeIndexResult>;
  /** 校验索引与 knowledge/ 内容一致（索引漂移检测）。 */
  verifyConsistency(): Promise<KnowledgeConsistency>;
}
