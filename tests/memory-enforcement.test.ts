import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-mem-enforce-'));
  roots.push(root);
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
    preset: 'user-operations',
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
