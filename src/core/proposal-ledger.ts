// D-041 P1-3：身份修订对账账本（硬门）。
//
// 背景：四区模型下「人工只能通过飞书聊天改身份」，但系统层需要防住「员工绕过聊天、
// 未经用户批准就自行大改核心身份」。本模块提供两条防线：
//
// 1. **提案账本**（轻量 JSONL，`~/.ai-employees/logs/proposals/<agent-id>.jsonl`，0600）：
//    - `recordProposal`：员工写提案（agent/proposals/*.md）时留一行（status、target_file、
//      proposal_id）。best-effort，失败不阻断主流程。
//    - `recordDecision`：提案被批准（用户批准，员工标 `applied`）或拒绝（`rejected`）时
//      追加决策行——**带 user_anchor**（用户在飞书中的原话/截图，批准依据）。
//    - `readLedger`：回读账本（供 appliedWithoutAnchor / doctor / CLI 查询）。
//    - `truncateLedger`：账本上限（5000 行）防无限累积（P2-3）。
//
// 2. **对账校验**：`appliedWithoutAnchor(workspace, ledger)`——身份文档（ROLE/POLICIES/
//    CONSTITUTION）相对基线的改动若**超出 allowedIdentityDiff 范围**（整删/重写/锚点缺失），
//    且账本里没有带 `user_anchor` 的 `applied` 提案 → 判定「未授权身份改动」（违规）。
//    逻辑：显著的合法身份改动必有一份 `applied` + `user_anchor` 的提案作依据；没有依据的
//    显著改动即未经用户批准，系统应拒绝提交/告警。
//
// 3. **协议执行**：`maybeEnforceIdentityProtocol` 按 `identity_protocol` 分级：
//    - 默认 `advisory`（宽松）：仅 console.warn 留痕，不阻断提交。
//    - `enforced`（用户显式开启）：违规文件**不提交** + warn + CURRENT_STATE 记录「检测到
//      未授权身份改动已拒绝提交」。**提交拒绝 ≠ 恢复文件**——保留工作区脏文件供人工
//      `git diff` / `git checkout` 决策，不悄悄回滚。
//
// 账本写入一律 best-effort（recordProposal/recordDecision 失败仅 warn，不抛错），与
// usage-log 同思路：对账读不到账本时按「无批准依据」从严处理（宁可多 warn，不可放过未授权改动）。

import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import {
  IDENTITY_BASELINE_FILE,
  allowedIdentityDiff,
  baselineDrift,
  parseIdentityBaseline,
  type DocBaseline,
} from './identity-baseline.js';

/** 提案账本文件（相对日志根目录）。 */
export const PROPOSAL_LEDGER_FILE = 'proposals';

/** 提案状态机取值。 */
export const PROPOSAL_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'applied',
  'expired',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** 提案变更的目标文件类型。 */
export const PROPOSAL_KINDS = ['identity', 'policy', 'goal'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** 提案文件 frontmatter 解析结果（宽容解析：缺字段时为 undefined，不抛错）。 */
export interface ProposalFrontmatter {
  proposal_id?: string;
  kind?: ProposalKind;
  status?: ProposalStatus;
  target_file?: string;
  proposed_at?: string;
  user_anchor?: string;
}

/** 提案账本行：提案登记。 */
export interface ProposalLedgerRow {
  ts: string;
  /** 事件类型。 */
  event: 'proposal';
  proposal_id: string;
  kind?: ProposalKind;
  target_file?: string;
  status: ProposalStatus;
}

/** 提案账本行：决策登记（用户批准/拒绝后，员工标记时由系统写入）。 */
export interface DecisionLedgerRow {
  ts: string;
  event: 'decision';
  proposal_id: string;
  decision: 'approved' | 'rejected';
  target_file?: string;
  /** 用户在飞书中的原话/截图（批准依据）。applied 决策必填。 */
  user_anchor?: string;
}

export type LedgerRow = ProposalLedgerRow | DecisionLedgerRow;

/** 解析提案文件 frontmatter（YAML 头，宽容：解析失败返回空对象，不抛错）。 */
export function parseProposalFrontmatter(content: string): ProposalFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return {};
  const out: ProposalFrontmatter = {};
  for (const line of match[1].split('\n')) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey?.trim();
    const value = rest.join(':').trim();
    if (!key || !value) continue;
    if (key === 'proposal_id') out.proposal_id = value;
    else if (key === 'kind') out.kind = value as ProposalKind;
    else if (key === 'status') out.status = value as ProposalStatus;
    else if (key === 'target_file') out.target_file = value;
    else if (key === 'proposed_at') out.proposed_at = value;
    else if (key === 'user_anchor') out.user_anchor = value;
  }
  return out;
}

/** 提案账本路径：`<logsRoot>/proposals/<agent-id>.jsonl`。 */
export function proposalLedgerPath(logsRoot: string, agentId: string): string {
  return path.join(logsRoot, PROPOSAL_LEDGER_FILE, `${agentId}.jsonl`);
}

/** 读取账本全部行（损坏行跳过不阻断）。文件不存在返回 []。 */
export async function readLedger(logsRoot: string, agentId: string): Promise<LedgerRow[]> {
  const file = proposalLedgerPath(logsRoot, agentId);
  const content = await fs.readFile(file, 'utf8').catch(() => '');
  const rows: LedgerRow[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as LedgerRow);
    } catch {
      // 损坏行跳过，不阻断对账（与 usage-log 容错一致）。
    }
  }
  return rows;
}

/** 追加一行账本（JSONL，0600）。best-effort——失败仅告警，不抛错阻断主流程。 */
export async function appendLedgerRow(
  logsRoot: string,
  agentId: string,
  row: LedgerRow,
): Promise<void> {
  try {
    const file = proposalLedgerPath(logsRoot, agentId);
    await fs.ensureDir(path.dirname(file));
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(
      `[proposal-ledger] 写入账本失败（跳过）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 登记员工提案：读到 agent/proposals/*.md 的 frontmatter 时留痕。 */
export async function recordProposal(
  logsRoot: string,
  agentId: string,
  frontmatter: ProposalFrontmatter,
): Promise<void> {
  await appendLedgerRow(logsRoot, agentId, {
    ts: new Date().toISOString(),
    event: 'proposal',
    proposal_id: frontmatter.proposal_id ?? 'unknown',
    ...(frontmatter.kind !== undefined ? { kind: frontmatter.kind } : {}),
    ...(frontmatter.target_file !== undefined ? { target_file: frontmatter.target_file } : {}),
    status: frontmatter.status ?? 'proposed',
  });
}

/** 登记提案决策（批准/拒绝）。批准（applied）须带 user_anchor——批准依据来自用户在飞书聊天。 */
export async function recordDecision(
  logsRoot: string,
  agentId: string,
  input: {
    proposal_id: string;
    decision: 'approved' | 'rejected';
    target_file?: string;
    user_anchor?: string;
  },
): Promise<void> {
  await appendLedgerRow(logsRoot, agentId, {
    ts: new Date().toISOString(),
    event: 'decision',
    proposal_id: input.proposal_id,
    decision: input.decision,
    ...(input.target_file !== undefined ? { target_file: input.target_file } : {}),
    ...(input.user_anchor !== undefined ? { user_anchor: input.user_anchor } : {}),
  });
}

/** 账本上限（行数）。超限只保留最近 maxLines 行（P2-3）。 */
export const PROPOSAL_LEDGER_MAX_LINES = 5000;

/** 截断账本到最近 maxLines 行。best-effort。 */
export async function truncateLedger(
  logsRoot: string,
  agentId: string,
  maxLines = PROPOSAL_LEDGER_MAX_LINES,
): Promise<void> {
  try {
    const file = proposalLedgerPath(logsRoot, agentId);
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length <= maxLines) return;
    await atomicWriteFile(file, `${lines.slice(-maxLines).join('\n')}\n`, 0o600);
  } catch {
    // best-effort：截断失败不影响主流程。
  }
}

/** 对账结果：某份身份文档的漂移是否构成「未授权身份改动」。 */
export interface UnauthorizedChange {
  relPath: string;
  /** 违规判定依据（人类可读）。 */
  reason: string;
}

/** 账本里是否有带 user_anchor 的 applied 提案（对 target_file 生效）。 */
export function hasApprovedAnchor(ledger: readonly LedgerRow[], targetFile?: string): boolean {
  return ledger.some(
    (row) =>
      row.event === 'decision' &&
      row.decision === 'approved' &&
      Boolean(row.user_anchor?.trim()) &&
      (targetFile === undefined || row.target_file === targetFile),
  );
}

/**
 * 对账：身份文档（ROLE/POLICIES/CONSTITUTION）相对基线的改动超出可进化范围，且无
 * 带 user_anchor 的 applied 提案 → 未授权身份改动。
 *
 * - 基线缺失（IDENTITY_BASELINE.md 不存在/不可解析）→ 返回空（无基线无从对账，交给
 *   doctor 的 identity-baseline 检查项告警；不在此硬判，避免存量员工首次 settle 误伤）。
 * - 只对「受保护身份区」对账：ROLE.md / POLICIES.md / CONSTITUTION.md。可进化区
 *   （GOALS / OPERATING_SYSTEM / knowledge / skills）由员工自主，不走提案门。
 * - `allowedIdentityDiff` 判定为「可进化」的小幅改动 → 不算违规（无需提案依据）。
 */
export async function appliedWithoutAnchor(
  workspace: string,
  ledger: readonly LedgerRow[],
): Promise<UnauthorizedChange[]> {
  const drift = await baselineDrift(workspace);
  if (!drift) return [];
  // 读取基线快照（供 allowedIdentityDiff 对比原文）。缺失/不可解析时本函数返回空：
  // 无基线无从对账，交给 doctor 的 identity-baseline 检查项告警，避免存量首次 settle 误伤。
  const baselineFile = await fs
    .readFile(path.join(workspace, IDENTITY_BASELINE_FILE), 'utf8')
    .catch(() => '');
  const baseline = baselineFile.trim() ? parseIdentityBaseline(baselineFile) : null;
  const result: UnauthorizedChange[] = [];
  const protectedDocs = ['agent/ROLE.md', 'agent/POLICIES.md', 'agent/CONSTITUTION.md'] as const;
  for (const relPath of protectedDocs) {
    if (!drift.docs[relPath]) continue; // 无漂移
    const baselineEntry: DocBaseline | undefined = baseline?.docs[relPath];
    if (!baselineEntry) continue;
    const current = await fs.readFile(path.join(workspace, relPath), 'utf8').catch(() => '');
    if (allowedIdentityDiff(relPath, current, baselineEntry)) continue; // 可进化区判定通过
    const anchored = hasApprovedAnchor(ledger, relPath);
    if (anchored) continue; // 有批准依据
    result.push({
      relPath,
      reason: `${relPath} 相对身份基线发生超出可进化范围（>30% 行改动或锚点缺失）的改动，但账本中没有带 user_anchor 的 applied 提案作为批准依据。`,
    });
  }
  return result;
}

/** identity_protocol 值（与 agent-schema 一致，本地镜像避免循环依赖）。 */
export type IdentityProtocol = 'advisory' | 'enforced';

export interface EnforceResult {
  /** 是否实际拦截（enforced + 有违规）。 */
  blocked: boolean;
  /** 违规清单（可能为空）。 */
  unauthorized: UnauthorizedChange[];
}

/** 读取员工身份协议模式（agent.yaml 缺失时默认 advisory）。 */
export async function readIdentityProtocol(workspace: string): Promise<IdentityProtocol> {
  try {
    const doc = YAML.parse(await fs.readFile(path.join(workspace, 'agent.yaml'), 'utf8')) as {
      memory?: { identity_protocol?: IdentityProtocol };
    };
    return doc.memory?.identity_protocol ?? 'advisory';
  } catch {
    return 'advisory';
  }
}

/**
 * 执行身份协议：对账身份文档改动，按协议级别处置。
 * - `advisory`（默认）：仅 console.warn 留痕，不阻断（返回 blocked=false）。
 * - `enforced`：违规文件不提交 + CURRENT_STATE 记录「检测到未授权身份改动已拒绝提交」。
 *   **提交拒绝 ≠ 恢复文件**：保留工作区脏文件供人工 git diff / checkout 决策。
 *
 * 返回值 blocked=true 表示调用方（commitSelfEvolution）应跳过违规文件的提交。
 */
export async function maybeEnforceIdentityProtocol(input: {
  workspace: string;
  agentId: string;
  logsRoot: string;
  protocol: IdentityProtocol;
  /** CURRENT_STATE 记录函数（enforced + 违规时调用）。缺省不记录。 */
  recordState?: (message: string) => Promise<void>;
}): Promise<EnforceResult> {
  const { workspace, agentId, logsRoot, protocol, recordState } = input;
  if (protocol !== 'enforced') return { blocked: false, unauthorized: [] };
  const ledger = await readLedger(logsRoot, agentId);
  const unauthorized = await appliedWithoutAnchor(workspace, ledger);
  if (unauthorized.length === 0) return { blocked: false, unauthorized: [] };
  for (const entry of unauthorized) {
    console.warn(
      `[identity-protocol] 检测到未授权身份改动（enforced）：${entry.reason} ` +
        `已拒绝提交 ${entry.relPath}，保留工作区脏文件供人工决策。`,
    );
  }
  if (recordState) {
    const message = `检测到未授权身份改动已拒绝提交：${unauthorized.map((u) => u.relPath).join('、')}`;
    await recordState(message).catch(() => undefined);
  }
  return { blocked: true, unauthorized };
}
