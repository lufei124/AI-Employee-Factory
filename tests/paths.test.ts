import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import {
  assertInside,
  assertInsideReal,
  resolveFactoryPaths,
  resolvePathLayout,
} from '../src/core/paths.js';

describe('resolveFactoryPaths', () => {
  it('uses HOME defaults without hard-coded user paths', () => {
    const result = resolveFactoryPaths({ HOME: '/tmp/employee-home' });

    expect(result.userHome).toBe('/tmp/employee-home');
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

describe('resolvePathLayout', () => {
  it('derives a data-only layout whose managed dirs all live inside home', () => {
    const paths = resolveFactoryPaths({ HOME: '/tmp/employee-home' });
    const layout = resolvePathLayout(paths);

    expect(layout.home).toBe(paths.home);
    expect(layout.workspaceRoot).toBe(paths.workspaceRoot);
    // OP2-F/OP5-E：每个受管目录都必须位于 home 树内（assertInside 语义）。
    for (const dir of layout.managedDirs) {
      expect(() => assertInside(layout.home, dir, '受管目录')).not.toThrow();
    }
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

describe('assertInsideReal', () => {
  it('accepts a real child path, rejects symlink candidates and symlinked-parent escape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-paths-real-'));
    const escapeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-paths-escape-'));
    try {
      const child = path.join(root, 'child');
      await fs.ensureDir(child);
      await expect(assertInsideReal(root, child, '子路径')).resolves.toBe(path.resolve(child));

      // 候选本身是符号链接 -> 拒绝（与 documentFile 一致）
      const link = path.join(root, 'escape-link');
      await fs.symlink(escapeDir, link);
      await expect(assertInsideReal(root, link, '符号链接')).rejects.toThrow('软链接');

      // 候选非符号链接，但父目录是符号链接逃逸到 root 之外 -> realpath 包含校验拒绝
      const linkedDir = path.join(root, 'linked');
      await fs.symlink(escapeDir, linkedDir);
      await fs.outputFile(path.join(escapeDir, 'leaked.txt'), 'secret');
      await expect(
        assertInsideReal(root, path.join(linkedDir, 'leaked.txt'), '逃逸文件'),
      ).rejects.toThrow('必须位于');
    } finally {
      await Promise.all([fs.remove(root), fs.remove(escapeDir)]);
    }
  });
});
