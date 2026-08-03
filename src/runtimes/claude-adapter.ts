import { buildRuntimeEnvironment } from '../core/runtime.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { ExecutionContext, RuntimeAdapter } from './runtime-adapter.js';

export class ClaudeRuntimeAdapter implements RuntimeAdapter {
  readonly provider = 'claude' as const;

  chat(agent: RegistryAgent): ExecutionContext {
    return this.context(agent, 'chat', agent.runtime.model ? ['--model', agent.runtime.model] : []);
  }

  run(agent: RegistryAgent, task: string, timeoutMs?: number): ExecutionContext {
    const args = ['-p', task];
    if (agent.runtime.model) args.push('--model', agent.runtime.model);
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
      env: buildRuntimeEnvironment(agent),
    };
    if (timeoutMs !== undefined) context.timeoutMs = timeoutMs;
    return context;
  }
}
