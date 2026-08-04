import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentCtlError } from '../src/core/errors.js';
import {
  assertInside,
  assertInsideReal,
  assertPathLayout,
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
    // OP5-E：断言路径布局收敛（同步、零 I/O）通过。
    expect(() => assertPathLayout(layout)).not.toThrow();
  });

  it('rejects a managed dir that escapes the home tree (OP5-E R25)', () => {
    const layout: ReturnType<typeof resolvePathLayout> = {
      home: '/tmp/employee-home/.ai-employees',
      workspaceRoot: '/tmp/employee-home/AI-Employees/agents',
      managedDirs: ['/etc/passwd', '/tmp/employee-home/.ai-employees/runtimes'],
    };
    let caught: AgentCtlError | undefined;
    try {
      assertPathLayout(layout);
    } catch (error) {
      caught = error as AgentCtlError;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe('VALIDATION_ERROR');
    // 外置卷语义在 remediation：bind mount/符号链接挂到树内并经 realpath 校验。
    expect(caught?.remediation).toMatch(/bind mount|符号链接/);
    expect(caught?.remediation).toContain('realpath');
  });

  it('rejects a managed dir that merely shares a prefix with home (sibling trick, OP5-E)', () => {
    const layout: ReturnType<typeof resolvePathLayout> = {
      home: '/tmp/employee-home/.ai-employees',
      workspaceRoot: '/tmp/employee-home/AI-Employees/agents',
      managedDirs: ['/tmp/employee-home/.ai-employees-other/escaped'],
    };
    expect(() => assertPathLayout(layout)).toThrow(AgentCtlError);
  });

  it('accepts an explicit workspaceRoot override and treats it as a second tree (OP5-E)', () => {
    // 用户刻意覆盖 workspaceRoot（README「覆盖默认值」）——workspace 属第二棵树，受管目录仍以 home 为根。
    const paths = resolveFactoryPaths({
      HOME: '/tmp/employee-home',
      AI_EMPLOYEES_WORKSPACE_ROOT: '/work/ai-agents',
    });
    expect(paths.workspaceRoot).toBe('/work/ai-agents');
    const layout = resolvePathLayout(paths);
    // workspaceRoot 是第二棵树（员工 workspace 所在），不在受管目录之列——断言不受影响。
    expect(() => assertPathLayout(layout)).not.toThrow();
    // 受管目录全部位于 home 树内（workspaceRoot 覆盖不改变受管目录根）。
    for (const dir of layout.managedDirs) {
      expect(() => assertInside(layout.home, dir, '受管目录')).not.toThrow();
    }
  });

  it('rejects an external-volume managed dir even when home is externally overridden (OP5-E)', () => {
    // home 本身被覆盖到外置卷是刻意选择（不硬失败），但受管目录仍须落在该 home 树内——
    // 直接指向外部路径（未被 bind mount/符号链接挂入）拒绝。
    const layout: ReturnType<typeof resolvePathLayout> = {
      home: '/vol/ext-ai-employees',
      workspaceRoot: '/tmp/employee-home/AI-Employees/agents',
      managedDirs: ['/etc/nginx.conf'],
    };
    expect(() => assertPathLayout(layout)).toThrow(AgentCtlError);
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
