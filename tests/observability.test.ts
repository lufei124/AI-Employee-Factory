import { describe, expect, it } from 'vitest';
import { NoopObservabilitySink, defaultObservabilitySink } from '../src/core/observability.js';

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
