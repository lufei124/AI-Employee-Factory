import { describe, expect, it } from 'vitest';
import { renderAuthorityStance, validateMemoryConfig } from '../src/core/authority.js';
import type { AgentConfig, AuthorityLayer } from '../src/schemas/agent-schema.js';

type Memory = AgentConfig['memory'];

function makeMemory(order: AuthorityLayer[], enforced?: boolean): Memory {
  const memory: Memory = {
    isolation: 'strict',
    native_memory: true,
    portable_memory: true,
    authority_order: order,
  };
  if (enforced !== undefined) memory.enforced = enforced;
  return memory;
}

const STANDARD = ['agent', 'knowledge', 'decisions', 'skills', 'native_memory', 'session'] as const;

describe('validateMemoryConfig (OP1 Stage A)', () => {
  it('accepts the standard 6-layer order with agent first', () => {
    const result = validateMemoryConfig(makeMemory([...STANDARD]));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts a valid subset (agent first, no duplicates)', () => {
    expect(validateMemoryConfig(makeMemory(['agent', 'session'])).ok).toBe(true);
  });

  it('flags an empty order', () => {
    const result = validateMemoryConfig(makeMemory([]));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes('不能为空'))).toBe(true);
  });

  it("flags a missing 'agent' layer", () => {
    const result = validateMemoryConfig(makeMemory(['knowledge', 'decisions']));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("必须包含 'agent'"))).toBe(true);
  });

  it("flags 'agent' not in the first position", () => {
    const result = validateMemoryConfig(makeMemory(['knowledge', 'agent']));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes("首位必须是 'agent'"))).toBe(true);
  });

  it('flags duplicate layers', () => {
    const result = validateMemoryConfig(makeMemory(['agent', 'knowledge', 'agent']));
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes('重复层'))).toBe(true);
  });
});

describe('renderAuthorityStance (OP1 Stage A)', () => {
  it('derives a stance section listing every declared layer with agent first', () => {
    const stance = renderAuthorityStance(makeMemory([...STANDARD]));
    expect(stance).toContain('## 记忆权威顺序');
    expect(stance).toContain('1. agent（');
    expect(stance).toContain('2. knowledge（');
    expect(stance).toContain('6. session（');
    expect(stance).toContain('不得凌驾于正式文件之上');
  });

  it('orders layers per authority_order', () => {
    const stance = renderAuthorityStance(makeMemory(['agent', 'session']));
    expect(stance).toContain('1. agent（');
    expect(stance).toContain('2. session（');
    expect(stance).not.toContain('\n3. ');
  });
});
