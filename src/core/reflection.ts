// D-041 P1-2 二级：经验提炼的「重要性累积」触发层。
//
// 对齐前沿模式（Generative Agents poignancy、Reflexion 滑动窗口）：反思按「重要性累积」
// 触发，而非每轮都提炼（每轮提炼=噪音 + 成本）。一级原始记录（lessons/raw/）始终落盘，
// 二级提炼仅在累积信号达标时发生，产出进 lessons/refined/ 并带 `because of raw/<file>:<line>`
// 证据引用。
//
// 信号文件：`knowledge/.reflection-signals.jsonl`（每行一个 JSON：{date, importance, topics,
// transcriptFile}）。纯追加；读侧按需截断（上限见 readReflectionSignals）。

import fs from 'fs-extra';
import path from 'node:path';

export const REFLECTION_SIGNALS_FILE = 'knowledge/.reflection-signals.jsonl';

/** 累积到多少 importance 触发一次提炼。 */
export const REFLECTION_THRESHOLD = 3;

/** 距上次提炼超过 24h 也触发一次（保底，避免长期不提炼）。 */
export const REFLECTION_MAX_IDLE_HOURS = 24;

export interface ReflectionSignal {
  date: string;
  /** 轻量启发式重要性（0-5）：主题/决策/经验越丰富越重要。 */
  importance: number;
  topics: string[];
  /** 本次会话的决策要点（脱敏后，供二级提炼输入）。 */
  decisions?: string[];
  /** 本次会话的经验教训（脱敏后，供二级提炼输入）。 */
  lessons?: string[];
  transcriptFile: string;
}

/** 轻量启发式：单次 transcript 的重要性评分（纯函数）。
 *  基准 1，每有决策 +1，每有经验 +1，主题超过 1 个额外 +1，封顶 5。 */
export function estimateImportance(input: {
  topics: string[];
  decisions: string[];
  lessons: string[];
}): number {
  const { topics, decisions, lessons } = input;
  let score = 1;
  score += Math.min(decisions.length, 2);
  score += Math.min(lessons.length, 2);
  if (topics.length > 1) score += 1;
  return Math.min(score, 5);
}

/** 追加一条反射信号到信号文件（原子写，0600）。 */
export async function appendReflectionSignal(
  signalsFile: string,
  signal: ReflectionSignal,
): Promise<void> {
  await fs.ensureDir(path.dirname(signalsFile));
  await fs.appendFile(signalsFile, `${JSON.stringify(signal)}\n`, { mode: 0o600 });
}

/** 读取全部反射信号（行损坏跳过）。 */
export async function readReflectionSignals(signalsFile: string): Promise<ReflectionSignal[]> {
  const content = await fs.readFile(signalsFile, 'utf8').catch(() => '');
  const signals: ReflectionSignal[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ReflectionSignal;
      if (parsed && typeof parsed.importance === 'number') signals.push(parsed);
    } catch {
      // 损坏行跳过（员工/系统并发写的边角，不阻断）。
    }
  }
  return signals;
}

/** 累计 importance（未达阈值前持续累加）。 */
export function accumulatedImportance(signals: ReflectionSignal[]): number {
  return signals.reduce((sum, signal) => sum + signal.importance, 0);
}

/** 是否触发一次提炼（纯函数，供测试与调用方决策）。
 *  - 累积 importance >= threshold（按信号从新到旧累加至阈值）；
 *  - 或距上次提炼超过 MAX_IDLE 小时（保底；从未提炼时以最早信号时间为参照，避免首条消息即触发）。
 *  @param lastRefinedAt 上次提炼文件的 ISO 时间；null 表示从未提炼（以最早信号为参照）。 */
export function shouldReflect(
  signals: ReflectionSignal[],
  options: { lastRefinedAt?: string | null; threshold?: number; maxIdleHours?: number } = {},
): boolean {
  const threshold = options.threshold ?? REFLECTION_THRESHOLD;
  const maxIdleHours = options.maxIdleHours ?? REFLECTION_MAX_IDLE_HOURS;
  if (accumulatedImportance(signals) >= threshold) return true;
  // 距上次提炼过久（保底触发）。从未提炼时以最早信号时间为参照——新员工首条消息
  // 一般不触发，符合「按重要性累积而非每轮」；信号积累超过保底窗口仍未达阈值则兜底。
  let since: number;
  if (options.lastRefinedAt) {
    since = Date.parse(options.lastRefinedAt);
    if (Number.isNaN(since)) return true; // 损坏的时间戳：保守触发一次。
  } else if (signals.length > 0) {
    const earliest = signals[0];
    if (!earliest) return false; // 防御：信号列表为空（并发下读到截断边缘）。
    since = Date.parse(earliest.date);
    if (Number.isNaN(since)) return true;
  } else {
    return false; // 无信号无提炼记录：不触发。
  }
  const idleHours = (Date.now() - since) / 3_600_000;
  return idleHours >= maxIdleHours;
}

/** 截断信号文件：超上限（默认 5000 行）只保留最近 N 行，防无限累积（D-041 P2-3 同源策略）。
 *  超限时把最早的一批信号**压缩为一行摘要**（统计+主题聚合），再保留最近的原始行——比
 *  直接丢最旧行多留一层统计痕迹（何时产生过多少信号），对齐「账本超限压缩为摘要」的 P2-3 目标。 */
export async function truncateReflectionSignals(
  signalsFile: string,
  maxLines = 5000,
): Promise<void> {
  const content = await fs.readFile(signalsFile, 'utf8').catch(() => '');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return;
  // 压缩最早的一批为一行摘要，保留最近 maxLines-1 行原始 + 1 行摘要 = maxLines。
  const keepRaw = maxLines - 1;
  const raw = lines.slice(-keepRaw);
  const early = lines.slice(0, lines.length - keepRaw);
  const summary = summarizeReflectionSignals(early);
  await fs.writeFile(signalsFile, [...(summary ? [summary] : []), ...raw].join('\n') + '\n', {
    mode: 0o600,
  });
}

/** 把一批信号行压缩为一行摘要 JSON（统计 + 主题聚合）。行损坏则跳过。 */
export function summarizeReflectionSignals(lines: readonly string[]): string | undefined {
  const signals: ReflectionSignal[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ReflectionSignal;
      if (parsed && typeof parsed.importance === 'number') signals.push(parsed);
    } catch {
      // 损坏行跳过。
    }
  }
  if (signals.length === 0) return undefined;
  const topics = [...new Set(signals.flatMap((signal) => signal.topics ?? []))].slice(0, 20);
  const first = signals[0]?.date ?? '';
  const last = signals.at(-1)?.date ?? '';
  return JSON.stringify({
    date: last,
    summary: true,
    importance: signals.reduce((sum, signal) => sum + signal.importance, 0),
    count: signals.length,
    span: first && last && first !== last ? `${first}..${last}` : last,
    topics,
    transcriptFile: `#${signals.length} 条早期信号摘要`,
  });
}

/** 员工工作区内的信号文件路径。 */
export function reflectionSignalsPath(workspace: string): string {
  return path.join(workspace, REFLECTION_SIGNALS_FILE);
}
