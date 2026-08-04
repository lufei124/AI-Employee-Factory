import fs from 'fs-extra';
import path from 'node:path';
import { AgentCtlError } from './errors.js';
import { atomicWriteFile } from './atomic.js';
import { ClaudeRuntimeAdapter } from '../runtimes/claude-adapter.js';
import { CodexRuntimeAdapter } from '../runtimes/codex-adapter.js';
import type { RuntimeAdapter } from '../runtimes/runtime-adapter.js';
import type { RuntimeProvider } from '../schemas/agent-schema.js';
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

const ccSwitchClaudeProviderVariables = new Set([
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
]);

// R24：流量路由字段（同步=流量重定向原语）。保留可同步（兼容中继/代理型 Provider，D-006），
// 但在 SyncSummary.routedFieldsChanged 标记变更并告警，使路由变更可见可审计。
const routedFields = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
]);

export interface CcSwitchSyncSummary {
  source: string;
  destination: string;
  keys: string[];
  routedFieldsChanged: string[];
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
  userHome: string,
  runtimesDir: string,
  sanitizeNonWhitelist = false,
): Promise<CcSwitchSyncSummary> {
  if (agent.runtime.provider !== 'claude') {
    throw new AgentCtlError('VALIDATION_ERROR', `Agent ${agent.id} 不是 Claude Runtime。`);
  }
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
  if (!(await fs.pathExists(source))) {
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
  return { source, destination, keys, routedFieldsChanged };
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
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // OP3-C：委托给 adapter.buildEnv，消除 provider if/else 与静默回退。
  return getRuntimeAdapter(agent).buildEnv(agent, source);
}

// OP3-C：工厂对象。Record<RuntimeProvider, _> 类型注解对对象字面量做穷尽性检查--
// 新增 provider 时此处编译失败，等价 assertNever；未知 provider 运行时抛
// DEPENDENCY_MISSING，不再静默回退 Codex（修 T-2）。
const runtimeAdapterFactories: Record<RuntimeProvider, () => RuntimeAdapter> = {
  claude: () => new ClaudeRuntimeAdapter(),
  codex: () => new CodexRuntimeAdapter(),
};

export function getRuntimeAdapter(agent: RegistryAgent): RuntimeAdapter {
  if (!agent.runtime.locked)
    throw new AgentCtlError('CONFLICT', `Agent ${agent.id} 的运行器未锁定。`);
  const factory = runtimeAdapterFactories[agent.runtime.provider];
  if (!factory)
    throw new AgentCtlError(
      'DEPENDENCY_MISSING',
      `未注册的 Runtime Provider：${agent.runtime.provider}`,
      {
        remediation: '请检查 agent.yaml 的 runtime.provider，仅支持 claude / codex。',
      },
    );
  return factory();
}
