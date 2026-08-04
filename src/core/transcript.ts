import fs from 'fs-extra';
import path from 'node:path';
import { redactSecrets } from './secrets.js';

// OP1 Stage C：chat transcript 持久化。弥合 A1——runInteractive 当前不落盘 transcript。
// 摘要非全量原文（D-006 对齐），secret 经 SECRET_PATTERN 过滤；全量原文默认不落盘，
// 仅用户显式 opt-in（agent.yaml.memory.transcript_persist=true）时写 logs/<id>/runs/<slug>/transcript.jsonl（0600）。

/** 会话摘要（摘要级，非全量原文）。 */
export interface TranscriptSummary {
  agent_id: string;
  operation: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  /** 主题关键词（best-effort 从输出提取）。 */
  topics: string[];
  /** 决策要点（best-effort 抽取含"决策/决定/结论"的尾行）。 */
  decisions: string[];
  /** 经验教训（best-effort 抽取含"经验/教训/下次"的尾行）。 */
  lessons: string[];
  /** 最后 N 行输出的脱敏片段，便于人工回看上下文。 */
  tail: string[];
}

export interface TranscriptSink {
  /** 写入一行摘要到 transcript.jsonl（0600）。返回写入的文件路径。 */
  persist(summary: TranscriptSummary): Promise<string>;
}

/** 按行追加写 transcript.jsonl。行内容为 JSON，secret 已脱敏。 */
export class FileTranscriptSink implements TranscriptSink {
  constructor(private readonly file: string) {}

  async persist(summary: TranscriptSummary): Promise<string> {
    await fs.ensureDir(path.dirname(this.file));
    await fs.writeFile(this.file, `${JSON.stringify(summary)}\n`, { flag: 'a', mode: 0o600 });
    await fs.chmod(this.file, 0o600);
    return this.file;
  }
}

// 从输出文本提取摘要字段的纯函数（零 I/O）。供 runLogged/runInteractive 完成后 best-effort 生成。

const TOPIC_LINE_PATTERN = /^(?:#|##)\s+(.+)$/gm;
const DECISION_PATTERN = /(?:决策|决定|结论|decided|decision)/i;
const LESSON_PATTERN = /(?:经验|教训|下次|lesson|learn)/i;

export function summarizeTranscript(input: {
  agentId: string;
  operation: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  outputLines: string[];
  maxTopics?: number;
  maxTail?: number;
}): TranscriptSummary {
  const { agentId, operation, startedAt, finishedAt, exitCode } = input;
  const maxTopics = input.maxTopics ?? 6;
  const maxTail = input.maxTail ?? 20;
  const lines = input.outputLines;
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const match of lines.join('\n').matchAll(TOPIC_LINE_PATTERN)) {
    const topic = match[1]?.trim();
    if (topic && !seen.has(topic)) {
      seen.add(topic);
      topics.push(topic);
      if (topics.length >= maxTopics) break;
    }
  }
  const decisions: string[] = [];
  const lessons: string[] = [];
  for (const line of lines) {
    if (line.length > 200) continue;
    if (DECISION_PATTERN.test(line) && decisions.length < 3) decisions.push(line);
    if (LESSON_PATTERN.test(line) && lessons.length < 3) lessons.push(line);
  }
  const tail = lines.slice(-maxTail).map((line) => redactSecrets(line));
  return {
    agent_id: agentId,
    operation,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: exitCode,
    topics,
    decisions: decisions.map((line) => redactSecrets(line)),
    lessons: lessons.map((line) => redactSecrets(line)),
    tail,
  };
}

/** 从 stdin 流式收集输出行（供 runInteractive 捕获后生成摘要）。 */
export function collectLines(): { push(chunk: string): void; lines(): string[] } {
  const lines: string[] = [];
  return {
    push(chunk: string) {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) lines.push(trimmed);
      }
    },
    lines() {
      return lines;
    },
  };
}
