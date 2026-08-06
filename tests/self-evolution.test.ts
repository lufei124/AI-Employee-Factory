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

import type * as SkillGeneratorModule from '../src/core/skill-generator.js';

// D-034：自动生成路径需 mock generateSkill（避免真实 claude CLI），同时保留 renderSkillFile 真实实现。
vi.mock('../src/core/skill-generator.js', async () => {
  const original = await vi.importActual<typeof SkillGeneratorModule>(
    '../src/core/skill-generator.js',
  );
  return { ...original, generateSkill: vi.fn() };
});

// TASK-029 自我进化：员工可更新 agent/ROLE|GOALS|OPERATING_SYSTEM|POLICIES 与 knowledge/ 知识，
// 系统在 runJob（原 runAgent/runChat 一并移除，D-033）后自动检测并单文件 git 提交（evolve: 前缀）。
// 唯一 seam = JobRunner 内部的 ProcessRunner.runLogged：vi.spyOn 注入假 runLogged，验证提交逻辑而非真实 spawn。

const tempDirs: string[] = [];
// 为提交断言提供确定性 git 身份（CI 无全局 git config 时也能过）。
const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

function now(): string {
  return new Date().toISOString();
}

function fakeResult(stdout: string, transcriptFile?: string): LoggedRunResult {
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
    ...(transcriptFile ? { transcriptFile } : {}),
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
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈', '闭环跟进问题'],
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

// D-033：runAgent 已移除，改用 agent 定时任务触发同一后处理链（commitSelfEvolution）。
// 任务用 managed_by: 'admin'（reconcileEmployeeJobs 只 reconcile employee，故不触发 launchd 安装）。
async function runAdminJob(app: FactoryApplication, jobId: string, prompt: string) {
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
  return app.runJob('worker-a', jobId, {});
}

describe('员工自我进化（TASK-029）', () => {
  it('runJob 后 agent/ROLE.md 变更被单文件自动提交（evolve: 前缀）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const roleFile = path.join(workspace, 'agent', 'ROLE.md');

    // 唯一 seam = JobRunner 内的 ProcessRunner.runLogged：mock 底层运行器（模拟员工在执行中更新岗位文档），
    // 走真实 runJob 的后处理链（maybeExtractExperience + commitSelfEvolution）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.appendFile(roleFile, '\n- 已学习：优先使用异步批量处理。\n');
      return fakeResult('完成。');
    });

    await runAdminJob(app, 'role-update', '学习并更新岗位描述');

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

  it('ensureAgentDocsAllowed 幂等放行 automation/jobs 与 automation/prompts（D-028）', async () => {
    const { paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');

    await ensureAgentDocsAllowed(workspace, ['automation/jobs/**', 'automation/prompts/**']);
    await ensureAgentDocsAllowed(workspace, ['automation/jobs/**', 'automation/prompts/**']);

    const settings = await fs.readJson(path.join(workspace, '.claude', 'settings.json'));
    const allow = settings.permissions.allow as string[];
    for (const rule of [
      'Edit(automation/jobs/**)',
      'Write(automation/jobs/**)',
      'Edit(automation/prompts/**)',
      'Write(automation/prompts/**)',
    ]) {
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

  it('employee-authored skills/workflows/knowledge content is auto-committed (D-029 broaden)', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');

    // 员工在一次 run 中新建内容文件（未跟踪），系统应在 runJob 后自动单文件提交。
    const reportsDirty = path.join(workspace, 'skills/reporting/SKILL.md');
    const workflowFile = path.join(workspace, 'workflows/review.md');
    const knowledgeFile = path.join(workspace, 'knowledge/lessons/batch-processing.md');
    await fs.outputFile(
      reportsDirty,
      '---\nname: reporting\ndescription: 生成日报\n---\n# Reporting\n',
    );
    await fs.outputFile(workflowFile, '# 复盘流程\n');
    await fs.outputFile(knowledgeFile, '# 经验\n- 批量处理更快。\n');
    // 非内容目录（tasks/）不应被自动提交。
    const tasksDirty = path.join(workspace, 'tasks/ACTIVE.md');
    await fs.appendFile(tasksDirty, '\n- 进行中的任务\n');

    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockResolvedValue(fakeResult('完成。'));

    await runAdminJob(app, 'content-output', '产出内容');

    for (const rel of [
      'skills/reporting/SKILL.md',
      'workflows/review.md',
      'knowledge/lessons/batch-processing.md',
    ]) {
      const log = await gitLog(workspace, rel);
      expect(log.some((line) => line.includes('evolve:'))).toBe(true);
    }
    // 内容目录已提交，不再 dirty；tasks/ 未提交，仍 dirty。
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain('skills/reporting');
    expect(status.stdout).not.toContain('workflows/review.md');
    expect(status.stdout).not.toContain('lessons/batch-processing');
    expect(status.stdout).toContain('tasks/ACTIVE.md');
  });

  it('runJob 后员工写盘 skills/ 自动 adopt（补元数据 + 投影）并被 evolve 提交（D-034）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const skillDir = path.join(workspace, 'skills', 'self-made');
    // 员工在任务中直接写 SKILL.md（无 .agentctl.yaml）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.outputFile(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: self-made\ndescription: 自建\nversion: 0.1.0\n---\n# 自建\n',
      );
      return fakeResult('完成。');
    });

    await runAdminJob(app, 'self-skill', '沉淀一个可复用技能');

    // 自动 adopt：补写 .agentctl.yaml + 投影软链。
    expect(await fs.pathExists(path.join(skillDir, '.agentctl.yaml'))).toBe(true);
    expect(
      (await fs.lstat(path.join(workspace, '.claude', 'skills', 'self-made'))).isSymbolicLink(),
    ).toBe(true);
    // 投影软链目标真实存在（软链内容相对 .claude/skills，指向 store 根）。
    const link = await fs.readlink(path.join(workspace, '.claude', 'skills', 'self-made'));
    expect(await fs.pathExists(path.resolve(workspace, '.claude', 'skills', link))).toBe(true);
    // .agentctl.yaml 与 SKILL.md 均被 evolve 单文件提交。
    const logSkill = await gitLog(workspace, 'skills/self-made/SKILL.md');
    expect(logSkill.some((line) => line.includes('evolve:'))).toBe(true);
    const logMeta = await gitLog(workspace, 'skills/self-made/.agentctl.yaml');
    expect(logMeta.some((line) => line.includes('evolve:'))).toBe(true);
  });

  it('skill_self_creation 开启且 transcript 命中重复模式时自动生成并注册 Skill（D-034）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    // 开启 skill_self_creation + transcript_persist。
    const agentYaml = path.join(workspace, 'agent.yaml');
    const YAML = (await import('yaml')).default;
    const parsed = YAML.parse(await fs.readFile(agentYaml, 'utf8'));
    parsed.memory.transcript_persist = true;
    parsed.memory.skill_self_creation = true;
    await fs.writeFile(agentYaml, YAML.stringify(parsed));
    // 预置一条历史信号，使本次命中阈值（threshold=2）。
    await fs.outputFile(
      path.join(workspace, 'knowledge', '.skill-signals.jsonl'),
      `${JSON.stringify({ topic: 'report', date: new Date().toISOString() })}\n`,
    );
    // mock generateSkill 返回一个蓝图。
    const { generateSkill } = await import('../src/core/skill-generator.js');
    (generateSkill as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: 'reporting',
      version: '1.0.0',
      short_description: '生成报告',
      description: '按模板生成报告',
      instructions: '# 步骤\n1. 读取数据\n2. 生成报告',
      triggers: ['生成报告'],
    });
    // transcript 含重复信号 topic + lesson。
    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-evolve-transcript-'));
    tempDirs.push(transcriptDir);
    const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
    await fs.writeFile(
      transcriptFile,
      `${JSON.stringify({
        agent_id: 'worker-a',
        operation: 'run',
        started_at: now(),
        finished_at: now(),
        exit_code: 0,
        topics: ['report'],
        decisions: [],
        lessons: ['下次用统一模板生成 report'],
        tail: [],
      })}\n`,
    );
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockResolvedValue(
      fakeResult('完成。', transcriptFile),
    );

    await runAdminJob(app, 'auto-skill', '生成报告');

    // 自动生成并注册：store 根出现 SKILL.md + 元数据 + 投影。
    expect(await fs.pathExists(path.join(workspace, 'skills/reporting/SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(workspace, 'skills/reporting/.agentctl.yaml'))).toBe(true);
    expect(
      (await fs.lstat(path.join(workspace, '.claude', 'skills', 'reporting'))).isSymbolicLink(),
    ).toBe(true);
    // 被 evolve 提交。
    const log = await gitLog(workspace, 'skills/reporting/SKILL.md');
    expect(log.some((line) => line.includes('evolve:'))).toBe(true);
  });
});
