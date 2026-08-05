import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { ensureAgentDocsAllowed } from '../src/core/current-state.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import type { LoggedRunResult } from '../src/core/process-runner.js';

// TASK-029 自我进化：员工可更新 agent/ROLE|GOALS|OPERATING_SYSTEM|POLICIES 与 knowledge/ 知识，
// 系统在 runAgent/runChat/runJob 后自动检测并单文件 git 提交（evolve: 前缀）。
// 唯一 seam = FactoryApplication.runAgent：vi.spyOn 注入假 runAgent，验证提交逻辑而非真实 spawn。

const tempDirs: string[] = [];
// 为提交断言提供确定性 git 身份（CI 无全局 git config 时也能过）。
const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

function now(): string {
  return new Date().toISOString();
}

function fakeResult(stdout: string): LoggedRunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-evolve-stdout-'));
  tempDirs.push(dir);
  const stdoutFile = path.join(dir, 'stdout.log');
  fs.writeFileSync(stdoutFile, stdout);
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    logDir: dir,
    stdoutFile,
    stderrFile: path.join(dir, 'stderr.log'),
    metadataFile: path.join(dir, 'metadata.json'),
    startedAt: now(),
    finishedAt: now(),
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-evolve-'));
  tempDirs.push(root);
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
    id: 'worker-a',
    name: '员工 A',
    runtime: 'claude',
    preset: 'user-operations',
    feishu: 'disabled',
  });
  // 预置 0600 降级凭据（OP5-B）：prepareRuntime 在无 CC Switch 源时读它，避免真实 CLI 依赖。
  const runtimeHome = path.join(paths.runtimesDir, 'worker-a', 'claude');
  await fs.outputFile(
    path.join(runtimeHome, '.cc-switch.env'),
    'ANTHROPIC_AUTH_TOKEN=test-token\n',
    {
      mode: 0o600,
    },
  );
  return { root, paths, app };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

/** 某文件自 HEAD 起的提交消息列表（按时间正序）。 */
async function gitLog(workspace: string, relPath: string): Promise<string[]> {
  const result = await execa('git', ['log', '--oneline', '--', relPath], {
    cwd: workspace,
    shell: false,
    extendEnv: false,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

describe('员工自我进化（TASK-029）', () => {
  it('runAgent 后 agent/ROLE.md 变更被单文件自动提交（evolve: 前缀）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const roleFile = path.join(workspace, 'agent', 'ROLE.md');

    // 唯一 seam = ProcessRunner.runLogged：mock 底层运行器（模拟员工在执行中更新岗位文档），
    // 走真实 runAgent 的后处理链（maybeExtractExperience + commitSelfEvolution）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.appendFile(roleFile, '\n- 已学习：优先使用异步批量处理。\n');
      return fakeResult('完成。');
    });

    await app.runAgent('worker-a', '学习并更新岗位描述');

    const log = await gitLog(workspace, 'agent/ROLE.md');
    expect(log.some((line) => line.includes('evolve:'))).toBe(true);
    // 单文件提交：只 add ROLE.md，不误收其他未提交内容。
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain('ROLE.md');
  });

  it('ensureAgentDocsAllowed 幂等：重复调用不产生重复放行规则', async () => {
    const { paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const relPaths = [
      'agent/ROLE.md',
      'agent/GOALS.md',
      'agent/OPERATING_SYSTEM.md',
      'agent/POLICIES.md',
    ];

    await ensureAgentDocsAllowed(workspace, relPaths);
    await ensureAgentDocsAllowed(workspace, relPaths);

    const settings = await fs.readJson(path.join(workspace, '.claude', 'settings.json'));
    const allow = settings.permissions.allow as string[];
    for (const rule of ['Edit(agent/ROLE.md)', 'Write(agent/ROLE.md)', 'Edit(agent/POLICIES.md)']) {
      expect(allow.filter((r) => r === rule)).toHaveLength(1);
    }
  });

  it('knowledgeWrite 后知识文件被单文件自动提交', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');

    await app.knowledgeWrite('worker-a', 'lessons/batch.md', '# 经验\n- 批量处理更快。\n');

    const log = await gitLog(workspace, 'knowledge/lessons/batch.md');
    expect(log.some((line) => line.includes('evolve:'))).toBe(true);
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain('lessons/batch.md');
  });
});
