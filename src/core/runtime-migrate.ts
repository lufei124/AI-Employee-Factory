// TASK-048（D-044）：显式 runtime 迁移工作流——claude ↔ codex 双向迁移。
//
// 背景：agent.yaml 的 runtime 块（provider/locked/model）由 config_hash 指纹守护（agents.ts
// computeConfigHash/loadPortableConfig），任何手改都会触发 HARD CONFLICT。现状唯一逃生口是
// `agentctl repair`（重建指纹），但它不迁移 runtime_home 目录、不换凭据、不建 codex config.toml。
// 本模块把迁移做成**内部一致的事务**：目录 + agent.yaml 先于 registry 单次原子写（commit 点），
// 任一步失败都不留半迁移态。
//
// 关键约束：
// - 凭据不自动跨 provider 复制（守 D-015：Factory 不自动复制/注入凭据）——目标 claude 只建
//   空目录，迁移后引导 `agentctl runtime sync`；目标 codex 预写 config.toml（复用 create-agent
//   模式），引导 `agentctl runtime login`。
// - 旧 provider 目录默认保留（回滚逃生口）；`--discard` 在 commit 成功后删除。
// - 本模块是纯事务（零服务启停），服务启停由 FactoryApplication 编排（与 archiveAgent 同模式）。

import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import { AgentCtlError } from './errors.js';
import { assertInside } from './paths.js';
import { computeConfigHash } from './agents.js';
import { projectSkillsToProvider } from './skills.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

/** codex runtime_home 的 config.toml 种子（approval_policy/sandbox_mode，对齐 create-agent）。 */
export const CODEX_CONFIG_TOML =
  'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n';

/** 迁移计划（--dry-run 用，零写入）。 */
export interface RuntimeMigrationPlan {
  id: string;
  from: 'claude' | 'codex';
  to: 'claude' | 'codex';
  fromRuntimeHome: string;
  toRuntimeHome: string;
  /** 将停止/重启的 launchd 服务清单。 */
  services: Array<'bridge' | 'settle' | 'job'>;
  /** 将切换的 skills 投影目录（旧 → 新）。 */
  projectedSkills: boolean;
}

/** 迁移结果。 */
export interface RuntimeMigrationResult {
  id: string;
  from: 'claude' | 'codex';
  to: 'claude' | 'codex';
  toRuntimeHome: string;
  /** 旧 provider 目录（--discard 前）。 */
  oldRuntimeHome: string;
  oldDiscarded: boolean;
  configHash: string;
  projectedSkills: boolean;
}

/** 校验 --to 参数值（非法抛 VALIDATION_ERROR）。 */
export function parseRuntimeProvider(value: string): 'claude' | 'codex' {
  if (value !== 'claude' && value !== 'codex') {
    throw new AgentCtlError(
      'VALIDATION_ERROR',
      `无效的 runtime provider：${value}（仅支持 claude / codex）。`,
    );
  }
  return value;
}

/** 目标 provider 的 runtime_home 路径（runtimes/<id>/<provider>，assertInside 防护）。 */
export function targetRuntimeHome(
  runtimesDir: string,
  id: string,
  provider: 'claude' | 'codex',
): string {
  return assertInside(
    runtimesDir,
    path.join(runtimesDir, id, provider),
    `runtime_home（${id}/${provider}）`,
  );
}

/** 写 codex config.toml（复用 create-agent.ts:103-108 模式）。 */
export async function writeCodexConfigToml(dir: string): Promise<void> {
  await fs.outputFile(path.join(dir, 'config.toml'), CODEX_CONFIG_TOML, { mode: 0o600 });
}

/** 把 workspace/skills/* 投影切换到目标 provider 的发现目录（.claude/skills ↔ .codex/skills）。
 *  删旧投影目录 → 复用共享投影助手（skills.ts projectSkillsToProvider，与 SkillService/ensureFactorySkill 同语义）。 */
export async function switchSkillsProjection(
  workspace: string,
  fromProvider: 'claude' | 'codex',
  toProvider: 'claude' | 'codex',
): Promise<void> {
  if (fromProvider === toProvider) return;
  const oldProjection = path.join(
    workspace,
    fromProvider === 'claude' ? '.claude' : '.codex',
    'skills',
  );
  await fs.remove(oldProjection);
  await projectSkillsToProvider(workspace, toProvider);
}

/**
 * 迁移计划（零写入）。校验目标合法 + 目标目录状态，供 --dry-run 与正式迁移共用。
 */
export async function buildRuntimeMigrationPlan(input: {
  registry: RegistryAgent;
  agent: AgentConfig;
  runtimesDir: string;
  to: 'claude' | 'codex';
}): Promise<RuntimeMigrationPlan> {
  const { registry, agent, runtimesDir, to } = input;
  if (to === agent.runtime.provider) {
    throw new AgentCtlError(
      'VALIDATION_ERROR',
      `Agent ${agent.id} 当前已是 ${to} runtime，无需迁移。`,
    );
  }
  const toRuntimeHome = targetRuntimeHome(runtimesDir, agent.id, to);
  if (await fs.pathExists(toRuntimeHome)) {
    const children = await fs.readdir(toRuntimeHome);
    if (children.length > 0) {
      throw new AgentCtlError('CONFLICT', `目标 runtime_home 已存在且非空：${toRuntimeHome}。`, {
        remediation: `请先清理该目录，或确认上次迁移已完成后重试。`,
      });
    }
  }
  const services: RuntimeMigrationPlan['services'] = [];
  if (registry.bridge.enabled) services.push('bridge');
  services.push('settle', 'job');
  return {
    id: agent.id,
    from: agent.runtime.provider,
    to,
    fromRuntimeHome: registry.runtime_home.path,
    toRuntimeHome,
    services,
    projectedSkills: true,
  };
}

/**
 * 执行迁移（纯事务，不含服务启停）：
 * 1. 建 toRuntimeHome（0700）+ 目标 codex 预写 config.toml；
 * 2. 改 agent.yaml runtime.provider（保留 locked:true 与 model 原值）；
 * 3. **commit 点**：updateAgent 单次原子写（runtime_home.path + config_hash + credential_provider 清除 + updated_at）；
 * 4. skills 投影切换（best-effort）；
 * 5. --discard 删旧目录（best-effort）。
 * 失败回滚：agent.yaml 回写旧 provider + refreshConfigHash 旧 hash + 清理 toRuntimeHome。
 *
 * @param workspace 员工工作区路径（agent.yaml 所在目录）。
 */
export async function applyRuntimeMigration(input: {
  registry: RegistryAgent;
  agent: AgentConfig;
  workspace: string;
  runtimesDir: string;
  to: 'claude' | 'codex';
  updateAgent: (id: string, update: (current: RegistryAgent) => RegistryAgent) => Promise<void>;
  refreshConfigHash: (id: string, configHash: string) => Promise<void>;
  discardOld?: boolean;
}): Promise<RuntimeMigrationResult> {
  const {
    registry,
    agent,
    workspace,
    runtimesDir,
    to,
    updateAgent,
    refreshConfigHash,
    discardOld,
  } = input;
  const from = agent.runtime.provider;
  const plan = await buildRuntimeMigrationPlan({ registry, agent, runtimesDir, to });
  const agentYamlFile = path.join(workspace, 'agent.yaml');
  const oldYaml = await fs.readFile(agentYamlFile, 'utf8');
  const toRuntimeHome = plan.toRuntimeHome;
  const fromRuntimeHome = registry.runtime_home.path;
  const oldConfigHash = registry.config_hash ?? '';

  try {
    // 步 1：建目标目录（0700）。目标 codex 预写 config.toml；目标 claude 只建空目录（凭据不复制）。
    await fs.ensureDir(toRuntimeHome, { mode: 0o700 });
    if (to === 'codex') await writeCodexConfigToml(toRuntimeHome);

    // 步 2：改 agent.yaml（保留 locked:true 与 model 原值）。
    const parsed = YAML.parse(oldYaml) as {
      runtime: { provider: string; locked: true; model?: string };
    };
    parsed.runtime.provider = to;
    await fs.writeFile(agentYamlFile, YAML.stringify(parsed), { mode: 0o644 });

    // 步 3：commit 点——单次原子写，registry 与 agent.yaml 同一瞬间一致。
    const newRuntime: AgentConfig['runtime'] = {
      provider: to,
      locked: true,
      ...(parsed.runtime.model !== undefined ? { model: parsed.runtime.model } : {}),
    };
    const configHash = computeConfigHash(newRuntime);
    await updateAgent(agent.id, (current) => ({
      ...current,
      runtime_home: { path: toRuntimeHome },
      // exactOptionalPropertyTypes：清除绑定用显式 undefined（与 syncRuntime 既有写法一致）。
      ...(to === 'codex' ? { credential_provider: undefined } : {}),
      config_hash: configHash,
      updated_at: new Date().toISOString(),
    }));

    // 步 4：skills 投影切换（best-effort）。
    let projectedSkills = false;
    try {
      await switchSkillsProjection(workspace, from, to);
      projectedSkills = true;
    } catch (error) {
      console.warn(
        `[runtime-migrate] skills 投影切换失败（不影响迁移，可 doctor/adopt 修复）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // 步 5：--discard 删旧目录（best-effort）。
    let oldDiscarded = false;
    if (discardOld) {
      try {
        await fs.remove(fromRuntimeHome);
        oldDiscarded = true;
      } catch (error) {
        console.warn(
          `[runtime-migrate] 删除旧 runtime_home 失败（保留供人工清理）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      id: agent.id,
      from,
      to,
      toRuntimeHome,
      oldRuntimeHome: fromRuntimeHome,
      oldDiscarded,
      configHash,
      projectedSkills,
    };
  } catch (error) {
    // 回滚：恢复 agent.yaml + registry config_hash；清理 toRuntimeHome。恢复失败 → 指向 repair 逃生口。
    try {
      await fs.writeFile(agentYamlFile, oldYaml, { mode: 0o644 });
      if (oldConfigHash) await refreshConfigHash(agent.id, oldConfigHash);
      await fs.remove(toRuntimeHome);
    } catch (rollbackError) {
      throw new AgentCtlError(
        'OPERATION_FAILED',
        `迁移失败且回滚未完全成功：${error instanceof Error ? error.message : String(error)}`,
        {
          remediation: `请运行 agentctl repair ${agent.id} 以 agent.yaml 重建 Registry 缓存。`,
          cause: rollbackError,
        },
      );
    }
    throw error;
  }
}
