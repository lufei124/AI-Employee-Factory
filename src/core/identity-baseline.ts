// D-041 P0-3：身份基线 + 双真相消解。
//
// 双真相消解：`agent.yaml.description` 是岗位定位的唯一权威。ROLE.md 的 `# 岗位定位` 段由
// 系统从 description 渲染（创建 + 回填时写），员工不直改该段；其余身份文档（GOALS/
// OPERATING_SYSTEM/POLICIES）为「可进化区」，员工自主，但改动必须可 diff、可回溯。
//
// `ensureIdentityBaseline`：幂等快照四份身份文档的标题结构 + 内容到 `agent/IDENTITY_BASELINE.md`
// （含 sha256 标记与生成时间），作为「身份漂移」的对比基线。系统每次重写基线（ROLE 岗位定位
// 渲染 / 回填）后刷新基线，使基线始终代表系统认可的权威内容。
//
// `baselineDrift`：按文件返回 `{added, removed, changed}` 差异摘要（供 doctor 与进化历史）。
// `allowedIdentityDiff`：改动行占比 < 30% + 未删受保护标题 + 红线词仍在 → 判「可进化」；
// 整删/重写 → 疑似漂移（doctor warn）。
//
// 基线文件本身由系统写入，不参与员工自进化提交（不属 commitSelfEvolution 的 relPaths）；
// 写盘走 gitCommitFile（evolve: 更新 IDENTITY_BASELINE.md）使基线版本化可回溯。

import fs from 'fs-extra';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './atomic.js';
import { validateIdentityGuard } from './identity-guard.js';

/** 基线文件相对工作区的路径。 */
export const IDENTITY_BASELINE_FILE = 'agent/IDENTITY_BASELINE.md';

/** 五份身份文档（相对工作区）。D-041 P1-3 起包含 CONSTITUTION.md——宪法区同样是
 *  员工不可静默改动的身份文档，纳入基线快照供提案对账（appliedWithoutAnchor）。 */
export const IDENTITY_DOCS = [
  'agent/ROLE.md',
  'agent/GOALS.md',
  'agent/OPERATING_SYSTEM.md',
  'agent/POLICIES.md',
  'agent/CONSTITUTION.md',
] as const;

export type IdentityDoc = (typeof IDENTITY_DOCS)[number];

/** 单份身份文档的基线记录。 */
export interface DocBaseline {
  /** sha256 内容摘要（trim 后）。 */
  sha256: string;
  /** 一级/二级标题清单（trim 后按序），用于「标题结构漂移」检测。 */
  headings: string[];
  /** 全文（trim 后）。 */
  content: string;
}

/** 基线快照内容（写入 IDENTITY_BASELINE.md 的结构）。 */
export interface IdentityBaseline {
  schema_version: 1;
  generated_at: string;
  /** 权威 description（agent.yaml.description，岗位定位唯一来源）。 */
  description: string;
  /** 各身份文档基线。 */
  docs: Record<IdentityDoc, DocBaseline>;
}

/** 渲染基线文档全文（含生成头，供人类/doctor 阅读）。 */
export function renderIdentityBaseline(baseline: IdentityBaseline): string {
  const lines: string[] = [
    '<!-- 本文件由系统自动生成（D-041 P0-3 身份基线）。内容为员工身份文档的权威快照，',
    '     用于检测「身份漂移」（员工/进程未经授权的删除或重写）。不要手动编辑本文件，',
    '     系统在每次身份文档回填/渲染后自动刷新。 -->',
    '',
    '# 身份基线',
    '',
    `- 生成时间：${baseline.generated_at}`,
    `- 岗位定位唯一权威：\`agent.yaml.description\`（ROLE.md 的 \`# 岗位定位\` 段由系统渲染，员工不直改）`,
    '',
    `## 权威描述（agent.yaml.description）`,
    '',
    baseline.description,
    '',
  ];
  for (const doc of IDENTITY_DOCS) {
    const entry = baseline.docs[doc];
    lines.push(`## ${doc}`, '');
    lines.push(`- sha256：\`${entry.sha256}\``, '');
    lines.push('### 标题结构', '');
    for (const heading of entry.headings) lines.push(`- \`${heading}\``);
    lines.push('', '### 全文', '', '```md', entry.content, '```', '');
  }
  return lines.join('\n');
}

/** 从文件内容提取 sha256 与标题清单（纯函数）。 */
export function snapshotDoc(content: string): DocBaseline {
  const trimmed = content.trim();
  return {
    sha256: createHash('sha256').update(trimmed).digest('hex'),
    headings: trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^#{1,2}\s+/.test(line))
      .map((line) => line.replace(/^#{1,2}\s+/, '').trim()),
    content: trimmed,
  };
}

/** 读取员工工作区的四份身份文档内容（缺文件视为空字符串，供快照）。 */
async function readIdentityDocs(workspace: string): Promise<Record<IdentityDoc, string>> {
  const result = {} as Record<IdentityDoc, string>;
  for (const doc of IDENTITY_DOCS) {
    result[doc] = await fs.readFile(path.join(workspace, doc), 'utf8').catch(() => '');
  }
  return result;
}

/** 解析基线文档回到 IdentityBaseline（供 baselineDrift / doctor 读取）。失败返回 null。 */
export function parseIdentityBaseline(content: string): IdentityBaseline | null {
  try {
    // 从渲染文本反解：authority description 在「## 权威描述」后首个非空行；各文档块按
    // 「## agent/<doc>」标题切分，取「### 全文」后 ```md ``` 代码块内容重新快照。
    const sections = content.split(/(?=^## agent\/)/m);
    const docs = {} as Record<IdentityDoc, DocBaseline>;
    for (const section of sections.slice(1)) {
      const doc = IDENTITY_DOCS.find((d) => section.startsWith(`## ${d}`));
      if (!doc) continue;
      const codeBlock = /```md\n([\s\S]*?)\n```/.exec(section);
      if (codeBlock?.[1] !== undefined) docs[doc] = snapshotDoc(codeBlock[1]);
    }
    const descriptionMatch =
      /## 权威描述（agent\.yaml\.description）\n\n([\s\S]*?)\n\n## agent\//.exec(content);
    return {
      schema_version: 1,
      generated_at: /- 生成时间：(.+)$/m.exec(content)?.[1] ?? '',
      description: descriptionMatch?.[1]?.trim() ?? '',
      docs,
    };
  } catch {
    return null;
  }
}

/**
 * 幂等确保身份基线存在：读四份文档 + agent.yaml.description 生成快照写入。
 * 幂等判定忽略 generated_at（每次调用都变），仅当描述或任一文档内容与既有基线不一致时
 * 才重写并返回 wrote=true（供调用方决定是否走自进化提交）；完全一致则跳过写盘（mtime 不变，
 * 不产生 evolve 提交）。
 *
 * D-041 P1-3：`excludeDocs` 供身份对账（enforced 模式）使用——被判定为未授权改动的文档
 * **不吸收进基线**（保留既有基线条目），防止违规改动被基线快照认可后在下次 settle 被放行提交。
 */
export async function ensureIdentityBaseline(input: {
  workspace: string;
  description: string;
  excludeDocs?: readonly string[];
}): Promise<{ wrote: boolean; baseline: IdentityBaseline }> {
  const { workspace, description, excludeDocs = [] } = input;
  const contents = await readIdentityDocs(workspace);
  const excludedSet = new Set(excludeDocs);
  const existingFile = await fs
    .readFile(path.join(workspace, IDENTITY_BASELINE_FILE), 'utf8')
    .catch(() => '');
  const existing = existingFile.trim() ? parseIdentityBaseline(existingFile) : null;
  const docs = {} as Record<IdentityDoc, DocBaseline>;
  for (const doc of IDENTITY_DOCS) {
    // 被排除的文档沿用既有基线条目（不重快照），使违规改动不被吸收。
    docs[doc] =
      excludedSet.has(doc) && existing?.docs[doc] ? existing.docs[doc] : snapshotDoc(contents[doc]);
  }
  const sameAsExisting =
    existing !== null &&
    existing.description === description &&
    IDENTITY_DOCS.every((doc) => existing.docs[doc]?.sha256 === docs[doc].sha256);
  if (sameAsExisting) {
    return { wrote: false, baseline: { ...existing!, generated_at: existing!.generated_at, docs } };
  }

  const baseline: IdentityBaseline = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    description,
    docs,
  };
  await atomicWriteFile(
    path.join(workspace, IDENTITY_BASELINE_FILE),
    renderIdentityBaseline(baseline),
    0o644,
  );
  return { wrote: true, baseline };
}

/** 单文件相对基线的行级差异（trim 后逐行对比，保持基线行序）。 */
export interface DocDrift {
  /** 与基线相比新增的行（trim 后对比，仅存在于当前内容）。 */
  added: string[];
  /** 与基线相比被移除的行（仅存在于基线内容）。 */
  removed: string[];
  /** 基线行数。 */
  baselineLines: number;
  /** 当前内容 sha256 是否与基线一致。 */
  changed: boolean;
}

/** 计算单文件相对基线的行级差异（trim 后逐行对比，保持基线行序）。 */
export function diffDoc(current: string, baseline: DocBaseline): DocDrift {
  const currentLines = current.trim().split('\n');
  const baselineLines = baseline.content.split('\n');
  const baselineSet = new Set(baselineLines.map((line) => line.trim()));
  const currentSet = new Set(currentLines.map((line) => line.trim()));
  const added = currentLines.map((line) => line.trim()).filter((line) => !baselineSet.has(line));
  const removed = baselineLines.map((line) => line.trim()).filter((line) => !currentSet.has(line));
  return {
    added,
    removed,
    baselineLines: baselineLines.length,
    changed: createHash('sha256').update(current.trim()).digest('hex') !== baseline.sha256,
  };
}

/** 全部身份文档的漂移摘要（相对基线）。 */
export interface BaselineDrift {
  /** 各文档漂移（仅 changed 的文档）。 */
  docs: Partial<Record<IdentityDoc, DocDrift>>;
  /** 是否有任何文档漂移。 */
  drift: boolean;
}

/** 计算员工工作区身份文档相对基线的漂移。基线缺失时返回 null（调用方处理）。 */
export async function baselineDrift(workspace: string): Promise<BaselineDrift | null> {
  const baselineContent = await fs
    .readFile(path.join(workspace, IDENTITY_BASELINE_FILE), 'utf8')
    .catch(() => '');
  if (!baselineContent.trim()) return null;
  const baseline = parseIdentityBaseline(baselineContent);
  if (!baseline) return null;
  const contents = await readIdentityDocs(workspace);
  const docs: BaselineDrift['docs'] = {};
  for (const doc of IDENTITY_DOCS) {
    const entry = baseline.docs[doc];
    if (!entry) continue;
    const drift = diffDoc(contents[doc], entry);
    if (drift.changed) docs[doc] = drift;
  }
  return { docs, drift: Object.keys(docs).length > 0 };
}

/** 身份文档漂移是否在「可进化」范围内（供提案对账 / doctor）。
 *  - 改动行占比 = (added + removed) / max(当前行数, 基线行数) < 30%；
 *  - 未删受保护标题（ROLE 岗位定位/长期职责）；
 *  - 红线词仍在（POLICIES）。
 *  整删/重写（改动占比过高或锚点缺失）→ 疑似漂移。 */
export function allowedIdentityDiff(
  relPath: string,
  current: string,
  baseline: DocBaseline,
): boolean {
  const drift = diffDoc(current, baseline);
  const currentLines = current.trim().split('\n').length;
  const totalLines = Math.max(currentLines, drift.baselineLines, 1);
  const changed = drift.added.length + drift.removed.length;
  if (changed / totalLines >= 0.3) return false;
  // 锚点硬门复用 identity-guard：ROLE 标题 / POLICIES 红线词仍在。
  return validateIdentityGuard(relPath, current).ok;
}
