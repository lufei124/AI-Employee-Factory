import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeConfigHash } from '../src/core/agents.js';
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

  it('serializes concurrent updates under a global registry lock without losing entries', async () => {
    const root = await tempRoot();
    const locksDir = path.join(root, 'locks');
    await fs.ensureDir(locksDir);
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'), locksDir);
    await store.initialize();

    const count = 12;
    await Promise.all(
      Array.from({ length: count }, (_, index) => store.add(agent(root, `agent-${index}`))),
    );

    const agents = (await store.read()).agents;
    expect(agents).toHaveLength(count);
    expect(new Set(agents.map((entry) => entry.id)).size).toBe(count);
    // 锁在 finally 中释放
    expect(await fs.pathExists(path.join(locksDir, 'registry.lock'))).toBe(false);
  });

  it('stores config_hash on add (OP3-A)', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    await store.add({ ...agent(root), config_hash: 'abc123' });
    expect((await store.read()).agents[0]?.config_hash).toBe('abc123');
  });

  it('rejects model changes via updateAgent but allows status changes (OP3-A single writable source)', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    await store.add(agent(root));
    await expect(
      store.updateAgent('user-operations', (current) => ({
        ...current,
        runtime: { ...current.runtime, model: 'opus' },
      })),
    ).rejects.toThrow('model');
    // 非 model 字段（status）仍可改
    await store.updateAgent('user-operations', (current) => ({ ...current, status: 'running' }));
    expect((await store.read()).agents[0]?.status).toBe('running');
  });

  it('resyncRuntime rebuilds runtime block and config_hash from agent.yaml truth (OP3-A)', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    await store.add(agent(root));
    const runtime = { provider: 'claude' as const, locked: true as const, model: 'opus' };
    await store.resyncRuntime('user-operations', runtime, computeConfigHash(runtime));
    const updated = (await store.read()).agents[0];
    expect(updated?.runtime.model).toBe('opus');
    expect(updated?.config_hash).toBe(computeConfigHash(runtime));
  });

  it('resyncRuntime refuses provider/locked immutability violations', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    await store.add(agent(root));
    await expect(
      store.resyncRuntime(
        'user-operations',
        { provider: 'codex', locked: true, model: 'sonnet' },
        'deadbeef',
      ),
    ).rejects.toThrow('provider/locked');
  });
});
