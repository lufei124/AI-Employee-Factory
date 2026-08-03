import { AgentCtlError } from './errors.js';
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
