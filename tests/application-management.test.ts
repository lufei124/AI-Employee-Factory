import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];

// 为状态自动提交断言提供确定性 git 身份（CI 无全局 git config 时也能过）。
const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-management-'));
  roots.push(root);
  const gitConfig = path.join(root, 'gitconfig');
  await fs.writeFile(
    gitConfig,
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  await app.initialize();
  await app.createAgent({
    id: 'user-operations',
    name: '用户运营专员',
    runtime: 'claude',
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈', '闭环跟进问题'],
    feishu: 'disabled',
  });
  return { root, paths, app };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

/** 读取员工工作区 CURRENT_STATE.md 并断言其包含目标行（OP6-B 事件自动更新）。 */
async function currentState(app: FactoryApplication, id: string): Promise<string> {
  const { registry } = await app.getAgent(id);
  return fs.readFile(path.join(registry.workspace.path, 'agent/CURRENT_STATE.md'), 'utf8');
}

/** 断言员工工作区 git 最近提交信息（OP6-B 自动提交）。 */
async function lastCommit(workspace: string): Promise<string> {
  const { stdout } = await execa('git', ['log', '--oneline', '-1', '--format=%s'], {
    cwd: workspace,
    shell: false,
    reject: false,
  });
  return stdout.trim();
}

describe('FactoryApplication management use cases', () => {
  it('creates, updates, and lists jobs while exposing terminal guidance', async () => {
    const { app, paths } = await setup();
    await fs.outputFile(
      path.join(paths.workspaceRoot, 'user-operations/prompts/review.md'),
      '# 每日复盘\n',
    );
    await app.createJob('user-operations', {
      schema_version: 1,
      id: 'daily-review',
      enabled: false,
      schedule: { type: 'daily', time: '09:00' },
      execution: {
        type: 'agent',
        prompt_file: 'prompts/review.md',
        timeout_seconds: 300,
        concurrency: 'forbid',
      },
    });
    await app.updateJob('user-operations', 'daily-review', {
      schema_version: 1,
      id: 'daily-review',
      enabled: false,
      schedule: { type: 'daily', time: '10:00' },
      execution: {
        type: 'agent',
        prompt_file: 'prompts/review.md',
        timeout_seconds: 300,
        concurrency: 'forbid',
      },
    });

    expect((await app.listJobs('user-operations'))[0]?.schedule.time).toBe('10:00');
    expect(await app.terminalGuidance('user-operations')).toEqual({
      runtimeLogin: 'agentctl runtime sync user-operations',
      bridgeAuthorize: 'agentctl bridge authorize user-operations',
      chat: 'agentctl chat user-operations',
    });
  });

  it('syncs the active CC Switch provider instead of invoking Claude OAuth login', async () => {
    const { app, paths, root } = await setup();
    await fs.outputJson(path.join(root, '.claude/settings.json'), {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'cc-switch-token',
        ANTHROPIC_BASE_URL: 'https://provider.example.test',
      },
    });

    expect(await app.runtimeAuth('user-operations', 'login')).toBe(0);
    expect(
      await fs.readJson(path.join(paths.runtimesDir, 'user-operations/claude/settings.json')),
    ).toMatchObject({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'cc-switch-token',
        ANTHROPIC_BASE_URL: 'https://provider.example.test',
      },
    });
  });

  it('previews and moves a complete Agent into the recoverable trash', async () => {
    const { app, paths } = await setup();
    await fs.outputFile(path.join(paths.logsDir, 'user-operations/run/output.log'), 'test');
    await fs.outputFile(path.join(paths.servicesDir, 'user-operations/bridge.plist'), 'test');
    await fs.outputFile(path.join(paths.schedulesDir, 'user-operations/job.plist'), 'test');

    const preview = await app.trashAgent('user-operations', { dryRun: true });
    expect(preview).toMatchObject({ agentId: 'user-operations' });
    expect(await app.getAgent('user-operations')).toBeDefined();

    const moved = await app.trashAgent('user-operations');

    expect(moved).toMatchObject({ agentId: 'user-operations', state: 'ready' });
    await expect(app.getAgent('user-operations')).rejects.toThrow('Agent 不存在');
    expect((await app.listTrash())[0]).toMatchObject({ trashId: moved.trashId });
    await app.restoreTrash(moved.trashId);
    expect((await app.getAgent('user-operations')).registry.status).toBe('stopped');
  });

  it('lists installed skills, logs, and generated backups without exposing arbitrary paths', async () => {
    const { app, paths } = await setup();
    // preset 无内置 skill，初始列表为空
    expect(await app.listSkills('user-operations')).toEqual([]);
    await fs.outputFile(
      path.join(paths.logsDir, 'user-operations/manual/output.log'),
      'line one\nline two\n',
    );
    expect((await app.readLatestLog('user-operations', 1)).content).toBe('line two\n');

    const output = await app.createBackup('user-operations');
    expect(output).toContain(paths.backupsDir);
    expect((await app.listBackups())[0]).toMatchObject({
      name: path.basename(output),
      encrypted: false,
    });
  });
});

describe('CURRENT_STATE.md lifecycle auto-update (OP6-B)', () => {
  it('updates and commits the state file after runtime auth', async () => {
    const { app, paths } = await setup();
    // runtimeAuth(claude) 成功路径（CC Switch 同步，无真实 CLI 调用）。
    await fs.outputJson(path.join(paths.userHome, '.claude/settings.json'), {
      env: { ANTHROPIC_AUTH_TOKEN: 'test-token' },
    });
    expect(await app.runtimeAuth('user-operations', 'login')).toBe(0);

    const state = await currentState(app, 'user-operations');
    expect(state).toContain('- 状态：已就绪');
    expect(state).toContain('- 运行器：已登录');
    expect(state).toContain('- 最近事件：运行器登录');
    // 自动提交：最近一次提交为状态更新（非初始 scaffold）。
    const { registry } = await app.getAgent('user-operations');
    expect(await lastCommit(registry.workspace.path)).toContain('更新当前状态');
  });

  it('status query does not write a login event (only login does)', async () => {
    const { app, paths } = await setup();
    await fs.outputJson(path.join(paths.userHome, '.claude/settings.json'), {
      env: { ANTHROPIC_AUTH_TOKEN: 'test-token' },
    });
    // 先登录一次，状态文件已有事件行。
    await app.runtimeAuth('user-operations', 'login');
    const { registry } = await app.getAgent('user-operations');
    const stateFile = path.join(registry.workspace.path, 'agent/CURRENT_STATE.md');
    const before = await fs.readFile(stateFile, 'utf8');

    // status 只是查询：不应追加/改写登录事件行。
    expect(await app.runtimeAuth('user-operations', 'status')).toBe(0);
    const after = await fs.readFile(stateFile, 'utf8');
    expect(after).toBe(before);
  });

  it('updates the state file after bridge authorize', async () => {
    const { app } = await setup();
    // 模拟 Bridge CLI 存在且授权成功（测试环境无 lark-channel-bridge，mock 掉 spawn）。
    const { BridgeAdapter } = await import('../src/core/bridge.js');
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(BridgeAdapter.prototype, 'inspectCapabilities').mockResolvedValue({
      compatible: true,
      missing: [],
      version: 'test',
    });
    vi.spyOn(BridgeAdapter.prototype, 'authorize').mockReturnValue({
      command: 'lark-channel-bridge',
      args: ['profile', 'create', 'test-profile'],
      cwd: '/tmp',
      env: {},
    });
    vi.spyOn(ProcessRunner.prototype, 'runInteractive').mockResolvedValue(0);
    // secureProfile 会真实 spawn lark-channel-bridge，mock 掉。
    vi.spyOn(BridgeAdapter.prototype, 'secureProfile').mockResolvedValue(undefined);

    expect(await app.bridgeAuthorize('user-operations', { tenant: 'feishu' })).toBe(0);
    const state = await currentState(app, 'user-operations');
    expect(state).toContain('- 状态：已就绪');
    expect(state).toContain('- 飞书：已授权');
    expect(state).toContain('- 最近事件：飞书授权');
  });

  it('updates the state file after archive and trash restore', async () => {
    const { app } = await setup();
    await app.archiveAgent('user-operations');
    let state = await currentState(app, 'user-operations');
    expect(state).toContain('- 状态：已归档');
    expect(state).toContain('- 最近事件：归档员工');

    const moved = await app.trashAgent('user-operations');
    await app.restoreTrash(moved.trashId);
    state = await currentState(app, 'user-operations');
    expect(state).toContain('- 状态：已恢复');
    expect(state).toContain('- 最近事件：恢复员工');
  });

  it('does not break when the state file lacks a marker block and was human-edited', async () => {
    const { app, paths } = await setup();
    // runtimeAuth(claude) 需要 CC Switch 源。
    await fs.outputJson(path.join(paths.userHome, '.claude/settings.json'), {
      env: { ANTHROPIC_AUTH_TOKEN: 'test-token' },
    });
    const { registry } = await app.getAgent('user-operations');
    await fs.writeFile(
      path.join(registry.workspace.path, 'agent/CURRENT_STATE.md'),
      '# 当前状态\n\n- 状态：人工维护中\n',
    );
    await app.runtimeAuth('user-operations', 'login');
    // 人工内容原样保留（永不覆盖他人成果）。
    expect(await currentState(app, 'user-operations')).toContain('- 状态：人工维护中');
  });
});
