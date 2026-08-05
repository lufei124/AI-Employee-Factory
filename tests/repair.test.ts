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
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈', '闭环跟进问题'],
    feishu: 'dedicated',
  });
  return { root, paths, registry, application: new FactoryApplication(paths, registry) };
}

describe('FactoryApplication.repairAgent (OP3-A HARD)', () => {
  it('rebuilds Registry config_hash from agent.yaml truth after a model drift', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // 模拟漂移：手工改 agent.yaml 的 model 为 opus。
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as { runtime: { model?: string } };
    doc.runtime.model = 'opus';
    await fs.writeFile(agentYaml, YAML.stringify(doc));

    const result = await application.repairAgent(agent.id);
    expect(result).toEqual({ id: agent.id, config_hash: computeConfigHash(doc.runtime) });
    const updated = (await registry.read()).agents[0];
    if (!updated) throw new Error('missing updated agent');
    expect(updated.config_hash).toBe(computeConfigHash(doc.runtime));
    // 修复后 loadPortableConfig 不再抛 HARD CONFLICT
    const portable = await loadPortableConfig(updated);
    expect(portable.runtime.model).toBe('opus');
  });

  it('is idempotent when agent.yaml already matches Registry config_hash', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const before = agent.config_hash;
    const result = await application.repairAgent(agent.id);
    const updated = (await registry.read()).agents[0];
    expect(result.config_hash).toBe(before);
    expect(updated?.config_hash).toBe(before);
    // 幂等：重复 repair 不改变 config_hash
    await application.repairAgent(agent.id);
    expect((await registry.read()).agents[0]?.config_hash).toBe(before);
  });

  it('repairs provider drift as the escape hatch (agent.yaml is sole source)', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // provider 漂移：agent.yaml 改 provider 后，loadPortableConfig 会 HARD 拒绝，
    // 但 repairAgent 绕过它直接按 agent.yaml 重建 config_hash。
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as {
      runtime: { provider: string };
    };
    doc.runtime.provider = 'codex';
    await fs.writeFile(agentYaml, YAML.stringify(doc));

    const result = await application.repairAgent(agent.id);
    expect(result.config_hash).toBe(computeConfigHash(doc.runtime));
    const updated = (await registry.read()).agents[0];
    expect(updated?.config_hash).toBe(computeConfigHash(doc.runtime));
  });

  it('loadPortableConfig throws HARD CONFLICT when config_hash drifts (I-5)', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as { runtime: { model?: string } };
    doc.runtime.model = 'opus';
    await fs.writeFile(agentYaml, YAML.stringify(doc));
    // HARD：漂移后 loadPortableConfig 抛 CONFLICT，阻断运行
    await expect(loadPortableConfig(agent)).rejects.toThrow('不一致');
    // 但 repairAgent 可绕过并修复
    await application.repairAgent(agent.id);
    const updated = (await registry.read()).agents[0];
    if (!updated) throw new Error('missing updated agent');
    await expect(loadPortableConfig(updated)).resolves.toBeDefined();
  });
});
