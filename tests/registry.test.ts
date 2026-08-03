import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RegistryStore } from '../src/core/registry.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-registry-'));
  tempDirs.push(root);
  return root;
}

function agent(root: string, id = 'user-operations'): RegistryAgent {
  return {
    id,
    name: '用户运营专员',
    status: 'stopped',
    archived: false,
    runtime: { provider: 'claude', locked: true, model: 'sonnet' },
    workspace: { path: path.join(root, 'workspaces', id), git_repository: true },
    runtime_home: { path: path.join(root, 'private', 'runtimes', id, 'claude') },
    bridge: {
      enabled: true,
      profile: id,
      home: path.join(root, 'private', 'bridges', id),
      mode: 'dedicated_bot',
      authorization: 'pending',
    },
    permissions: { level: 'workspace', production_write: 'approval_required' },
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('RegistryStore', () => {
  it('initializes and atomically persists a registry with restrictive mode', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'registry', 'agents.yaml');
    const store = new RegistryStore(file);

    await store.initialize();
    await store.add(agent(root));

    expect((await store.read()).agents).toHaveLength(1);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(file))).some((name) => name.includes('.tmp-'))).toBe(
      false,
    );
  });

  it('creates a backup before updating an existing registry', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    await store.add(agent(root));

    const backups = await fs.readdir(path.join(root, 'registry', 'backups'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('rejects duplicate ids, workspaces, runtime homes, and bridge profiles', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    const first = agent(root);
    await store.add(first);

    await expect(
      store.add({ ...agent(root, 'other'), workspace: first.workspace }),
    ).rejects.toThrow('工作区');
    await expect(
      store.add({ ...agent(root, 'other'), runtime_home: first.runtime_home }),
    ).rejects.toThrow('Runtime Home');
    await expect(
      store.add({ ...agent(root, 'other'), bridge: { ...first.bridge } }),
    ).rejects.toThrow('Bridge Profile');
    await expect(store.add(first)).rejects.toThrow('已存在');
  });
});
