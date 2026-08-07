// TASK-048（D-044）：显式 runtime 迁移工作流测试。
// 覆盖：claude→codex / codex→claude 双向、config_hash 重算与无漂移、凭据不复制（D-015）、
// --dry-run 零写入、目标目录非空 CONFLICT、同 provider VALIDATION_ERROR、漂移拒绝、
// --discard 与默认保留、失败回滚、skills 投影切换、迁移后 doctor 全 pass、e2e 路径一致性。

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { computeConfigHash, loadPortableConfig } from '../src/core/agents.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import {
  applyRuntimeMigration,
  buildRuntimeMigrationPlan,
  CODEX_CONFIG_TOML,
  parseRuntimeProvider,
  targetRuntimeHome,
} from '../src/core/runtime-migrate.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-migrate-'));
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
    feishu: 'disabled',
  });
  return { root, paths, registry, application: new FactoryApplication(paths, registry) };
}

describe('runtime-migrate 核心契约', () => {
  it('parseRuntimeProvider 拒绝非法值（VALIDATION_ERROR）', () => {
    expect(parseRuntimeProvider('claude')).toBe('claude');
    expect(parseRuntimeProvider('codex')).toBe('codex');
    expect(() => parseRuntimeProvider('gemini')).toThrow(/仅支持 claude \/ codex/);
  });

  it('targetRuntimeHome 解析 runtimes/<id>/<provider> 且 assertInside 防逃逸', async () => {
    const { paths } = await setup();
    expect(targetRuntimeHome(paths.runtimesDir, 'worker-a', 'codex')).toBe(
      path.join(paths.runtimesDir, 'worker-a', 'codex'),
    );
    expect(() => targetRuntimeHome(paths.runtimesDir, '../evil', 'claude')).toThrow();
  });
});

describe('claude → codex 迁移', () => {
  it('迁移后：agent.yaml provider=codex、config_hash 重算、registry 指向新目录、凭据清除、config.toml 预写、旧目录保留、无漂移', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const workspace = agent.workspace.path;

    const result = await application.runtimeMigrate(agent.id, 'codex');

    // agent.yaml 真值：provider 已切，locked/model 保留。
    const yaml = YAML.parse(await fs.readFile(path.join(workspace, 'agent.yaml'), 'utf8')) as {
      runtime: { provider: string; locked: true; model?: string };
    };
    expect(yaml.runtime.provider).toBe('codex');
    expect(yaml.runtime.locked).toBe(true);

    // registry 指向新 runtime_home + credential_provider 显式清除 + config_hash 重算。
    const updated = (await registry.read()).agents[0];
    if (!updated) throw new Error('missing updated agent');
    expect(updated.runtime_home.path).toBe(path.join(paths.runtimesDir, agent.id, 'codex'));
    expect(updated.credential_provider).toBeUndefined();
    expect(updated.config_hash).toBe(computeConfigHash(yaml.runtime));
    expect(result.toRuntimeHome).toBe(updated.runtime_home.path);

    // codex config.toml 预写（复用 create-agent 模式）。
    expect(await fs.readFile(path.join(updated.runtime_home.path, 'config.toml'), 'utf8')).toBe(
      CODEX_CONFIG_TOML,
    );

    // 旧 claude 目录默认保留（回滚逃生口）。
    expect(await fs.pathExists(path.join(paths.runtimesDir, agent.id, 'claude'))).toBe(true);
    expect(result.oldDiscarded).toBe(false);

    // loadPortableConfig 无漂移。
    await expect(loadPortableConfig(updated)).resolves.toMatchObject({
      runtime: { provider: 'codex' },
    });
  });
});

describe('codex → claude 迁移', () => {
  it('凭据不跨 provider 复制（D-015）：claude 目录空、credential_provider 保持未设置', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-migrate-codex-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    const registry = new RegistryStore(paths.registryFile);
    await new CreateAgentService(paths, registry).create({
      id: 'codex-worker',
      name: 'Codex 员工',
      runtime: 'codex',
      description: '负责自动化运维',
      goals: ['处理日常运维任务'],
      feishu: 'disabled',
    });
    const application = new FactoryApplication(paths, registry);
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');

    const result = await application.runtimeMigrate(agent.id, 'claude');

    const updated = (await registry.read()).agents[0];
    if (!updated) throw new Error('missing updated agent');
    expect(updated.runtime_home.path).toBe(path.join(paths.runtimesDir, agent.id, 'claude'));
    // 目标 claude：credential_provider 不写入（保持未设置）。
    expect(updated.credential_provider).toBeUndefined();
    // 凭据不复制：claude 目录只有空壳（无 settings.json/.cc-switch.env）。
    const children = await fs.readdir(updated.runtime_home.path);
    expect(children).toEqual([]);
    // 旧 codex 目录保留。
    expect(await fs.pathExists(path.join(paths.runtimesDir, agent.id, 'codex'))).toBe(true);
    expect(result.oldDiscarded).toBe(false);
  });
});

describe('迁移防护', () => {
  it('--dry-run 零写入', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const plan = await application.runtimeMigratePlan(agent.id, 'codex');
    expect(plan.from).toBe('claude');
    expect(plan.to).toBe('codex');
    expect(plan.services).toEqual(['settle', 'job']);
    expect(plan.projectedSkills).toBe(true);
    // 零写入：目标目录未创建、agent.yaml 未动、registry 未动。
    expect(await fs.pathExists(plan.toRuntimeHome)).toBe(false);
    const yaml = YAML.parse(
      await fs.readFile(path.join(agent.workspace.path, 'agent.yaml'), 'utf8'),
    ) as { runtime: { provider: string } };
    expect(yaml.runtime.provider).toBe('claude');
  });

  it('目标目录已存在非空 → CONFLICT', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const target = path.join(paths.runtimesDir, agent.id, 'codex');
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, 'stray.txt'), 'x');
    await expect(application.runtimeMigrate(agent.id, 'codex')).rejects.toThrow(
      /CONFLICT|已存在且非空/,
    );
  });

  it('--to 与当前 provider 相同 → VALIDATION_ERROR', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    await expect(application.runtimeMigrate(agent.id, 'claude')).rejects.toThrow(
      /无需迁移|VALIDATION_ERROR/,
    );
  });

  it('config_hash 漂移拒绝：先改 agent.yaml model → 迁移抛 CONFLICT（零写入）', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as { runtime: { model?: string } };
    doc.runtime.model = 'opus';
    await fs.writeFile(agentYaml, YAML.stringify(doc));
    await expect(application.runtimeMigrate(agent.id, 'codex')).rejects.toThrow(/config_hash 漂移/);
    // 未产生半迁移态：目标目录未创建。
    expect(await fs.pathExists(path.join(paths.runtimesDir, agent.id, 'codex'))).toBe(false);
  });
});

describe('--discard 与失败回滚', () => {
  it('--discard 在 commit 成功后删除旧目录；默认保留', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const oldHome = path.join(paths.runtimesDir, agent.id, 'claude');
    expect(await fs.pathExists(oldHome)).toBe(true);

    const result = await application.runtimeMigrate(agent.id, 'codex', { discardOld: true });
    expect(result.oldDiscarded).toBe(true);
    expect(await fs.pathExists(oldHome)).toBe(false);
  });

  it('updateAgent 失败 → 回滚：agent.yaml 恢复、config_hash 恢复、toRuntimeHome 清理', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const oldHash = agent.config_hash;
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const oldYaml = await fs.readFile(agentYaml, 'utf8');
    const spy = vi.spyOn(registry, 'updateAgent').mockRejectedValue(new Error('disk full'));

    await expect(application.runtimeMigrate(agent.id, 'codex')).rejects.toThrow(/disk full/);
    spy.mockRestore();

    // agent.yaml 原文恢复（含原 provider 与 model）。
    expect(await fs.readFile(agentYaml, 'utf8')).toBe(oldYaml);
    // registry config_hash 恢复旧值。
    const after = (await registry.read()).agents[0];
    if (!after) throw new Error('missing after agent');
    expect(after.config_hash).toBe(oldHash);
    expect(after.runtime_home.path).toBe(path.join(paths.runtimesDir, agent.id, 'claude'));
    // 目标目录已清理。
    expect(await fs.pathExists(path.join(paths.runtimesDir, agent.id, 'codex'))).toBe(false);
  });
});

describe('skills 投影切换与迁移后验证', () => {
  it('claude→codex：.codex/skills 软链存在、.claude/skills 移除、软链指向相对目标', async () => {
    const { registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const workspace = agent.workspace.path;
    // seed 一个项目级 skill（模拟员工自进化沉淀）。
    await fs.ensureDir(path.join(workspace, 'skills', 'ops-runbook'));
    await fs.writeFile(path.join(workspace, 'skills', 'ops-runbook', 'SKILL.md'), '# ops-runbook');

    await application.runtimeMigrate(agent.id, 'codex');

    const oldProjection = path.join(workspace, '.claude', 'skills');
    const newProjection = path.join(workspace, '.codex', 'skills');
    expect(await fs.pathExists(oldProjection)).toBe(false);
    // 新投影软链存在且指向相对目标（含宿主平台 skill）。
    for (const name of ['ops-runbook', 'ai-employee-factory']) {
      const link = path.join(newProjection, name);
      expect(await fs.pathExists(link)).toBe(true);
      expect(await fs.readlink(link)).toBe(path.join('../../skills', name));
    }
  });

  it('迁移后 doctor config-drift/runtime-home/runtime-lock 全 pass', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');

    await application.runtimeMigrate(agent.id, 'codex');

    const { DoctorService } = await import('../src/core/doctor.js');
    const report = await new DoctorService(paths, registry).run(agent.id);
    for (const checkId of ['config-drift', 'runtime-home', 'runtime-lock'] as const) {
      const check = report.checks.find((c) => c.id === checkId);
      expect(check?.status, `doctor 检查 ${checkId}：${check?.detail}`).toBe('pass');
    }
  });

  it('e2e：registry.runtime_home.path 与 runtimes/<id>/<provider> 目录一致', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');

    await application.runtimeMigrate(agent.id, 'codex');

    const updated = (await registry.read()).agents[0];
    if (!updated) throw new Error('missing updated agent');
    expect(updated.runtime_home.path).toBe(path.join(paths.runtimesDir, agent.id, 'codex'));
    expect(await fs.pathExists(updated.runtime_home.path)).toBe(true);
  });
});

describe('纯事务模块（不启停服务）', () => {
  it('applyRuntimeMigration 直接可用：updateAgent/refreshConfigHash 注入', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');

    const result = await applyRuntimeMigration({
      registry: agent,
      agent: await application.getAgent(agent.id).then((x) => x.agent),
      workspace: agent.workspace.path,
      runtimesDir: paths.runtimesDir,
      to: 'codex',
      updateAgent: (id, update) => registry.updateAgent(id, update),
      refreshConfigHash: (id, hash) => registry.refreshConfigHash(id, hash),
    });
    expect(result.to).toBe('codex');
    expect(result.projectedSkills).toBe(true);
  });

  it('buildRuntimeMigrationPlan 在非空目标目录抛 CONFLICT（plan 层防护）', async () => {
    const { paths, registry, application } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    const target = path.join(paths.runtimesDir, agent.id, 'codex');
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, 'stray.txt'), 'x');
    const { agent: config } = await application.getAgent(agent.id);
    await expect(
      buildRuntimeMigrationPlan({
        registry: agent,
        agent: config,
        runtimesDir: paths.runtimesDir,
        to: 'codex',
      }),
    ).rejects.toThrow(/已存在且非空/);
  });
});
