import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-app-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  return {
    root,
    paths,
    app: new FactoryApplication(paths, new RegistryStore(paths.registryFile)),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('FactoryApplication', () => {
  it('initializes the factory and returns dashboard summaries', async () => {
    const { app } = setup();

    expect(await app.factoryStatus()).toEqual({ initialized: false });
    await app.initialize();
    await app.createAgent({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      preset: 'user-operations',
      feishu: 'dedicated',
    });

    expect(await app.factoryStatus()).toEqual({ initialized: true });
    expect(await app.dashboard()).toMatchObject({
      total: 1,
      running: 0,
      pendingAuthorization: 1,
      archived: 0,
    });
    expect((await app.listAgents())[0]).toMatchObject({
      id: 'user-operations',
      runtime: 'claude',
      bridgeAuthorization: 'pending',
    });
  });

  it('reads and atomically updates only declared identity documents', async () => {
    const { app, paths } = setup();
    await app.initialize();
    await app.createAgent({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      preset: 'user-operations',
      feishu: 'disabled',
    });

    const before = await app.readDocument('user-operations', 'goals');
    expect(before.content).toContain('目标');
    const saved = await app.saveDocument('user-operations', 'goals', '# 新目标\n');
    expect(saved).toMatchObject({ key: 'goals', content: '# 新目标\n', dirty: true });
    expect(
      await fs.readFile(path.join(paths.workspaceRoot, 'user-operations/agent/GOALS.md'), 'utf8'),
    ).toBe('# 新目标\n');

    await expect(app.readDocument('user-operations', 'agent.yaml' as 'goals')).rejects.toThrow(
      '文档类型',
    );
    await expect(
      app.saveDocument('user-operations', 'goals', 'x'.repeat(1024 * 1024 + 1)),
    ).rejects.toThrow('1 MiB');

    const outside = path.join(paths.workspaceRoot, 'outside-goals.md');
    const goals = path.join(paths.workspaceRoot, 'user-operations/agent/GOALS.md');
    await fs.outputFile(outside, '# outside\n');
    await fs.remove(goals);
    await fs.symlink(outside, goals);
    await expect(app.readDocument('user-operations', 'goals')).rejects.toThrow('身份文档');
  });
});
