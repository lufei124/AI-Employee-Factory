import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { computeConfigHash, loadPortableConfig } from '../src/core/agents.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-repair-'));
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

describe('FactoryApplication.repairAgent (OP3-A)', () => {
  it('rebuilds Registry runtime block and config_hash from agent.yaml truth', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // 模拟漂移：手工改 agent.yaml 的 model 为 opus，Registry 仍缓存 sonnet。
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as { runtime: { model?: string } };
    doc.runtime.model = 'opus';
    await fs.writeFile(agentYaml, YAML.stringify(doc));

    const result = await application.repairAgent(agent.id);
    expect(result.resynced.model).toBe(true);
    expect(result.resynced.hash).toBe(true);

    const updated = (await registry.read()).agents[0];
    if (!updated) throw new Error('missing updated agent');
    expect(updated.runtime.model).toBe('opus');
    const portable = await loadPortableConfig(updated);
    expect(updated.config_hash).toBe(computeConfigHash(portable.runtime));
  });

  it('reports no change when agent.yaml already matches Registry cache', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const result = await application.repairAgent(agent.id);
    expect(result.resynced.model).toBe(false);
    expect(result.resynced.hash).toBe(false);
  });

  it('refuses when agent.yaml provider drifts from Registry (immutable)', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // provider 是不可变字段；agent.yaml 改 provider 后 loadPortableConfig 拒绝。
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
      runtime: { provider: string };
    };
    doc.runtime.provider = 'codex';
    await fs.writeFile(agentYaml, YAML.stringify(doc));
    await expect(application.repairAgent(agent.id)).rejects.toThrow('不一致');
  });
});
