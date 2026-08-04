import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntimeEnvironment, getRuntimeAdapter } from '../src/core/runtime.js';
import { ClaudeRuntimeAdapter } from '../src/runtimes/claude-adapter.js';
import { CodexRuntimeAdapter } from '../src/runtimes/codex-adapter.js';
import type { AgentConfig } from '../src/schemas/agent-schema.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

function agent(provider: 'claude' | 'codex'): RegistryAgent {
  return {
    id: 'employee',
    name: '员工',
    status: 'stopped',
    archived: false,
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

function runtimeBlock(provider: 'claude' | 'codex'): AgentConfig['runtime'] {
  return { provider, locked: true };
}

describe('runtime environment isolation', () => {
  it('removes inherited personal configuration and credential variables', () => {
    const env = buildRuntimeEnvironment(agent('claude'), runtimeBlock('claude'), {
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

  it('throws DEPENDENCY_MISSING for an unknown provider instead of falling back to Codex (OP3-C)', () => {
    expect(() => getRuntimeAdapter({ provider: 'unknown' as 'claude', locked: true })).toThrow(
      /未注册的 Runtime Provider/,
    );
  });

  it('builds CODEX_HOME for the codex provider via adapter.buildEnv delegation (OP3-C)', () => {
    const env = buildRuntimeEnvironment(agent('codex'), runtimeBlock('codex'), {
      HOME: '/Users/person',
      PATH: '/bin',
    });
    expect(env.CODEX_HOME).toBe('/tmp/private/runtimes/employee/codex');
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
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

      const summary = (await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
      )) as {
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

  it('sanitizes non-whitelist env when sanitizeNonWhitelist is true (R5)', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
      sanitize?: boolean,
    ) => Promise<unknown>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-r5-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      await fs.outputJson(path.join(root, '.claude/settings.json'), {
        env: { ANTHROPIC_AUTH_TOKEN: 'provider-secret' },
      });
      await fs.outputJson(path.join(claudeAgent.runtime_home.path, 'settings.json'), {
        env: { EMPLOYEE_LOCAL_SETTING: 'drop-me', ANTHROPIC_AUTH_TOKEN: 'old-secret' },
      });

      await sync(claudeAgent, runtimeBlock('claude'), root, path.join(root, 'runtimes'), true);
      const isolated = await fs.readJson(path.join(claudeAgent.runtime_home.path, 'settings.json'));

      // 白名单 provider 字段保留，非白名单残留被移除
      expect(isolated.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'provider-secret' });
      expect(isolated.env).not.toHaveProperty('EMPLOYEE_LOCAL_SETTING');
    } finally {
      await fs.remove(root);
    }
  });

  it('rejects a CC Switch source that points into an employee Runtime Home', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
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

      await expect(sync(claudeAgent, runtimeBlock('claude'), root, runtimesDir)).rejects.toThrow(
        '员工 Runtime Home',
      );
    } finally {
      await fs.remove(root);
    }
  });

  it('records no routed-field change when traffic-routing fields are absent', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
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

      const summary = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
      );
      expect(summary.routedFieldsChanged).toEqual([]);
    } finally {
      await fs.remove(root);
    }
  });

  it('skips rewriting when the source mtime is unchanged (OP5-B SyncCache)', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
      sanitize?: boolean,
      cache?: { isStale: (m: number) => boolean; markSynced: (m: number) => void },
    ) => Promise<{ keys: string[]; cached?: boolean }>;
    const createSyncCache = runtime.createSyncCache as () => {
      isStale: (m: number) => boolean;
      markSynced: (m: number) => void;
    };
    expect(sync).toBeTypeOf('function');
    expect(createSyncCache).toBeTypeOf('function');
    if (typeof sync !== 'function' || typeof createSyncCache !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-cache-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      const sourceFile = path.join(root, '.claude/settings.json');
      await fs.outputJson(sourceFile, { env: { ANTHROPIC_AUTH_TOKEN: 'secret' } });

      const cache = createSyncCache();
      const first = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
        false,
        cache,
      );
      expect(first.cached).toBeUndefined();
      expect(first.keys).toEqual(['ANTHROPIC_AUTH_TOKEN']);

      // 源未变：第二次同步命中缓存，keys 为空且 cached=true。
      const second = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
        false,
        cache,
      );
      expect(second.cached).toBe(true);
      expect(second.keys).toEqual([]);

      // 源 mtime 变化：第三次同步重新写入。
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(sourceFile, later, later);
      const third = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
        false,
        cache,
      );
      expect(third.cached).toBeUndefined();
      expect(third.keys).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    } finally {
      await fs.remove(root);
    }
  });

  it('degrades to .cc-switch.env when the CC Switch source is missing (OP5-B)', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
    ) => Promise<{ source: string; keys: string[] }>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-env-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      const envFile = path.join(claudeAgent.runtime_home.path, '.cc-switch.env');
      await fs.outputFile(
        envFile,
        '# pre-provisioned\nANTHROPIC_AUTH_TOKEN=env-secret\nANTHROPIC_BASE_URL=https://env.example.test\nOPENAI_API_KEY=not-in-allowlist\n',
        { mode: 0o600 },
      );

      // 无任何 CC Switch 源（无 ~/.claude/settings.json、无 ~/.cc-switch/settings.json）。
      const summary = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
      );
      expect(summary.source).toBe(envFile);
      expect(summary.keys).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);

      const isolated = await fs.readJson(path.join(claudeAgent.runtime_home.path, 'settings.json'));
      expect(isolated.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: 'env-secret',
        ANTHROPIC_BASE_URL: 'https://env.example.test',
      });
      expect(isolated.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(
        (await fs.stat(path.join(claudeAgent.runtime_home.path, 'settings.json'))).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await fs.remove(root);
    }
  });

  it('rejects a .cc-switch.env that is not 0600 (OP5-B)', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
    ) => Promise<unknown>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-env-mode-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      await fs.outputFile(
        path.join(claudeAgent.runtime_home.path, '.cc-switch.env'),
        'ANTHROPIC_AUTH_TOKEN=secret',
        { mode: 0o644 },
      );

      await expect(
        sync(claudeAgent, runtimeBlock('claude'), root, path.join(root, 'runtimes')),
      ).rejects.toThrow(/0600/);
    } finally {
      await fs.remove(root);
    }
  });

  it('loads the allowlist from presets/cc-switch-allowlist.json (OP5-B)', async () => {
    const { loadAllowlist } = await import('../src/core/runtime.js');
    const allowed = loadAllowlist();
    // 外置白名单与内置回退同构：22 个变量 + 3 个路由字段。
    expect(allowed.variables.size).toBe(22);
    expect(allowed.routedFields.size).toBe(3);
    expect(allowed.variables.has('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(allowed.variables.has('OPENAI_API_KEY')).toBe(false);
    expect(allowed.routedFields.has('ANTHROPIC_BASE_URL')).toBe(true);
  });

  it('syncs a specific CC Switch Provider by name when providerName is set (OP5-D)', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
      sanitize?: boolean,
      cache?: unknown,
      providerName?: string,
      sqliteExecutor?: (dbPath: string, sql: string) => Promise<string | null>,
    ) => Promise<{ source: string; keys: string[]; routedFieldsChanged: string[] }>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-provider-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      await fs.outputJson(path.join(claudeAgent.runtime_home.path, 'settings.json'), {
        env: { EMPLOYEE_LOCAL_SETTING: 'keep-me', ANTHROPIC_AUTH_TOKEN: 'old-secret' },
      });
      // 模拟 sqlite3 CLI 的 -json 输出：两行 Provider，ProviderA 为当前 live（含非白名单字段），
      // ProviderB 为 per-agent 绑定目标。
      const fakeDb = async (dbPath: string, sql: string) => {
        expect(dbPath).toBe(path.join(root, '.cc-switch', 'cc-switch.db'));
        expect(sql).toContain("app_type='claude'");
        if (sql.includes('SELECT name')) {
          return JSON.stringify([{ name: 'ProviderA' }, { name: 'ProviderB' }]);
        }
        return JSON.stringify([
          {
            name: 'ProviderB',
            settings_config: JSON.stringify({
              env: {
                ANTHROPIC_AUTH_TOKEN: 'provider-b-secret',
                ANTHROPIC_BASE_URL: 'https://provider-b.example.test',
                OPENAI_API_KEY: 'must-not-copy',
              },
            }),
          },
        ]);
      };

      const summary = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
        false,
        undefined,
        'ProviderB',
        fakeDb,
      );
      const isolated = await fs.readJson(path.join(claudeAgent.runtime_home.path, 'settings.json'));
      // 按 ProviderB 同步：白名单字段来自 ProviderB，员工本地非白名单设置保留。
      expect(isolated.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: 'provider-b-secret',
        ANTHROPIC_BASE_URL: 'https://provider-b.example.test',
        EMPLOYEE_LOCAL_SETTING: 'keep-me',
      });
      expect(isolated.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(summary.source).toBe(path.join(root, '.cc-switch', 'cc-switch.db'));
      expect(summary.keys).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
      // R24：BASE_URL 由无变有 -> 流量路由字段变更被标记；摘要只含字段名，不含值。
      expect(summary.routedFieldsChanged).toEqual(['ANTHROPIC_BASE_URL']);
      expect(JSON.stringify(summary)).not.toContain('provider-b-secret');
      expect(JSON.stringify(summary)).not.toContain('provider-b.example.test');
      expect(
        (await fs.stat(path.join(claudeAgent.runtime_home.path, 'settings.json'))).mode & 0o777,
      ).toBe(0o600);
    } finally {
      await fs.remove(root);
    }
  });

  it('throws NOT_FOUND when the named CC Switch Provider is absent (OP5-D)', async () => {
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
      sanitize?: boolean,
      cache?: unknown,
      providerName?: string,
      sqliteExecutor?: (dbPath: string, sql: string) => Promise<string | null>,
    ) => Promise<unknown>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-provider-miss-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      const fakeDb = async () => null; // sqlite3 不可用或数据库缺失
      await expect(
        sync(
          claudeAgent,
          runtimeBlock('claude'),
          root,
          path.join(root, 'runtimes'),
          false,
          undefined,
          'MissingProvider',
          fakeDb,
        ),
      ).rejects.toThrow('MissingProvider');
    } finally {
      await fs.remove(root);
    }
  });

  it('reads a real CC Switch DB via the sqlite3 CLI for a named Provider (OP5-D e2e)', async () => {
    // 若系统无 sqlite3 二进制（如精简镜像），跳过：CI ubuntu / macOS 均自带 sqlite3。
    const sqliteAvailable = await import('execa').then(async ({ execa }) => {
      const probe = await execa('sqlite3', ['--version'], { shell: false, reject: false });
      return probe.exitCode === 0;
    });
    if (!sqliteAvailable) return;
    const runtime = (await import('../src/core/runtime.js')) as Record<string, unknown>;
    const sync = runtime.syncCcSwitchClaudeProvider as (
      agent: RegistryAgent,
      runtime: AgentConfig['runtime'],
      home: string,
      runtimesDir: string,
      sanitize?: boolean,
      cache?: unknown,
      providerName?: string,
    ) => Promise<{ keys: string[] }>;
    expect(sync).toBeTypeOf('function');
    if (typeof sync !== 'function') return;

    const { execa } = await import('execa');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-cc-switch-provider-db-'));
    try {
      const claudeAgent = {
        ...agent('claude'),
        runtime_home: { path: path.join(root, 'private/runtime') },
      };
      // 用 sqlite3 CLI 建真实 CC Switch 形状的数据库（providers 表含 app_type/name/settings_config）。
      const dbFile = path.join(root, '.cc-switch', 'cc-switch.db');
      await fs.ensureDir(path.dirname(dbFile));
      const create = await execa(
        'sqlite3',
        [
          dbFile,
          'CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER);' +
            ' INSERT INTO providers VALUES (\'1\',\'claude\',\'Relay A\',\'{"env":{"ANTHROPIC_AUTH_TOKEN":"token-a","ANTHROPIC_MODEL":"m-a"}}\',1);' +
            ' INSERT INTO providers VALUES (\'2\',\'claude\',\'Relay B\',\'{"env":{"ANTHROPIC_AUTH_TOKEN":"token-b","ANTHROPIC_BASE_URL":"https://b.test"}}\',0);',
        ],
        { shell: false, reject: false },
      );
      expect(create.exitCode).toBe(0);

      // 默认 executor（sqlite3 CLI）：绑定 Relay B（非 live），而非当前 live Relay A。
      const summary = await sync(
        claudeAgent,
        runtimeBlock('claude'),
        root,
        path.join(root, 'runtimes'),
        false,
        undefined,
        'Relay B',
      );
      expect(summary.keys).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
      const isolated = await fs.readJson(path.join(claudeAgent.runtime_home.path, 'settings.json'));
      expect(isolated.env).toMatchObject({
        ANTHROPIC_AUTH_TOKEN: 'token-b',
        ANTHROPIC_BASE_URL: 'https://b.test',
      });
      expect(isolated.env).not.toHaveProperty('ANTHROPIC_MODEL');
    } finally {
      await fs.remove(root);
    }
  });
});

describe('runtime adapters', () => {
  it('builds Claude chat and run commands as argument arrays', () => {
    const adapter = new ClaudeRuntimeAdapter();
    expect(adapter.chat(agent('claude'), runtimeBlock('claude'))).toMatchObject({
      command: 'claude',
      args: [],
    });
    expect(adapter.run(agent('claude'), runtimeBlock('claude'), '检查; rm -rf /')).toMatchObject({
      command: 'claude',
      args: ['-p', '检查; rm -rf /'],
      cwd: '/tmp/agents/employee',
    });
    // OP4-C 前置：structured=true 追加 --output-format json。
    expect(
      adapter.run(agent('claude'), runtimeBlock('claude'), '任务', undefined, true),
    ).toMatchObject({ command: 'claude', args: ['-p', '任务', '--output-format', 'json'] });
  });

  it('builds Codex commands with the workspace and no shell string', () => {
    const adapter = new CodexRuntimeAdapter();
    expect(adapter.chat(agent('codex'), runtimeBlock('codex'))).toMatchObject({
      command: 'codex',
      args: ['-C', '/tmp/agents/employee'],
    });
    expect(adapter.run(agent('codex'), runtimeBlock('codex'), '分析任务')).toMatchObject({
      command: 'codex',
      args: ['exec', '-C', '/tmp/agents/employee', '分析任务'],
    });
    // OP4-C 前置：structured=true 追加 --json。
    expect(
      adapter.run(agent('codex'), runtimeBlock('codex'), '分析任务', undefined, true),
    ).toMatchObject({
      command: 'codex',
      args: ['exec', '--json', '-C', '/tmp/agents/employee', '分析任务'],
    });
  });
});
