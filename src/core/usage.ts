// OP4-C 前置（CLI 结构化输出）：从 Claude/Codex CLI 的结构化 stdout 抽取用量
// （token/模型/成本）。纯函数、零 I/O，供 process-runner 在 runLogged 结束后 best-effort
// 解析，再注入 metadata.json 与 gen_ai.* span（阶段 3）。
//
// A2 可达性结论（.scratch/cli-structured-output.md）：
// - Claude：`claude -p --output-format json` 单对象，含 usage（input/output/cache tokens）、
//   modelUsage（per-model canonicalModel+costUSD）、total_cost_usd。
// - Codex：`codex exec --json` JSONL 事件流，仅 turn.completed 携带 usage（含
//   cached_input_tokens）；事件 schema 不含 model 与 cost，故这两项保持 undefined。

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  /** 主模型名（Claude 从 modelUsage 取 inputTokens 最大的 canonicalModel；Codex 不可达）。 */
  model?: string;
}

export type StructuredOutputProvider = 'claude' | 'codex';

const CLAUDE_USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const;

interface ClaudeUsageJson {
  usage?: Partial<Record<(typeof CLAUDE_USAGE_KEYS)[number], number>>;
  modelUsage?: Record<string, { inputTokens?: number; canonicalModel?: string }>;
  total_cost_usd?: number;
}

/** 解析 `claude -p --output-format json` 的单对象 stdout。解析失败或无用量返回 undefined。 */
export function parseClaudeUsage(stdout: string): RunUsage | undefined {
  let json: ClaudeUsageJson;
  try {
    json = JSON.parse(stdout.trim()) as ClaudeUsageJson;
  } catch {
    return undefined;
  }
  if (!json || typeof json !== 'object') return undefined;
  const usage = json.usage;
  const hasUsage = usage !== undefined && CLAUDE_USAGE_KEYS.some((key) => usage[key] !== undefined);
  // 主模型：取 modelUsage 中 inputTokens 最大的条目（真正执行工作的模型）。
  let model: string | undefined;
  let maxInput = -1;
  if (json.modelUsage && typeof json.modelUsage === 'object') {
    for (const entry of Object.values(json.modelUsage)) {
      const tokens = entry?.inputTokens ?? 0;
      if (tokens > maxInput) {
        maxInput = tokens;
        model = entry?.canonicalModel;
      }
    }
  }
  if (!hasUsage && model === undefined && json.total_cost_usd === undefined) return undefined;
  return {
    ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage?.cache_read_input_tokens !== undefined
      ? { cacheReadInputTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage?.cache_creation_input_tokens !== undefined
      ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
      : {}),
    ...(typeof json.total_cost_usd === 'number' ? { totalCostUsd: json.total_cost_usd } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** 解析 `codex exec --json` 的 JSONL 事件流，累加 turn.completed 的 usage。 */
export function parseCodexUsage(stdout: string): RunUsage | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cached_input_tokens?: number;
        };
      };
      if (event?.type === 'turn.completed' && event.usage) {
        if (typeof event.usage.input_tokens === 'number') inputTokens = event.usage.input_tokens;
        if (typeof event.usage.output_tokens === 'number') outputTokens = event.usage.output_tokens;
        if (typeof event.usage.cached_input_tokens === 'number')
          cacheReadInputTokens = event.usage.cached_input_tokens;
      }
    } catch {
      // 非 JSON 行（如退出码提示）跳过，best-effort。
    }
  }
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };
}

/** 按 provider 分派结构化输出解析。解析失败或无用量返回 undefined。 */
export function parseStructuredUsage(
  provider: StructuredOutputProvider,
  stdout: string,
): RunUsage | undefined {
  return provider === 'claude' ? parseClaudeUsage(stdout) : parseCodexUsage(stdout);
}

// OP6-A（T02）：结构化 result 正文取回（Chief 拆解、Cross-review 读取 worker 结论用）。
// 与 parseStructuredUsage 同源但语义不同——usage 抽用量，result 抽「真正产出的文本结论」。
// - Claude：`claude -p --output-format json` 单对象的 `result` 字段。
// - Codex：`codex exec --json` JSONL 事件流，取末个含 `agent_message.text` 的事件正文。
// 纯函数、零 I/O，解析失败返回 undefined（调用方优雅降级）。

/** 解析 `claude -p --output-format json` 单对象的 `result` 文本字段。 */
export function parseClaudeResult(stdout: string): string | undefined {
  let json: { result?: unknown };
  try {
    json = JSON.parse(stdout.trim()) as { result?: unknown };
  } catch {
    return undefined;
  }
  if (typeof json.result !== 'string') return undefined;
  return json.result;
}

/** 解析 `codex exec --json` JSONL 事件流，取末个 agent 消息文本。 */
export function parseCodexResult(stdout: string): string | undefined {
  let last: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as {
        item?: { type?: string; text?: string };
      };
      // Codex 事件 schema：agent 消息位于 `item.type === 'agent_message'` 的 `item.text`。
      if (event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        last = event.item.text;
      }
    } catch {
      // 非 JSON 行（如退出码提示）跳过，best-effort。
    }
  }
  return last;
}

/** 按 provider 分派结构化 result 正文解析。解析失败返回 undefined（调用方降级）。 */
export function parseStructuredResult(
  provider: StructuredOutputProvider,
  stdout: string,
): string | undefined {
  return provider === 'claude' ? parseClaudeResult(stdout) : parseCodexResult(stdout);
}
