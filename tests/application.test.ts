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
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
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

  it('reads provider via agent.yaml (N+1) and falls back to unknown when missing (OP3-A)', async () => {
    const { app, paths } = setup();
    await app.initialize();
    await app.createAgent({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
    });
    // 正常：agent.yaml 存在，provider 来自单一真相源
    expect((await app.listAgents())[0]?.runtime).toBe('claude');
    // 删除 agent.yaml：list 容错降级为 unknown，不抛错
    await fs.remove(path.join(paths.workspaceRoot, 'user-operations', 'agent.yaml'));
    expect((await app.listAgents())[0]?.runtime).toBe('unknown');
  });

  it('surfaces role (worker default / chief) in list summaries (T08)', async () => {
    const { app } = setup();
    await app.initialize();
    await app.createAgent({
      id: 'chief',
      name: '主管',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
      role: 'chief',
    });
    await app.createAgent({
      id: 'worker',
      name: '执行者',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
    });
    const summaries = await app.listAgents();
    expect(summaries.find((agent) => agent.id === 'chief')?.role).toBe('chief');
    expect(summaries.find((agent) => agent.id === 'worker')?.role).toBe('worker');
  });

  it('installAllSkillFromStore installs all skills and skips already-installed ones', async () => {
    const { app, paths } = setup();
    await app.initialize();
    await app.createAgent({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
      feishu: 'disabled',
    });
    await app.addSkillStoreRepository({
      name: 'batch',
      url: 'https://github.com/owner/repo',
    });
    // 手工铺设缓存仓库（.git 标记 + 两个技能），模拟已刷新的本地缓存，避免依赖网络。
    const cacheRoot = path.join(paths.skillStoreDir, 'cache', 'batch');
    await fs.ensureDir(path.join(cacheRoot, '.git'));
    for (const name of ['alpha', 'beta']) {
      await fs.outputFile(
        path.join(cacheRoot, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
      );
    }

    const first = await app.installAllSkillFromStore('batch', 'user-operations', 'project');
    expect(first.total).toBe(2);
    expect(first.installed.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
    expect(first.skipped).toEqual([]);
    expect(first.failed).toEqual([]);

    // 二次安装：两个都已存在，应全部跳过而非报错。
    const second = await app.installAllSkillFromStore('batch', 'user-operations', 'project');
    expect(second.installed).toEqual([]);
    expect(second.skipped.sort()).toEqual(['alpha', 'beta']);
    expect(second.failed).toEqual([]);
  });

  it('reads and atomically updates only declared identity documents', async () => {
    const { app, paths } = setup();
    await app.initialize();
    await app.createAgent({
      id: 'user-operations',
      name: '用户运营专员',
      runtime: 'claude',
      description: '负责用户反馈收集、分析与闭环跟进',
      goals: ['收集并分析用户反馈', '闭环跟进问题'],
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
