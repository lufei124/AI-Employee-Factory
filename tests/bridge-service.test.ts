import { describe, expect, it } from 'vitest';
import { BridgeAdapter } from '../src/core/bridge.js';
import { renderLaunchdPlist } from '../src/services/launchd-service.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

const agent: RegistryAgent = {
  id: 'user-operations',
  name: '用户运营专员',
  status: 'stopped',
  archived: false,
  runtime: { provider: 'claude', locked: true, model: 'sonnet' },
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
    const context = new BridgeAdapter().run(agent);

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
});
