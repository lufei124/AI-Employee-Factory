import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];
let prevGitConfigGlobal: string | undefined;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-mem-enforce-'));
  roots.push(root);
  const gitConfig = path.join(root, 'gitconfig');
  await fs.writeFile(
    gitConfig,
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  await initializeFactory(paths);
  const registry = new RegistryStore(paths.registryFile);
  await new CreateAgentService(paths, registry).create({
    id: 'user-operations',
    name: '用户运营专员',
    runtime: 'claude',
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈', '闭环跟进问题'],
    feishu: 'dedicated',
  });
  return { root, paths, registry, application: new FactoryApplication(paths, registry) };
}

async function editMemory(
  agentYaml: string,
  mutate: (memory: { authority_order: string[]; enforced?: boolean }) => void,
): Promise<void> {
  const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
    memory: { authority_order: string[]; enforced?: boolean };
  };
  mutate(doc.memory);
  await fs.writeFile(agentYaml, YAML.stringify(doc));
}

describe('FactoryApplication prepareRuntime memory enforcement (OP1 Stage A)', () => {
  it('hard-fails before spawn when enforced:true and authority_order is invalid', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // enforced 保持 true，把 authority_order 改成缺 agent 的非法序。
    await editMemory(path.join(agent.workspace.path, 'agent.yaml'), (memory) => {
      memory.authority_order = ['knowledge', 'decisions'];
    });
    // syncRuntime 经 getAgent -> prepareRuntime -> assertMemoryEnforced，在 spawn 前抛 VALIDATION_ERROR。
    await expect(application.syncRuntime(agent.id)).rejects.toThrow('memory 配置无效');
  });

  it('skips the memory gate when enforced is false (proceeds to CC Switch sync)', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // 显式关闭强制 + 非法序：assertMemoryEnforced 跳过，进入 CC Switch 同步，
    // 临时 HOME 无 CC Switch -> NOT_FOUND（证明未在 memory 检查处硬失败）。
    await editMemory(path.join(agent.workspace.path, 'agent.yaml'), (memory) => {
      memory.authority_order = ['knowledge'];
      memory.enforced = false;
    });
    await expect(application.syncRuntime(agent.id)).rejects.toThrow('CC Switch');
  });
});

describe('ensureMemoryFlags 存量回填（D-041 P1-1）', () => {
  it('缺失自进化开关的存量员工在 settle 时回填默认 true，并 evolve 提交', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const yamlFile = path.join(agent.workspace.path, 'agent.yaml');

    // 模拟 D-041 之前的旧 agent.yaml：三个自进化开关缺失（undefined）。
    // 注意：新建员工已显式写三个 true 并被初始 scaffold 提交，故需先把「旧版（无开关）」
    // 提交为基线，再触发回填——否则回填后的内容与已提交版本相同，git 无 diff，不产生提交。
    const doc = YAML.parse(await fs.readFile(yamlFile, 'utf8')) as Record<string, unknown>;
    delete (doc.memory as Record<string, unknown>).transcript_persist;
    delete (doc.memory as Record<string, unknown>).experience_extraction;
    delete (doc.memory as Record<string, unknown>).skill_self_creation;
    await fs.writeFile(yamlFile, YAML.stringify(doc));
    await execa('git', ['-C', agent.workspace.path, 'add', 'agent.yaml'], {
      reject: false,
      extendEnv: false,
    });
    await execa('git', ['-C', agent.workspace.path, 'commit', '-m', 'legacy baseline'], {
      reject: false,
      extendEnv: false,
    });

    // settle 链触发 ensureMemoryFlags 回填。
    await application.settleEmployee(agent.id);

    // 三个开关被回填为 true；显式既有值不受影响。
    const after = YAML.parse(await fs.readFile(yamlFile, 'utf8')) as {
      memory: Record<string, unknown>;
    };
    expect(after.memory.transcript_persist).toBe(true);
    expect(after.memory.experience_extraction).toBe(true);
    expect(after.memory.skill_self_creation).toBe(true);
    // 回填写入被 evolve 单文件提交（可回溯）。
    const { stdout } = await execa('git', ['-C', agent.workspace.path, 'log', '--oneline'], {
      reject: false,
      extendEnv: false,
    });
    expect(stdout).toMatch(/evolve: 更新 agent\.yaml/);
  });

  it('显式 false 尊重用户关闭意图，不回填；幂等不产生重复提交', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const yamlFile = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(yamlFile, 'utf8')) as {
      memory: Record<string, unknown>;
    };
    delete (doc.memory as Record<string, unknown>).transcript_persist;
    delete (doc.memory as Record<string, unknown>).experience_extraction;
    (doc.memory as Record<string, unknown>).skill_self_creation = false;
    await fs.writeFile(yamlFile, YAML.stringify(doc));
    // 与上一测试同理：先把旧版提交为基线，使回填产生可验证的 git 差异。
    await execa('git', ['-C', agent.workspace.path, 'add', 'agent.yaml'], {
      reject: false,
      extendEnv: false,
    });
    await execa('git', ['-C', agent.workspace.path, 'commit', '-m', 'legacy baseline'], {
      reject: false,
      extendEnv: false,
    });

    await application.settleEmployee(agent.id);

    const after = YAML.parse(await fs.readFile(yamlFile, 'utf8')) as {
      memory: Record<string, unknown>;
    };
    // undefined 的两个开关回填 true；显式 false 保留。
    expect(after.memory.transcript_persist).toBe(true);
    expect(after.memory.experience_extraction).toBe(true);
    expect(after.memory.skill_self_creation).toBe(false);
    // 幂等：第二次 settle 不产生新的 agent.yaml evolve 提交（无变更）。
    const before = await fs.readFile(yamlFile, 'utf8');
    await application.settleEmployee(agent.id);
    expect(await fs.readFile(yamlFile, 'utf8')).toBe(before);
  });
});
