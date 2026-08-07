import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitAddCommit,
  gitCommitFile,
  gitLog,
  gitShowCommitFiles,
  gitShowFile,
  gitStatusShort,
} from '../src/core/git.js';

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

  it('gitCommitFile commits only the target file, leaving other dirty files untouched', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'init');
    // 目标文件与另一个脏文件都未提交。
    await fs.writeFile(path.join(root, 'state.md'), 'new state');
    await fs.writeFile(path.join(root, 'other.md'), 'work in progress');
    const ok = await gitCommitFile(root, 'state.md', 'chore: 更新当前状态');
    expect(ok).toBe(true);
    // 目标文件已提交且干净。
    const status = await gitStatusShort(root);
    expect(status.some((entry) => entry.path.includes('state.md'))).toBe(false);
    // 其他脏文件保持未提交（绝不用 add -A）。
    expect(status.some((entry) => entry.path.includes('other.md'))).toBe(true);
  });

  it('gitCommitFile with requireIdentity:false returns false and skips commit when identity is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-git-noident-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'a.txt'), 'hello');
    await execa('git', ['init', '--initial-branch=main'], { cwd: root, shell: false });
    await execa('git', ['config', 'user.name', ''], { cwd: root, shell: false });
    await execa('git', ['config', 'user.email', ''], { cwd: root, shell: false });
    await fs.writeFile(path.join(root, 'state.md'), 'x');
    const ok = await gitCommitFile(root, 'state.md', 'chore: 更新当前状态', {
      requireIdentity: false,
    });
    expect(ok).toBe(false);
  });

  it('gitShowFile reads a committed file content at HEAD / specified ref (D-041 P2-2)', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'chore: initial scaffold');
    // HEAD 下的文件全文可读。
    expect(await gitShowFile(root, 'a.txt')).toBe('hello');
    // 文件在工作区被改动后，git show 仍读已提交版本（供身份回滚写回历史快照）。
    await fs.writeFile(path.join(root, 'a.txt'), 'dirty working tree');
    expect(await gitShowFile(root, 'a.txt')).toBe('hello');
    // 指定 ref 读历史提交；初始提交前无历史 → undefined。
    const firstCommit = (
      await execa('git', ['rev-list', '--max-count=1', 'HEAD'], { cwd: root, shell: false })
    ).stdout.trim();
    await fs.writeFile(path.join(root, 'b.txt'), 'second');
    await gitCommitFile(root, 'b.txt', 'chore: second');
    expect(await gitShowFile(root, 'b.txt', firstCommit)).toBeUndefined();
    expect(await gitShowFile(root, 'b.txt', 'HEAD')).toBe('second');
  });

  it('gitShowFile returns undefined for nonexistent path or non-repo', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'chore: initial scaffold');
    expect(await gitShowFile(root, 'no-such-file.md')).toBeUndefined();
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-git-plain-'));
    roots.push(plain);
    expect(await gitShowFile(plain, 'a.txt')).toBeUndefined();
  });

  it('gitLog filters by grep and caps at limit, newest first (D-041 P3-1)', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'chore: initial scaffold');
    await fs.writeFile(path.join(root, 'goals.md'), '目标 A\n');
    await gitCommitFile(root, 'goals.md', 'evolve: 更新目标 A');
    await fs.writeFile(path.join(root, 'goals.md'), '目标 B\n');
    await gitCommitFile(root, 'goals.md', 'evolve: 更新目标 B');
    await fs.writeFile(path.join(root, 'state.md'), '非进化提交\n');
    await gitCommitFile(root, 'state.md', 'chore: 普通提交');

    const all = await gitLog(root);
    expect(all.length).toBe(4);
    // 按 --grep evolve: 过滤：只返回自进化提交，最新在前。
    const evolved = await gitLog(root, { grep: 'evolve:' });
    expect(evolved.length).toBe(2);
    expect(evolved[0]!.subject).toBe('evolve: 更新目标 B');
    expect(evolved[1]!.subject).toBe('evolve: 更新目标 A');
    expect(evolved[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(evolved[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // limit 生效。
    const capped = await gitLog(root, { grep: 'evolve:', limit: 1 });
    expect(capped.length).toBe(1);
    // 非仓库返回空数组（不抛错）。
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-git-plain-'));
    roots.push(plain);
    expect(await gitLog(plain)).toEqual([]);
  });

  it('gitShowCommitFiles lists files changed by a commit (D-041 P3-1 点开看)', async () => {
    const root = await setupWorkspace();
    await gitAddCommit(root, 'chore: initial scaffold');
    await fs.writeFile(path.join(root, 'goals.md'), '目标\n');
    await gitCommitFile(root, 'goals.md', 'evolve: 更新目标');
    await fs.outputFile(path.join(root, 'skills', 'x.skill.md'), '技能\n');
    await gitCommitFile(root, 'skills/x.skill.md', 'evolve: 新增技能');

    const first = (await gitLog(root))[0];
    expect(first).toBeDefined();
    const files = await gitShowCommitFiles(root, first.hash);
    // 只列出该提交变更的文件（含目录层级）。
    expect(files.some((f) => f.status === 'A' && f.path === 'skills/x.skill.md')).toBe(true);
    expect(files.some((f) => f.path === 'goals.md')).toBe(false);
    // 无效 ref → 空数组（不抛错）。
    expect(await gitShowCommitFiles(root, 'deadbeef')).toEqual([]);
  });
});
