import fs from 'fs-extra';
import type { TranscriptSummary } from './transcript.js';

// D-034：Skill 机会检测器。从 transcript 摘要中识别"重复出现的可复用工作模式"，
// 达到阈值后触发员工自生成 Skill（配合 skill-generator）。
//
// 纯函数部分（pickCandidateTopic / detectRepeatedSkillOpportunity）零 I/O，便于单元测试；
// 信号持久化（readSkillSignals / appendSkillSignal）依赖 .skill-signals.jsonl（0600，append）。

/** 当下会话中出现的、可能值得沉淀为 Skill 的主题关键词。 */
export interface SkillSignalHistory {
  /** topic -> 最近窗口内出现次数。 */
  topics: Record<string, number>;
}

/** 触发"这是可复用动作"信号的 lessons 关键词。 */
export const REPEAT_SIGNAL_WORDS = ['重复', '每次', '总是', '下次', '反复', '再次', '常常'];

/** 一条信号记录（.skill-signals.jsonl 的每行）。 */
interface SkillSignalRecord {
  topic: string;
  date: string;
}

/** 从 transcript 摘要中提取本次候选 topic：优先选与"含重复信号词的 lessons"文字相关的 topic，
 *  否则取第一个 topic；无重复信号返回 null。 */
export function pickCandidateTopic(summary: TranscriptSummary): string | null {
  const signalLessons = summary.lessons.filter((lesson) =>
    REPEAT_SIGNAL_WORDS.some((word) => lesson.includes(word)),
  );
  if (signalLessons.length === 0) return null;
  for (const topic of summary.topics) {
    if (
      signalLessons.some((lesson) => lesson.includes(topic) || topic.includes(lesson.slice(0, 4)))
    ) {
      return topic;
    }
  }
  return summary.topics[0] ?? null;
}

/** 判断某候选 topic 是否已达重复阈值（含本次）。命中返回累计次数，供调用方写回历史。
 *  已存在同名 skill 时视为已覆盖，返回 null。 */
export function detectRepeatedSkillOpportunity(
  summary: TranscriptSummary,
  history: SkillSignalHistory,
  existingSkillNames: string[],
  threshold = 2,
): { topic: string; brief: string; count: number } | null {
  const candidate = pickCandidateTopic(summary);
  if (!candidate) return null;
  if (existingSkillNames.includes(candidate)) return null;
  const count = (history.topics[candidate] ?? 0) + 1;
  if (count < threshold) return null;
  return { topic: candidate, brief: `把「${candidate}」沉淀为可复用 Skill。`, count };
}

/** 读取信号文件，仅统计最近 windowDays 天内的 topic 出现次数（best-effort，坏行跳过）。 */
export async function readSkillSignals(file: string, windowDays = 7): Promise<SkillSignalHistory> {
  const topics: Record<string, number> = {};
  if (!(await fs.pathExists(file))) return { topics };
  const cutoff = Date.now() - windowDays * 86_400_000;
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as SkillSignalRecord;
      if (new Date(record.date).getTime() < cutoff) continue;
      topics[record.topic] = (topics[record.topic] ?? 0) + 1;
    } catch {
      // 坏行跳过，不阻断。
    }
  }
  return { topics };
}

/** 追加一条信号记录到信号文件（0600，append）。 */
export async function appendSkillSignal(file: string, topic: string): Promise<void> {
  await fs.appendFile(file, `${JSON.stringify({ topic, date: new Date().toISOString() })}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'a',
  });
}
