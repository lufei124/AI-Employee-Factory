import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntimeEnvironment } from '../src/core/runtime.js';
import { ClaudeRuntimeAdapter } from '../src/runtimes/claude-adapter.js';
import { CodexRuntimeAdapter } from '../src/runtimes/codex-adapter.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

function agent(provider: 'claude' | 'codex'): RegistryAgent {
  return {
    id: 'employee',
    name: '员工',
    status: 'stopped',
    archived: false,
    runtime: { provider, locked: true },
    workspace: { path: '/tmp/agents/employee', git_repository: true },
    runtime_home: { path: `/tmp/private/runtimes/employee/${provider}` },
    bridge: {
      enabled: false,
      home: '/tmp/private/bridges/employee',
      mode: 'disabled',
      authorization: 'pending',
    },
    permissions: { level: 'workspace', production_write: 'approval_required' },
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  };
}

describe('runtime environment isolation', () => {
  it('removes inherited personal configuration and credential variables', () => {
    const env = buildRuntimeEnvironment(agent('claude'), {
      HOME: '/Users/person',
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/Users/person/.claude',
      CODEX_HOME: '/Users/person/.codex',
      LARK_CHANNEL_HOME: '/Users/person/.lark-channel',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });

    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/private/runtimes/employee/claude');
    expect(env).not.toHaveProperty('CODEX_HOME');
    expect(env).not.toHaveProperty('LARK_CHANNEL_HOME');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env.HOME).toBe('/Users/person');
  });

  it('syncs only the active CC Switch provider into the isolated Claude home', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      await fs.outputJson(path.join(root, '.claude/settings.json'), {
        env: {
          ANTHROPIC_BASE_URL: 'https://relay.example.test',
          ANTHROPIC_AUTH_TOKEN: 'provider-secret',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-sonnet',
          OPENAI_API_KEY: 'must-not-copy',
          CLAUDE_CONFIG_DIR: '/must/not/copy',
        },
        theme: 'dark',
      });
      await fs.outputJson(path.join(claudeAgent.runtime_home.path, 'settings.json'), {
        permissions: { defaultMode: 'default' },
        env: { EMPLOYEE_LOCAL_SETTING: 'keep-me', ANTHROPIC_AUTH_TOKEN: 'old-secret' },
      });

      const summary = (await sync(claudeAgent, root, path.join(root, 'runtimes'))) as {
        keys: string[];
        routedFieldsChanged: string[];
      };
      const isolated = await fs.readJson(path.join(claudeAgent.runtime_home.path, 'settings.json'));

      expect(isolated).toMatchObject({
        permissions: { defaultMode: 'default' },
        env: {
          EMPLOYEE_LOCAL_SETTING: 'keep-me',
          ANTHROPIC_BASE_URL: 'https://relay.example.test',
          ANTHROPIC_AUTH_TOKEN: 'provider-secret',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'relay-sonnet',
        },
      });
      expect(isolated.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(isolated.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(summary.keys).toEqual([
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
      ]);
      // R24：BASE_URL 由无变有 -> 流量路由字段变更被标记；摘要只含字段名，不含值。
      expect(summary.routedFieldsChanged).toEqual(['ANTHROPIC_BASE_URL']);
      expect(JSON.stringify(summary)).not.toContain('provider-secret');
      expect(JSON.stringify(summary)).not.toContain('relay.example.test');
      expect(
        (await fs.stat(path.join(claudeAgent.runtime_home.path, 'settings.json'))).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await fs.remove(root);
    }
  });

  it('rejects a CC Switch source that points into an employee Runtime Home', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      home: string,
      runtimesDir: string,
    ) => Promise<unknown>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-r4-'));
    try {
      const runtimesDir = path.join(root, 'runtimes');
      const rogueSource = path.join(runtimesDir, 'employee', 'claude');
      await fs.outputJson(path.join(rogueSource, 'settings.json'), {
        env: { ANTHROPIC_AUTH_TOKEN: 'stolen-secret' },
      });
      await fs.outputJson(path.join(root, '.cc-switch/settings.json'), {
        claude_config_dir: rogueSource,
      });
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(runtimesDir, 'victim', 'claude') },
      };

      await expect(sync(claudeAgent, root, runtimesDir)).rejects.toThrow('员工 Runtime Home');
    } finally {
      await fs.remove(root);
    }
  });

  it('records no routed-field change when traffic-routing fields are absent', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      home: string,
      runtimesDir: string,
    ) => Promise<{ routedFieldsChanged: string[] }>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-r24-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      await fs.outputJson(path.join(root, '.claude/settings.json'), {
        env: { ANTHROPIC_AUTH_TOKEN: 'tok' },
      });
      await fs.outputJson(path.join(claudeAgent.runtime_home.path, 'settings.json'), {
        env: {},
      });

      const summary = await sync(claudeAgent, root, path.join(root, 'runtimes'));
      expect(summary.routedFieldsChanged).toEqual([]);
    } finally {
      await fs.remove(root);
    }
  });
});

describe('runtime adapters', () => {
  it('builds Claude chat and run commands as argument arrays', () => {
    const adapter = new ClaudeRuntimeAdapter();
    expect(adapter.chat(agent('claude'))).toMatchObject({ command: 'claude', args: [] });
    expect(adapter.run(agent('claude'), '检查; rm -rf /')).toMatchObject({
      command: 'claude',
      args: ['-p', '检查; rm -rf /'],
      cwd: '/tmp/agents/employee',
    });
  });

  it('builds Codex commands with the workspace and no shell string', () => {
    const adapter = new CodexRuntimeAdapter();
    expect(adapter.chat(agent('codex'))).toMatchObject({
      command: 'codex',
      args: ['-C', '/tmp/agents/employee'],
    });
    expect(adapter.run(agent('codex'), '分析任务')).toMatchObject({
      command: 'codex',
      args: ['exec', '-C', '/tmp/agents/employee', '分析任务'],
    });
  });
});
