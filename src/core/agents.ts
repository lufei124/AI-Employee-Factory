import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import type { RegistryStore } from './registry.js';
import { agentConfigSchema, type AgentConfig } from '../schemas/agent-schema.js';
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

export async function loadPortableConfig(agent: RegistryAgent): Promise<AgentConfig> {
  const file = path.join(agent.workspace.path, 'agent.yaml');
  if (!(await fs.pathExists(file)))
    throw new AgentCtlError('NOT_FOUND', `Agent 配置不存在：${file}`);
  const config = agentConfigSchema.parse(YAML.parse(await fs.readFile(file, 'utf8')));
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
