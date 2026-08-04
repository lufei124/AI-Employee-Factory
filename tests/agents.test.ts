import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPortableConfig } from '../src/core/agents.js';
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
    preset: 'user-operations',
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
