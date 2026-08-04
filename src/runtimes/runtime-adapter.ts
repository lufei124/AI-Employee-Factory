import type { AgentConfig } from '../schemas/agent-schema.js';
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
  // OP3-A 长期：provider/model 从 agent.yaml 的 runtime 块（AgentConfig['runtime']）读取，
  // 不再经 RegistryAgent（Registry 已移除 runtime 块）。
  chat(agent: RegistryAgent, runtime: AgentConfig['runtime']): ExecutionContext;
  run(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
    task: string,
    timeoutMs?: number,
    // OP4-C 前置：true 时追加结构化输出 flag（claude --output-format json / codex --json），
    // 供 process-runner 解析 usage。默认 false 保持既有文本行为。
    structured?: boolean,
  ): ExecutionContext;
  login(agent: RegistryAgent): ExecutionContext;
  authStatus(agent: RegistryAgent): ExecutionContext;
  // OP3-C：provider 专属运行环境由 adapter 自建，buildRuntimeEnvironment 委托至此，
  // 消除 runtime.ts 中的 provider if/else 与静默回退。
  buildEnv(agent: RegistryAgent, source?: NodeJS.ProcessEnv): Record<string, string>;
}
