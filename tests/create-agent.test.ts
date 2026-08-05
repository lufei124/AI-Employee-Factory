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
  it('creates an isolated Claude employee from the user-operations preset', async () => {
    const { paths, registry, service } = await setup();

    const created = await service.create({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      preset: 'user-operations',
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
    // preset 无内置 skill，skills 目录为空
    expect(await fs.pathExists(path.join(created.workspace, 'skills'))).toBe(true);
    expect(await fs.readdir(path.join(created.workspace, 'skills'))).toEqual([]);
    expect(await fs.pathExists(path.join(created.workspace, '.claude/skills'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.runtimesDir, 'user-operations/claude'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.bridgesDir, 'user-operations'))).toBe(true);
    expect(await fs.pathExists(path.join(paths.logsDir, 'user-operations'))).toBe(true);
    const config = agentConfigSchema.parse(
      YAML.parse(await fs.readFile(path.join(created.workspace, 'agent.yaml'), 'utf8')),
    );
    expect(config.runtime).toEqual({ provider: 'claude', locked: true, model: 'sonnet' });
    expect((await registry.read()).agents[0]?.runtime_home.path).not.toContain('/.claude');
  });

  it('writes memory.enforced=true and derived authority stance into the runtime prompt (OP1 Stage A)', async () => {
    const { service } = await setup();
    const claude = await service.create({
      id: 'claude-stance',
      name: 'Claude Stance',
      runtime: 'claude',
      preset: 'user-operations',
      feishu: 'dedicated',
    });
    const claudeConfig = agentConfigSchema.parse(
      YAML.parse(await fs.readFile(path.join(claude.workspace, 'agent.yaml'), 'utf8')),
    );
    expect(claudeConfig.memory.enforced).toBe(true);
    const claudePrompt = await fs.readFile(path.join(claude.workspace, 'CLAUDE.md'), 'utf8');
    expect(claudePrompt).toContain('## 记忆权威顺序');
    expect(claudePrompt).toContain('1. agent（岗位正式文件');

    const codex = await service.create({
      id: 'codex-stance',
      name: 'Codex Stance',
      runtime: 'codex',
      preset: 'user-operations',
      feishu: 'disabled',
    });
    const codexPrompt = await fs.readFile(path.join(codex.workspace, 'AGENTS.md'), 'utf8');
    expect(codexPrompt).toContain('## 记忆权威顺序');
    expect(codexPrompt).toContain('1. agent（岗位正式文件');
  });

  it('creates a Chief from --role chief and defaults new agents to worker (T08)', async () => {
    const { service } = await setup();
    const chief = await service.create({
      id: 'chief',
      name: '主管',
      runtime: 'claude',
      preset: 'user-operations',
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
      preset: 'user-operations',
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
      preset: 'user-operations',
      feishu: 'dedicated' as const,
    };
    await service.create(input);

    await expect(service.create(input)).rejects.toThrow('已存在');
    expect(
      (await fs.readdir(paths.workspaceRoot)).filter((name) => name.startsWith('.staging-')),
    ).toEqual([]);
  });
});
