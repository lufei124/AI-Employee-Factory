import { buildSafeBaseEnvironment } from '../core/runtime.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { ExecutionContext, RuntimeAdapter } from './runtime-adapter.js';

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly provider = 'codex' as const;

  buildEnv(agent: RegistryAgent, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return { ...buildSafeBaseEnvironment(source), CODEX_HOME: agent.runtime_home.path };
  }

  chat(agent: RegistryAgent, runtime: AgentConfig['runtime']): ExecutionContext {
    const args = ['-C', agent.workspace.path];
    if (runtime.model) args.push('-m', runtime.model);
    return this.context(agent, 'chat', args);
  }

  run(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
    task: string,
    timeoutMs?: number,
  ): ExecutionContext {
    const args = ['exec', '-C', agent.workspace.path];
    if (runtime.model) args.push('-m', runtime.model);
    args.push(task);
    return this.context(agent, 'run', args, timeoutMs);
  }

  login(agent: RegistryAgent): ExecutionContext {
    return this.context(agent, 'login', ['login']);
  }

  authStatus(agent: RegistryAgent): ExecutionContext {
    return this.context(agent, 'auth-status', ['login', 'status']);
  }

  private context(
    agent: RegistryAgent,
    operation: ExecutionContext['operation'],
    args: string[],
    timeoutMs?: number,
  ): ExecutionContext {
    const context: ExecutionContext = {
      operation,
      command: 'codex',
      args,
      cwd: agent.workspace.path,
      env: this.buildEnv(agent),
    };
    if (timeoutMs !== undefined) context.timeoutMs = timeoutMs;
    return context;
  }
}
