import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import type { RegistryStore } from './registry.js';
import {
  agentConfigSchema,
  CURRENT_AGENT_CONFIG_SCHEMA_VERSION,
  type AgentConfig,
} from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

export async function getRegisteredAgent(
  registry: RegistryStore,
  id: string,
): Promise<RegistryAgent> {
  const agent = (await registry.read()).agents.find((candidate) => candidate.id === id);
  if (!agent)
    throw new AgentCtlError('NOT_FOUND', `Agent 不存在：${id}`, {
      remediation: '请运行 agentctl list 查看已注册员工。',
    });
  return agent;
}

// OP3-B：版本化只读 reader。按 schema_version 显式分派；v1=identity（直接 parse），
// 不原地 mutate。未知版本拒绝并提示未来 migrate（migrate 命令留待后续批次）。
function readAgentConfig(raw: unknown, version: number): AgentConfig {
  if (version === 1) return agentConfigSchema.parse(raw);
  throw new AgentCtlError(
    'VALIDATION_ERROR',
    `不支持的 agent.yaml schema_version：${version}（当前支持 v${CURRENT_AGENT_CONFIG_SCHEMA_VERSION}）。`,
    {
      remediation: '请升级 agentctl 后运行 agentctl migrate（尚未实现），或使用匹配版本的工具。',
    },
  );
}

export async function loadPortableConfig(agent: RegistryAgent): Promise<AgentConfig> {
  const file = path.join(agent.workspace.path, 'agent.yaml');
  if (!(await fs.pathExists(file)))
    throw new AgentCtlError('NOT_FOUND', `Agent 配置不存在：${file}`);
  const raw = YAML.parse(await fs.readFile(file, 'utf8'));
  const declared =
    typeof raw === 'object' && raw !== null && 'schema_version' in raw
      ? Number((raw as { schema_version: unknown }).schema_version)
      : 1;
  const config = readAgentConfig(raw, Number.isFinite(declared) ? declared : 1);
  if (
    config.id !== agent.id ||
    config.runtime.provider !== agent.runtime.provider ||
    config.runtime.locked !== true
  ) {
    throw new AgentCtlError('CONFLICT', `Agent ${agent.id} 的 Registry 与 agent.yaml 不一致。`, {
      remediation: `请运行 agentctl doctor ${agent.id} 检查，不要直接修改已锁定的 runtime。`,
    });
  }
  return config;
}
