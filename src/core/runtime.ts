import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCtlError } from './errors.js';
import { atomicWriteFile } from './atomic.js';
import { ClaudeRuntimeAdapter } from '../runtimes/claude-adapter.js';
import { CodexRuntimeAdapter } from '../runtimes/codex-adapter.js';
import type { RuntimeAdapter } from '../runtimes/runtime-adapter.js';
import type { AgentConfig, RuntimeProvider } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

const safeInheritedVariables = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

// OP5-B：白名单外置到 presets/cc-switch-allowlist.json（便于随 Claude Code 版本更新，不改代码）。
// 加载失败时回退内置默认（同 JSON 内容），保持向后兼容与健壮。
interface AllowlistFile {
  variables: string[];
  routed_fields: string[];
}

const ALLOWLIST_FILE = path.join(packageRoot(), 'presets', 'cc-switch-allowlist.json');

const FALLBACK_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
];

const FALLBACK_ROUTED_FIELDS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
];

let allowlistCache: { variables: Set<string>; routedFields: Set<string> } | undefined;

export function loadAllowlist(): { variables: Set<string>; routedFields: Set<string> } {
  if (allowlistCache) return allowlistCache;
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8')) as AllowlistFile;
    const variables = Array.isArray(raw.variables)
      ? raw.variables.filter((value): value is string => typeof value === 'string')
      : [];
    const routedFields = Array.isArray(raw.routed_fields)
      ? raw.routed_fields.filter((value): value is string => typeof value === 'string')
      : [];
    allowlistCache = {
      variables: new Set(variables.length ? variables : FALLBACK_VARIABLES),
      routedFields: new Set(routedFields.length ? routedFields : FALLBACK_ROUTED_FIELDS),
    };
  } catch {
    allowlistCache = {
      variables: new Set(FALLBACK_VARIABLES),
      routedFields: new Set(FALLBACK_ROUTED_FIELDS),
    };
  }
  return allowlistCache;
}

// OP5-B：mtime 缓存。源 settings.json 的 mtime 未变且已同步过则跳过重写（减少无谓 I/O 与竞态）。
export interface SyncCache {
  isStale(sourceMtimeMs: number): boolean;
  markSynced(sourceMtimeMs: number): void;
}

export function createSyncCache(): SyncCache {
  let syncedMtime = -1;
  return {
    isStale(sourceMtimeMs: number): boolean {
      // mtime < 0（源缺失/不可 stat）恒为 stale：缓存命中仅对真实存在的源有效，
      // 否则会把「源缺失」误当作已同步跳过，导致 NOT_FOUND/降级路径不触发。
      return sourceMtimeMs < 0 || sourceMtimeMs !== syncedMtime;
    },
    markSynced(sourceMtimeMs: number): void {
      syncedMtime = sourceMtimeMs;
    },
  };
}

export interface CcSwitchSyncSummary {
  source: string;
  destination: string;
  keys: string[];
  routedFieldsChanged: string[];
  /** OP5-B：mtime 缓存命中，跳过重写。 */
  cached?: boolean;
}

async function ccSwitchClaudeSettingsFile(userHome: string): Promise<string> {
  const localSettings = path.join(userHome, '.cc-switch', 'settings.json');
  if (await fs.pathExists(localSettings)) {
    try {
      const settings = (await fs.readJson(localSettings)) as { claude_config_dir?: unknown };
      if (typeof settings.claude_config_dir === 'string' && settings.claude_config_dir.trim()) {
        const configured = settings.claude_config_dir.startsWith('~/')
          ? path.join(userHome, settings.claude_config_dir.slice(2))
          : settings.claude_config_dir;
        return path.join(path.resolve(userHome, configured), 'settings.json');
      }
    } catch (error) {
      throw new AgentCtlError('VALIDATION_ERROR', 'CC Switch 本地设置格式无效。', {
        remediation: '请在 CC Switch 中检查 Claude Code 配置目录，然后重试。',
        cause: error,
      });
    }
  }
  return path.join(userHome, '.claude', 'settings.json');
}

export async function syncCcSwitchClaudeProvider(
  agent: RegistryAgent,
  runtime: AgentConfig['runtime'],
  userHome: string,
  runtimesDir: string,
  sanitizeNonWhitelist = false,
  cache?: SyncCache,
): Promise<CcSwitchSyncSummary> {
  if (runtime.provider !== 'claude') {
    throw new AgentCtlError('VALIDATION_ERROR', `Agent ${agent.id} 不是 Claude Runtime。`);
  }
  const { variables: ccSwitchClaudeProviderVariables, routedFields } = loadAllowlist();
  const source = await ccSwitchClaudeSettingsFile(path.resolve(userHome));
  const destination = path.join(agent.runtime_home.path, 'settings.json');
  if (path.resolve(source) === path.resolve(destination)) {
    throw new AgentCtlError('CONFLICT', 'CC Switch 配置目录不能直接复用员工 Runtime Home。');
  }
  // R4：CC Switch 源不得指向任一员工 Runtime Home（防跨员工凭据复制），且不得是软链接。
  if (await fs.pathExists(source)) {
    if ((await fs.lstat(source)).isSymbolicLink()) {
      throw new AgentCtlError('VALIDATION_ERROR', 'CC Switch 配置不能是软链接。', {
        remediation: '请在 CC Switch 中检查 claude_config_dir 指向，移除软链接后重试。',
      });
    }
    const sourceReal = await fs.realpath(source);
    const runtimesReal = (await fs.pathExists(runtimesDir))
      ? await fs.realpath(runtimesDir)
      : path.resolve(runtimesDir);
    const relative = path.relative(runtimesReal, sourceReal);
    const insideRuntimes =
      relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (insideRuntimes) {
      throw new AgentCtlError('CONFLICT', 'CC Switch 配置目录不得指向员工 Runtime Home。', {
        remediation:
          '请在 CC Switch 中将 claude_config_dir 指向用户自己的 Claude 配置目录，而非员工 Runtime Home。',
      });
    }
  }
  // OP5-B：mtime 缓存。源未变且已同步过则跳过重写。
  const sourceMtime = (await fs.stat(source).catch(() => null))?.mtimeMs ?? -1;
  if (cache && !cache.isStale(sourceMtime)) {
    return { source, destination, keys: [], routedFieldsChanged: [], cached: true };
  }
  if (!(await fs.pathExists(source))) {
    // OP5-B：降级读取 agent.runtime_home/.cc-switch.env（0600，用户预置）。仅当显式存在时使用；
    // 否则保持既有 NOT_FOUND 语义。降级来源不参与 mtime 缓存（一次性环境预置，非滚动同步源）。
    const fallbackEnvFile = path.join(agent.runtime_home.path, '.cc-switch.env');
    if (await fs.pathExists(fallbackEnvFile)) {
      const degraded = await syncFromEnvFile(agent, fallbackEnvFile, destination);
      cache?.markSynced(sourceMtime);
      return degraded;
    }
    throw new AgentCtlError('NOT_FOUND', `未找到 CC Switch 当前 Claude 配置：${source}`, {
      remediation: '请先在 CC Switch 中启用一个 Claude Provider，然后重新执行同步。',
    });
  }
  let live: { env?: Record<string, unknown> };
  try {
    live = (await fs.readJson(source)) as { env?: Record<string, unknown> };
  } catch (error) {
    throw new AgentCtlError('VALIDATION_ERROR', 'CC Switch 当前 Claude 配置不是有效 JSON。', {
      remediation: '请在 CC Switch 中重新启用当前 Claude Provider，然后重试。',
      cause: error,
    });
  }
  const providerEnv = Object.fromEntries(
    Object.entries(live.env ?? {}).filter(
      ([key, value]) => ccSwitchClaudeProviderVariables.has(key) && typeof value === 'string',
    ),
  ) as Record<string, string>;
  const keys = Object.keys(providerEnv).sort();
  if (!keys.length) {
    throw new AgentCtlError('AUTH_REQUIRED', 'CC Switch 当前 Claude Provider 未提供 API 配置。', {
      remediation: '请在 CC Switch 中启用一个 API Provider，而不是执行 Claude 官方登录。',
    });
  }
  let isolated: Record<string, unknown> = {};
  if (await fs.pathExists(destination)) {
    try {
      isolated = (await fs.readJson(destination)) as Record<string, unknown>;
    } catch (error) {
      throw new AgentCtlError('VALIDATION_ERROR', `员工 Claude 设置格式无效：${destination}`, {
        cause: error,
      });
    }
  }
  const existingEnv =
    isolated.env && typeof isolated.env === 'object' && !Array.isArray(isolated.env)
      ? ({ ...isolated.env } as Record<string, unknown>)
      : {};
  // R24：记录流量路由字段的有效值变更（仅字段名，不记录值，守 D-006）。
  const routedFieldsChanged: string[] = [];
  for (const key of routedFields) {
    const oldValue =
      typeof existingEnv[key] === 'string' ? (existingEnv[key] as string) : undefined;
    const newValue: string | undefined = providerEnv[key];
    if (oldValue !== newValue) routedFieldsChanged.push(key);
  }
  for (const key of ccSwitchClaudeProviderVariables) delete existingEnv[key];
  // R5：sanitize 时移除员工设置中残留的非白名单 env（默认 false，保留兼容）。
  if (sanitizeNonWhitelist) {
    for (const key of Object.keys(existingEnv)) delete existingEnv[key];
  }
  await atomicWriteFile(
    destination,
    `${JSON.stringify({ ...isolated, env: { ...existingEnv, ...providerEnv } }, null, 2)}\n`,
    0o600,
  );
  cache?.markSynced(sourceMtime);
  return { source, destination, keys, routedFieldsChanged };
}

// OP5-B：从 .cc-switch.env（0600，用户预置）降级读取 Provider 配置。格式为 KEY=VALUE 行，
// 忽略注释与空行；仅白名单字段生效。返回与正常同步一致的摘要。
async function syncFromEnvFile(
  agent: RegistryAgent,
  envFile: string,
  destination: string,
): Promise<CcSwitchSyncSummary> {
  const { variables: ccSwitchClaudeProviderVariables, routedFields } = loadAllowlist();
  const mode = (await fs.stat(envFile)).mode & 0o777;
  if (mode !== 0o600) {
    throw new AgentCtlError(
      'VALIDATION_ERROR',
      `.cc-switch.env 权限必须为 0600，当前 ${mode.toString(8)}`,
      {
        remediation: '运行 chmod 600 后重试。',
      },
    );
  }
  const content = await fs.readFile(envFile, 'utf8');
  const providerEnv: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (ccSwitchClaudeProviderVariables.has(key)) providerEnv[key] = value;
  }
  const keys = Object.keys(providerEnv).sort();
  if (!keys.length) {
    throw new AgentCtlError(
      'AUTH_REQUIRED',
      `.cc-switch.env 未提供任何白名单 Claude Provider 配置。`,
      { remediation: '在 .cc-switch.env 中填写白名单字段（如 ANTHROPIC_AUTH_TOKEN）后重试。' },
    );
  }
  let isolated: Record<string, unknown> = {};
  if (await fs.pathExists(destination)) {
    try {
      isolated = (await fs.readJson(destination)) as Record<string, unknown>;
    } catch (error) {
      throw new AgentCtlError('VALIDATION_ERROR', `员工 Claude 设置格式无效：${destination}`, {
        cause: error,
      });
    }
  }
  const existingEnv =
    isolated.env && typeof isolated.env === 'object' && !Array.isArray(isolated.env)
      ? ({ ...isolated.env } as Record<string, unknown>)
      : {};
  const routedFieldsChanged: string[] = [];
  for (const key of routedFields) {
    const oldValue =
      typeof existingEnv[key] === 'string' ? (existingEnv[key] as string) : undefined;
    const newValue: string | undefined = providerEnv[key];
    if (oldValue !== newValue) routedFieldsChanged.push(key);
  }
  for (const key of ccSwitchClaudeProviderVariables) delete existingEnv[key];
  await atomicWriteFile(
    destination,
    `${JSON.stringify({ ...isolated, env: { ...existingEnv, ...providerEnv } }, null, 2)}\n`,
    0o600,
  );
  return { source: envFile, destination, keys, routedFieldsChanged };
}

export function buildSafeBaseEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of safeInheritedVariables) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function buildRuntimeEnvironment(
  agent: RegistryAgent,
  runtime: AgentConfig['runtime'],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // OP3-C：委托给 adapter.buildEnv，消除 provider if/else 与静默回退。
  return getRuntimeAdapter(runtime).buildEnv(agent, source);
}

// OP3-C：工厂对象。Record<RuntimeProvider, _> 类型注解对对象字面量做穷尽性检查--
// 新增 provider 时此处编译失败，等价 assertNever；未知 provider 运行时抛
// DEPENDENCY_MISSING，不再静默回退 Codex（修 T-2）。
const runtimeAdapterFactories: Record<RuntimeProvider, () => RuntimeAdapter> = {
  claude: () => new ClaudeRuntimeAdapter(),
  codex: () => new CodexRuntimeAdapter(),
};

export function getRuntimeAdapter(runtime: AgentConfig['runtime']): RuntimeAdapter {
  if (!runtime.locked) throw new AgentCtlError('CONFLICT', `运行器未锁定。`);
  const factory = runtimeAdapterFactories[runtime.provider];
  if (!factory)
    throw new AgentCtlError(
      'DEPENDENCY_MISSING',
      `未注册的 Runtime Provider：${runtime.provider}`,
      {
        remediation: '请检查 agent.yaml 的 runtime.provider，仅支持 claude / codex。',
      },
    );
  return factory();
}
