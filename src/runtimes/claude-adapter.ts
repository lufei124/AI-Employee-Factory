import { buildSafeBaseEnvironment } from '../core/runtime.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { ExecutionContext, RuntimeAdapter } from './runtime-adapter.js';

export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly provider = 'claude' as const;

  buildEnv(agent: RegistryAgent, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return { ...buildSafeBaseEnvironment(source), CLAUDE_CONFIG_DIR: agent.runtime_home.path };
  }

  chat(agent: RegistryAgent, runtime: AgentConfig['runtime']): ExecutionContext {
    return this.context(agent, 'chat', runtime.model ? ['--model', runtime.model] : []);
  }

  run(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
    task: string,
    timeoutMs?: number,
  ): ExecutionContext {
    const args = ['-p', task];
    if (runtime.model) args.push('--model', runtime.model);
    return this.context(agent, 'run', args, timeoutMs);
  }

  login(agent: RegistryAgent): ExecutionContext {
    return this.context(agent, 'login', ['auth', 'login']);
  }

  authStatus(agent: RegistryAgent): ExecutionContext {
    return this.context(agent, 'auth-status', ['auth', 'status']);
  }

  private context(
    agent: RegistryAgent,
    operation: ExecutionContext['operation'],
    args: string[],
    timeoutMs?: number,
  ): ExecutionContext {
    const context: ExecutionContext = {
      operation,
      command: 'claude',
      args,
      cwd: agent.workspace.path,
      env: this.buildEnv(agent),
    };
    if (timeoutMs !== undefined) context.timeoutMs = timeoutMs;
    return context;
  }
}
