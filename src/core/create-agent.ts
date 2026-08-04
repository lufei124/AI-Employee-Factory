import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { z } from 'zod';
import { AgentCtlError } from './errors.js';
import { FileLock } from './locks.js';
import { assertInside, type FactoryPaths } from './paths.js';
import { type RegistryStore } from './registry.js';
import { loadPreset, renderAgentWorkspace } from './templates.js';
import { computeConfigHash } from './agents.js';
import {
  agentConfigSchema,
  agentIdSchema,
  runtimeProviderSchema,
  type AgentConfig,
} from '../schemas/agent-schema.js';
import type { Preset } from '../schemas/preset-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

export const createAgentInputSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  runtime: runtimeProviderSchema,
  preset: agentIdSchema.optional(),
  feishu: z.enum(['dedicated', 'disabled']),
  description: z.string().min(1).optional(),
  goals: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export class CreateAgentService {
  constructor(
    private readonly paths: FactoryPaths,
    private readonly registry: RegistryStore,
  ) {}

  async create(raw: CreateAgentInput): Promise<{ id: string; workspace: string }> {
    const input = createAgentInputSchema.parse(raw);
    const lock = new FileLock(path.join(this.paths.locksDir, `create-${input.id}.lock`));
    return lock.withLock({ purpose: `create:${input.id}` }, async () => this.createLocked(input));
  }

  private async createLocked(input: CreateAgentInput): Promise<{ id: string; workspace: string }> {
    const registry = await this.registry.read();
    if (registry.agents.some((agent) => agent.id === input.id)) {
      throw new AgentCtlError('CONFLICT', `Agent 已存在：${input.id}`);
    }
    const preset = await this.resolvePreset(input);
    const workspace = assertInside(
      this.paths.workspaceRoot,
      path.join(this.paths.workspaceRoot, input.id),
      '工作区',
    );
    const runtimeHome = assertInside(
      this.paths.runtimesDir,
      path.join(this.paths.runtimesDir, input.id, input.runtime),
      'Runtime Home',
    );
    const bridgeHome = assertInside(
      this.paths.bridgesDir,
      path.join(this.paths.bridgesDir, input.id),
      'Bridge Home',
    );
    const logsHome = assertInside(
      this.paths.logsDir,
      path.join(this.paths.logsDir, input.id),
      '日志目录',
    );
    for (const [label, target] of [
      ['工作区', workspace],
      ['Runtime Home', runtimeHome],
      ['Bridge Home', bridgeHome],
      ['日志目录', logsHome],
    ] as const) {
      if (await fs.pathExists(target))
        throw new AgentCtlError('CONFLICT', `${label}已存在：${target}`);
    }

    const id = randomUUID();
    const stages = {
      workspace: path.join(this.paths.workspaceRoot, `.staging-${input.id}-${id}`),
      runtime: path.join(this.paths.runtimesDir, `.staging-${input.id}-${id}`),
      bridge: path.join(this.paths.bridgesDir, `.staging-${input.id}-${id}`),
      logs: path.join(this.paths.logsDir, `.staging-${input.id}-${id}`),
    };
    const finals: string[] = [];
    try {
      await Promise.all(Object.values(stages).map((dir) => fs.ensureDir(dir)));
      const now = new Date().toISOString();
      const model = input.model ?? (input.runtime === 'claude' ? 'sonnet' : undefined);
      const config = this.buildAgentConfig(input, preset, now, model);
      await renderAgentWorkspace({ workspace: stages.workspace, config, preset });
      if (input.runtime === 'codex') {
        await fs.writeFile(
          path.join(stages.runtime, 'config.toml'),
          'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n',
        );
      }
      await execa('git', ['init', '--initial-branch=main'], {
        cwd: stages.workspace,
        shell: false,
      });
      await fs.ensureDir(path.dirname(workspace));
      for (const [stage, target] of [
        [stages.workspace, workspace],
        [stages.runtime, runtimeHome],
        [stages.bridge, bridgeHome],
        [stages.logs, logsHome],
      ] as const) {
        await fs.ensureDir(path.dirname(target));
        await fs.rename(stage, target);
        finals.push(target);
      }
      if (input.runtime === 'codex')
        await this.projectCodexSkills(workspace, runtimeHome, preset.skills);
      await this.registry.add(
        this.buildRegistryAgent(input, workspace, runtimeHome, bridgeHome, now, model),
      );
      return { id: input.id, workspace };
    } catch (error) {
      await Promise.all(
        [...Object.values(stages), ...finals].map((target) =>
          fs.remove(target).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  private async resolvePreset(input: CreateAgentInput): Promise<Preset> {
    if (input.preset) return loadPreset(input.preset);
    if (!input.description || !input.goals?.length) {
      throw new AgentCtlError(
        'VALIDATION_ERROR',
        '无 Preset 创建时必须提供 description 和至少一个 goal。',
      );
    }
    return {
      schema_version: 1,
      id: input.id,
      name: input.name,
      description: input.description,
      goals: input.goals,
      responsibilities: [input.description],
      policies: ['生产写入、对外发布、Git push 和删除数据必须经人工审批'],
      escalation_conditions: ['需要生产权限或管理决策'],
      skills: [],
    };
  }

  private buildAgentConfig(
    input: CreateAgentInput,
    preset: Preset,
    now: string,
    model: string | undefined,
  ): AgentConfig {
    const runtime = model
      ? { provider: input.runtime, locked: true as const, model }
      : { provider: input.runtime, locked: true as const };
    return agentConfigSchema.parse({
      schema_version: 1,
      id: input.id,
      name: input.name,
      description: preset.description,
      runtime,
      identity: {
        role_file: 'agent/ROLE.md',
        goals_file: 'agent/GOALS.md',
        operating_system_file: 'agent/OPERATING_SYSTEM.md',
        policies_file: 'agent/POLICIES.md',
        current_state_file: 'agent/CURRENT_STATE.md',
      },
      memory: {
        isolation: 'strict',
        native_memory: true,
        portable_memory: true,
        authority_order: ['agent', 'knowledge', 'decisions', 'skills', 'native_memory', 'session'],
        // OP1 Stage A：新建员工默认启用运行时强制（prepareRuntime 校验 authority_order 不变量）。
        enforced: true,
      },
      feishu:
        input.feishu === 'dedicated'
          ? { enabled: true, mode: 'dedicated_bot', bridge_profile: input.id }
          : { enabled: false, mode: 'disabled' },
      permissions: {
        level: 'workspace',
        production_write: 'approval_required',
        external_publish: 'approval_required',
      },
      lifecycle: { status: 'active', created_at: now, archived_at: null },
    });
  }

  private buildRegistryAgent(
    input: CreateAgentInput,
    workspace: string,
    runtimeHome: string,
    bridgeHome: string,
    now: string,
    model: string | undefined,
  ): RegistryAgent {
    const runtime = model
      ? { provider: input.runtime, locked: true as const, model }
      : { provider: input.runtime, locked: true as const };
    const bridge =
      input.feishu === 'dedicated'
        ? {
            enabled: true,
            profile: input.id,
            home: bridgeHome,
            mode: 'dedicated_bot' as const,
            authorization: 'pending' as const,
          }
        : {
            enabled: false,
            home: bridgeHome,
            mode: 'disabled' as const,
            authorization: 'pending' as const,
          };
    return {
      id: input.id,
      name: input.name,
      status: 'stopped',
      archived: false,
      workspace: { path: workspace, git_repository: true },
      runtime_home: { path: runtimeHome },
      bridge,
      permissions: { level: 'workspace', production_write: 'approval_required' },
      created_at: now,
      updated_at: now,
      // OP3-A 长期：Registry 不再持有 runtime 块，仅存 config_hash（agent.yaml runtime 块指纹）。
      config_hash: computeConfigHash(runtime),
    };
  }

  private async projectCodexSkills(
    workspace: string,
    _runtimeHome: string,
    skills: string[],
  ): Promise<void> {
    // 项目级：preset 声明的 Skill 随项目模板，投影到 workspace/.codex/skills（项目发现目录）。
    const projection = path.join(workspace, '.codex', 'skills');
    await fs.ensureDir(projection);
    for (const skill of skills)
      await fs.symlink(path.join(workspace, 'skills', skill), path.join(projection, skill));
  }
}
