import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateAgentService } from '../src/core/create-agent.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { agentConfigSchema } from '../src/schemas/agent-schema.js';

const tempDirs: string[] = [];

// 为基线提交断言提供确定性 git 身份（CI 无全局 git config 时也能过）。
const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-create-'));
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
  const registry = new RegistryStore(paths.registryFile);
  await registry.initialize();
  return { paths, registry, service: new CreateAgentService(paths, registry) };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

describe('CreateAgentService', () => {
  it('creates an isolated Claude employee from a description-driven profile', async () => {
    const { paths, registry, service } = await setup();

    const created = await service.create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });

    expect(created.workspace).toBe(path.join(paths.workspaceRoot, 'user-operations'));
    expect(await fs.pathExists(path.join(created.workspace, '.git'))).toBe(true);
    // OP6-A（T01）：创建后应有基线提交（解锁后续 diff 审查）。
    const { stdout } = await execa('git', ['log', '--oneline', '-1', '--format=%s'], {
      cwd: created.workspace,
      shell: false,
    });
    expect(stdout.trim()).toBe('chore: initial scaffold');
    expect(await fs.pathExists(path.join(created.workspace, 'CLAUDE.md'))).toBe(true);
    expect(await fs.pathExists(path.join(created.workspace, 'AGENTS.md'))).toBe(false);
    expect(await fs.pathExists(path.join(created.workspace, '.codex'))).toBe(false);
    // 描述驱动，未给 skills → 仅预置宿主平台 skill（ai-employee-factory）
    expect(await fs.pathExists(path.join(created.workspace, 'skills'))).toBe(true);
    expect(await fs.readdir(path.join(created.workspace, 'skills'))).toEqual([
      'ai-employee-factory',
    ]);
    expect(await fs.pathExists(path.join(created.workspace, '.claude/skills'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.runtimesDir, 'user-operations/claude'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.bridgesDir, 'user-operations'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.logsDir, 'user-operations'))).toBe(true);
    const config = agentConfigSchema.parse(
      YAML.parse(await fs.readFile(path.join(created.workspace, 'agent.yaml'), 'utf8')),
    );
    expect(config.runtime).toEqual({ provider: 'claude', locked: true, model: 'sonnet' });
    expect((await registry.read()).agents[0]?.runtime_home.path).not.toContain('/.claude');
    // OP6-B：创建即写入带标记块的 CURRENT_STATE 种子 + settings 放行员工编辑该文件。
    const stateFile = await fs.readFile(
      path.join(created.workspace, 'agent/CURRENT_STATE.md'),
      'utf8',
    );
    expect(stateFile).toContain('<!-- factory-auto:begin -->');
    expect(stateFile).toContain('- 状态：已创建');
    expect(stateFile).toContain('## 工作进展');
    const claudeSettings = await fs.readJson(path.join(created.workspace, '.claude/settings.json'));
    expect(claudeSettings).toEqual({
      permissions: {
        defaultMode: 'default',
        allow: ['Edit(agent/CURRENT_STATE.md)', 'Write(agent/CURRENT_STATE.md)'],
      },
    });
  });

  it('writes memory.enforced=true and derived authority stance into the runtime prompt (OP1 Stage A)', async () => {
    const { service } = await setup();
    const claude = await service.create({
      id: 'claude-stance',
      name: 'Claude Stance',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated',
    });
    const claudeConfig = agentConfigSchema.parse(
      YAML.parse(await fs.readFile(path.join(claude.workspace, 'agent.yaml'), 'utf8')),
    );
    expect(claudeConfig.memory.enforced).toBe(true);
    const claudePrompt = await fs.readFile(path.join(claude.workspace, 'CLAUDE.md'), 'utf8');
    expect(claudePrompt).toContain('## 记忆权威顺序');
    expect(claudePrompt).toContain('1. agent（岗位正式文件');
    // OP6-B：运行指南含当前状态维护约定。
    expect(claudePrompt).toContain('## 当前状态维护');
    expect(claudePrompt).toContain('agent/CURRENT_STATE.md');

    const codex = await service.create({
      id: 'codex-stance',
      name: 'Codex Stance',
      runtime: 'codex',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
    });
    const codexPrompt = await fs.readFile(path.join(codex.workspace, 'AGENTS.md'), 'utf8');
    expect(codexPrompt).toContain('## 记忆权威顺序');
    expect(codexPrompt).toContain('1. agent（岗位正式文件');
    // OP6-B：codex 侧同样注入当前状态维护约定。
    expect(codexPrompt).toContain('## 当前状态维护');
    expect(codexPrompt).toContain('agent/CURRENT_STATE.md');
  });

  it('creates a Chief from --role chief and defaults new agents to worker (T08)', async () => {
    const { service } = await setup();
    const chief = await service.create({
      id: 'chief',
      name: '主管',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
      role: 'chief',
    });
    const chiefConfig = agentConfigSchema.parse(
      YAML.parse(await fs.readFile(path.join(chief.workspace, 'agent.yaml'), 'utf8')),
    );
    expect(chiefConfig.role).toBe('chief');

    const worker = await service.create({
      id: 'worker',
      name: '执行者',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
    });
    const workerConfig = agentConfigSchema.parse(
      YAML.parse(await fs.readFile(path.join(worker.workspace, 'agent.yaml'), 'utf8')),
    );
    expect(workerConfig.role).toBe('worker');
  });

  it('does not leave a staging workspace after duplicate creation', async () => {
    const { paths, service } = await setup();
    const input = {
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude' as const,
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'dedicated' as const,
    };
    await service.create(input);

    await expect(service.create(input)).rejects.toThrow('已存在');
    expect(
      (await fs.readdir(paths.workspaceRoot)).filter((name) => name.startsWith('.staging-')),
    ).toEqual([]);
  });

  it('synthesizes default responsibilities/policies from description+goals and renders skills (D-029)', async () => {
    const { service } = await setup();
    const created = await service.create({
      id: 'gen-profile',
      name: '内容运营',
      runtime: 'claude',
      feishu: 'disabled',
      description: '负责内容选题、撰写与效果复盘',
      goals: ['每周输出报告', '提升内容转化'],
      responsibilities: ['选题策划', '内容撰写'],
      policies: ['对外发布须审批'],
      skills: ['content-writing'],
    });
    const role = await fs.readFile(path.join(created.workspace, 'agent/ROLE.md'), 'utf8');
    const goalsMd = await fs.readFile(path.join(created.workspace, 'agent/GOALS.md'), 'utf8');
    const policiesMd = await fs.readFile(path.join(created.workspace, 'agent/POLICIES.md'), 'utf8');
    // 显式 responsibilities 渲染进 ROLE；goals 渲染进 GOALS；显式 policies 覆盖默认。
    expect(role).toContain('- 选题策划');
    expect(role).toContain('- 内容撰写');
    expect(goalsMd).toContain('- 每周输出报告');
    expect(policiesMd).toContain('- 对外发布须审批');
    expect(policiesMd).not.toContain('生产写入、对外发布、Git push');
    // skills 渲染为占位 skill 目录（含 .codex 投影）。
    expect(
      await fs.pathExists(path.join(created.workspace, 'skills/content-writing/SKILL.md')),
    ).toBe(true);
    expect(
      await fs.pathExists(path.join(created.workspace, '.claude/skills/content-writing')),
    ).toBe(true);
    // TASK-037：新建员工自动预置宿主平台 skill（内容 + .claude 投影）。
    expect(
      await fs.pathExists(path.join(created.workspace, 'skills/ai-employee-factory/SKILL.md')),
    ).toBe(true);
    expect(
      await fs.pathExists(path.join(created.workspace, '.claude/skills/ai-employee-factory')),
    ).toBe(true);
    const factorySkill = await fs.readFile(
      path.join(created.workspace, 'skills/ai-employee-factory/SKILL.md'),
      'utf8',
    );
    expect(factorySkill).toContain('AI Employee Factory');
    expect(factorySkill).toContain(created.id);
    // 缺 responsibilities/policies 时用默认（description 作职责、默认审批策略）。
    const minimal = await service.create({
      id: 'minimal-profile',
      name: '最小员工',
      runtime: 'codex',
      feishu: 'disabled',
      description: '仅描述',
      goals: ['目标一'],
    });
    const minimalRole = await fs.readFile(path.join(minimal.workspace, 'agent/ROLE.md'), 'utf8');
    const minimalPolicies = await fs.readFile(
      path.join(minimal.workspace, 'agent/POLICIES.md'),
      'utf8',
    );
    expect(minimalRole).toContain('- 仅描述');
    expect(minimalPolicies).toContain('生产写入、对外发布、Git push 和删除数据必须经人工审批');
    // TASK-037：codex 员工也预置宿主平台 skill（.codex 投影）。
    expect(
      await fs.pathExists(path.join(minimal.workspace, 'skills/ai-employee-factory/SKILL.md')),
    ).toBe(true);
    expect(
      await fs.pathExists(path.join(minimal.workspace, '.codex/skills/ai-employee-factory')),
    ).toBe(true);
  });
});
