import fs from 'fs-extra';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import type { RegistryStore } from './registry.js';
import {
  agentConfigSchema,
  CURRENT_AGENT_CONFIG_SCHEMA_VERSION,
  type AgentConfig,
} from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

// OP3-A：计算 agent.yaml runtime 块的 sha256，作为 Registry 派生缓存的漂移指纹。
// 哈希 runtime 块（provider/locked/model）而非整文件，精确覆盖单源范围，
// 避免 archive（写 lifecycle 块）等合法 agent.yaml 改写误报漂移。
export function computeConfigHash(runtime: AgentConfig['runtime']): string {
  const canonical: { provider: string; locked: true; model?: string } = {
    provider: runtime.provider,
    locked: runtime.locked,
  };
  if (typeof runtime.model === 'string') canonical.model = runtime.model;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

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
// 不原地 mutate。未知版本拒绝并提示 migrate。
function readAgentConfig(raw: unknown, version: number): AgentConfig {
  if (version === 1) return agentConfigSchema.parse(raw);
  throw new AgentCtlError(
    'VALIDATION_ERROR',
    `不支持的 agent.yaml schema_version：${version}（当前支持 v${CURRENT_AGENT_CONFIG_SCHEMA_VERSION}）。`,
    {
      remediation: '请升级 agentctl 后运行 agentctl migrate，或使用匹配版本的工具。',
    },
  );
}

// 原样读取 agent.yaml（不做任何 Registry 一致性校验）。供 repair 逃生口与 list N+1 回退使用。
export async function readAgentConfigFile(file: string): Promise<AgentConfig> {
  const raw = YAML.parse(await fs.readFile(file, 'utf8'));
  const declared =
    typeof raw === 'object' && raw !== null && 'schema_version' in raw
      ? Number((raw as { schema_version: unknown }).schema_version)
      : 1;
  return readAgentConfig(raw, Number.isFinite(declared) ? declared : 1);
}

export async function loadPortableConfig(agent: RegistryAgent): Promise<AgentConfig> {
  const file = path.join(agent.workspace.path, 'agent.yaml');
  if (!(await fs.pathExists(file)))
    throw new AgentCtlError('NOT_FOUND', `Agent 配置不存在：${file}`);
  const config = await readAgentConfigFile(file);
  // OP3-A 长期：HARD 一致性校验。Registry 不再持有 runtime 块，以 config_hash 为唯一指纹；
  // 漂移（含 model/provider/locked 变更）抛 CONFLICT 阻断运行，agentctl repair 为逃生口。
  if (
    config.id !== agent.id ||
    !agent.config_hash ||
    computeConfigHash(config.runtime) !== agent.config_hash
  ) {
    throw new AgentCtlError(
      'CONFLICT',
      `Agent ${agent.id} 的 Registry 与 agent.yaml 不一致（config_hash 漂移）。`,
      {
        remediation: `请运行 agentctl repair ${agent.id} 以 agent.yaml 重建 Registry 缓存。`,
      },
    );
  }
  return config;
}
