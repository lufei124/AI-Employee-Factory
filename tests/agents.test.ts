import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { computeConfigHash, loadPortableConfig } from '../src/core/agents.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-agents-'));
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
  const agent = (await registry.read()).agents[0];
  return { root, paths, registry, agent };
}

describe('loadPortableConfig versioned reader (OP3-B)', () => {
  it('parses a v1 agent.yaml via the identity reader', async () => {
    const { agent } = await setup();
    const config = await loadPortableConfig(agent);
    expect(config.schema_version).toBe(1);
    expect(config.id).toBe('user-operations');
  });

  it('rejects an unknown schema_version with VALIDATION_ERROR', async () => {
    const { agent } = await setup();
    const file = path.join(agent.workspace.path, 'agent.yaml');
    await fs.writeFile(file, YAML.stringify({ schema_version: 2 }));
    await expect(loadPortableConfig(agent)).rejects.toThrow(
      /不支持的 agent\.yaml schema_version：2/,
    );
  });
});

describe('computeConfigHash (OP3-A)', () => {
  it('is deterministic and reflects the runtime block', () => {
    const a = computeConfigHash({ provider: 'claude', locked: true, model: 'sonnet' });
    const b = computeConfigHash({ provider: 'claude', locked: true, model: 'sonnet' });
    expect(a).toBe(b);
    expect(a).not.toBe(computeConfigHash({ provider: 'claude', locked: true, model: 'opus' }));
    expect(a).not.toBe(computeConfigHash({ provider: 'codex', locked: true, model: 'sonnet' }));
    expect(a).not.toBe(computeConfigHash({ provider: 'claude', locked: true }));
  });

  it('create flow stores config_hash matching agent.yaml runtime block', async () => {
    const { agent } = await setup();
    const config = await loadPortableConfig(agent);
    expect(agent.config_hash).toBe(computeConfigHash(config.runtime));
  });
});
