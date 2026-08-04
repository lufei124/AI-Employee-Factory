import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { DoctorService } from '../src/core/doctor.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { TrashService } from '../src/core/trash.js';
import { FactoryApplication } from '../src/application/factory-application.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('DoctorService', () => {
  it('reports strict isolation passes and pending Bridge authorization as a warning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-'));
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

    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalClaudeHome = process.env.CLAUDE_CONFIG_DIR;
    const originalBridgeHome = process.env.LARK_CHANNEL_HOME;
    process.env.HOME = root;
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.LARK_CHANNEL_HOME;
    let report;
    try {
      report = await new DoctorService(paths, registry).run('user-operations');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeHome;
      if (originalBridgeHome === undefined) delete process.env.LARK_CHANNEL_HOME;
      else process.env.LARK_CHANNEL_HOME = originalBridgeHome;
    }

    expect(report.checks.find((check) => check.id === 'runtime-lock')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'default-home-isolation')?.status).toBe(
      'pass',
    );
    expect(report.checks.find((check) => check.id === 'workspace-git')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'bridge-profile')?.status).toBe('warn');
    expect(report.checks.find((check) => check.id === 'registry-permissions')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'config-permissions')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'secrets-check')?.status).toBe('pass');
    expect(report.checks.find((check) => check.id === 'recent-logs')?.status).toBe('pass');
    expect(report.summary.fail).toBe(0);
    expect(await fs.pathExists(path.join(root, '.claude'))).toBe(false);
    expect(await fs.pathExists(path.join(root, '.codex'))).toBe(false);
    expect(await fs.pathExists(path.join(root, '.lark-channel'))).toBe(false);
  });

  it('reports a failed/moving trash entry as fail with purge --force remediation (R20)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-trash-'));
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
    const entry = await new TrashService(paths, registry).move(agent);
    const manifestFile = path.join(paths.trashDir, 'manifests', `${entry.trashId}.yaml`);
    const doc = YAML.parse(await fs.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    doc.state = 'failed';
    await fs.writeFile(manifestFile, YAML.stringify(doc));

    const report = await new DoctorService(paths, registry).run();
    const check = report.checks.find((item) => item.id === 'trash-health');
    expect(check?.status).toBe('fail');
    expect(check?.remediation).toContain('agentctl trash purge --force');
  });

  it('warns disk-usage when backups exceed the threshold (OP4-D)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-disk-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await initializeFactory(paths);
    await fs.ensureDir(paths.backupsDir);
    const big = path.join(paths.backupsDir, 'big.tar.gz');
    await fs.writeFile(big, '');
    await fs.truncate(big, 600 * 1024 * 1024); // 稀疏 600MiB，stat 报告逻辑大小
    const registry = new RegistryStore(paths.registryFile);

    const report = await new DoctorService(paths, registry).run();
    const check = report.checks.find((item) => item.id === 'disk-usage');
    expect(check?.status).toBe('warn');
    expect(check?.remediation).toContain('agentctl prune --dry-run');
  });

  it('warns on config_hash drift and passes after repair (OP3-A)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-doctor-drift-'));
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
    if (!agent) throw new Error('missing agent');
    // 模拟漂移：手工改 agent.yaml 的 model，Registry 缓存（含 config_hash）未同步。
    const agentYaml = path.join(agent.workspace.path, 'agent.yaml');
    const doc = YAML.parse(await fs.readFile(agentYaml, 'utf8')) as { runtime: { model?: string } };
    doc.runtime.model = 'opus';
    await fs.writeFile(agentYaml, YAML.stringify(doc));

    const originalHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const report = await new DoctorService(paths, registry).run('user-operations');
      const drift = report.checks.find((c) => c.id === 'config-drift');
      expect(drift?.status).toBe('warn');
      expect(drift?.remediation).toContain('agentctl repair');
      // repair 后漂移消除
      await new FactoryApplication(paths, registry).repairAgent('user-operations');
      const report2 = await new DoctorService(paths, registry).run('user-operations');
      expect(report2.checks.find((c) => c.id === 'config-drift')?.status).toBe('pass');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
