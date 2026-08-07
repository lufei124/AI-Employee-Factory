// TASK-050（D-046）：任务完成态自动写 CURRENT_STATE + 自动 git 提交。
// 覆盖：sanitizeTaskLabel/formatDuration/taskStartRow/taskCompleteRow 纯函数单测；
// runJob 完成后 CURRENT_STATE.md 出现「最近任务」行 + git log 出现 chore 提交（走真实后处理链）。

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import type { LoggedRunResult } from '../src/core/process-runner.js';
import {
  formatDuration,
  sanitizeTaskLabel,
  taskCompleteRow,
  taskStartRow,
} from '../src/core/task-state.js';

const tempDirs: string[] = [];
const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

function now(): string {
  return new Date().toISOString();
}

/** 假 runLogged 结果：60s 耗时、退出码 0，无 transcript（settle 链跳过 transcript 依赖项）。 */
function fakeResult(): LoggedRunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-task-state-'));
  tempDirs.push(dir);
  const t0 = Date.parse(now());
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    logDir: dir,
    stdoutFile: path.join(dir, 'stdout.log'),
    stderrFile: path.join(dir, 'stderr.log'),
    metadataFile: path.join(dir, 'metadata.json'),
    startedAt: new Date(t0 - 60_000).toISOString(),
    finishedAt: new Date(t0).toISOString(),
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-task-state-'));
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
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈', '闭环跟进问题'],
    feishu: 'disabled',
  });
  // 预置 0600 降级凭据（OP5-B）：prepareRuntime 在无 CC Switch 源时读它，避免真实 CLI 依赖。
  const runtimeHome = path.join(paths.runtimesDir, 'worker-a', 'claude');
  await fs.outputFile(
    path.join(runtimeHome, '.cc-switch.env'),
    'ANTHROPIC_AUTH_TOKEN=test-token\n',
    { mode: 0o600 },
  );
  return { root, paths, app };
}

/** admin 管理的 agent 任务（enabled:false + managed_by:admin，避免 launchd reconcile）。 */
async function addAgentJob(app: FactoryApplication, jobId: string, prompt: string) {
  const workspace = path.join(app.paths.workspaceRoot, 'worker-a');
  const jobsDir = path.join(workspace, 'automation', 'jobs');
  const promptsDir = path.join(workspace, 'automation', 'prompts');
  await fs.outputFile(path.join(promptsDir, `${jobId}.md`), prompt);
  await fs.outputFile(
    path.join(jobsDir, `${jobId}.yaml`),
    [
      'schema_version: 1',
      `id: ${jobId}`,
      'enabled: false',
      'managed_by: admin',
      'schedule:',
      '  type: daily',
      '  time: "09:00"',
      'execution:',
      '  type: agent',
      `  prompt_file: automation/prompts/${jobId}.md`,
      '  timeout_seconds: 60',
      '  concurrency: forbid',
      '',
    ].join('\n'),
  );
}

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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

describe('task-state 助手（D-046）', () => {
  it('sanitizeTaskLabel 取首行、截 40 字；空/空白 → <空消息>', () => {
    expect(sanitizeTaskLabel('今天定时任务执行了吗\n第二行')).toBe('今天定时任务执行了吗');
    expect(sanitizeTaskLabel('   ')).toBe('<空消息>');
    expect(sanitizeTaskLabel('')).toBe('<空消息>');
    expect(sanitizeTaskLabel('a'.repeat(50))).toBe(`${'a'.repeat(40)}…`);
  });

  it('formatDuration：秒/分+秒/整分/时+分/整时/负数钳 0', () => {
    expect(formatDuration(44_000)).toBe('44s');
    expect(formatDuration(106_000)).toBe('1m46s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(3_720_000)).toBe('1h2m');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(-5_000)).toBe('0s');
  });

  it('taskStartRow / taskCompleteRow 拼状态行', () => {
    expect(taskStartRow({ source: '飞书', taskLabel: '写周报' })).toEqual({
      last_task: '飞书任务 处理中 · 写周报',
    });
    expect(
      taskCompleteRow({
        source: '定时',
        taskLabel: 'job-1 · 汇总进展',
        exitCode: 0,
        durationMs: 106_000,
      }),
    ).toEqual({
      last_event: '定时任务 完成（退出码 0）',
      last_task: '定时任务 完成 · 1m46s · job-1 · 汇总进展',
    });
    // 无 durationMs（交互对话）→ 完成行不拼耗时。
    expect(taskCompleteRow({ source: '对话', taskLabel: '交互对话', exitCode: 1 })).toEqual({
      last_event: '对话任务 失败（退出码 1）',
      last_task: '对话任务 失败 · 交互对话',
    });
  });
});

describe('runJob 完成后自动写状态（TASK-050）', () => {
  it('CURRENT_STATE.md 出现「最近任务」行，且 git log 有 chore 提交', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    await addAgentJob(app, 'daily-report', '今天定时任务执行了吗\n\n请按流程汇报。');
    // 唯一 seam = JobRunner 内的 ProcessRunner.runLogged：mock 底层运行器，走真实 runJob 后处理链。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => fakeResult());

    await app.runJob('worker-a', 'daily-report', {});

    const stateFile = path.join(workspace, 'agent', 'CURRENT_STATE.md');
    const content = await fs.readFile(stateFile, 'utf8');
    expect(content).toContain('最近任务：定时任务 完成 · 1m · daily-report · 今天定时任务执行了吗');
    expect(content).toContain('最近事件：定时任务 完成（退出码 0）');

    const log = await gitLog(workspace, 'agent/CURRENT_STATE.md');
    expect(log.some((line) => line.includes('chore: 更新当前状态'))).toBe(true);
  });

  it('任务失败（退出码非 0）→ 完成行写「失败」', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    await addAgentJob(app, 'nightly', '跑批任务');
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      const r = fakeResult();
      return { ...r, exitCode: 1 };
    });

    await app.runJob('worker-a', 'nightly', {});

    const content = await fs.readFile(path.join(workspace, 'agent', 'CURRENT_STATE.md'), 'utf8');
    expect(content).toContain('最近事件：定时任务 失败（退出码 1）');
    expect(content).toContain('最近任务：定时任务 失败 · 1m · nightly · 跑批任务');
  });
});
