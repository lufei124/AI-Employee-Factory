import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
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

  it('allows status changes via updateAgent and preserves config_hash (OP3-A single writable source)', async () => {
    const root = await tempRoot();
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'));
    await store.initialize();
    await store.add({ ...agent(root), config_hash: 'abc123' });
    await store.updateAgent('user-operations', (current) => ({ ...current, status: 'running' }));
    const updated = (await store.read()).agents[0];
    expect(updated?.status).toBe('running');
    // Registry 不再持有 runtime 块；updateAgent 不得触碰 config_hash（仍由 refreshConfigHash 维护）
    expect(updated?.config_hash).toBe('abc123');
  });

  it('refreshConfigHash updates config_hash under lock (OP3-A)', async () => {
    const root = await tempRoot();
    const locksDir = path.join(root, 'locks');
    await fs.ensureDir(locksDir);
    const store = new RegistryStore(path.join(root, 'registry', 'agents.yaml'), locksDir);
    await store.initialize();
    await store.add(agent(root));
    const hash = computeConfigHash({ provider: 'claude', locked: true, model: 'opus' });
    await store.refreshConfigHash('user-operations', hash);
    const updated = (await store.read()).agents[0];
    expect(updated?.config_hash).toBe(hash);
    expect(await fs.pathExists(path.join(locksDir, 'registry.lock'))).toBe(false);
  });

  it('read() normalizes a v1 registry file to v2 in memory without dropping data (SOFT)', async () => {
    const root = await tempRoot();
    await fs.ensureDir(path.join(root, 'registry'));
    const file = path.join(root, 'registry', 'agents.yaml');
    const v1 = {
      version: 1,
      agents: [
        {
          ...agent(root),
          runtime: { provider: 'claude', locked: true, model: 'sonnet' },
          config_hash: 'abc123',
        },
      ],
    };
    await fs.writeFile(file, YAML.stringify(v1));
    const store = new RegistryStore(file);
    const read = await store.read();
    expect(read.version).toBe(2);
    const entry = read.agents[0];
    expect(entry).toBeDefined();
    // runtime 块被丢弃，config_hash 与其余字段保留
    expect('runtime' in entry).toBe(false);
    expect(entry?.config_hash).toBe('abc123');
    expect(entry?.id).toBe('user-operations');
  });

  it('migrate() rewrites a v1 registry file to v2 on disk; dry-run does not', async () => {
    const root = await tempRoot();
    await fs.ensureDir(path.join(root, 'registry'));
    await fs.ensureDir(path.join(root, 'locks'));
    const file = path.join(root, 'registry', 'agents.yaml');
    const v1 = {
      version: 1,
      agents: [
        {
          ...agent(root),
          runtime: { provider: 'claude', locked: true, model: 'sonnet' },
          config_hash: 'abc123',
        },
      ],
    };
    await fs.writeFile(file, YAML.stringify(v1));
    const store = new RegistryStore(file, path.join(root, 'locks'));
    const dry = await store.migrate({ dryRun: true });
    expect(dry.migrated).toBe(true);
    expect((YAML.parse(await fs.readFile(file, 'utf8')) as { version: number }).version).toBe(1);
    const run = await store.migrate();
    expect(run.migrated).toBe(true);
    const rewritten = YAML.parse(await fs.readFile(file, 'utf8')) as {
      version: number;
      agents: Array<Record<string, unknown>>;
    };
    expect(rewritten.version).toBe(2);
    expect('runtime' in rewritten.agents[0]).toBe(false);
    // 幂等：再次迁移无操作
    expect((await store.migrate()).migrated).toBe(false);
  });

  it('read() rejects an unknown registry version', async () => {
    const root = await tempRoot();
    await fs.ensureDir(path.join(root, 'registry'));
    const file = path.join(root, 'registry', 'agents.yaml');
    await fs.writeFile(file, YAML.stringify({ version: 99, agents: [] }));
    const store = new RegistryStore(file);
    await expect(store.read()).rejects.toThrow('格式无效');
  });
});
