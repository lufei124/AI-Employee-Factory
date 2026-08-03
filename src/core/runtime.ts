import fs from 'fs-extra';
import path from 'node:path';
import { AgentCtlError } from './errors.js';
import { atomicWriteFile } from './atomic.js';
import { ClaudeRuntimeAdapter } from '../runtimes/claude-adapter.js';
import { CodexRuntimeAdapter } from '../runtimes/codex-adapter.js';
import type { RuntimeAdapter } from '../runtimes/runtime-adapter.js';
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

export interface CcSwitchSyncSummary {
  source: string;
  destination: string;
  keys: string[];
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
): Promise<CcSwitchSyncSummary> {
  if (agent.runtime.provider !== 'claude') {
    throw new AgentCtlError('VALIDATION_ERROR', `Agent ${agent.id} 不是 Claude Runtime。`);
  }
  const source = await ccSwitchClaudeSettingsFile(path.resolve(userHome));
  const destination = path.join(agent.runtime_home.path, 'settings.json');
  if (path.resolve(source) === path.resolve(destination)) {
    throw new AgentCtlError('CONFLICT', 'CC Switch 配置目录不能直接复用员工 Runtime Home。');
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
  for (const key of ccSwitchClaudeProviderVariables) delete existingEnv[key];
  await atomicWriteFile(
    destination,
    `${JSON.stringify({ ...isolated, env: { ...existingEnv, ...providerEnv } }, null, 2)}\n`,
    0o600,
  );
  return { source, destination, keys };
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
  const result = buildSafeBaseEnvironment(source);
  if (agent.runtime.provider === 'claude') result.CLAUDE_CONFIG_DIR = agent.runtime_home.path;
  else result.CODEX_HOME = agent.runtime_home.path;
  return result;
}

export function getRuntimeAdapter(agent: RegistryAgent): RuntimeAdapter {
  if (!agent.runtime.locked)
    throw new AgentCtlError('CONFLICT', `Agent ${agent.id} 的运行器未锁定。`);
  return agent.runtime.provider === 'claude'
    ? new ClaudeRuntimeAdapter()
    : new CodexRuntimeAdapter();
}
