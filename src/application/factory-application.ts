import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import YAML from 'yaml';
import {
  computeConfigHash,
  getRegisteredAgent,
  loadPortableConfig,
  readAgentConfigFile,
} from '../core/agents.js';
import { validateMemoryConfig } from '../core/authority.js';
import { atomicWriteFile } from '../core/atomic.js';
import { BackupService } from '../core/backup.js';
import { BridgeAdapter } from '../core/bridge.js';
import { FileLock } from '../core/locks.js';
import { initializeFactory, readConfig } from '../core/config.js';
import { CreateAgentService, type CreateAgentInput } from '../core/create-agent.js';
import { DoctorService } from '../core/doctor.js';
import { AgentCtlError } from '../core/errors.js';
import { JobRunner } from '../core/job-runner.js';
import { assertInside, assertInsideReal, type FactoryPaths } from '../core/paths.js';
import type { RegistryStore } from '../core/registry.js';
import { JobStore } from '../core/scheduler.js';
import { SkillService, type SkillScope } from '../core/skills.js';
import { SkillStoreService } from '../core/skill-store.js';
import { OperationStore, type OperationSummary } from '../core/operation-store.js';
import { PruneService, type PruneOptions, type PruneResult } from '../core/prune.js';
import { TrashService, type TrashEntryDto, type TrashPreview } from '../core/trash.js';
import { ProcessRunner, type LoggedRunOptions } from '../core/process-runner.js';
import {
  buildRuntimeEnvironment,
  buildSafeBaseEnvironment,
  getRuntimeAdapter,
  syncCcSwitchClaudeProvider,
} from '../core/runtime.js';
import type { AgentConfig, RuntimeProvider } from '../schemas/agent-schema.js';
import type { JobConfig } from '../schemas/job-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import { bridgeLaunchdService, jobLaunchdService } from '../services/factory-services.js';

export const agentDocumentKeys = [
  'role',
  'goals',
  'operating-system',
  'policies',
  'current-state',
] as const;

export type AgentDocumentKey = (typeof agentDocumentKeys)[number];

export interface AgentSummary {
  id: string;
  name: string;
  status: RegistryAgent['status'];
  archived: boolean;
  // OP3-A 长期：provider 从 agent.yaml 实时读取（N+1）；缺失/无效 yaml 容错为 'unknown'。
  runtime: RuntimeProvider | 'unknown';
  bridgeEnabled: boolean;
  bridgeAuthorization: RegistryAgent['bridge']['authorization'];
  updatedAt: string;
}

export interface AgentDocument {
  key: AgentDocumentKey;
  path: string;
  content: string;
  dirty: boolean;
}

export interface BackupSummary {
  name: string;
  size: number;
  modifiedAt: string;
  encrypted: boolean;
}

const documentFields: Record<AgentDocumentKey, keyof AgentConfig['identity']> = {
  role: 'role_file',
  goals: 'goals_file',
  'operating-system': 'operating_system_file',
  policies: 'policies_file',
  'current-state': 'current_state_file',
};

function validateDocumentKey(value: string): AgentDocumentKey {
  if (!agentDocumentKeys.includes(value as AgentDocumentKey)) {
    throw new AgentCtlError('VALIDATION_ERROR', `不支持的文档类型：${value}`);
  }
  return value as AgentDocumentKey;
}

export class FactoryApplication {
  constructor(
    readonly paths: FactoryPaths,
    readonly registry: RegistryStore,
  ) {}

  async factoryStatus(): Promise<{ initialized: boolean }> {
    return {
      initialized:
        (await fs.pathExists(this.paths.configFile)) &&
        (await fs.pathExists(this.paths.registryFile)),
    };
  }

  async initialize(): Promise<void> {
    await initializeFactory(this.paths);
  }

  async createAgent(input: CreateAgentInput): Promise<{ id: string; workspace: string }> {
    await this.initialize();
    return new CreateAgentService(this.paths, this.registry).create(input);
  }

  async listAgents(): Promise<AgentSummary[]> {
    const data = await this.registry.read();
    // OP3-A 长期：Registry 不再持有 provider，逐个读 agent.yaml 取实时 provider（N+1）。
    return Promise.all(
      data.agents.map(async (agent) => this.toSummary(agent, await this.readProvider(agent))),
    );
  }

  async dashboard(): Promise<{
    total: number;
    running: number;
    pendingAuthorization: number;
    archived: number;
    agents: AgentSummary[];
  }> {
    const agents = await this.listAgents();
    return {
      total: agents.length,
      running: agents.filter((agent) => agent.status === 'running').length,
      pendingAuthorization: agents.filter(
        (agent) => agent.bridgeEnabled && agent.bridgeAuthorization !== 'ready',
      ).length,
      archived: agents.filter((agent) => agent.archived).length,
      agents,
    };
  }

  async getAgent(id: string): Promise<{ registry: RegistryAgent; agent: AgentConfig }> {
    const registry = await getRegisteredAgent(this.registry, id);
    return { registry, agent: await loadPortableConfig(registry) };
  }

  async readDocument(id: string, rawKey: AgentDocumentKey | string): Promise<AgentDocument> {
    const key = validateDocumentKey(rawKey);
    const { registry, agent } = await this.getAgent(id);
    const file = await this.documentFile(registry, agent, key);
    return {
      key,
      path: path.relative(registry.workspace.path, file),
      content: await fs.readFile(file, 'utf8'),
      dirty: await this.isDirty(registry.workspace.path, file),
    };
  }

  async saveDocument(
    id: string,
    rawKey: AgentDocumentKey | string,
    content: string,
  ): Promise<AgentDocument> {
    const key = validateDocumentKey(rawKey);
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
      throw new AgentCtlError('VALIDATION_ERROR', '文档不得超过 1 MiB。');
    }
    const { registry, agent } = await this.getAgent(id);
    const file = await this.documentFile(registry, agent, key);
    await atomicWriteFile(file, content, 0o644);
    return this.readDocument(id, key);
  }

  async listJobs(id: string): Promise<JobConfig[]> {
    const { registry } = await this.getAgent(id);
    return new JobStore(registry.workspace.path).list();
  }

  async createJob(id: string, input: JobConfig): Promise<JobConfig> {
    const { registry } = await this.getAgent(id);
    return new JobStore(registry.workspace.path).create(input);
  }

  async installJob(id: string, source: string): Promise<JobConfig> {
    const { registry } = await this.getAgent(id);
    return new JobStore(registry.workspace.path).install(source);
  }

  async updateJob(id: string, jobId: string, input: JobConfig): Promise<JobConfig> {
    const { registry } = await this.getAgent(id);
    return new JobStore(registry.workspace.path).update(jobId, input);
  }

  async listSkills(id: string) {
    const { registry, agent } = await this.getAgent(id);
    return new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).list();
  }

  async createBackup(
    id: string,
    options: { output?: string; includeRuntime?: boolean; passphrase?: string } = {},
  ): Promise<string> {
    return new BackupService(this.paths, this.registry).backup(id, options);
  }

  async listBackups(): Promise<BackupSummary[]> {
    if (!(await fs.pathExists(this.paths.backupsDir))) return [];
    const backups: BackupSummary[] = [];
    for (const entry of await fs.readdir(this.paths.backupsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/(?:\.tar\.gz|\.aief\.enc|\.enc)$/i.test(entry.name)) continue;
      const stat = await fs.stat(path.join(this.paths.backupsDir, entry.name));
      backups.push({
        name: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        encrypted: /\.enc$/i.test(entry.name),
      });
    }
    return backups.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async readLatestLog(id: string, lines = 200): Promise<{ file: string; content: string }> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 5000) {
      throw new AgentCtlError('VALIDATION_ERROR', '日志行数必须是 1 到 5000 的整数。');
    }
    const { root, file } = await this.latestLogFile(id);
    const text = await fs.readFile(file, 'utf8');
    const parts = text.split('\n');
    const endedWithNewline = parts.at(-1) === '';
    if (endedWithNewline) parts.pop();
    return {
      file: path.relative(root, file),
      content: `${parts.slice(-lines).join('\n')}${endedWithNewline ? '\n' : ''}`,
    };
  }

  async terminalGuidance(id: string): Promise<{
    runtimeLogin: string;
    bridgeAuthorize: string;
    chat: string;
  }> {
    const { agent } = await this.getAgent(id);
    return {
      runtimeLogin:
        agent.runtime.provider === 'claude'
          ? `agentctl runtime sync ${id}`
          : `agentctl runtime login ${id}`,
      bridgeAuthorize: `agentctl bridge authorize ${id}`,
      chat: `agentctl chat ${id}`,
    };
  }

  async doctor(id?: string) {
    return new DoctorService(this.paths, this.registry).run(id);
  }

  async runAgent(id: string, task: string, timeoutSeconds = 900, options: LoggedRunOptions = {}) {
    if (!task.trim()) throw new AgentCtlError('VALIDATION_ERROR', '任务内容不能为空。');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
      throw new AgentCtlError('VALIDATION_ERROR', 'timeout 必须是 1 到 86400 秒。');
    }
    const { registry, agent } = await this.getAgent(id);
    await this.prepareRuntime(registry, agent);
    return new ProcessRunner(this.paths.logsDir).runLogged(
      id,
      getRuntimeAdapter(agent.runtime).run(registry, agent.runtime, task, timeoutSeconds * 1000),
      options,
    );
  }

  async chat(id: string): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    await this.prepareRuntime(registry, agent);
    return new ProcessRunner(this.paths.logsDir).runInteractive(
      getRuntimeAdapter(agent.runtime).chat(registry, agent.runtime),
    );
  }

  async runtimeAuth(id: string, operation: 'login' | 'status'): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    if (agent.runtime.provider === 'claude') {
      await this.prepareRuntime(registry, agent);
      return 0;
    }
    const adapter = getRuntimeAdapter(agent.runtime);
    return new ProcessRunner(this.paths.logsDir).runInteractive(
      operation === 'login' ? adapter.login(registry) : adapter.authStatus(registry),
    );
  }

  async syncRuntime(id: string) {
    const { registry, agent } = await this.getAgent(id);
    if (agent.runtime.provider !== 'claude') {
      throw new AgentCtlError('VALIDATION_ERROR', `Agent ${id} 使用 Codex，无需同步 CC Switch。`, {
        remediation: `请运行 agentctl runtime login ${id}。`,
      });
    }
    return this.prepareRuntime(registry, agent);
  }

  async bridgeAuthorize(
    id: string,
    options: { appId?: string; tenant: 'feishu' | 'lark' },
  ): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    const adapter = new BridgeAdapter();
    const capabilities = await adapter.inspectCapabilities({
      ...buildRuntimeEnvironment(registry, agent.runtime),
      LARK_CHANNEL_HOME: registry.bridge.home,
    });
    if (!capabilities.compatible) {
      throw new AgentCtlError(
        'DEPENDENCY_MISSING',
        `Bridge 版本不兼容，缺少：${capabilities.missing.join(', ')}`,
      );
    }
    const code = await new ProcessRunner(this.paths.logsDir).runInteractive(
      adapter.authorize(registry, agent.runtime, options),
    );
    if (code === 0) {
      await this.secureBridgeProfile(registry, agent.runtime);
      await this.markBridgeReady(id);
    }
    return code;
  }

  async bridgeStatus(id: string): Promise<{ exitCode: number; output: string }> {
    const { registry, agent } = await this.getAgent(id);
    const context = new BridgeAdapter().status(registry, agent.runtime);
    const result = await execa(context.command, context.args, {
      cwd: context.cwd,
      env: context.env,
      extendEnv: false,
      shell: false,
      reject: false,
    });
    if (result.exitCode === 0) {
      await this.secureBridgeProfile(registry, agent.runtime);
      await this.markBridgeReady(id);
    }
    return { exitCode: result.exitCode ?? 1, output: result.stdout };
  }

  async followLatestLog(id: string, lines: number): Promise<number> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 5000) {
      throw new AgentCtlError('VALIDATION_ERROR', '日志行数必须是 1 到 5000 的整数。');
    }
    const { file } = await this.latestLogFile(id);
    const result = await execa('tail', ['-n', String(lines), '-f', file], {
      shell: false,
      stdio: 'inherit',
      reject: false,
    });
    return result.exitCode ?? 1;
  }

  async dependencyVersions(): Promise<Record<'Git' | 'Claude' | 'Codex' | 'Bridge', string>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-init-check-'));
    try {
      const env = {
        ...buildSafeBaseEnvironment(),
        HOME: root,
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CODEX_HOME: path.join(root, 'codex'),
        LARK_CHANNEL_HOME: path.join(root, 'bridge'),
      };
      return {
        Git: await this.detectDependency('git', env),
        Claude: await this.detectDependency('claude', env),
        Codex: await this.detectDependency('codex', env),
        Bridge: await this.detectDependency('lark-channel-bridge', env),
      };
    } finally {
      await fs.remove(root);
    }
  }

  async runBridgeService(id: string): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    await this.prepareRuntime(registry, agent);
    const adapter = new BridgeAdapter();
    await this.secureBridgeProfile(registry, agent.runtime);
    return new ProcessRunner(this.paths.logsDir).runInteractive(
      adapter.run(registry, agent.runtime),
    );
  }

  async runJobService(id: string, jobId: string): Promise<number> {
    return (await this.runJob(id, jobId)).exitCode;
  }

  async lifecycleAction(id: string, action: 'start' | 'stop' | 'restart' | 'status') {
    const { registry, agent } = await this.getAgent(id);
    if (registry.archived) throw new AgentCtlError('CONFLICT', `Agent ${id} 已归档。`);
    if (!registry.bridge.enabled)
      throw new AgentCtlError('VALIDATION_ERROR', `Agent ${id} 未启用 Bridge。`);
    if (action === 'start' && registry.bridge.authorization !== 'ready') {
      throw new AgentCtlError('AUTH_REQUIRED', `Agent ${id} 的飞书 Bridge 尚未授权。`, {
        remediation: `请先运行 agentctl bridge authorize ${id}。`,
      });
    }
    if (action === 'start' || action === 'restart') {
      await this.prepareRuntime(registry, agent);
      await this.secureBridgeProfile(registry, agent.runtime);
    }
    const service = bridgeLaunchdService(registry, agent.runtime, this.paths);
    if (action === 'status') {
      const status = await service.status();
      const state = status.state === 'running' ? 'running' : 'stopped';
      await this.registry.updateAgent(id, (current) => ({
        ...current,
        status: state,
        updated_at: new Date().toISOString(),
      }));
      return { state, detail: status.detail };
    }
    await service[action]();
    const state = action === 'stop' ? 'stopped' : 'running';
    await this.registry.updateAgent(id, (current) => ({
      ...current,
      status: state,
      updated_at: new Date().toISOString(),
    }));
    return { state };
  }

  async archiveAgent(id: string): Promise<void> {
    const { registry, agent } = await this.getAgent(id);
    await bridgeLaunchdService(registry, agent.runtime, this.paths)
      .uninstall()
      .catch(() => undefined);
    const now = new Date().toISOString();
    await atomicWriteFile(
      path.join(registry.workspace.path, 'agent.yaml'),
      YAML.stringify({
        ...agent,
        lifecycle: {
          status: 'archived',
          created_at: agent.lifecycle.created_at,
          archived_at: now,
        },
      }),
      0o644,
    );
    await this.registry.updateAgent(id, (current) => ({
      ...current,
      archived: true,
      status: 'archived',
      updated_at: now,
    }));
  }

  async trashAgent(id: string, options: { dryRun: true }): Promise<TrashPreview>;
  async trashAgent(id: string, options?: { dryRun?: false }): Promise<TrashEntryDto>;
  async trashAgent(id: string, options: { dryRun?: boolean } = {}) {
    const { registry, agent } = await this.getAgent(id);
    const trash = new TrashService(this.paths, this.registry);
    if (options.dryRun) return trash.preview(registry);
    const jobs = await new JobStore(registry.workspace.path).list();
    for (const job of jobs) {
      await jobLaunchdService(
        registry,
        agent.runtime,
        job,
        this.paths,
        process.argv[1] ?? 'agentctl',
        this.paths.userHome,
      ).uninstall();
    }
    if (registry.bridge.enabled) {
      await bridgeLaunchdService(
        registry,
        agent.runtime,
        this.paths,
        process.argv[1] ?? 'agentctl',
        this.paths.userHome,
      ).uninstall();
    }
    return trash.move(registry);
  }

  async listTrash() {
    return new TrashService(this.paths, this.registry).list();
  }

  async restoreTrash(trashId: string, options: { dryRun?: boolean } = {}) {
    const trash = new TrashService(this.paths, this.registry);
    if (options.dryRun) {
      const entry = (await trash.list()).find((item) => item.trashId === trashId);
      if (!entry) throw new AgentCtlError('NOT_FOUND', `回收站条目不存在：${trashId}`);
      return entry;
    }
    await trash.restore(trashId);
    return { restored: true, trashId };
  }

  async purgeExpiredTrash(options: { dryRun?: boolean } = {}) {
    const trash = new TrashService(this.paths, this.registry);
    if (options.dryRun) {
      const expired = (await trash.list()).filter(
        (entry) => entry.state === 'ready' && new Date(entry.expiresAt).getTime() <= Date.now(),
      );
      return { purged: [], wouldPurge: expired.map((entry) => entry.trashId) };
    }
    return { ...(await trash.purgeExpired()), wouldPurge: [] as string[] };
  }

  async purgeTrash(
    trashId: string,
    options: { force?: boolean; dryRun?: boolean } = {},
  ): Promise<{ purged: boolean; wouldPurge?: boolean }> {
    return new TrashService(this.paths, this.registry).purgeOne(trashId, options);
  }

  // OP4-A：事后审计 operations.jsonl。
  async queryOperations(
    filter: {
      agentId?: string;
      kind?: string;
      since?: string;
      until?: string;
      limit?: number;
    } = {},
  ): Promise<OperationSummary[]> {
    return new OperationStore(this.paths.logsDir).query(filter);
  }

  // OP4-D：按分类清理 run 日志/registry 备份/员工备份归档/operations 审计日志。
  async prune(options: PruneOptions): Promise<PruneResult> {
    return new PruneService(this.paths).run(options);
  }

  async setJobEnabled(id: string, jobId: string, enabled: boolean): Promise<JobConfig> {
    const { registry, agent } = await this.getAgent(id);
    const store = new JobStore(registry.workspace.path);
    const job = await store.setEnabled(jobId, enabled);
    const service = jobLaunchdService(registry, agent.runtime, job, this.paths);
    if (enabled) await service.enableScheduled();
    else await service.uninstall();
    return job;
  }

  async runJob(id: string, jobId: string, options: LoggedRunOptions = {}) {
    const { registry, agent } = await this.getAgent(id);
    const job = await new JobStore(registry.workspace.path).get(jobId);
    if (job.execution.type === 'agent') await this.prepareRuntime(registry, agent);
    return new JobRunner(this.paths).run(registry, agent.runtime, job, options);
  }

  // OP1 Stage A：运行前强制校验 memory/authority_order 不变量（W1 收敛）。
  // enforced:true 时硬失败（VALIDATION_ERROR），不让误配 agent 跑起来；undefined(旧)/false 不硬失败，doctor warn。
  private assertMemoryEnforced(agent: AgentConfig): void {
    if (agent.memory.enforced !== true) return;
    const { ok, issues } = validateMemoryConfig(agent.memory);
    if (!ok) {
      throw new AgentCtlError('VALIDATION_ERROR', `Agent memory 配置无效：${issues.join('；')}`, {
        remediation:
          '修正 agent.yaml 的 memory.authority_order 后重试，或设 memory.enforced: false 暂时降级（doctor 将告警）。',
      });
    }
  }

  private async prepareRuntime(registry: RegistryAgent, agent: AgentConfig) {
    this.assertMemoryEnforced(agent);
    if (agent.runtime.provider !== 'claude') return undefined;
    const config = await readConfig(this.paths);
    const summary = await syncCcSwitchClaudeProvider(
      registry,
      agent.runtime,
      this.paths.userHome,
      this.paths.runtimesDir,
      config.sync.sanitize_non_whitelist,
    );
    if (summary.routedFieldsChanged.length > 0) {
      console.warn(
        `⚠️  员工 ${registry.id} 的 CC Switch 流量路由字段已变更：${summary.routedFieldsChanged.join(', ')}。请核对 CC Switch Provider 配置。`,
      );
    }
    return summary;
  }

  async archiveJob(id: string, jobId: string): Promise<void> {
    const { registry, agent } = await this.getAgent(id);
    const store = new JobStore(registry.workspace.path);
    const job = await store.get(jobId);
    await jobLaunchdService(registry, agent.runtime, job, this.paths)
      .uninstall()
      .catch(() => undefined);
    await store.uninstall(jobId);
  }

  async installSkill(id: string, source: string, scope: SkillScope = 'project') {
    const { registry, agent } = await this.getAgent(id);
    return new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).install(source, scope);
  }

  async removeSkill(id: string, name: string, scope: SkillScope = 'project'): Promise<void> {
    const { registry, agent } = await this.getAgent(id);
    await new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).remove(name, scope);
  }

  // ---- Skill 商店（GitHub 仓库源）----
  async listSkillStoreRepositories() {
    return new SkillStoreService(this.paths).listRepositories();
  }

  async addSkillStoreRepository(input: { name: string; url: string; description?: string }) {
    return new SkillStoreService(this.paths).addRepository(input);
  }

  async removeSkillStoreRepository(name: string): Promise<void> {
    return new SkillStoreService(this.paths).removeRepository(name);
  }

  async refreshSkillStoreRepository(name: string) {
    return new SkillStoreService(this.paths).refresh(name);
  }

  async listSkillStoreSkills(repoName: string) {
    return new SkillStoreService(this.paths).listSkills(repoName);
  }

  async installSkillFromStore(
    repoName: string,
    skillPath: string,
    agentId: string,
    scope: SkillScope = 'project',
  ) {
    const { registry, agent } = await this.getAgent(agentId);
    const source = await new SkillStoreService(this.paths).resolveSkillSource(repoName, skillPath);
    return new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).install(source, scope);
  }

  // OP3-A 长期：SOFT 迁移--Registry 仍为 v1（含 runtime 块）时重写磁盘为 v2，v2 无操作。
  async migrate(options: { dryRun?: boolean } = {}): Promise<{ migrated: boolean }> {
    return this.registry.migrate(options);
  }

  async restoreBackup(
    name: string,
    options: { newId?: string; newName?: string; passphrase?: string; dryRun?: boolean },
  ) {
    if (path.basename(name) !== name) {
      throw new AgentCtlError('VALIDATION_ERROR', '备份名称不能包含路径。');
    }
    const backup = assertInside(
      this.paths.backupsDir,
      path.join(this.paths.backupsDir, name),
      '备份',
    );
    return new BackupService(this.paths, this.registry).restore(backup, options);
  }

  async restoreBackupPath(
    backupPath: string,
    options: { newId?: string; newName?: string; passphrase?: string; dryRun?: boolean },
  ) {
    // R22：CLI 备份路径必须位于受管 backupsDir 内，并抵抗软链接逃逸（Web 已不暴露此入口）。
    await assertInsideReal(
      this.paths.backupsDir,
      path.resolve(this.paths.backupsDir, backupPath),
      '备份',
    );
    return new BackupService(this.paths, this.registry).restore(backupPath, options);
  }

  // OP3-A 长期：以 agent.yaml 为唯一真相，重建 Registry 的 config_hash 派生缓存。
  // HARD 逃生口：不用 getAgent（其 loadPortableConfig 在 config_hash 漂移时抛 CONFLICT），
  // 原样读 agent.yaml 并刷新 config_hash，使漂移 agent 恢复可用。
  async repairAgent(id: string): Promise<{ id: string; config_hash: string }> {
    const registry = await getRegisteredAgent(this.registry, id);
    const file = path.join(registry.workspace.path, 'agent.yaml');
    if (!(await fs.pathExists(file)))
      throw new AgentCtlError('NOT_FOUND', `Agent 配置不存在：${file}`);
    const config = await readAgentConfigFile(file);
    const hash = computeConfigHash(config.runtime);
    await this.registry.refreshConfigHash(id, hash);
    return { id, config_hash: hash };
  }

  private toSummary(agent: RegistryAgent, runtime: RuntimeProvider | 'unknown'): AgentSummary {
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      archived: agent.archived,
      runtime,
      bridgeEnabled: agent.bridge.enabled,
      bridgeAuthorization: agent.bridge.authorization,
      updatedAt: agent.updated_at,
    };
  }

  // OP3-A 长期：原样读 agent.yaml 取 provider（不做 config_hash 校验，list 容错不因漂移失败）。
  private async readProvider(agent: RegistryAgent): Promise<RuntimeProvider | 'unknown'> {
    try {
      const config = await readAgentConfigFile(path.join(agent.workspace.path, 'agent.yaml'));
      return config.runtime.provider;
    } catch {
      return 'unknown';
    }
  }

  private async documentFile(
    registry: RegistryAgent,
    config: AgentConfig,
    key: AgentDocumentKey,
  ): Promise<string> {
    const file = assertInside(
      registry.workspace.path,
      path.resolve(registry.workspace.path, config.identity[documentFields[key]]),
      '身份文档',
    );
    if (!(await fs.pathExists(file))) {
      throw new AgentCtlError('NOT_FOUND', `身份文档不存在：${file}`);
    }
    const [workspaceReal, fileReal, stat] = await Promise.all([
      fs.realpath(registry.workspace.path),
      fs.realpath(file),
      fs.lstat(file),
    ]);
    assertInside(workspaceReal, fileReal, '身份文档');
    if (stat.isSymbolicLink()) {
      throw new AgentCtlError('VALIDATION_ERROR', '身份文档不能是软链接。');
    }
    return file;
  }

  private async isDirty(workspace: string, file: string): Promise<boolean> {
    const result = await execa('git', ['status', '--short', '--', path.relative(workspace, file)], {
      cwd: workspace,
      shell: false,
      reject: false,
    });
    return result.stdout.trim().length > 0;
  }

  private async latestLogFile(id: string): Promise<{ root: string; file: string }> {
    await this.getAgent(id);
    const root = path.join(this.paths.logsDir, id);
    if (!(await fs.pathExists(root))) throw new AgentCtlError('NOT_FOUND', '暂无日志。');
    const rootReal = await fs.realpath(root);
    const candidates: Array<{ file: string; mtime: number }> = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (/\.(?:log|json)$/i.test(entry.name)) {
          const real = await fs.realpath(file);
          assertInside(rootReal, real, '日志文件');
          candidates.push({ file, mtime: (await fs.stat(file)).mtimeMs });
        }
      }
    };
    await visit(root);
    const latest = candidates.sort((left, right) => right.mtime - left.mtime)[0];
    if (!latest) throw new AgentCtlError('NOT_FOUND', '暂无日志。');
    return { root, file: latest.file };
  }

  private async secureBridgeProfile(
    registry: RegistryAgent,
    runtime: AgentConfig['runtime'],
  ): Promise<void> {
    // R16：secureProfile 读-改-写 config.json 全程持 per-bridge 锁，防并发硬化丢失。
    const lock = new FileLock(path.join(this.paths.locksDir, `bridge-${registry.id}.lock`));
    await lock.withLock({ purpose: `bridge:secure:${registry.id}` }, () =>
      new BridgeAdapter().secureProfile(registry, runtime),
    );
  }

  private async markBridgeReady(id: string): Promise<void> {
    await this.registry.updateAgent(id, (current) => ({
      ...current,
      bridge: { ...current.bridge, authorization: 'ready' },
      updated_at: new Date().toISOString(),
    }));
  }

  private async detectDependency(command: string, env: Record<string, string>): Promise<string> {
    try {
      const result = await execa(command, ['--version'], {
        shell: false,
        reject: false,
        env,
        extendEnv: false,
      });
      return result.exitCode === 0
        ? ((result.stdout || result.stderr).trim().split('\n')[0] ?? '已安装')
        : '不可用';
    } catch {
      return '未安装';
    }
  }
}
