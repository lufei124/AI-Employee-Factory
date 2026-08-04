import type { RegistryAgent } from '../schemas/registry-schema.js';

export type RuntimeOperation = 'chat' | 'run' | 'login' | 'auth-status' | 'bridge' | 'job';

export interface ExecutionContext {
  operation: RuntimeOperation;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface RuntimeAdapter {
  readonly provider: 'claude' | 'codex';
  chat(agent: RegistryAgent): ExecutionContext;
  run(agent: RegistryAgent, task: string, timeoutMs?: number): ExecutionContext;
  login(agent: RegistryAgent): ExecutionContext;
  authStatus(agent: RegistryAgent): ExecutionContext;
  // OP3-C：provider 专属运行环境由 adapter 自建，buildRuntimeEnvironment 委托至此，
  // 消除 runtime.ts 中的 provider if/else 与静默回退。
  buildEnv(agent: RegistryAgent, source?: NodeJS.ProcessEnv): Record<string, string>;
}
