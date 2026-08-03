import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateAgentService } from '../src/core/create-agent.js';
import { initializeFactory } from '../src/core/config.js';
import { DoctorService } from '../src/core/doctor.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

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
});
