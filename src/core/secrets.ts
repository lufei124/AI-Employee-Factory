// 共享 Secret 检测/脱敏。R27 备份内容扫描与 OP4-A 操作摘要持久化复用同一正则，
// 避免将疑似 Secret 写入 operations.jsonl（D-006：不落盘 Secret）。
export const SECRET_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|app[_-]?secret)\s*[:=]\s*[^\s]+)/i;

// 将文本中命中的 Secret 片段替换为 [REDACTED]，用于 error_summary 等摘要字段。
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[REDACTED]');
}
