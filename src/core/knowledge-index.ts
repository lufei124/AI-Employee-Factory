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
//
// D-042：召回引擎增强。
//  - 正文入索引（每文档正文 token 上限 MAX_BODY_TOKENS），不再只索引 title/summary/keywords；
//  - InvertedIndex v2：posting 记录 term frequency + 分字段 tf（title/keywords/summary/body），
//    条目带 len（文档总 token 数）供 BM25 长度归一；buildInverted 确定性（token/posting 排序），
//    verifyConsistency 的 JSON 对比稳定；v1 索引读取时一次性重建；
//  - BM25 评分（k1=1.5, b=0.75）+ 字段权重（title 2.0 / keywords 1.8 / summary 1.3 / body 1.0），
//    top-K + 相关度下限；不加 layer 权重（对齐 README 事实优先级）；
//  - 中文整词（≥4）+ 字符大词恒开混合（去掉「仅零命中走大词」回退）；正文中文同样大词入索引；
//  - 编辑距离/子串模糊回退（0.6×idf，精确命中占优；纯汉字 token 不参与模糊，防噪声）；
//  - 命中片段 snippet（首个命中点前后 ~200 字符窗口，剥 markdown）+ 既有 refined 证据合并一次读；
//  - mtime 节流自动重建（按根实例 10s 节流），覆盖「模型直写 knowledge/ 未触发 knowledgeWrite」。

/** 倒排 posting：分字段 term frequency（BM25 分字段加权用）。 */
interface TermPosting {
  relPath: string;
  titleTf: number;
  keywordsTf: number;
  summaryTf: number;
  bodyTf: number;
}

/** 关键词倒排：token → posting 列表。 */
interface InvertedIndex {
  [token: string]: TermPosting[];
}

/** 索引文件中的条目序列化形态：KnowledgeEntry + len（文档总 token 数）。fieldTokens 不落盘。 */
interface IndexEntryFile extends KnowledgeEntry {
  len: number;
}

/** 扫描/构建期内存形态：额外携带分字段 token 数组（buildInverted 计数用，不落盘）。 */
interface IndexableEntry extends IndexEntryFile {
  fieldTokens: Record<'title' | 'keywords' | 'summary' | 'body', string[]>;
}

/** .index.json 持久化结构（version 2：分字段 tf + len）。 */
interface IndexFile {
  version: 2;
  updatedAt: string;
  entries: IndexEntryFile[];
  inverted: InvertedIndex;
}

const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** 每文档正文 token 上限（控 .index.json 体积）。 */
const MAX_BODY_TOKENS = 2000;
/** BM25 参数。 */
const K1 = 1.5;
const B = 0.75;
/** 字段权重：title > keywords > summary > body。 */
const FIELD_WEIGHTS: Record<'title' | 'keywords' | 'summary' | 'body', number> = {
  title: 2.0,
  keywords: 1.8,
  summary: 1.3,
  body: 1.0,
};
/** top-K 召回上限。 */
const TOP_K = 8;
/** 相关度下限：低于 top 得分的 0.15 剔除（过滤 idf 暴涨的单 token 噪声）。 */
const RELEVANCE_FLOOR_RATIO = 0.15;
/** 模糊回退贡献权重（精确命中占优）。 */
const FUZZY_WEIGHT = 0.6;
/** mtime 陈旧检测节流间隔（按根实例），避免桥接热路径每消息全扫。 */
const STALENESS_CHECK_INTERVAL_MS = 10_000;

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

// D-042 A4：中文整词 + 字符大词恒开混合。对每个汉字串，len≥4 的整词与字符大词（2 字滑动窗口）
// 同时产出，两者都进索引与查询 token 集（不再「仅零命中才走大词」的 all-or-nothing 回退）。
/** 中文关键词解析：整词（≥4 字）+ 字符大词恒开混合（供索引与查询共用，导出供测试）。 */
export function chineseKeywords(text: string): string[] {
  const raw = text.toLowerCase().trim();
  const tokens = raw.match(/[\p{Script=Han}]+/gu);
  if (!tokens) return [];
  const result = new Set<string>();
  for (const token of tokens) {
    if (token.length >= 4) result.add(token);
    const chars = Array.from(token);
    for (let index = 0; index < chars.length - 1; index += 1) {
      result.add(chars[index]! + chars[index + 1]!);
    }
  }
  return [...result];
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

/** 是否纯汉字 token（不参与模糊回退——中文靠整词/大词，编辑距离会引入噪声）。 */
function isPureHan(token: string): boolean {
  return /^[\p{Script=Han}]+$/u.test(token);
}

/** 有界 Levenshtein：距离超过 max 返回 undefined（快速剪枝，词表遍历用）。 */
function levenshteinWithin(a: string, b: string, max: number): number | undefined {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return undefined;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = temp;
    }
  }
  const distance = dp[b.length]!;
  return distance <= max ? distance : undefined;
}

/** BM25 长度归一项。 */
function bm25(tf: number, dl: number, avgdl: number): number {
  return (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avgdl));
}

/** mtime 陈旧检测节流表（按根实例，避免跨测试/热路径相互抑制）。 */
const stalenessCheckTimes = new Map<string, number>();

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
      version: 2,
      updatedAt: new Date().toISOString(),
      entries: entries.map(
        ({ relPath, title, summary, keywords, updatedAt, authorityLayer, len }) => ({
          relPath,
          title,
          summary,
          keywords,
          updatedAt,
          authorityLayer,
          len,
        }),
      ),
      inverted: this.buildInverted(entries),
    };
    await atomicWriteFile(this.indexFile, JSON.stringify(index, null, 2), 0o600);
    return { entries: entries.length, indexFile: this.indexFile, updatedAt: index.updatedAt };
  }

  async recall(query: string): Promise<KnowledgeRecallResult> {
    const index = await this.readIndex();
    const entries = index.entries;
    const entryMap = new Map(entries.map((entry) => [entry.relPath, entry]));
    const N = entries.length;
    const avgdl = N > 0 ? entries.reduce((sum, entry) => sum + entry.len, 0) / N : 1;

    // 查询 token 集：精确分词 + 同义词扩展 + 中文整词/大词恒开混合。
    const queryTokens = new Set<string>();
    for (const token of tokenize(query)) {
      for (const expansion of SYNONYMS[token] ?? [token]) queryTokens.add(expansion);
    }
    for (const token of chineseKeywords(query)) queryTokens.add(token);

    const hits = new Map<string, { entry: KnowledgeEntry; score: number; matched: Set<string> }>();
    const zeroHitTokens: string[] = [];

    for (const token of queryTokens) {
      const postings = index.inverted[token] ?? [];
      if (postings.length === 0) {
        zeroHitTokens.push(token);
        continue;
      }
      const idf = Math.log(1 + (N - postings.length + 0.5) / (postings.length + 0.5));
      for (const posting of postings) {
        const entry = entryMap.get(posting.relPath);
        if (!entry) continue;
        const dl = Math.max(entry.len, 1);
        let fieldScore = 0;
        if (posting.titleTf > 0)
          fieldScore += FIELD_WEIGHTS.title * bm25(posting.titleTf, dl, avgdl);
        if (posting.keywordsTf > 0)
          fieldScore += FIELD_WEIGHTS.keywords * bm25(posting.keywordsTf, dl, avgdl);
        if (posting.summaryTf > 0)
          fieldScore += FIELD_WEIGHTS.summary * bm25(posting.summaryTf, dl, avgdl);
        if (posting.bodyTf > 0) fieldScore += FIELD_WEIGHTS.body * bm25(posting.bodyTf, dl, avgdl);
        const record = hits.get(entry.relPath) ?? {
          entry,
          score: 0,
          matched: new Set<string>(),
        };
        record.score += idf * fieldScore;
        record.matched.add(token);
        hits.set(entry.relPath, record);
      }
    }

    // D-042 A5：模糊/子串回退。仅对零精确命中且含拉丁/数字的 token（纯汉字靠整词/大词，跳过）。
    // 贡献 0.6×idf，保证精确命中占优。
    const vocab = Object.keys(index.inverted);
    for (const token of zeroHitTokens) {
      if (isPureHan(token)) continue;
      for (const vocabToken of vocab) {
        if (vocabToken === token) continue;
        const editLimit = vocabToken.length >= 8 ? 2 : 1;
        const distance = levenshteinWithin(token, vocabToken, editLimit);
        const substringHit =
          token.length >= 6 &&
          vocabToken.length >= 6 &&
          (vocabToken.includes(token) || token.includes(vocabToken));
        if (distance === undefined && !substringHit) continue;
        const postings = index.inverted[vocabToken]!;
        const idf =
          Math.log(1 + (N - postings.length + 0.5) / (postings.length + 0.5)) * FUZZY_WEIGHT;
        for (const posting of postings) {
          const entry = entryMap.get(posting.relPath);
          if (!entry) continue;
          const dl = Math.max(entry.len, 1);
          let fieldScore = 0;
          if (posting.titleTf > 0)
            fieldScore += FIELD_WEIGHTS.title * bm25(posting.titleTf, dl, avgdl);
          if (posting.keywordsTf > 0)
            fieldScore += FIELD_WEIGHTS.keywords * bm25(posting.keywordsTf, dl, avgdl);
          if (posting.summaryTf > 0)
            fieldScore += FIELD_WEIGHTS.summary * bm25(posting.summaryTf, dl, avgdl);
          if (posting.bodyTf > 0)
            fieldScore += FIELD_WEIGHTS.body * bm25(posting.bodyTf, dl, avgdl);
          const record = hits.get(entry.relPath) ?? {
            entry,
            score: 0,
            matched: new Set<string>(),
          };
          record.score += idf * fieldScore;
          record.matched.add(vocabToken);
          hits.set(entry.relPath, record);
        }
      }
    }

    let results = [...hits.values()].sort(
      (a, b) => b.score - a.score || a.entry.relPath.localeCompare(b.entry.relPath),
    );
    // top-K + 相关度下限。
    results = results.slice(0, TOP_K);
    const floor = results.length > 0 ? results[0]!.score * RELEVANCE_FLOOR_RATIO : 0;
    results = results.filter((record) => record.score >= floor);

    return {
      query,
      hits: await Promise.all(
        results.map(async ({ entry, score, matched }) => ({
          entry,
          score,
          matchedKeywords: [...matched],
          ...(await this.recallDetail(entry, [...matched])),
        })),
      ),
    };
  }

  /** D-041 P3-3 + D-042 A6：一次磁盘读合并 refined 证据行（`because of:`）与正文命中片段
   *  （首个命中 token 前后 ~200 字符窗口，剥 markdown）。非 refined 条目不附带证据。 */
  private async recallDetail(
    entry: KnowledgeEntry,
    matchTokens: string[],
  ): Promise<{ evidence?: string[]; snippet?: string }> {
    const file = path.join(this.root, entry.relPath.split('/').join(path.sep));
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    if (!content) return {};

    const result: { evidence?: string[]; snippet?: string } = {};
    if (entry.relPath.startsWith('lessons/refined/')) {
      const evidence = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- `because of:') || line.startsWith('`because of:'))
        .map((line) =>
          line
            .replace(/^[-*\s`]+/, '')
            .replace(/`+$/g, '')
            .trim(),
        )
        .filter(Boolean);
      if (evidence.length > 0) result.evidence = evidence;
    }

    const bodyText = stripMarkdown(content);
    for (const token of matchTokens) {
      if (token.length < 2) continue;
      const index = bodyText.toLowerCase().indexOf(token.toLowerCase());
      if (index === -1) continue;
      const start = Math.max(0, index - 80);
      const end = Math.min(bodyText.length, index + token.length + 120);
      result.snippet = bodyText.slice(start, end);
      break;
    }
    return result;
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
        cached.updatedAt !== entry.updatedAt ||
        // D-042 A7：v1 旧索引条目缺 len → 视为过期，提示重建。
        typeof (cached as IndexEntryFile).len !== 'number'
      ) {
        issues.push({
          kind: 'stale-entry',
          relPath: entry.relPath,
          detail: `索引过期：${entry.relPath}（磁盘已改或为旧版索引）。运行 agentctl knowledge rebuild ${'<agent-id>'} 重建。`,
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
      JSON.stringify(index.inverted ?? {}) !==
        JSON.stringify(this.buildInverted(onDisk as IndexableEntry[]))
    ) {
      issues.push({
        kind: 'stale-index',
        detail: '倒排索引与条目不一致。运行 agentctl knowledge rebuild 重建。',
      });
    }

    return { ok: issues.length === 0, issues };
  }

  private async scan(): Promise<IndexableEntry[]> {
    const results: IndexableEntry[] = [];
    if (!(await fs.pathExists(this.root))) return results;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        // D-041 P2-1：跳过点目录（knowledge/.archive/ 遗忘归档）与点文件（.retrieved.md 运行时
        // 便签、.index.json 等）——归档/便签不进索引、不参与 recall（保留在磁盘可恢复）。
        if (entry.name.startsWith('.')) continue;
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

  private async parseDocument(file: string, relPath: string): Promise<IndexableEntry | undefined> {
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
    const fieldTokens = {
      title: fieldTokenize(title),
      keywords: keywords.flatMap((keyword) => fieldTokenize(keyword)),
      summary: fieldTokenize(summary),
      // D-042 A1：正文入索引（token 化 + 中文整词/大词），每文档上限 MAX_BODY_TOKENS。
      body: fieldTokenize(parsed.body).slice(0, MAX_BODY_TOKENS),
    };
    const len =
      fieldTokens.title.length +
      fieldTokens.keywords.length +
      fieldTokens.summary.length +
      fieldTokens.body.length;
    return {
      relPath,
      title,
      summary,
      keywords,
      updatedAt: typeof fm.updated_at === 'string' ? fm.updated_at : new Date().toISOString(),
      authorityLayer: defaultLayerFor(relPath, fm.authority_layer),
      len,
      fieldTokens,
    };
  }

  private async readIndex(): Promise<IndexFile> {
    if (!(await fs.pathExists(this.indexFile))) {
      await this.ingest();
      return JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as IndexFile;
    }
    const existing = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as IndexFile;
    // D-042 A2/A7：v1 旧索引（缺分字段 tf/len）或磁盘新鲜度落后 → 重建一次。
    if (existing.version !== 2 || (await this.indexStale())) {
      await this.ingest();
      return JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as IndexFile;
    }
    return existing;
  }

  /** D-042 A7：索引文件 mtime 早于 knowledge/**\/*.md 最新 mtime → 陈旧。按根实例 10s 节流。 */
  private async indexStale(): Promise<boolean> {
    const now = Date.now();
    const last = stalenessCheckTimes.get(this.root) ?? 0;
    if (now - last < STALENESS_CHECK_INTERVAL_MS) return false;
    stalenessCheckTimes.set(this.root, now);
    const indexStat = await fs.stat(this.indexFile).catch(() => null);
    if (!indexStat) return true;
    const latestSource = await this.latestSourceMtime();
    return latestSource > indexStat.mtimeMs;
  }

  private async latestSourceMtime(): Promise<number> {
    let latest = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(file);
          continue;
        }
        if (!entry.name.endsWith('.md')) continue;
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.mtimeMs > latest) latest = stat.mtimeMs;
      }
    };
    await visit(this.root).catch(() => undefined);
    return latest;
  }

  /** 确定性倒排：token 排序 + posting 按 relPath 排序（verifyConsistency JSON 对比稳定）。 */
  private buildInverted(entries: IndexableEntry[]): InvertedIndex {
    const postingsByToken: Record<string, Map<string, TermPosting>> = {};
    for (const entry of entries) {
      const bump = (field: Exclude<keyof TermPosting, 'relPath'>, tokens: string[]): void => {
        for (const token of tokens) {
          let byRel = postingsByToken[token];
          if (!byRel) {
            byRel = new Map<string, TermPosting>();
            postingsByToken[token] = byRel;
          }
          let posting = byRel.get(entry.relPath);
          if (!posting) {
            posting = {
              relPath: entry.relPath,
              titleTf: 0,
              keywordsTf: 0,
              summaryTf: 0,
              bodyTf: 0,
            };
            byRel.set(entry.relPath, posting);
          }
          posting[field] += 1;
        }
      };
      bump('titleTf', entry.fieldTokens.title);
      bump('keywordsTf', entry.fieldTokens.keywords);
      bump('summaryTf', entry.fieldTokens.summary);
      bump('bodyTf', entry.fieldTokens.body);
    }
    const inverted: InvertedIndex = {};
    for (const token of Object.keys(postingsByToken).sort()) {
      inverted[token] = [...postingsByToken[token]!.values()].sort((a, b) =>
        a.relPath.localeCompare(b.relPath),
      );
    }
    return inverted;
  }
}

/** 字段级 token 化：精确分词 + 中文整词/大词混合，去重。 */
function fieldTokenize(text: string): string[] {
  return [...new Set([...tokenize(text), ...chineseKeywords(text)])];
}

function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, '')
    .replace(/[#>*_|[\]{}()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstHeading(body: string): string | undefined {
  const line = body.split('\n').find((candidate) => /^#{1,6}\s+/.test(candidate));
  return line ? line.replace(/^#{1,6}\s+/, '').trim() : undefined;
}

function keywordsFromBody(body: string): string[] {
  const tokens = tokenize(body).slice(0, 6);
  return [...new Set(tokens)];
}
