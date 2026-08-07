// D-046：任务完成态文案——任务开始/完成自动写 CURRENT_STATE（经 syncCurrentState 自动 git 提交）。
//
// 纯函数模块，不涉文件/git（应用层组合）：sanitizeTaskLabel/formatDuration 可单测，
// taskStartRow/taskCompleteRow 把「开始/完成」折叠成 StateRow，供 runBridgeMessage / runJob / chat 挂钩点复用。
import type { StateRow } from './current-state.js';

/** 任务标签：取首行、去换行、截 40 字；空则 `<空消息>`。 */
export function sanitizeTaskLabel(text: string): string {
  const firstLine = (text.split('\n')[0] ?? '').trim();
  if (!firstLine) return '<空消息>';
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

/** 耗时格式化：44s / 1m46s / 1h2m（不足 1s 记为 0s）。 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h${remMinutes}m` : `${hours}h`;
}

/** 任务开始行：`最近任务 = <source>任务 处理中 · <标签>`。 */
export function taskStartRow(opts: { source: string; taskLabel: string }): StateRow {
  return { last_task: `${opts.source}任务 处理中 · ${opts.taskLabel}` };
}

/** 任务完成行：`最近事件 = <source>任务 <完成|失败>（退出码 N）` + `最近任务 = ... · [耗时] · <标签>`。 */
export function taskCompleteRow(opts: {
  source: string;
  taskLabel: string;
  exitCode: number;
  durationMs?: number;
}): StateRow {
  const status = opts.exitCode === 0 ? '完成' : '失败';
  const duration = opts.durationMs !== undefined ? ` · ${formatDuration(opts.durationMs)}` : '';
  return {
    last_event: `${opts.source}任务 ${status}（退出码 ${opts.exitCode}）`,
    last_task: `${opts.source}任务 ${status}${duration} · ${opts.taskLabel}`,
  };
}
