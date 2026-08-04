import { describe, expect, it } from 'vitest';
import {
  NoopObservabilitySink,
  defaultObservabilitySink,
  toGenAiAttrs,
} from '../src/core/observability.js';

describe('ObservabilitySink (OP4-B)', () => {
  it('NoopObservabilitySink.spanStart returns a Span whose end is a no-op', () => {
    const sink = new NoopObservabilitySink();
    const span = sink.spanStart('operation', {
      operation_id: 'op-1',
      trace_id: 't-1',
      kind: 'run',
    });
    expect(span).toBeDefined();
    expect(() => span.end()).not.toThrow();
    expect(() => span.end({ exit_code: 0 })).not.toThrow();
  });

  it('defaultObservabilitySink is a NoopObservabilitySink instance', () => {
    expect(defaultObservabilitySink).toBeInstanceOf(NoopObservabilitySink);
  });
});

describe('toGenAiAttrs (OP4-C)', () => {
  it('maps model/tokens/cost to gen_ai.* span attributes', () => {
    expect(
      toGenAiAttrs({
        model: 'claude-opus-4-8',
        inputTokens: 10,
        outputTokens: 2,
        totalCostUsd: 0.01,
      }),
    ).toEqual({
      'gen_ai.request.model': 'claude-opus-4-8',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.cost_usd': 0.01,
    });
  });

  it('omits absent fields (Codex has no model/cost in schema)', () => {
    expect(toGenAiAttrs({ inputTokens: 10 })).toEqual({ 'gen_ai.usage.input_tokens': 10 });
    expect(toGenAiAttrs({})).toEqual({});
  });
});
