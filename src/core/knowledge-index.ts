import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import { assertInside } from './paths.js';
import {
  KNOWLEDGE_INDEX_FILE,
  defaultLayerFor,
  type KnowledgeConsistency,
  type KnowledgeDriftIssue,
  type KnowledgeEntry,
  type KnowledgeIndex,
  type KnowledgeIndexResult,
  type KnowledgeRecallResult,
} from './knowledge.js';

// OP1 Stage B：knowledge/ 轻量索引实现。扫描 knowledge/**/*.md，解析 frontmatter 建关键词倒排，
// 写 knowledge/.index.json（派生文件，.gitignore 排除）。recall 为关键词召回（非向量）。
// 所有读写路径均经 assertInside 收紧在 knowledge/ 根内（复用 documentFile 的硬约束模式）。

/** 关键词倒排：关键词 → 命中的 relPath 集合。 */
interface InvertedIndex {
  [keyword: string]: string[];
}

/** .index.json 持久化结构。 */
interface IndexFile {
  version: 1;
  updatedAt: string;
  entries: KnowledgeEntry[];
  inverted: InvertedIndex;
}

const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** 去除 markdown 格式噪音，保留中英文/数字 token。 */
export function tokenize(text: string): string[] {
  return (
    text
      .replace(/[`*_#>|()[\]{}:[\]/\\-]/g, ' ')
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.filter((token) => !STOPWORDS.has(token)) ?? []
  );
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'with',
  'this',
  'that',
  'from',
  'your',
  'you',
  'not',
  'but',
  'have',
  'has',
  'had',
  'will',
  'would',
  'should',
  'shall',
  'can',
  'could',
  'may',
  'might',
  'must',
  'about',
  'into',
  'over',
  'under',
  'upon',
  'then',
  'than',
  'them',
  'they',
  'their',
  'there',
  'here',
  'where',
  'when',
  'what',
  'which',
  'who',
  'whom',
  'how',
  'all',
  'any',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  'so',
  'too',
  'very',
  'just',
  'also',
  'between',
  'through',
  'during',
  'before',
  'after',
  'again',
  'further',
  'once',
  'these',
  'those',
  'because',
  'while',
  'being',
]);

/** 中文别名映射（查询词 → 同义词集合，用于召回拓展）。 */
const SYNONYMS: Record<string, string[]> = {
  经验: ['经验', 'lessons'],
  知识: ['知识', 'knowledge'],
  决策: ['决策', 'decisions'],
  lessons: ['经验', 'lessons'],
  decisions: ['决策', 'decisions'],
  knowledge: ['知识', 'knowledge'],
};

/** 中文关键词解析：整词优先（保留最长 ngram），失败时退化为字符 ngram。 */
function chineseKeywords(text: string): string[] {
  const raw = text.toLowerCase().trim();
  const chars = raw.match(/\p{Script=Han}/gu);
  if (!chars || chars.length === 0) return [];
  const tokens = raw.match(/[\p{Script=Han}]+/gu);
  if (tokens?.some((token) => token.length >= 4)) return tokens;
  return Array.from(
    new Set(
      chars.map((_, index) => chars.slice(index, index + 2).join('')).filter((s) => s.length >= 2),
    ),
  );
}

/** 单条 frontmatter 解析（容忍 YAML 异常，返回 undefined 以便 ignore）。 */
function parseFrontmatter(content: string): { frontmatter: unknown; body: string } | undefined {
  if (!content.startsWith('---')) return undefined;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return undefined;
  const yamlText = content.slice(4, end).trim();
  try {
    return { frontmatter: YAML.parse(yamlText), body: content.slice(end + 4) };
  } catch {
    return undefined;
  }
}

export class KnowledgeIndexImpl implements KnowledgeIndex {
  private readonly root: string;
  private readonly indexFile: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.indexFile = path.join(this.root, KNOWLEDGE_INDEX_FILE);
  }

  async ingest(): Promise<KnowledgeIndexResult> {
    const entries = await this.scan();
    const index: IndexFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
      inverted: this.buildInverted(entries),
    };
    await atomicWriteFile(this.indexFile, JSON.stringify(index, null, 2), 0o600);
    return { entries: entries.length, indexFile: this.indexFile, updatedAt: index.updatedAt };
  }

  async recall(query: string): Promise<KnowledgeRecallResult> {
    const index = await this.readIndex();
    const queryTokens = tokenize(query);
    const expansions = queryTokens.flatMap((token) => SYNONYMS[token] ?? [token]);
    const hits = new Map<string, { entry: KnowledgeEntry; score: number; matched: Set<string> }>();

    for (const token of expansions) {
      const hitPaths = index.inverted[token] ?? [];
      for (const relPath of hitPaths) {
        const entry = index.entries.find((candidate) => candidate.relPath === relPath);
        if (!entry) continue;
        const record = hits.get(relPath) ?? {
          entry,
          score: 0,
          matched: new Set<string>(),
        };
        record.score += 1;
        record.matched.add(token);
        hits.set(relPath, record);
      }
    }

    if (hits.size === 0) {
      const chinese = chineseKeywords(query);
      for (const token of chinese) {
        const hitPaths = index.inverted[token] ?? [];
        for (const relPath of hitPaths) {
          const entry = index.entries.find((candidate) => candidate.relPath === relPath);
          if (!entry) continue;
          const record = hits.get(relPath) ?? {
            entry,
            score: 0,
            matched: new Set<string>(),
          };
          record.score += 1;
          record.matched.add(token);
          hits.set(relPath, record);
        }
      }
    }

    const results = [...hits.values()].sort(
      (a, b) => b.score - a.score || a.entry.relPath.localeCompare(b.entry.relPath),
    );

    return {
      query,
      hits: results.map(({ entry, score, matched }) => ({
        entry,
        score,
        matchedKeywords: [...matched],
      })),
    };
  }

  async compact(): Promise<KnowledgeIndexResult> {
    return this.ingest();
  }

  async verifyConsistency(): Promise<KnowledgeConsistency> {
    const issues: KnowledgeDriftIssue[] = [];
    let onDisk: KnowledgeEntry[] = [];
    let onDiskMap = new Map<string, KnowledgeEntry>();
    try {
      onDisk = await this.scan();
      onDiskMap = new Map(onDisk.map((entry) => [entry.relPath, entry]));
    } catch (error) {
      issues.push({
        kind: 'invalid-frontmatter',
        detail: `扫描 knowledge/ 失败：${String(error)}`,
      });
    }

    const indexFile = this.indexFile;
    if (!(await fs.pathExists(indexFile))) {
      issues.push({
        kind: 'missing-index',
        detail: `索引文件不存在：${indexFile}。运行 agentctl knowledge rebuild ${'<agent-id>'} 重建。`,
      });
      return { ok: false, issues };
    }

    let index: IndexFile;
    try {
      index = JSON.parse(await fs.readFile(indexFile, 'utf8')) as IndexFile;
    } catch (error) {
      issues.push({ kind: 'stale-index', detail: `索引文件不可解析：${String(error)}` });
      return { ok: false, issues };
    }
    const indexed = new Map(index.entries.map((entry) => [entry.relPath, entry]));

    for (const entry of onDisk) {
      const cached = indexed.get(entry.relPath);
      if (!cached) {
        issues.push({
          kind: 'stale-entry',
          relPath: entry.relPath,
          detail: `索引缺条目：${entry.relPath}。运行 agentctl knowledge rebuild ${'<agent-id>'} 重建。`,
        });
      } else if (
        cached.title !== entry.title ||
        cached.summary !== entry.summary ||
        cached.updatedAt !== entry.updatedAt
      ) {
        issues.push({
          kind: 'stale-entry',
          relPath: entry.relPath,
          detail: `索引过期：${entry.relPath}（磁盘已改）。运行 agentctl knowledge rebuild ${'<agent-id>'} 重建。`,
        });
      }
    }

    for (const relPath of indexed.keys()) {
      if (!onDiskMap.has(relPath)) {
        issues.push({
          kind: 'orphan-entry',
          relPath,
          detail: `索引含已删除条目：${relPath}。运行 agentctl knowledge rebuild ${'<agent-id>'} 重建。`,
        });
      }
    }

    if (
      issues.length === 0 &&
      JSON.stringify(index.inverted ?? {}) !== JSON.stringify(this.buildInverted(onDisk))
    ) {
      issues.push({
        kind: 'stale-index',
        detail: '倒排索引与条目不一致。运行 agentctl knowledge rebuild 重建。',
      });
    }

    return { ok: issues.length === 0, issues };
  }

  private async scan(): Promise<KnowledgeEntry[]> {
    const results: KnowledgeEntry[] = [];
    if (!(await fs.pathExists(this.root))) return results;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(file);
          continue;
        }
        if (!entry.name.endsWith('.md')) continue;
        const relPath = path.relative(this.root, file);
        const resolved = assertInside(this.root, file, '知识文档');
        if (resolved !== file) continue;
        const parsed = await this.parseDocument(file, relPath);
        if (parsed) results.push(parsed);
      }
    };
    await visit(this.root);
    results.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return results;
  }

  private async parseDocument(file: string, relPath: string): Promise<KnowledgeEntry | undefined> {
    const content = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) return undefined;
    const parsed = parseFrontmatter(content);
    if (!parsed) return undefined;
    const fm = (parsed.frontmatter ?? {}) as Record<string, unknown>;
    const title =
      typeof fm.title === 'string' && fm.title.trim()
        ? fm.title.trim()
        : (firstHeading(parsed.body) ?? path.basename(relPath, '.md'));
    const summary = typeof fm.summary === 'string' ? fm.summary.trim() : '';
    const rawKeywords = Array.isArray(fm.keywords)
      ? fm.keywords.filter((k): k is string => typeof k === 'string')
      : [];
    const keywords = rawKeywords.length > 0 ? rawKeywords : keywordsFromBody(parsed.body);
    return {
      relPath,
      title,
      summary,
      keywords,
      updatedAt: typeof fm.updated_at === 'string' ? fm.updated_at : new Date().toISOString(),
      authorityLayer: defaultLayerFor(relPath, fm.authority_layer),
    };
  }

  private async readIndex(): Promise<IndexFile> {
    if (!(await fs.pathExists(this.indexFile))) {
      await this.ingest();
    }
    return JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as IndexFile;
  }

  private buildInverted(entries: KnowledgeEntry[]): InvertedIndex {
    const inverted: InvertedIndex = {};
    for (const entry of entries) {
      const tokens = new Set<string>();
      for (const keyword of entry.keywords)
        for (const token of tokenize(keyword)) tokens.add(token);
      for (const token of tokenize(entry.title)) tokens.add(token);
      for (const token of tokenize(entry.summary)) tokens.add(token);
      for (const token of chineseKeywords(entry.title)) tokens.add(token);
      for (const token of chineseKeywords(entry.summary)) tokens.add(token);
      for (const token of tokens) {
        (inverted[token] ??= []).push(entry.relPath);
      }
    }
    return inverted;
  }
}

function firstHeading(body: string): string | undefined {
  const line = body.split('\n').find((candidate) => /^#{1,6}\s+/.test(candidate));
  return line ? line.replace(/^#{1,6}\s+/, '').trim() : undefined;
}

function keywordsFromBody(body: string): string[] {
  const tokens = tokenize(body).slice(0, 6);
  return [...new Set(tokens)];
}
