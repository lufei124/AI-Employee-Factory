import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

// 隔离 launchd / CC Switch / git 副作用：bridgeLaunchdService 换成可控 spy adapter，execa 假成功。
const start = vi.hoisted(() => vi.fn(async () => undefined));
const stop = vi.hoisted(() => vi.fn(async () => undefined));
const setRunAtLoad = vi.hoisted(() => vi.fn(async () => undefined));
const isAutoStart = vi.hoisted(() => vi.fn(async () => false));
const status = vi.hoisted(() => vi.fn(async () => ({ state: 'not-installed', detail: '' })));

vi.mock('../src/services/factory-services.js', () => ({
  bridgeLaunchdService: () => ({
    start,
    stop,
    setRunAtLoad,
    isAutoStart,
    status,
    install: async () => undefined,
    restart: async () => undefined,
    uninstall: async () => undefined,
  }),
  jobLaunchdService: () => ({
    enableScheduled: async () => undefined,
    uninstall: async () => undefined,
  }),
  // D-035：周期 settle 服务由 lifecycleAction start/stop 安装/卸载（best-effort）。
  settleLaunchdService: () => ({
    start: async () => undefined,
    stop: async () => undefined,
    uninstall: async () => undefined,
  }),
}));
vi.mock('execa', () => ({
  execa: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

async function setup() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-reconcile-'));
  roots.push(home);
  const paths = resolveFactoryPaths({
    HOME: home,
    AI_EMPLOYEES_HOME: path.join(home, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(home, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  // prepareRuntime/secureBridgeProfile 是私有方法，spy 为空以隔离 CC Switch / bridge 配置副作用。
  vi.spyOn(
    app as unknown as { prepareRuntime: () => Promise<unknown> },
    'prepareRuntime',
  ).mockResolvedValue(undefined);
  vi.spyOn(
    app as unknown as { secureBridgeProfile: () => Promise<unknown> },
    'secureBridgeProfile',
  ).mockResolvedValue(undefined);
  return { app };
}

async function createBridgeAgent(app: FactoryApplication, id: string) {
  await app.createAgent({
    id,
    name: id,
    runtime: 'claude',
    feishu: 'dedicated',
    description: `员工 ${id}`,
    goals: [`目标 ${id}`],
  });
  // 桥接授权置为 ready，否则 start 路径被守卫跳过。
  await app.registry.updateAgent(id, (current) => ({
    ...current,
    bridge: { ...current.bridge, authorization: 'ready' },
  }));
}

describe('reconcileServices（D-032：Web 启动拉起常驻员工）', () => {
  it('拉起床板服务意图常驻但未在跑的员工，并回写 running', async () => {
    isAutoStart.mockResolvedValue(true);
    status.mockResolvedValue({ state: 'not-installed', detail: '' });
    const { app } = await setup();
    await createBridgeAgent(app, 'a1');

    const result = await app.reconcileServices();

    expect(start).toHaveBeenCalledWith();
    expect(result.activated).toContain('a1');
    const saved = await app.registry.read();
    expect(saved.agents.find((agent) => agent.id === 'a1')?.status).toBe('running');
  });

  it('关停意图已停止但仍在跑的服务，并回写 stopped、改写 RunAtLoad false', async () => {
    isAutoStart.mockResolvedValue(false);
    status.mockResolvedValue({ state: 'running', detail: '' });
    const { app } = await setup();
    await createBridgeAgent(app, 'a2');
    await app.registry.updateAgent('a2', (current) => ({ ...current, status: 'running' }));

    await app.reconcileServices();

    expect(stop).toHaveBeenCalledWith();
    expect(setRunAtLoad).toHaveBeenCalledWith(false);
    const saved = await app.registry.read();
    expect(saved.agents.find((agent) => agent.id === 'a2')?.status).toBe('stopped');
  });

  it('未启用 Bridge 的员工被跳过，不触发 start/stop', async () => {
    const { app } = await setup();
    await app.createAgent({
      id: 'a3',
      name: 'a3',
      runtime: 'claude',
      feishu: 'disabled',
      description: '员工 a3',
      goals: ['目标 a3'],
    });

    await app.reconcileServices();

    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('未授权(start 需 ready)的员工即使意图常驻也不拉起', async () => {
    isAutoStart.mockResolvedValue(true);
    status.mockResolvedValue({ state: 'not-installed', detail: '' });
    const { app } = await setup();
    // 不调用 createBridgeAgent（保持 authorization: pending）。
    await app.createAgent({
      id: 'a4',
      name: 'a4',
      runtime: 'claude',
      feishu: 'dedicated',
      description: '员工 a4',
      goals: ['目标 a4'],
    });

    await app.reconcileServices();

    expect(start).not.toHaveBeenCalled();
  });
});

describe('lifecycleAction 停止＝暂停（D-032）', () => {
  it('stop 调用 setRunAtLoad(false)，使停机跨重启保持', async () => {
    isAutoStart.mockResolvedValue(true);
    status.mockResolvedValue({ state: 'running', detail: '' });
    const { app } = await setup();
    await createBridgeAgent(app, 'a5');
    await app.registry.updateAgent('a5', (current) => ({ ...current, status: 'running' }));

    await app.lifecycleAction('a5', 'stop');

    expect(stop).toHaveBeenCalledWith();
    expect(setRunAtLoad).toHaveBeenCalledWith(false);
    const saved = await app.registry.read();
    expect(saved.agents.find((agent) => agent.id === 'a5')?.status).toBe('stopped');
  });
});
