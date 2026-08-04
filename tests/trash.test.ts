import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

const roots: string[] = [];

function testAgent(root: string): RegistryAgent {
  return {
    id: 'test-employee',
    name: '测试员工',
    status: 'stopped',
    archived: false,
    runtime: { provider: 'claude', locked: true },
    workspace: { path: path.join(root, 'agents/test-employee'), git_repository: true },
    runtime_home: { path: path.join(root, 'private/runtimes/test-employee/claude') },
    bridge: {
      enabled: false,
      home: path.join(root, 'private/bridges/test-employee'),
      mode: 'disabled',
      authorization: 'pending',
    },
    permissions: { level: 'workspace', production_write: 'approval_required' },
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function setupTrashAgent() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-trash-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  await initializeFactory(paths);
  const registry = new RegistryStore(paths.registryFile);
  const agent = testAgent(root);
  await registry.add(agent);
  const components = [
    agent.workspace.path,
    agent.runtime_home.path,
    agent.bridge.home,
    path.join(paths.logsDir, agent.id),
    path.join(paths.servicesDir, agent.id),
    path.join(paths.schedulesDir, agent.id),
  ];
  for (const component of components) await fs.outputFile(path.join(component, 'marker'), 'data');
  await fs.outputFile(path.join(agent.runtime_home.path, 'settings.json'), 'runtime-secret-value');
  return { root, paths, registry, agent, components };
}

// R20：直接改写 manifest 状态，模拟 purgeExpired/restore 中途失败留下的 failed/卡死条目。
async function forceTrashState(paths: { trashDir: string }, trashId: string, state: string) {
  const file = path.join(paths.trashDir, 'manifests', `${trashId}.yaml`);
  const doc = YAML.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  doc.state = state;
  await fs.writeFile(file, YAML.stringify(doc));
}

describe('RegistryStore trash support', () => {
  it('atomically removes and returns one registered Agent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-trash-registry-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await registry.add(testAgent(root));

    const removed = await registry.remove('test-employee');

    expect(removed.id).toBe('test-employee');
    expect((await registry.read()).agents).toEqual([]);
  });
});

describe('trash manifest schema', () => {
  it('validates a versioned ready manifest without storing component contents', async () => {
    const module = (await import('../src/schemas/trash-schema.js')) as Record<string, unknown>;
    const schema = module.trashManifestSchema as { parse: (value: unknown) => unknown };
    expect(schema).toBeDefined();
    expect(
      schema.parse({
        schema_version: 1,
        trash_id: '018f6b77-82d4-7c80-8000-000000000001',
        agent_id: 'test-employee',
        name: '测试员工',
        deleted_at: '2026-08-03T00:00:00.000Z',
        expires_at: '2026-08-10T00:00:00.000Z',
        state: 'ready',
        registry: testAgent('/tmp/trash-schema'),
        components: ['workspace', 'runtime', 'bridge', 'logs', 'services', 'schedules'].map(
          (name) => ({
            name,
            source: `/tmp/trash-schema/${name}/test-employee`,
            trashed: `/tmp/trash-schema/${name}/.agentctl-trash/id/${name}`,
            existed: true,
            moved: true,
          }),
        ),
      }),
    ).toMatchObject({ schema_version: 1, state: 'ready' });
  });
});

describe('TrashService', () => {
  it('moves every managed component out of the active roots and restores it stopped', async () => {
    const { paths, registry, agent, components } = await setupTrashAgent();
    const module = (await import('../src/core/trash.js')) as Record<string, unknown>;
    const TrashService = module.TrashService as new (
      paths: typeof paths,
      registry: RegistryStore,
    ) => {
      move: (agent: RegistryAgent) => Promise<{ trashId: string }>;
      list: () => Promise<Array<{ trashId: string; agentId: string }>>;
      restore: (trashId: string) => Promise<void>;
    };
    expect(TrashService).toBeDefined();
    const service = new TrashService(paths, registry);

    const entry = await service.move(agent);

    expect((await registry.read()).agents).toEqual([]);
    for (const component of components) expect(await fs.pathExists(component)).toBe(false);
    expect(await service.list()).toEqual([
      expect.objectContaining({ trashId: entry.trashId, agentId: agent.id }),
    ]);
    const manifestText = await fs.readFile(
      path.join(paths.trashDir, 'manifests', `${entry.trashId}.yaml`),
      'utf8',
    );
    expect(manifestText).not.toContain('runtime-secret-value');

    await service.restore(entry.trashId);

    for (const component of components) expect(await fs.pathExists(component)).toBe(true);
    expect((await registry.read()).agents[0]).toMatchObject({
      id: agent.id,
      status: 'stopped',
      archived: false,
    });
    expect(await service.list()).toEqual([]);
  });

  it('resets Bridge authorization to pending on restore so stale credentials must be re-authorized', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-trash-r19-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    const readyAgent: RegistryAgent = {
      ...testAgent(root),
      bridge: {
        enabled: true,
        profile: 'test-employee',
        home: path.join(root, 'private/bridges/test-employee'),
        mode: 'dedicated_bot',
        authorization: 'ready',
      },
    };
    await registry.add(readyAgent);
    for (const component of [
      readyAgent.workspace.path,
      readyAgent.runtime_home.path,
      readyAgent.bridge.home,
    ])
      await fs.outputFile(path.join(component, 'marker'), 'data');

    const { TrashService } = await import('../src/core/trash.js');
    const service = new TrashService(paths, registry);
    const entry = await service.move(readyAgent);

    await service.restore(entry.trashId);

    const restored = (await registry.read()).agents[0];
    expect(restored).toMatchObject({ id: 'test-employee', status: 'stopped' });
    expect(restored.bridge.authorization).toBe('pending');
  });

  it('purges only ready entries whose seven-day retention has expired', async () => {
    const { paths, registry, agent } = await setupTrashAgent();
    const { TrashService } = await import('../src/core/trash.js');
    const service = new TrashService(paths, registry);
    const deletedAt = new Date('2026-08-01T00:00:00.000Z');
    const entry = await service.move(agent, deletedAt);

    expect((await service.purgeExpired(new Date('2026-08-07T23:59:59.000Z'))).purged).toEqual([]);
    expect((await service.purgeExpired(new Date('2026-08-08T00:00:00.000Z'))).purged).toEqual([
      entry.trashId,
    ]);
    expect(await service.list()).toEqual([]);
  });

  it('rolls every component back when Registry removal fails', async () => {
    const { paths, registry, agent, components } = await setupTrashAgent();
    const failingRegistry = new RegistryStore(paths.registryFile);
    failingRegistry.remove = async () => {
      throw new Error('injected registry failure');
    };
    const { TrashService } = await import('../src/core/trash.js');

    await expect(new TrashService(paths, failingRegistry).move(agent)).rejects.toThrow(
      '移入回收站失败',
    );

    for (const component of components) expect(await fs.pathExists(component)).toBe(true);
    expect((await registry.read()).agents[0]?.id).toBe(agent.id);
  });

  it('refuses restore when the original Agent ID has been reused', async () => {
    const { paths, registry, agent } = await setupTrashAgent();
    const { TrashService } = await import('../src/core/trash.js');
    const service = new TrashService(paths, registry);
    const entry = await service.move(agent);
    await registry.add({
      ...agent,
      workspace: { ...agent.workspace, path: path.join(paths.workspaceRoot, 'replacement') },
      runtime_home: { path: path.join(paths.runtimesDir, 'replacement/claude') },
      bridge: { ...agent.bridge, home: path.join(paths.bridgesDir, 'replacement') },
    });

    await expect(service.restore(entry.trashId)).rejects.toThrow('Agent ID 已被占用');
  });

  it('purgeExpired skips failed entries and purgeOne --force clears them (R20)', async () => {
    const { paths, registry, agent } = await setupTrashAgent();
    const { TrashService } = await import('../src/core/trash.js');
    const service = new TrashService(paths, registry);
    const entry = await service.move(agent, new Date('2026-08-01T00:00:00.000Z'));
    await forceTrashState(paths, entry.trashId, 'failed');

    // purgeExpired 不触碰 failed 条目（仅清理 ready+过期）
    expect((await service.purgeExpired(new Date('2026-08-09T00:00:00.000Z'))).purged).toEqual([]);
    expect(await service.list()).toHaveLength(1);

    // 无 --force 在 failed 上拒绝
    await expect(
      service.purgeOne(entry.trashId, {}, new Date('2026-08-09T00:00:00.000Z')),
    ).rejects.toThrow();
    expect(await service.list()).toHaveLength(1);

    // --force 清理成功
    expect((await service.purgeOne(entry.trashId, { force: true })).purged).toBe(true);
    expect(await service.list()).toEqual([]);
  });

  it('purgeOne without --force refuses a non-expired ready entry (R20)', async () => {
    const { paths, registry, agent } = await setupTrashAgent();
    const { TrashService } = await import('../src/core/trash.js');
    const service = new TrashService(paths, registry);
    const entry = await service.move(agent, new Date('2026-08-04T00:00:00.000Z'));

    await expect(
      service.purgeOne(entry.trashId, {}, new Date('2026-08-05T00:00:00.000Z')),
    ).rejects.toThrow();
    expect(await service.list()).toHaveLength(1);

    // --force 可无视未过期清理
    expect((await service.purgeOne(entry.trashId, { force: true })).purged).toBe(true);
    expect(await service.list()).toEqual([]);
  });

  it('purgeOne --dry-run reports wouldPurge without removing (R20)', async () => {
    const { paths, registry, agent } = await setupTrashAgent();
    const { TrashService } = await import('../src/core/trash.js');
    const service = new TrashService(paths, registry);
    const entry = await service.move(agent, new Date('2026-08-01T00:00:00.000Z'));
    await forceTrashState(paths, entry.trashId, 'failed');

    expect(await service.purgeOne(entry.trashId, { force: true, dryRun: true })).toEqual({
      purged: false,
      wouldPurge: true,
    });
    expect(await service.list()).toHaveLength(1);
  });
});
