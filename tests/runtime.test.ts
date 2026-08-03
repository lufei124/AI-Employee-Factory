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
