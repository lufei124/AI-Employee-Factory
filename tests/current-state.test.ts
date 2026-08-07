import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STATE_BLOCK_BEGIN,
  STATE_BLOCK_END,
  LEGACY_SEED_CONTENT,
  INITIAL_STATE,
  renderNewSeed,
  renderStateBlock,
  updateCurrentState,
} from '../src/core/current-state.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function stateFile(content: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-state-'));
  roots.push(root);
  const file = path.join(root, 'CURRENT_STATE.md');
  await fs.outputFile(file, content);
  return file;
}

describe('renderStateBlock / renderNewSeed (OP6-B)', () => {
  it('renders the initial seed with the auto marker block and progress section', () => {
    const seed = renderNewSeed();
    expect(seed).toContain(STATE_BLOCK_BEGIN);
    expect(seed).toContain(STATE_BLOCK_END);
    expect(seed).toContain('- 状态：已创建');
    expect(seed).toContain('- 运行器：未登录');
    expect(seed).toContain('- 飞书：未授权');
    expect(seed).toContain('- 最近事件：创建员工');
    expect(seed).toContain('## 工作进展');
    // 标记块必须位于工作进展段之前。
    expect(seed.indexOf(STATE_BLOCK_END)).toBeLessThan(seed.indexOf('## 工作进展'));
  });

  it('renders only the supplied keys in the state block', () => {
    const block = renderStateBlock({ state: '运行中', last_event: '启动服务' });
    expect(block).toContain('- 状态：运行中');
    expect(block).toContain('- 最近事件：启动服务');
    expect(block).not.toContain('运行器');
    expect(block).not.toContain('飞书');
  });
});

describe('updateCurrentState (OP6-B)', () => {
  it('updates only the target key line and preserves everything else', async () => {
    const file = await stateFile(
      `# 当前状态\n\n${STATE_BLOCK_BEGIN}\n- 状态：已创建\n- 运行器：未登录\n- 飞书：未授权\n- 最近事件：创建员工\n${STATE_BLOCK_END}\n\n## 工作进展\n\n- 我在推进飞书接入\n`,
    );
    const result = await updateCurrentState(file, {
      runtime_auth: '已登录',
      state: '已就绪',
      last_event: '运行器登录',
    });
    expect(result).toBe('updated');
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain('- 运行器：已登录');
    expect(content).toContain('- 状态：已就绪');
    expect(content).toContain('- 最近事件：运行器登录');
    // 未更新的 key 与块外人工内容原样保留。
    expect(content).toContain('- 飞书：未授权');
    expect(content).toContain('## 工作进展');
    expect(content).toContain('- 我在推进飞书接入');
  });

  it('adds a new key line when the block lacks it', async () => {
    const file = await stateFile(
      `# 当前状态\n\n${STATE_BLOCK_BEGIN}\n- 状态：已创建\n${STATE_BLOCK_END}\n`,
    );
    await updateCurrentState(file, { feishu_auth: '已授权' });
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain('- 状态：已创建');
    expect(content).toContain('- 飞书：已授权');
  });

  it('renders and merges D-046 task state keys (last_task / last_audit)', async () => {
    const file = await stateFile(
      `# 当前状态\n\n${STATE_BLOCK_BEGIN}\n- 状态：已就绪\n${STATE_BLOCK_END}\n`,
    );
    await updateCurrentState(file, { last_task: '飞书任务 完成 · 44s · 写周报' });
    let content = await fs.readFile(file, 'utf8');
    expect(content).toContain('- 最近任务：飞书任务 完成 · 44s · 写周报');
    // 审计键与任务键共存不覆盖（D-046：对账提示不被任务完成态覆盖）。
    await updateCurrentState(file, {
      last_event: '定时任务 完成（退出码 0）',
      last_audit: '检测到未授权身份改动已拒绝提交：agent/POLICIES.md',
    });
    content = await fs.readFile(file, 'utf8');
    expect(content).toContain('- 最近任务：飞书任务 完成 · 44s · 写周报');
    expect(content).toContain('- 最近事件：定时任务 完成（退出码 0）');
    expect(content).toContain('- 最近审计：检测到未授权身份改动已拒绝提交：agent/POLICIES.md');
  });

  it('upgrades the legacy seed content to the marker-block format with event rows', async () => {
    const file = await stateFile(LEGACY_SEED_CONTENT);
    const result = await updateCurrentState(file, {
      runtime_auth: '已登录',
      state: '已就绪',
      last_event: '运行器登录',
    });
    expect(result).toBe('upgraded');
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain(STATE_BLOCK_BEGIN);
    expect(content).toContain('- 状态：已就绪');
    expect(content).toContain('- 运行器：已登录');
    // 升级时未携带的 key 沿用初始种子值。
    expect(content).toContain('- 飞书：未授权');
    expect(content).toContain('- 最近事件：运行器登录');
    expect(content).toContain('## 工作进展');
  });

  it('skips files without a marker block that a human already edited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = await stateFile('# 当前状态\n\n- 状态：我自己改的\n');
    const result = await updateCurrentState(file, { state: '运行中' });
    expect(result).toBe('skipped');
    expect(await fs.readFile(file, 'utf8')).toContain('- 状态：我自己改的');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is a no-op when the target key already has the value', async () => {
    const file = await stateFile(
      `# 当前状态\n\n${STATE_BLOCK_BEGIN}\n- 状态：已就绪\n- 最近事件：运行器登录\n${STATE_BLOCK_END}\n\n- 人工补充\n`,
    );
    const result = await updateCurrentState(file, {
      state: '已就绪',
      last_event: '运行器登录',
    });
    expect(result).toBe('updated');
    // 内容未变化（mtime 不变）。
    const stat = await fs.stat(file);
    expect(stat.mtimeMs).toBeGreaterThan(0);
    const content = await fs.readFile(file, 'utf8');
    expect(content).toContain('- 人工补充');
  });

  it('throws when the file is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-state-'));
    roots.push(root);
    await expect(updateCurrentState(path.join(root, 'missing.md'), {})).rejects.toThrow('不存在');
  });
});

describe('INITIAL_STATE', () => {
  it('matches the seed values', () => {
    expect(INITIAL_STATE).toEqual({
      state: '已创建',
      runtime_auth: '未登录',
      feishu_auth: '未授权',
      last_event: '创建员工',
    });
  });
});
