import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeAdapter } from '../src/core/bridge.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { renderLaunchdPlist } from '../src/services/launchd-service.js';
import { bridgeLaunchdService } from '../src/services/factory-services.js';
import type { AgentConfig } from '../src/schemas/agent-schema.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

const runtime: AgentConfig['runtime'] = { provider: 'claude', locked: true, model: 'sonnet' };

const agent: RegistryAgent = {
  id: 'user-operations',
  name: '用户运营专员',
  status: 'stopped',
  archived: false,
  workspace: { path: '/tmp/agents/user-operations', git_repository: true },
  runtime_home: { path: '/tmp/private/runtimes/user-operations/claude' },
  bridge: {
    enabled: true,
    profile: 'user-operations',
    home: '/tmp/private/bridges/user-operations',
    mode: 'dedicated_bot',
    authorization: 'ready',
  },
  permissions: { level: 'workspace', production_write: 'approval_required' },
  created_at: '2026-08-03T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
};

describe('BridgeAdapter', () => {
  it('builds an isolated bridge run context', () => {
    const context = new BridgeAdapter().run(agent, runtime);

    expect(context.command).toBe('lark-channel-bridge');
    expect(context.args).toEqual([
      'run',
      '--profile',
      'user-operations',
      '--agent',
      'claude',
      '--workspace',
      '/tmp/agents/user-operations',
    ]);
    expect(context.env.CLAUDE_CONFIG_DIR).toBe('/tmp/private/runtimes/user-operations/claude');
    expect(context.env.LARK_CHANNEL_HOME).toBe('/tmp/private/bridges/user-operations');
  });

  it('tightens the official profile to workspace access without touching credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-bridge-profile-'));
    const scopedAgent = {
      ...agent,
      bridge: { ...agent.bridge, home: root },
    };
    const configFile = path.join(root, 'config.json');
    await fs.outputJson(configFile, {
      schemaVersion: 2,
      activeProfile: 'user-operations',
      profiles: {
        'user-operations': {
          schemaVersion: 2,
          agentKind: 'claude',
          accounts: { app: { id: 'cli_test', secret: 'keep-me', tenant: 'feishu' } },
          permissions: { defaultAccess: 'full', maxAccess: 'full' },
          sandbox: { default: 'danger-full-access', max: 'danger-full-access' },
        },
      },
    });

    await new BridgeAdapter().secureProfile(scopedAgent, runtime);

    const saved = await fs.readJson(configFile);
    expect(saved.profiles['user-operations'].permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles['user-operations'].sandbox).toBeUndefined();
    expect(saved.profiles['user-operations'].accounts.app.secret).toBe('keep-me');
    expect(saved.migrations.permissionDefaultsV1).toContain('user-operations');
    await fs.remove(root);
  });

  it('probes run and authorization flags instead of trusting one help page', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-bridge-probe-'));
    const executable = path.join(root, 'lark-channel-bridge');
    await fs.outputFile(
      executable,
      `#!/bin/sh\ncase "$*" in\n  "--version") echo "0.5.9" ;;\n  "run --help") echo "--profile --agent --workspace" ;;\n  "profile create --help") echo "--agent --workspace --app-id" ;;\n  "profile export --help") echo "--output" ;;\nesac\n`,
      { mode: 0o755 },
    );

    const capabilities = await new BridgeAdapter().inspectCapabilities({
      PATH: `${root}:${process.env.PATH ?? ''}`,
    });

    expect(capabilities.compatible).toBe(false);
    expect(capabilities.missing).toContain('profile create:--tenant');
    expect(capabilities.version).toBe('0.5.9');
    await fs.remove(root);
  });
});

describe('launchd plist', () => {
  it('contains isolated environment and never embeds secrets', () => {
    const plist = renderLaunchdPlist({
      label: 'com.aiemployees.user-operations',
      program: '/usr/local/bin/agentctl',
      args: ['_service', 'bridge', 'user-operations'],
      env: {
        CLAUDE_CONFIG_DIR: agent.runtime_home.path,
        LARK_CHANNEL_HOME: agent.bridge.home,
      },
      stdoutPath: '/tmp/private/logs/user-operations/bridge.stdout.log',
      stderrPath: '/tmp/private/logs/user-operations/bridge.stderr.log',
    });

    expect(plist).toContain('com.aiemployees.user-operations');
    expect(plist).toContain('CLAUDE_CONFIG_DIR');
    expect(plist).toContain('/tmp/private/bridges/user-operations');
    expect(plist).not.toMatch(/secret|token/i);
  });

  // D-032：RunAtLoad 由 input 控制——员工桥接常驻用 true，定时任务等保持 false。
  it('emits RunAtLoad according to the input flag', () => {
    const base = {
      label: 'com.aiemployees.user-operations',
      program: '/usr/local/bin/agentctl',
      args: ['_service', 'bridge', 'user-operations'],
      env: { CLAUDE_CONFIG_DIR: agent.runtime_home.path },
      stdoutPath: '/tmp/private/logs/user-operations/bridge.stdout.log',
      stderrPath: '/tmp/private/logs/user-operations/bridge.stderr.log',
    };
    expect(renderLaunchdPlist({ ...base, runAtLoad: true })).toContain(
      '<key>RunAtLoad</key><true/>',
    );
    expect(renderLaunchdPlist({ ...base, runAtLoad: false })).toContain(
      '<key>RunAtLoad</key><false/>',
    );
    // 缺省（定时任务等）为 false，向后兼容。
    expect(renderLaunchdPlist(base)).toContain('<key>RunAtLoad</key><false/>');
  });

  // D-052：KeepAlive 由 input 控制——bridge 常驻自愈用 true；周期服务（settle/job）不设，避免崩溃立即重启。
  it('emits KeepAlive only for an explicit true flag', () => {
    const base = {
      label: 'com.aiemployees.user-operations',
      program: '/usr/local/bin/agentctl',
      args: ['_service', 'bridge', 'user-operations'],
      env: { CLAUDE_CONFIG_DIR: agent.runtime_home.path },
      stdoutPath: '/tmp/private/logs/user-operations/bridge.stdout.log',
      stderrPath: '/tmp/private/logs/user-operations/bridge.stderr.log',
    };
    expect(renderLaunchdPlist({ ...base, keepAlive: true })).toContain(
      '<key>KeepAlive</key><true/>',
    );
    expect(renderLaunchdPlist({ ...base, keepAlive: false })).not.toContain('KeepAlive');
    // 缺省（定时/周期任务等）不渲染 KeepAlive，向后兼容。
    expect(renderLaunchdPlist(base)).not.toContain('KeepAlive');
  });

  it('bridge factory installs a RunAtLoad<true/> + KeepAlive<true/> plist (常驻自愈)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-bridge-runatload-'));
    try {
      const paths = resolveFactoryPaths({
        HOME: home,
        AI_EMPLOYEES_HOME: path.join(home, 'private'),
        AI_EMPLOYEES_WORKSPACE_ROOT: path.join(home, 'agents'),
      });
      const service = bridgeLaunchdService(agent, runtime, paths);
      await service.install();
      const canonical = await fs.readFile(
        path.join(paths.servicesDir, agent.id, 'bridge.plist'),
        'utf8',
      );
      expect(canonical).toContain('<key>RunAtLoad</key><true/>');
      // D-052：bridge 进程意外退出/被杀后 launchd 自动重启。
      expect(canonical).toContain('<key>KeepAlive</key><true/>');
      expect(await service.isAutoStart()).toBe(true);
    } finally {
      await fs.remove(home);
    }
  });
});
