import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { gitAddCommit, gitDiff, gitStatusShort, snapshotWorkspaceHash } from '../src/core/git.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setupWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-git-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  await execa('git', ['init', '--initial-branch=main'], { cwd: root, shell: false });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root, shell: false });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: root, shell: false });
  return root;
}

describe('git.ts (OP6-A)', () => {
  it('gitAddCommit creates a baseline commit and reports success', async () => {
    const root = await setupWorkspace();
    const ok = await gitAddCommit(root, 'chore: initial scaffold');
    expect(ok).toBe(true);
    const log = await execa('git', ['log', '--oneline'], { cwd: root, shell: false });
    expect(log.stdout).toContain('chore: initial scaffold');
  });

  it('gitAddCommit with requireIdentity:false returns false and skips commit when identity is missing', async () => {
    // 本地置空身份；git 无 HOME 时回退 OS 用户家目录，故必须显式清空才能模拟缺身份。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-git-noident-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
    await execa('git', ['init', '--initial-branch=main'], { cwd: root, shell: false });
    await execa('git', ['config', 'user.name', ''], { cwd: root, shell: false });
    await execa('git', ['config', 'user.email', ''], { cwd: root, shell: false });
    const ok = await gitAddCommit(root, 'chore: initial scaffold', { requireIdentity: false });
    expect(ok).toBe(false);
    const log = await execa('git', ['log', '--oneline'], {
      cwd: root,
      shell: false,
      reject: false,
    });
    expect(log.stdout).not.toContain('chore: initial scaffold');
  });

  it('gitStatusShort lists untracked/modified files', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'init');
    await fs.writeFile(path.join(root, 'b.txt'), 'world');
    const status = await gitStatusShort(root);
    expect(status.some((entry) => entry.path.includes('b.txt'))).toBe(true);
  });

  it('gitDiff returns the unstaged diff for a modified file', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'init');
    await fs.writeFile(path.join(root, 'a.txt'), 'changed');
    const diff = await gitDiff(root);
    expect(diff).toContain('+changed');
    expect(diff).toContain('-hello');
  });

  it('snapshotWorkspaceHash changes when content changes and is stable when not', async () => {
    const root = await setupWorkspace();
    const before = await snapshotWorkspaceHash(root);
    // 无 git 提交也无关——快照纯读文件内容
    const unchanged = await snapshotWorkspaceHash(root);
    expect(unchanged).toBe(before);
    await fs.writeFile(path.join(root, 'a.txt'), 'different');
    const after = await snapshotWorkspaceHash(root);
    expect(after).not.toBe(before);
  });

  it('snapshotWorkspaceHash ignores the .git directory', async () => {
    const root = await setupWorkspace();
    const before = await snapshotWorkspaceHash(root);
    // 在 .git 里写文件不应改变快照
    await fs.writeFile(path.join(root, '.git', 'probe'), 'x');
    const after = await snapshotWorkspaceHash(root);
    expect(after).toBe(before);
  });
});
