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

  it('recallForTask 写入 .retrieved.md 便签：gitignored、永不被 evolve 提交/索引/归档（D-042 B5）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    // 造一条可召回的知识（knowledgeWrite 会重取索引）。
    await app.knowledgeWrite(
      'worker-a',
      'lessons/feishu-loop.md',
      [
        '---',
        'title: 飞书消息闭环',
        'summary: 飞书消息的闭环跟进',
        'keywords: [飞书, 闭环]',
        'updated_at: 2026-08-06',
        '---',
        '收到飞书消息后先确认问题，再闭环跟进。',
      ].join('\n'),
    );
    // 模拟 runJob 前的召回注入：写入便签。
    await app.recallForTask('worker-a', '飞书消息闭环跟进');
    const scratchpad = path.join(workspace, 'knowledge', '.retrieved.md');
    expect(await fs.pathExists(scratchpad)).toBe(true);
    const content = await fs.readFile(scratchpad, 'utf8');
    expect(content).toContain('<!-- factory:retrieved -->');
    expect(content).toContain('lessons/feishu-loop.md');

    // runAdminJob 走完整自进化链后：便签未 evolve 提交，git status 也不含它（gitignored）。
    // 唯一 seam = JobRunner 内的 ProcessRunner.runLogged（mock 底层运行器，验证提交逻辑而非真实 spawn）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockResolvedValue(fakeResult('完成。'));
    await runAdminJob(app, 'content-output', '产出内容');
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain('.retrieved.md');
    const log = await gitLog(workspace, 'knowledge/.retrieved.md');
    expect(log).toHaveLength(0); // 从未被提交。

    // 便签未入索引（scan 跳过点文件）、未被归档（.archive 不存在）。
    const index = await fs.readJson(path.join(workspace, 'knowledge', '.index.json'));
    expect(index.entries.some((e: { relPath: string }) => e.relPath === '.retrieved.md')).toBe(
      false,
    );
    expect(await fs.pathExists(path.join(workspace, 'knowledge', '.archive'))).toBe(false);
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

describe('身份守卫 P0（D-041）', () => {
  it('员工删除 POLICIES 红线词 → identity-guard 拒绝提交该文件（保留脏文件），不阻断其他提交', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const policiesFile = path.join(workspace, 'agent', 'POLICIES.md');
    const goalsFile = path.join(workspace, 'agent', 'GOALS.md');

    // 员工在任务中删掉红线词（削弱权限边界）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.writeFile(
        policiesFile,
        '# 权限与上报规则\n\n## 权限边界\n\n所有操作须谨慎。\n\n## 主动上报\n\n需要时上报。\n',
      );
      await fs.appendFile(goalsFile, '\n- 新增目标。\n');
      return fakeResult('完成。');
    });

    // capture console.warn 验证 identity-guard 留痕。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runAdminJob(app, 'guard-redline', '更新规则');

    // POLICIES.md 未被提交（脏文件保留供人工决策）。
    const policiesLog = await gitLog(workspace, 'agent/POLICIES.md');
    expect(policiesLog.some((line) => line.includes('evolve:'))).toBe(false);
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).toContain('POLICIES.md');
    // warn 留痕包含 identity-guard 拒绝提交。
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('[identity-guard] 拒绝提交')),
    ).toBe(true);
    // 其他文件（GOALS）仍正常提交，不阻断主流程。
    const goalsLog = await gitLog(workspace, 'agent/GOALS.md');
    expect(goalsLog.some((line) => line.includes('evolve:'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('员工删除 ROLE 岗位定位标题 → identity-guard 拒绝提交该文件', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const roleFile = path.join(workspace, 'agent', 'ROLE.md');

    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.writeFile(roleFile, '# 岗位说明\n\n负责用户反馈收集、分析与闭环跟进。\n');
      return fakeResult('完成。');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runAdminJob(app, 'guard-role', '更新岗位');

    const roleLog = await gitLog(workspace, 'agent/ROLE.md');
    expect(roleLog.some((line) => line.includes('evolve:'))).toBe(false);
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).toContain('ROLE.md');
    warnSpy.mockRestore();
  });

  it('员工保留红线词但扩展说明 → 仍提交（合法强化不被误伤）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const policiesFile = path.join(workspace, 'agent', 'POLICIES.md');

    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.writeFile(
        policiesFile,
        '# 权限与上报规则\n\n## 权限边界\n\n生产写入、对外发布、Git push 和删除数据必须经人工审批。任何绕过审批的操作都属违规。\n\n## 主动上报\n\n需要时上报。\n',
      );
      return fakeResult('完成。');
    });

    await runAdminJob(app, 'guard-ok', '强化规则');

    const policiesLog = await gitLog(workspace, 'agent/POLICIES.md');
    expect(policiesLog.some((line) => line.includes('evolve:'))).toBe(true);
  });

  it('proposals 目录写入随自进化链提交；身份基线文件在 settleActive 后存在', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');

    // 创建即播种 proposals/README.md + IDENTITY_BASELINE.md。
    expect(await fs.pathExists(path.join(workspace, 'agent/proposals/README.md'))).toBe(true);
    expect(await fs.pathExists(path.join(workspace, 'agent/IDENTITY_BASELINE.md'))).toBe(true);

    // 员工写一份提案（未跟踪文件）→ settleEmployee 后随自进化链提交。
    const proposalFile = path.join(workspace, 'agent/proposals/p-20260806-01.md');
    await fs.writeFile(
      proposalFile,
      [
        '---',
        'proposal_id: p-20260806-01',
        'kind: policy',
        'status: proposed',
        'target_file: agent/POLICIES.md',
        'proposed_at: 2026-08-06T00:00:00+08:00',
        '---',
        '',
        '现状：...',
        '拟改：...',
        '理由：...',
        'because of knowledge/lessons/xxx.md:3',
        '',
      ].join('\n'),
    );
    await app.settleEmployee('worker-a');

    const log = await gitLog(workspace, 'agent/proposals/p-20260806-01.md');
    expect(log.some((line) => line.includes('evolve:'))).toBe(true);
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain('proposals/p-20260806-01.md');
  });

  it('identity-baseline 回填幂等：settleActive 不重复提交未变化的基线', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const baselineFile = path.join(workspace, 'agent', 'IDENTITY_BASELINE.md');
    const before = await fs.readFile(baselineFile, 'utf8');

    await app.settleEmployee('worker-a');
    await app.settleEmployee('worker-a');

    expect(await fs.readFile(baselineFile, 'utf8')).toBe(before);
    const log = await gitLog(workspace, 'agent/IDENTITY_BASELINE.md');
    // 创建时已提交一次（scaffold 基线）；settle 幂等不产生新的 evolve: 提交。
    expect(log.filter((line) => line.includes('evolve: 更新 身份基线')).length).toBe(0);
  });
});

describe('提案账本同步 + enforced 对账（D-041 P1-3）', () => {
  it('settleActive 扫描 proposals：登记提案 + 带 user_anchor 的 applied 提案登记批准决策', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');

    // 员工写一份已批准（applied + user_anchor）的提案 → settle 后账本应有 proposal + decision 两行。
    await fs.writeFile(
      path.join(workspace, 'agent/proposals/p-approved.md'),
      [
        '---',
        'proposal_id: p-approved-01',
        'kind: identity',
        'status: applied',
        'target_file: agent/ROLE.md',
        'proposed_at: 2026-08-06T00:00:00+08:00',
        'user_anchor: 用户说“就按这个改”',
        '---',
        '',
        '现状：...',
        '拟改：...',
      ].join('\n'),
    );
    await app.settleEmployee('worker-a');

    const { readLedger } = await import('../src/core/proposal-ledger.js');
    const ledger = await readLedger(paths.logsDir, 'worker-a');
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      event: 'proposal',
      proposal_id: 'p-approved-01',
      status: 'applied',
    });
    expect(ledger[1]).toMatchObject({
      event: 'decision',
      decision: 'approved',
      target_file: 'agent/ROLE.md',
      user_anchor: '用户说“就按这个改”',
    });
    // 账本写入进 evolve 提交（proposals 目录随自进化链提交）。
    const proposalLog = await gitLog(workspace, 'agent/proposals/p-approved.md');
    expect(proposalLog.some((line) => line.includes('evolve:'))).toBe(true);
  });

  it('enforced：未授权整删 POLICIES 红线词被拒绝提交 + CURRENT_STATE 留痕，合法文件不受影响', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const policiesFile = path.join(workspace, 'agent', 'POLICIES.md');
    const goalsFile = path.join(workspace, 'agent', 'GOALS.md');

    // 开启 identity_protocol=enforced。
    const agentYaml = path.join(workspace, 'agent.yaml');
    const YAML = (await import('yaml')).default;
    const parsed = YAML.parse(await fs.readFile(agentYaml, 'utf8'));
    parsed.memory.identity_protocol = 'enforced';
    await fs.writeFile(agentYaml, YAML.stringify(parsed));

    // 员工在任务中整删红线词（远超 allowedIdentityDiff、无 user_anchor 依据）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.writeFile(
        policiesFile,
        '# 权限与上报规则\n\n## 权限边界\n\n所有操作须谨慎。\n\n## 主动上报\n\n需要时上报。\n',
      );
      await fs.appendFile(goalsFile, '\n- 新增目标。\n');
      return fakeResult('完成。');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runAdminJob(app, 'ledger-block', '更新规则');

    // POLICIES.md 未提交（脏文件保留供人工决策）。
    const policiesLog = await gitLog(workspace, 'agent/POLICIES.md');
    expect(policiesLog.some((line) => line.includes('evolve:'))).toBe(false);
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).toContain('POLICIES.md');
    // warn 留痕包含 enforced 拒绝提交。
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('[identity-protocol] 检测到未授权身份改动（enforced）'),
      ),
    ).toBe(true);
    // 违规改动不被吸收进基线：POLICIES 基线条目保持原 sha256。
    const baselineFile = await fs.readFile(
      path.join(workspace, 'agent/IDENTITY_BASELINE.md'),
      'utf8',
    );
    const { parseIdentityBaseline } = await import('../src/core/identity-baseline.js');
    const baseline = parseIdentityBaseline(baselineFile);
    expect(baseline!.docs['agent/POLICIES.md'].content).toContain('人工审批');
    // CURRENT_STATE 记录「检测到未授权身份改动已拒绝提交」。
    const stateFile = await fs.readFile(path.join(workspace, 'agent/CURRENT_STATE.md'), 'utf8');
    expect(stateFile).toContain('未授权身份改动已拒绝提交');
    // 合法文件（GOALS）仍正常提交，不阻断主流程。
    const goalsLog = await gitLog(workspace, 'agent/GOALS.md');
    expect(goalsLog.some((line) => line.includes('evolve:'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('enforced：带 user_anchor 的 applied 提案 → 显著改动放行提交', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const roleFile = path.join(workspace, 'agent', 'ROLE.md');

    // 开启 enforced + 预置一份已批准提案（user_anchor 依据）。
    const agentYaml = path.join(workspace, 'agent.yaml');
    const YAML = (await import('yaml')).default;
    const parsed = YAML.parse(await fs.readFile(agentYaml, 'utf8'));
    parsed.memory.identity_protocol = 'enforced';
    await fs.writeFile(agentYaml, YAML.stringify(parsed));
    await fs.writeFile(
      path.join(workspace, 'agent/proposals/p-role.md'),
      [
        '---',
        'proposal_id: p-role-01',
        'kind: identity',
        'status: applied',
        'target_file: agent/ROLE.md',
        'proposed_at: 2026-08-06T00:00:00+08:00',
        'user_anchor: 用户说“岗位定位改成内容运营”',
        '---',
        '',
        '现状：...',
        '拟改：...',
      ].join('\n'),
    );

    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      // 大幅改写 ROLE（>30% 改动），但有 user_anchor 依据。
      await fs.writeFile(
        roleFile,
        '# 岗位定位\n\n负责内容运营。\n\n## 长期职责\n\n- 选题策划。\n- 内容撰写。\n- 数据分析。\n- 跨部门协同。\n- 独立跟进完整项目。\n- 输出周报。\n',
      );
      return fakeResult('完成。');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runAdminJob(app, 'ledger-approved', '按批准方案更新岗位');

    // ROLE.md 有 evolve: 提交（放行）。
    const roleLog = await gitLog(workspace, 'agent/ROLE.md');
    expect(roleLog.some((line) => line.includes('evolve:'))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe('身份 git 回滚 + knowledge 遗忘归档（D-041 P2）', () => {
  it('identity rollback 把身份文档恢复到历史提交内容，走 evolve 提交且工作区干净', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    const roleFile = path.join(workspace, 'agent', 'ROLE.md');
    const original = await fs.readFile(roleFile, 'utf8');

    // 员工在任务中修改岗位文档并提交（HEAD 变为新内容）。
    const { ProcessRunner } = await import('../src/core/process-runner.js');
    vi.spyOn(ProcessRunner.prototype, 'runLogged').mockImplementation(async () => {
      await fs.appendFile(roleFile, '\n- 已学习：优先使用异步批量处理。\n');
      return fakeResult('完成。');
    });
    await runAdminJob(app, 'role-change', '学习并更新岗位描述');

    // 回退目标 = 修改前的提交（git log 时间倒序，第 2 条即原创建提交）。
    const commits = (
      await execa('git', ['log', '--format=%H', '--', 'agent/ROLE.md'], {
        cwd: workspace,
        shell: false,
        extendEnv: false,
        reject: false,
      })
    ).stdout
      .split('\n')
      .filter(Boolean);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    const beforeCommit = commits[1];

    const result = await app.identityRollback('worker-a', 'agent/ROLE.md', {
      ref: beforeCommit,
    });
    expect(result.relPath).toBe('agent/ROLE.md');
    expect(result.ref).toBe(beforeCommit);
    // 工作区文件恢复为历史内容（含岗位定位锚点完整）。
    expect(await fs.readFile(roleFile, 'utf8')).toBe(original);
    // 回滚本身有 evolve 提交，且工作区干净（文件与提交一致）。
    const log = await gitLog(workspace, 'agent/ROLE.md');
    expect(log.some((line) => line.includes(`evolve: 回滚 agent/ROLE.md`))).toBe(true);
    const status = await execa('git', ['status', '--short'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain('ROLE.md');
  });

  it('identity rollback 拒绝非身份文档；目标提交无该文件时报 NOT_FOUND', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    await fs.ensureDir(path.join(workspace, 'knowledge', 'lessons'));
    await fs.writeFile(path.join(workspace, 'knowledge', 'lessons', 'note.md'), '# 知识\n');
    // 知识/技能等可进化区不提供 rollback 逃生口（员工 git 自主管理）。
    await expect(app.identityRollback('worker-a', 'knowledge/lessons/note.md')).rejects.toThrow(
      '仅支持身份文档',
    );
    // 目标提交不存在该文件（无效 ref）→ NOT_FOUND。
    await expect(
      app.identityRollback('worker-a', 'agent/GOALS.md', {
        ref: '0000000000000000000000000000000000000000',
      }),
    ).rejects.toThrow('不存在');
  });

  it('settleActive 末尾归档陈旧 raw 经验到 knowledge/.archive/（P2-1 钩子）', async () => {
    const { app, paths } = await setup();
    const workspace = path.join(paths.workspaceRoot, 'worker-a');
    // 播种一条超保留期（90 天）的 raw 经验；fresh 的留原处。
    const stale = new Date(Date.now() - 3 * 30 * 24 * 3600_000).toISOString().slice(0, 10);
    const fresh = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);
    const rawDir = path.join(workspace, 'knowledge', 'lessons', 'raw');
    await fs.ensureDir(rawDir);
    await fs.writeFile(path.join(rawDir, `${stale}-ops.md`), '旧经验\n');
    await fs.writeFile(path.join(rawDir, `${fresh}-ops.md`), '新经验\n');

    await app.settleEmployee('worker-a');

    // 陈旧条目移入 .archive/<date>/raw/，从 lessons/ 消失；fresh 条目不动。
    expect(await fs.pathExists(path.join(rawDir, `${stale}-ops.md`))).toBe(false);
    expect(
      await fs.pathExists(
        path.join(workspace, 'knowledge', '.archive', stale, 'raw', `${stale}-ops.md`),
      ),
    ).toBe(true);
    expect(await fs.pathExists(path.join(rawDir, `${fresh}-ops.md`))).toBe(true);
    // 归档目录已 .gitignore：移走的条目不进 git 跟踪（与「归档不进正式检索」一致）。
    const status = await execa('git', ['status', '--short', '--ignored'], {
      cwd: workspace,
      shell: false,
      extendEnv: false,
      reject: false,
    });
    expect(status.stdout).not.toContain(`.archive/${stale}`);
  });
});
