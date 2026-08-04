import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/core/backup.js';
import { computeConfigHash, loadPortableConfig } from '../src/core/agents.js';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-backup-'));
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
  return { root, paths, registry, service: new BackupService(paths, registry) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('BackupService', () => {
  it('writes a portable archive with manifest and checksums but no runtime or secrets', async () => {
    const { root, registry, service } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    await fs.outputFile(path.join(agent.workspace.path, '.env'), 'TOKEN=do-not-back-up');

    const backup = await service.backup('user-operations');
    const extract = path.join(root, 'extract');
    await fs.ensureDir(extract);
    await tar.x({ file: backup, cwd: extract });

    expect(await fs.pathExists(path.join(extract, 'manifest.yaml'))).toBe(true);
    expect(await fs.pathExists(path.join(extract, 'checksums.txt'))).toBe(true);
    expect(await fs.pathExists(path.join(extract, 'workspace/agent.yaml'))).toBe(true);
    expect(await fs.pathExists(path.join(extract, 'workspace/.git'))).toBe(true);
    expect(await fs.pathExists(path.join(extract, 'workspace/.env'))).toBe(false);
    expect(await fs.pathExists(path.join(extract, 'runtime'))).toBe(false);
  });

  it('requires encryption when native runtime is included', async () => {
    const { service } = await setup();
    await expect(service.backup('user-operations', { includeRuntime: true })).rejects.toThrow(
      '密码',
    );
    const backup = await service.backup('user-operations', {
      includeRuntime: true,
      passphrase: 'correct horse battery staple',
    });
    expect(backup.endsWith('.aief.enc')).toBe(true);
    expect((await fs.readFile(backup, 'utf8')).startsWith('AIEF1\n')).toBe(true);
  });

  it('honors an injected BackupFilter (OP2-F data-only extension isolation)', async () => {
    const { root, paths, registry } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    // 自定义 filter：始终放行（data-only 纯函数），证明 filter 可注入覆盖默认排除规则。
    const custom = new BackupService(paths, registry, { shouldCopy: () => true });
    await fs.outputFile(path.join(agent.workspace.path, '.env'), 'TOKEN=should-not-be-backed');

    const backup = await custom.backup('user-operations');
    const extract = path.join(root, 'extract-custom');
    await fs.ensureDir(extract);
    await tar.x({ file: backup, cwd: extract });
    expect(await fs.pathExists(path.join(extract, 'workspace/.env'))).toBe(true);
  });

  it('restores portable data under a new id with fresh private homes', async () => {
    const { paths, registry, service } = await setup();
    const backup = await service.backup('user-operations');

    const restored = await service.restore(backup, { newId: 'user-operations-copy' });

    expect(restored.id).toBe('user-operations-copy');
    expect(await fs.pathExists(path.join(paths.workspaceRoot, restored.id, 'agent.yaml'))).toBe(
      true,
    );
    expect(await fs.pathExists(path.join(paths.runtimesDir, restored.id, 'claude'))).toBe(true);
    expect(await fs.readdir(path.join(paths.runtimesDir, restored.id, 'claude'))).toEqual([]);
    expect((await registry.read()).agents.map((agent) => agent.id)).toEqual([
      'user-operations',
      'user-operations-copy',
    ]);
  });

  it('stores config_hash on restore matching the restored agent.yaml (OP3-A)', async () => {
    const { registry, service } = await setup();
    const backup = await service.backup('user-operations');
    await service.restore(backup, { newId: 'restored-agent', newName: '恢复专员' });
    const restored = (await registry.read()).agents.find((a) => a.id === 'restored-agent');
    if (!restored) throw new Error('missing restored agent');
    const config = await loadPortableConfig(restored);
    expect(restored.config_hash).toBe(computeConfigHash(config.runtime));
  });

  it('excludes known secret files (R7) but keeps ssh public keys', async () => {
    const { registry, service, root } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    await fs.outputFile(path.join(agent.workspace.path, 'settings.json'), '{"theme":"dark"}');
    await fs.outputFile(path.join(agent.workspace.path, 'id_rsa'), 'PRIVATE-KEY');
    await fs.outputFile(path.join(agent.workspace.path, 'id_ed25519'), 'PRIVATE-KEY');
    await fs.outputFile(path.join(agent.workspace.path, 'id_rsa.pub'), 'ssh-rsa AAAA PUBLIC');

    const backup = await service.backup('user-operations');
    const extract = path.join(root, 'extract');
    await fs.ensureDir(extract);
    await tar.x({ file: backup, cwd: extract });

    expect(await fs.pathExists(path.join(extract, 'workspace/settings.json'))).toBe(false);
    expect(await fs.pathExists(path.join(extract, 'workspace/id_rsa'))).toBe(false);
    expect(await fs.pathExists(path.join(extract, 'workspace/id_ed25519'))).toBe(false);
    expect(await fs.pathExists(path.join(extract, 'workspace/id_rsa.pub'))).toBe(true);
  });

  it('rejects backup when an untracked staged file contains a secret (R27)', async () => {
    const { registry, service } = await setup();
    const agent = (await registry.read()).agents[0];
    if (!agent) throw new Error('missing agent');
    await fs.outputFile(
      path.join(agent.workspace.path, 'scripts', 'run.sh'),
      'export TOKEN=sk-abcdefghijklmnopqrstuvwxyz0123456789XYZ\n',
    );

    await expect(service.backup('user-operations')).rejects.toThrow(/Secret/);
  });

  it('rejects restore when the archive contains undeclared files (R21)', async () => {
    const { service, root } = await setup();
    const backup = await service.backup('user-operations');
    const tamper = path.join(root, 'tamper');
    await fs.ensureDir(tamper);
    await tar.x({ file: backup, cwd: tamper });
    await fs.outputFile(path.join(tamper, 'workspace', 'sneaky.txt'), 'extra');
    await fs.remove(backup);
    await tar.c(
      { gzip: true, cwd: tamper, file: backup, portable: true },
      await fs.readdir(tamper),
    );

    await expect(service.restore(backup)).rejects.toThrow(/未声明文件/);
  });

  it('writes factory_version into the backup manifest (OP3-B)', async () => {
    const { service, root } = await setup();
    const backup = await service.backup('user-operations');
    const extract = path.join(root, 'extract');
    await fs.ensureDir(extract);
    await tar.x({ file: backup, cwd: extract });
    const manifest = YAML.parse(await fs.readFile(path.join(extract, 'manifest.yaml'), 'utf8'));
    expect(manifest.factory_version).toBe('0.1.0');
  });

  it('restores an old backup manifest that lacks factory_version (OP3-B forward-compat)', async () => {
    const { service, root } = await setup();
    const backup = await service.backup('user-operations');
    const tamper = path.join(root, 'tamper');
    await fs.ensureDir(tamper);
    await tar.x({ file: backup, cwd: tamper });
    const manifestFile = path.join(tamper, 'manifest.yaml');
    const manifest = YAML.parse(await fs.readFile(manifestFile, 'utf8'));
    delete manifest.factory_version;
    await fs.writeFile(manifestFile, YAML.stringify(manifest));
    await fs.remove(backup);
    await tar.c(
      { gzip: true, cwd: tamper, file: backup, portable: true },
      await fs.readdir(tamper),
    );

    const restored = await service.restore(backup, { newId: 'user-operations-old' });
    expect(restored.id).toBe('user-operations-old');
  });
});
