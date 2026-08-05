import { describe, expect, it } from 'vitest';
import {
  parseClaudeResult,
  parseCodexResult,
  parseClaudeUsage,
  parseCodexUsage,
  parseStructuredResult,
  parseStructuredUsage,
} from '../src/core/usage.js';

describe('parseClaudeUsage (claude -p --output-format json)', () => {
  it('extracts usage/model/cost from a full result object', () => {
    const stdout = JSON.stringify({
      is_error: false,
      total_cost_usd: 0.114782,
      usage: {
        input_tokens: 22866,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {
        'claude-haiku-4-5': {
          inputTokens: 347,
          outputTokens: 6,
          canonicalModel: 'claude-haiku-4-5',
        },
        'claude-opus-4-8': {
          inputTokens: 22866,
          outputTokens: 3,
          canonicalModel: 'claude-opus-4-8',
        },
      },
      result: 'ok',
    });
    const usage = parseClaudeUsage(stdout);
    expect(usage).toEqual({
      inputTokens: 22866,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0.114782,
      // 主模型取 inputTokens 最大的条目（opus），而非首个。
      model: 'claude-opus-4-8',
    });
  });

  it('returns undefined for non-JSON or usage-less stdout', () => {
    expect(parseClaudeUsage('plain text output')).toBeUndefined();
    expect(parseClaudeUsage(JSON.stringify({ result: 'ok' }))).toBeUndefined();
  });

  it('stays undefined on malformed trailing JSON', () => {
    expect(parseClaudeUsage('{"usage":')).toBeUndefined();
  });
});

describe('parseCodexUsage (codex exec --json JSONL)', () => {
  it('sums turn.completed usage across JSONL events', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 },
      }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      'non-json line',
    ].join('\n');
    const usage = parseCodexUsage(stdout);
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
    });
    // Codex 事件 schema 无 model/cost，字段保持 undefined。
    expect(usage?.model).toBeUndefined();
    expect(usage?.totalCostUsd).toBeUndefined();
  });

  it('returns undefined when no turn.completed usage present', () => {
    expect(parseCodexUsage(JSON.stringify({ type: 'thread.started' }))).toBeUndefined();
  });
});

describe('parseStructuredUsage dispatch', () => {
  it('routes by provider', () => {
    const claude = JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } });
    const codex = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(parseStructuredUsage('claude', claude)?.inputTokens).toBe(1);
    expect(parseStructuredUsage('codex', codex)?.outputTokens).toBe(2);
  });
});

describe('parseStructuredResult (OP6-A/T02)', () => {
  it('extracts the result text field from a claude JSON object', () => {
    const stdout = JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1 } });
    expect(parseClaudeResult(stdout)).toBe('ok');
  });

  it('returns undefined for claude JSON without a string result', () => {
    expect(parseClaudeResult('plain text')).toBeUndefined();
    expect(parseClaudeResult(JSON.stringify({ result: 42 }))).toBeUndefined();
    expect(parseClaudeResult('{"result":')).toBeUndefined();
  });

  it('extracts the last agent message text from codex JSONL', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'final ans' },
      }),
      'non-json footer',
    ].join('\n');
    expect(parseCodexResult(stdout)).toBe('final ans');
  });

  it('returns undefined for codex JSONL without an agent message', () => {
    expect(parseCodexResult(JSON.stringify({ type: 'thread.started' }))).toBeUndefined();
  });

  it('routes by provider', () => {
    expect(parseStructuredResult('claude', JSON.stringify({ result: 'c' }))).toBe('c');
    expect(
      parseStructuredResult(
        'codex',
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }),
      ),
    ).toBe('x');
  });
});
