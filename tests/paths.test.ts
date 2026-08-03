import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import { assertInside, resolveFactoryPaths } from '../src/core/paths.js';

describe('resolveFactoryPaths', () => {
  it('uses HOME defaults without hard-coded user paths', () => {
    const result = resolveFactoryPaths({ HOME: '/tmp/employee-home' });

    expect(result.home).toBe('/tmp/employee-home/.ai-employees');
    expect(result.workspaceRoot).toBe('/tmp/employee-home/AI-Employees/agents');
    expect(result.registryFile).toBe('/tmp/employee-home/.ai-employees/registry/agents.yaml');
  });

  it('honors explicit root overrides', () => {
    const result = resolveFactoryPaths({
      HOME: '/tmp/employee-home',
      AI_EMPLOYEES_HOME: '/tmp/private-runtime',
      AI_EMPLOYEES_WORKSPACE_ROOT: '/tmp/workspaces',
    });

    expect(result.home).toBe('/tmp/private-runtime');
    expect(result.workspaceRoot).toBe('/tmp/workspaces');
  });
});

describe('assertInside', () => {
  it('accepts a child path', () => {
    expect(assertInside('/tmp/root', '/tmp/root/agent', '工作区')).toBe(
      path.resolve('/tmp/root/agent'),
    );
  });

  it('rejects path traversal and sibling-prefix tricks', () => {
    expect(() => assertInside('/tmp/root', '/tmp/root/../escape', '工作区')).toThrow(AgentCtlError);
    expect(() => assertInside('/tmp/root', '/tmp/root-other/agent', '工作区')).toThrow('必须位于');
  });
});
