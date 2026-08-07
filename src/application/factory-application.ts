import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { installClaudeShim, resolveRealClaude } from '../core/claude-shim.js';
import { KnowledgeIndexImpl } from '../core/knowledge-index.js';
import type {
  KnowledgeConsistency,
  KnowledgeIndexResult,
  KnowledgeRecallResult,
} from '../core/knowledge.js';
import {
  archiveStaleKnowledge,
  listKnowledgeArchive,
  purgeKnowledgeArchive,
  restoreKnowledge,
} from '../core/knowledge-retention.js';
import { RETRIEVED_BRIEF_FILE, renderRetrievalBrief } from '../core/retrieval-brief.js';
import { FileLock } from '../core/locks.js';
import {
  applyRuntimeMigration,
  buildRuntimeMigrationPlan,
  type RuntimeMigrationPlan,
  type RuntimeMigrationResult,
} from '../core/runtime-migrate.js';
import { initializeFactory, readConfig } from '../core/config.js';
import { CreateAgentService, type CreateAgentInput } from '../core/create-agent.js';
import { generateEmployeeProfile, generateEmployeeSkeleton } from '../core/employee-generator.js';
import { renderRawExperience, rawExperienceRelPath } from '../core/experience.js';
import { validateIdentityGuard } from '../core/identity-guard.js';
import { ensureIdentityBaseline, IDENTITY_DOCS } from '../core/identity-baseline.js';
import {
  maybeEnforceIdentityProtocol,
  parseProposalFrontmatter,
  recordDecision,
  recordProposal,
  truncateLedger,
} from '../core/proposal-ledger.js';
import {
  appendReflectionSignal,
  estimateImportance,
  readReflectionSignals,
  reflectionSignalsPath,
  shouldReflect,
  truncateReflectionSignals,
} from '../core/reflection.js';
import {
  refineExperience,
  readLastRefinedAt,
  renderRefineBrief,
  renderRefinedExperience,
  refinedExperienceRelPath,
} from '../core/experience-refiner.js';
import { DoctorService } from '../core/doctor.js';
import { AgentCtlError } from '../core/errors.js';
import { JobRunner } from '../core/job-runner.js';
import { assertInside, assertInsideReal, type FactoryPaths } from '../core/paths.js';
import type { RegistryStore } from '../core/registry.js';
import { JobStore } from '../core/scheduler.js';
import { reconcileEmployeeJobs } from '../core/job-reconcile.js';
import {
  SkillService,
  digestSkillDirectory,
  type SkillMetadata,
  type SkillScope,
} from '../core/skills.js';
import { SkillStoreService } from '../core/skill-store.js';
import { generateSkill, renderSkillFile } from '../core/skill-generator.js';
import { ensureFactorySkill, ensureRuntimePrompt } from '../core/templates.js';
import {
  appendSkillSignal,
  detectRepeatedSkillOpportunity,
  pickCandidateTopic,
  readSkillSignals,
} from '../core/skill-opportunity.js';
import { OperationStore, type OperationSummary } from '../core/operation-store.js';
import { OperationManager } from '../core/operation-manager.js';
import { UsageDb, type UsageFilter, type UsageSummaryRow } from '../core/usage-log.js';
import { PruneService, type PruneOptions, type PruneResult } from '../core/prune.js';
import { TrashService, type TrashEntryDto, type TrashPreview } from '../core/trash.js';
import { ProcessRunner, type LoggedRunOptions } from '../core/process-runner.js';
import {
  gitCommitFile,
  gitLog,
  gitShowCommitFiles,
  gitShowFile,
  gitStatusShort,
  type GitCommitFile,
} from '../core/git.js';
import {
  updateCurrentState,
  ensureAgentDocsAllowed,
  ensureStateEditAllowed,
  type StateRow,
} from '../core/current-state.js';
import type { TranscriptSummary } from '../core/transcript.js';
import {
  buildRuntimeEnvironment,
  buildSafeBaseEnvironment,
  createSyncCache,
  getRuntimeAdapter,
  syncCcSwitchClaudeProvider,
  type SyncCache,
} from '../core/runtime.js';
import type { AgentConfig, AgentRole, RuntimeProvider } from '../schemas/agent-schema.js';
import { resolveMemoryFlags } from '../schemas/agent-schema.js';
import type { ExecutionContext } from '../runtimes/runtime-adapter.js';
import type { JobConfig } from '../schemas/job-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import {
  bridgeLaunchdService,
  jobLaunchdService,
  settleLaunchdService,
} from '../services/factory-services.js';

export const agentDocumentKeys = [
  'role',
  'goals',
  'operating-system',
  'policies',
  'current-state',
] as const;

export type AgentDocumentKey = (typeof agentDocumentKeys)[number];

// D-035：飞书主入口周期 settle 默认间隔（秒，5 分钟）。随 bridge 服务启停安装/卸载。
export const FEISHU_SETTLE_INTERVAL_SECONDS = 300;

export interface AgentSummary {
  id: string;
  name: string;
  // T08：角色（worker / chief）。来自 Registry（role 在 agent.yaml 与 registry 双写，列表读 registry 免 N+1）。
  role: AgentRole;
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
  // OP5-B：CC Switch 同步的 mtime 缓存（源 settings.json 未变则跳过重写，降低 spawn 延迟与无谓 I/O）。
  private readonly ccSwitchSyncCache: SyncCache = createSyncCache();

  private injectedOperationManager: OperationManager | undefined;

  // D-036：飞书使用日志（本地 SQLite）。天然无状态，懒加载单例。
  private injectedUsageDb: UsageDb | undefined;
  private getUsageDb(): UsageDb {
    if (!this.injectedUsageDb) {
      this.injectedUsageDb = new UsageDb(path.join(this.paths.logsDir, 'usage.db'));
    }
    return this.injectedUsageDb;
  }

  // Operation 可观测：run/chat/job 等后台操作注册 Operation 供查询进度/取消，并返回 OperationDto。
  // CLI/web 可注入同一实例，使操作在 agentctl operations query 与 web 控制台 operations 列表中都
  // 可见。未注入时懒加载默认实例。
  get operationManager(): OperationManager {
    if (!this.injectedOperationManager) {
      this.injectedOperationManager = new OperationManager({
        store: new OperationStore(this.paths.logsDir),
      });
    }
    return this.injectedOperationManager;
  }

  constructor(
    readonly paths: FactoryPaths,
    readonly registry: RegistryStore,
    options: { operationManager?: OperationManager } = {},
  ) {
    this.injectedOperationManager = options.operationManager;
  }

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

  // D-029：创建阶段「描述 → 生成员工蓝图」。委托本地 Claude CLI，返回可编辑蓝图。
  async generateProfile(
    brief: string,
    options?: { model?: string },
  ): Promise<Awaited<ReturnType<typeof generateEmployeeProfile>>> {
    await this.initialize();
    return generateEmployeeProfile(brief, options?.model ? { model: options.model } : undefined);
  }

  // D-041 M3（决策② 骨架化）：创建阶段「一句话 → 基础岗位骨架」。字段收敛为
  // id/name/description/goals/skills，职责/权限/上报由系统按红线模板播种。
  async generateSkeleton(
    brief: string,
    options?: { model?: string },
  ): Promise<Awaited<ReturnType<typeof generateEmployeeSkeleton>>> {
    await this.initialize();
    return generateEmployeeSkeleton(brief, options?.model ? { model: options.model } : undefined);
  }

  async listAgents(): Promise<AgentSummary[]> {
    const data = await this.registry.read();
    // OP3-A 长期：Registry 不再持有 provider，逐个读 agent.yaml 取实时 provider（N+1）。
    // D-032：顺带观测 launchd 真实状态，目录/仪表盘显示真实 running/stopped。
    return Promise.all(
      data.agents.map(async (agent) => {
        const provider = await this.readProvider(agent);
        const runtime = await this.tryReadRuntime(agent);
        const status = runtime ? await this.refreshAgentStatus(agent, runtime) : agent.status;
        return this.toSummary({ ...agent, status }, provider);
      }),
    );
  }

  // D-035：返回已启用飞书 bridge 的员工 id 列表（供 bridge settle 批量扫描）。
  async listBridgeEnabledIds(): Promise<string[]> {
    const data = await this.registry.read();
    return data.agents.filter((agent) => agent.bridge.enabled).map((agent) => agent.id);
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

  // D-032：Web 控制台启动时调用。把「意图常驻(auto-start)但没在跑」的桥接服务拉起来，
  // 并把「已停止但仍在跑」的服务关停，最后刷新 registry 真实状态。best-effort，逐员工 catch。
  async reconcileServices(): Promise<{ activated: string[] }> {
    const data = await this.registry.read();
    const activated: string[] = [];
    for (const agent of data.agents) {
      if (agent.archived || !agent.bridge.enabled) continue;
      try {
        const config = await readAgentConfigFile(path.join(agent.workspace.path, 'agent.yaml'));
        const service = bridgeLaunchdService(agent, config.runtime, this.paths);
        const [autoStart, real] = await Promise.all([service.isAutoStart(), service.status()]);
        let nextStatus: RegistryAgent['status'];
        // 自检决策留痕：autoStart/真实状态/授权→动作，便于事后还原「谁在何时把服务停/起」。
        const decision = `[reconcile] ${agent.id} autoStart=${autoStart} real=${real.state} auth=${agent.bridge.authorization} status=${agent.status}`;
        if (autoStart && real.state !== 'running' && agent.bridge.authorization === 'ready') {
          await this.prepareRuntime(agent, config);
          await this.secureBridgeProfile(agent, config.runtime);
          await service.start();
          activated.push(agent.id);
          nextStatus = 'running';
          console.warn(`${decision} → 拉起`);
        } else if (!autoStart && real.state === 'running') {
          await service.stop();
          await service.setRunAtLoad(false);
          nextStatus = 'stopped';
          console.warn(`${decision} → 关停（autoStart=false 且仍在运行）`);
        } else {
          nextStatus = real.state === 'running' ? 'running' : 'stopped';
          console.warn(`${decision} → 维持 ${nextStatus}`);
        }
        if (nextStatus !== agent.status) {
          await this.registry.updateAgent(agent.id, (current) => ({
            ...current,
            status: nextStatus,
            updated_at: new Date().toISOString(),
          }));
        }
      } catch (error) {
        // best-effort：单个员工故障/未就绪不阻断整体；但留下可查的现场，
        // 否则服务被意外停/无法拉起时无任何日志（本次 17:56 SIGTERM 排查即因此盲区）。
        console.warn(
          `[reconcile] ${agent.id} 自检失败（跳过）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { activated };
  }

  async getAgent(id: string): Promise<{ registry: RegistryAgent; agent: AgentConfig }> {
    const registry = await getRegisteredAgent(this.registry, id);
    const agent = await loadPortableConfig(registry);
    // D-032：返回前观测真实状态（launchd 实际运行与否），详情页状态徽章不显示缓存。
    registry.status = await this.refreshAgentStatus(registry, agent.runtime);
    return { registry, agent };
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

  // OP1 Stage B：knowledge/ 轻量索引 + recall。索引读写复用 documentFile 的
  // assertInside+realpath+symlink 硬约束模式，root=workspace/knowledge。
  private knowledgeRoot(registry: RegistryAgent): string {
    return path.join(registry.workspace.path, 'knowledge');
  }

  private async knowledgeIndex(registry: RegistryAgent): Promise<KnowledgeIndexImpl> {
    const root = await assertInsideReal(
      this.paths.workspaceRoot,
      this.knowledgeRoot(registry),
      '知识库根目录',
    );
    return new KnowledgeIndexImpl(root);
  }

  async knowledgeIngest(id: string): Promise<KnowledgeIndexResult> {
    const { registry } = await this.getAgent(id);
    return this.knowledgeIndex(registry).then((index) => index.ingest());
  }

  async knowledgeCompact(id: string): Promise<KnowledgeIndexResult> {
    const { registry } = await this.getAgent(id);
    return this.knowledgeIndex(registry).then((index) => index.compact());
  }

  async knowledgeRecall(id: string, query: string): Promise<KnowledgeRecallResult> {
    const { registry } = await this.getAgent(id);
    return this.knowledgeIndex(registry).then((index) => index.recall(query));
  }

  // D-042 Part B：运行时 RAG 注入。按当前任务文本召回知识，命中时把便签写入
  // `<workspace>/knowledge/.retrieved.md`（dot 前缀 + 无 frontmatter + .gitignore 三重隔离：
  // 不进索引、不进 evolve 提交、归档不碰）。每次运行覆盖写 = 最后一次任务的缓存。
  // 故意不用 knowledgeWrite（那会重取索引 + 提交）；best-effort，异常仅告警不阻断。
  async recallForTask(id: string, taskText: string): Promise<void> {
    const { registry } = await this.getAgent(id);
    try {
      const query = taskText.trim().slice(0, 4000);
      if (!query) return;
      const index = await this.knowledgeIndex(registry);
      const result = await index.recall(query);
      if (result.hits.length === 0) return; // 无命中不写，避免陈旧便签误导。
      const brief = renderRetrievalBrief({
        query,
        hits: result.hits,
        generatedAt: new Date().toISOString(),
      });
      const file = path.join(this.knowledgeRoot(registry), RETRIEVED_BRIEF_FILE);
      await atomicWriteFile(file, brief, 0o644);
    } catch (error) {
      console.warn(`[recall-for-task] ${id} 召回写入便签失败（跳过）：`, error);
    }
  }

  async knowledgeVerify(id: string): Promise<KnowledgeConsistency> {
    const { registry } = await this.getAgent(id);
    return this.knowledgeIndex(registry).then((index) => index.verifyConsistency());
  }

  // D-041 P2-1：knowledge 遗忘归档公开入口（CLI knowledge retention / restore / purge）。
  async knowledgeArchiveStale(
    id: string,
    options: { retentionDays?: number } = {},
  ): Promise<Awaited<ReturnType<typeof archiveStaleKnowledge>>> {
    const { registry } = await this.getAgent(id);
    const result = await archiveStaleKnowledge({
      workspace: registry.workspace.path,
      ...(options.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
    });
    if (result.archived.length > 0) {
      await this.knowledgeIndex(registry).then((index) => index.ingest());
    }
    return result;
  }

  async knowledgeListArchive(
    id: string,
  ): Promise<Awaited<ReturnType<typeof listKnowledgeArchive>>> {
    const { registry } = await this.getAgent(id);
    return listKnowledgeArchive(registry.workspace.path);
  }

  async knowledgeRestore(
    id: string,
    archiveRelPath: string,
    targetRel?: string,
  ): Promise<{ restored: string }> {
    const { registry } = await this.getAgent(id);
    const result = await restoreKnowledge(registry.workspace.path, archiveRelPath, targetRel);
    await this.knowledgeIndex(registry).then((index) => index.ingest());
    return result;
  }

  async knowledgePurgeArchive(id: string, archiveRelPath: string): Promise<void> {
    const { registry } = await this.getAgent(id);
    await purgeKnowledgeArchive(registry.workspace.path, archiveRelPath);
    await this.knowledgeIndex(registry).then((index) => index.ingest());
  }

  // D-041 P2-2：身份 git 回滚——把某文件在指定提交（缺省 HEAD，即回退到「上一版本」）的内容
  // 写回工作区，走 evolve 单文件提交（可回溯），并刷新身份基线（身份文档回滚后基线同步到新内容，
  // 使对账反映回滚后的状态，而非旧的权威快照）。
  // 受限清单：四份自维护身份文档 + CONSTITUTION + IDENTITY_BASELINE + GOALS/OPERATING_SYSTEM/
  // POLICIES/ROLE/CONSTITUTION 均属身份区；知识/技能/workflows 由员工自主、git checkout 即可回退，
  // 不提供 rollback 逃生口（与「人工只走聊天改身份」对齐：CLI 回滚只服务身份文档）。
  async identityRollback(
    id: string,
    relPath: string,
    options: { ref?: string } = {},
  ): Promise<{ relPath: string; ref: string; restoredAt: string }> {
    const { registry, agent } = await this.getAgent(id);
    const workspace = registry.workspace.path;
    const ref = options.ref ?? 'HEAD';
    // 只允许回滚身份文档（含基线）。知识/技能等可进化区由员工 git 自主管理，不在此逃生口范围。
    const identityDocs = [
      ...IDENTITY_DOCS,
      'agent/IDENTITY_BASELINE.md',
      'agent/CURRENT_STATE.md',
    ] as const;
    if (!(identityDocs as readonly string[]).includes(relPath)) {
      throw new AgentCtlError(
        'VALIDATION_ERROR',
        `identity rollback 仅支持身份文档（${identityDocs.join('、')}），不支持 ${relPath}。`,
      );
    }
    const file = assertInside(workspace, path.resolve(workspace, relPath), '身份文档');
    await assertInsideReal(this.paths.workspaceRoot, file, '身份文档');
    const content = await gitShowFile(workspace, relPath, ref);
    if (content === undefined) {
      throw new AgentCtlError('NOT_FOUND', `提交 ${ref} 下不存在 ${relPath}（或 git 读取失败）。`, {
        remediation: '请用 git log --oneline -- <file> 确认提交存在，再指定 --ref。',
      });
    }
    await atomicWriteFile(file, content, 0o644);
    // 身份文档回滚后刷新基线：使对账反映回滚后的内容，而非旧权威快照（避免回滚后仍被判漂移）。
    const baseline = await ensureIdentityBaseline({
      workspace,
      description: agent.description,
    });
    if (baseline.wrote) {
      await this.commitAgentFile(workspace, 'agent/IDENTITY_BASELINE.md', 'evolve: 更新 身份基线');
    }
    const message = `evolve: 回滚 ${relPath} 到 ${ref}`;
    await this.commitAgentFile(workspace, relPath, message);
    return { relPath, ref, restoredAt: new Date().toISOString() };
  }

  async knowledgeRead(id: string, relPath: string): Promise<{ relPath: string; content: string }> {
    const { registry } = await this.getAgent(id);
    const root = this.knowledgeRoot(registry);
    const file = assertInside(root, path.resolve(root, relPath), '知识文档');
    await assertInsideReal(root, file, '知识文档');
    if (!(await fs.pathExists(file)))
      throw new AgentCtlError('NOT_FOUND', `知识文档不存在：${relPath}`);
    if ((await fs.lstat(file)).isSymbolicLink()) {
      throw new AgentCtlError('VALIDATION_ERROR', '知识文档不能是软链接。');
    }
    return { relPath: path.relative(root, file), content: await fs.readFile(file, 'utf8') };
  }

  async knowledgeWrite(
    id: string,
    relPath: string,
    content: string,
  ): Promise<{ relPath: string; content: string }> {
    const { registry } = await this.getAgent(id);
    const root = this.knowledgeRoot(registry);
    const file = assertInside(root, path.resolve(root, relPath), '知识文档');
    await assertInsideReal(root, file, '知识文档');
    await atomicWriteFile(file, content, 0o644);
    await this.knowledgeIndex(registry).then((index) => index.ingest());
    // TASK-029 自我进化：知识（含经验提取写回 knowledge/lessons/）一并自动单文件提交。
    // 仅在工作区有该文件变更时提交（内容与已提交版本相同时跳过，避免空 evolve: 提交）。
    const rel = path.relative(root, file);
    if ((await gitStatusShort(registry.workspace.path, `knowledge/${rel}`)).length > 0) {
      await this.commitAgentFile(registry.workspace.path, `knowledge/${rel}`, 'evolve: 更新知识');
    }
    return { relPath: rel, content };
  }

  // OP1 Stage D：从 transcript 摘要提取经验写回 knowledge/lessons/。
  // D-041 P1-2 经验两级化：一级原始记录（lessons/raw/）始终落盘，不依赖任何开关（防丢现场）；
  // 二级提炼（lessons/refined/）由重要性累积触发。写回复用 knowledgeWrite 的
  // assertInside+realpath+symlink 硬约束；best-effort，失败不阻断运行。
  // 公开入口：runJob 在 transcript 落盘后调用；测试可直接以 transcriptFile 驱动。
  async extractExperience(id: string, transcriptFile: string): Promise<void> {
    const { agent } = await this.getAgent(id);
    await this.maybeRecordRawExperience(id, agent, transcriptFile);
    await this.maybeRefineExperience(id, agent, transcriptFile);
  }

  // D-041 P1-2 一级：原始经验记录始终落盘。transcript 摘要一到即同步写
  // `knowledge/lessons/raw/<date>-<agent>.md`——不依赖 experience_extraction 开关。
  // 原始记录是二级提炼的证据源（experience-refiner 的 `because of raw/<file>`）。
  private async maybeRecordRawExperience(
    id: string,
    agent: AgentConfig,
    transcriptFile: string | undefined,
  ): Promise<void> {
    if (!transcriptFile) return;
    try {
      const { registry } = await this.getAgent(id);
      const summary = await this.readTranscriptSummary(id, transcriptFile);
      const relPath = rawExperienceRelPath(summary, { agentId: id });
      const workspace = registry.workspace.path;
      const file = path.join(workspace, 'knowledge', relPath);
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file, renderRawExperience(summary, { agentId: id }), { flag: 'wx' });
    } catch (error) {
      console.warn(`[experience-raw] 一级原始经验记录写入失败（跳过）：`, error);
    }
  }

  // D-041 P1-2 二级：重要性累积触发经验提炼。先向 reflection-signals 追加本次信号，
  // 达标（或距上次提炼过久）才调本地 Claude CLI 提炼并写回 lessons/refined/。
  // 门控：experience_extraction=true（resolveMemoryFlags 归一默认开）且 reflection_enabled!==false；
  // 仅 claude 运行时可用（依赖本地 claude CLI）；best-effort，失败不阻断运行。
  private async maybeRefineExperience(
    id: string,
    agent: AgentConfig,
    transcriptFile: string | undefined,
  ): Promise<void> {
    const flags = resolveMemoryFlags(agent.memory);
    if (flags.experience_extraction === false) return;
    if (agent.memory.reflection_enabled === false) return;
    if (agent.runtime.provider !== 'claude') return;
    if (!transcriptFile) return;
    try {
      const { registry } = await this.getAgent(id);
      const summary = await this.readTranscriptSummary(id, transcriptFile);
      const signalsFile = reflectionSignalsPath(registry.workspace.path);
      const topics = summary.topics.length > 0 ? summary.topics : ['会话'];
      const signal = {
        date: new Date().toISOString(),
        importance: estimateImportance({
          topics,
          decisions: summary.decisions,
          lessons: summary.lessons,
        }),
        topics,
        decisions: summary.decisions,
        lessons: summary.lessons,
        transcriptFile,
      };
      await appendReflectionSignal(signalsFile, signal);
      // D-041 P2-3 同源：信号文件只保留最近 5000 行，防无限累积（提炼失败时信号仍持续追加）。
      await truncateReflectionSignals(signalsFile).catch(() => undefined);
      const signals = await readReflectionSignals(signalsFile);
      const lastRefinedAt = await readLastRefinedAt(registry.workspace.path);
      // 未达阈值且从未提炼时不应触发（避免首条消息即提炼）——shouldReflect 对无信号场景返回 false。
      if (!shouldReflect(signals, { lastRefinedAt })) return;
      const refined = await refineExperience(renderRefineBrief(signals), {
        ...(agent.runtime.model ? { model: agent.runtime.model } : {}),
      });
      const relPath = refinedExperienceRelPath({ agentId: id });
      const workspace = registry.workspace.path;
      const file = path.join(workspace, 'knowledge', relPath);
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file, renderRefinedExperience(refined, { agentId: id }), { flag: 'wx' });
      await this.knowledgeIndex(registry).then((index) => index.ingest());
      await this.commitAgentFile(
        registry.workspace.path,
        `knowledge/${relPath}`,
        'evolve: 提炼经验',
      );
      // D-041 P2-3 同源：信号已收敛为提炼产物，重置累积（保底仍由 shouldReflect 的 idle 触发）。
      await fs.rm(signalsFile, { force: true });
      console.warn(`[experience-refine] 已提炼经验：knowledge/${relPath}`);
    } catch (error) {
      console.warn(`[experience-refine] 经验提炼失败（跳过，原始记录仍在 raw/）：`, error);
    }
  }

  private async readTranscriptSummary(
    id: string,
    transcriptFile: string,
  ): Promise<TranscriptSummary> {
    const lines = (await fs.readFile(transcriptFile, 'utf8')).trim().split('\n');
    const last = lines.at(-1);
    if (!last) throw new AgentCtlError('NOT_FOUND', `transcript 为空：${transcriptFile}`);
    const summary = JSON.parse(last) as TranscriptSummary;
    // 不信任 transcript 里的 agent_id（可能被改写），始终用当前 id 覆盖。
    return { ...summary, agent_id: id };
  }

  // TASK-029 自我进化：员工可在任务执行中更新 agent/ 自维护文档（ROLE/GOALS/
  // OPERATING_SYSTEM/POLICIES）与 knowledge/ 知识，系统自动检测并单文件 git 提交。
  // 与 syncCurrentState 同款 best-effort 语义：缺 git 身份或提交抛错仅 console.warn，不阻断主流程。
  private async commitAgentFile(
    workspace: string,
    relPath: string,
    message: string,
  ): Promise<void> {
    try {
      const committed = await gitCommitFile(workspace, relPath, message, {
        requireIdentity: false,
      });
      if (!committed) {
        console.warn(`[self-evolution] 提交 ${relPath} 失败（缺 git 身份或 git 异常），跳过。`);
      }
    } catch (error) {
      console.warn(`[self-evolution] 提交 ${relPath} 失败：`, error);
    }
  }

  /** 检测并单文件提交员工自维护文档/内容的变更（runJob 成功后调用）。
   *  D-029 拓宽：除四份身份文档外，员工写的内容目录（skills/workflows/knowledge）也自动
   *  版本化——含未跟踪新文件，沿用单文件 git add，绝不用 add -A。
   *  D-041 P0-1 硬门：ROLE.md / POLICIES.md 提交前过 identity-guard，锚点缺失（章节标题 /
   *  红线词被删）→ 跳过该文件提交并 console.warn 留现场（保留脏文件供 git diff / checkout），
   *  不悄悄回滚，不阻断其他文件的提交。
   *  D-041 P1-3 对账：CONSTITUTION.md 同样受 identity-guard 只读硬门（宪法区员工不可静默改动，
   *  只允许用户聊天明确指示修改）。enforced 模式下未授权身份改动（appliedWithoutAnchor）由
   *  blockedRel 拦截提交；settleActive 在基线重快照前算好并传入（防止改动被吸收进基线）。 */
  private async commitSelfEvolution(
    agent: AgentConfig,
    workspace: string,
    blockedRel?: ReadonlySet<string>,
  ): Promise<void> {
    // D-041 P1-3：enforced 对账。settleActive 已在 ensureIdentityBaseline 前算出 blockedRel；
    // 其他入口（如 maybeAutoCreateSkill 直接调用）未传时在此自行对账。
    const blocked = blockedRel ?? (await this.enforceIdentityProtocol(agent, workspace));
    const relPaths = [
      // D-041 P1-1：agent.yaml 随自进化链单文件提交。系统回填（ensureMemoryFlags 写默认开关）与
      // 员工对非 runtime 块的合法改动（如 self-maintained 备注）都进 evolve: 历史可回溯。
      // runtime 块（provider/model/locked）由 config_hash 指纹守护，改动会触发漂移拦截。
      'agent.yaml',
      agent.identity.role_file,
      agent.identity.goals_file,
      agent.identity.operating_system_file,
      agent.identity.policies_file,
      // D-041 P1-3：宪法区。员工不可静默改动（只允许用户聊天明确指示修改），提交前过
      // identity-guard 硬门；enforced 模式下的未授权改动由 blockedRel 拦截。
      'agent/CONSTITUTION.md',
      'skills',
      'workflows',
      'knowledge',
      // D-041 P0-4：「记录→提案→批准」通道。员工写提案（agent/proposals/*.md），系统随
      // 自进化链单文件提交（提案本身进 evolve: 历史可回溯）；批准/拒绝由用户在飞书聊天里
      // 明确表态，员工按协议改文件并标 applied/rejected。
      'agent/proposals',
      // 技能运行时投影目录：adopt/自建技能会新增软链（与创建期 renderSkills 的投影跟踪一致），
      // 一并提交，保持 git 干净（避免投影软链停留未跟踪）。
      '.claude/skills',
      '.codex/skills',
      // D-039：系统提示文件。回填（旧员工缺「宿主平台」小节时重渲一次）与员工自维护
      // 都会在此被单文件提交；已提交无变更则不产生提交。
      'CLAUDE.md',
      'AGENTS.md',
    ];
    for (const relPath of relPaths) {
      // D-041 P1-3：enforced 对账拦截——跳过违规文件的提交（保留脏文件供人工决策）。
      if (blocked.has(relPath)) {
        console.warn(
          `[identity-protocol] 已拒绝提交 ${relPath}：未授权身份改动（enforced）。` +
            `保留工作区脏文件供 git diff / git checkout 人工决策。`,
        );
        continue;
      }
      // D-041 P0-1：身份文档提交前过内容级硬门——锚点缺失则拒绝提交（保留脏文件）。
      if (
        relPath === agent.identity.role_file ||
        relPath === agent.identity.policies_file ||
        relPath === 'agent/CONSTITUTION.md'
      ) {
        const file = path.join(workspace, relPath);
        if (await fs.pathExists(file)) {
          const content = await fs.readFile(file, 'utf8');
          const { ok, issues } = validateIdentityGuard(relPath, content);
          if (!ok) {
            console.warn(
              `[identity-guard] 拒绝提交 ${relPath}：${issues
                .map((issue) => issue.message)
                .join('；')} ` +
                `（保留工作区脏文件供 git diff / git checkout 人工决策，不自动回滚。）`,
            );
            continue;
          }
        }
      }
      const dirty = await gitStatusShort(workspace, relPath);
      for (const entry of dirty) {
        if (entry.path === '.') continue;
        await this.commitAgentFile(
          workspace,
          entry.path,
          `evolve: 更新 ${path.basename(entry.path)}`,
        );
      }
    }
  }

  /** D-041 P1-3：enforced 模式身份对账，返回被拦截的身份文档相对路径集合（供提交跳过）。
   *  advisory 仅 warn 不拦截；对账/记录失败 best-effort（不阻断自进化链）。 */
  private async enforceIdentityProtocol(
    agent: AgentConfig,
    workspace: string,
  ): Promise<Set<string>> {
    const blocked = new Set<string>();
    try {
      const protocol = agent.memory.identity_protocol ?? 'advisory';
      const enforced = await maybeEnforceIdentityProtocol({
        workspace,
        agentId: agent.id,
        logsRoot: this.paths.logsDir,
        protocol,
        // D-043（identity_edits 生效）：direct=聊天直改模式（对账跳过提案门，硬门仍生效）；
        // proposal_required（默认）维持提案批准门。
        ...(agent.memory.identity_edits !== undefined
          ? { identityEdits: agent.memory.identity_edits }
          : {}),
        recordState: async (message: string) => {
          const file = path.join(workspace, 'agent', 'CURRENT_STATE.md');
          const result = await updateCurrentState(file, { last_event: message }).catch(
            (error: unknown) => {
              console.warn(
                `[identity-protocol] 更新 ${agent.id} 的当前状态失败：${error instanceof Error ? error.message : String(error)}`,
              );
              return undefined;
            },
          );
          if (result !== undefined && (await this.isDirty(workspace, file))) {
            await this.commitAgentFile(
              workspace,
              'agent/CURRENT_STATE.md',
              'chore: 记录未授权身份改动',
            );
          }
        },
      });
      if (enforced.blocked) {
        for (const entry of enforced.unauthorized) blocked.add(entry.relPath);
      }
    } catch (error) {
      console.warn(
        `[identity-protocol] 身份对账失败（跳过）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return blocked;
  }

  /** D-034：任务结束后自动 adopt/upsert 员工在任务中直接写盘的 skill，并投影到运行器发现目录。
   *  纯修复、始终开启、best-effort（失败仅 console.warn，不阻断 runJob）。 */
  private async autoAdoptSelfSkills(id: string, agent: AgentConfig): Promise<void> {
    try {
      const { registry } = await this.getAgent(id);
      const service = new SkillService(
        registry.workspace.path,
        agent.runtime.provider,
        registry.runtime_home.path,
      );
      const skillsRoot = path.join(registry.workspace.path, 'skills');
      if (!(await fs.pathExists(skillsRoot))) return;
      const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue; // 跳过 .archive/.staging
        const target = path.join(skillsRoot, entry.name);
        const skillFile = path.join(target, 'SKILL.md');
        if (!(await fs.pathExists(skillFile))) continue;
        const metaFile = path.join(target, '.agentctl.yaml');
        if (await fs.pathExists(metaFile)) {
          // 已有元数据：digest 变化则 upsert（源=该目录本身，同名版本化）。
          const meta = YAML.parse(await fs.readFile(metaFile, 'utf8')) as SkillMetadata;
          if (meta.digest === (await digestSkillDirectory(target))) continue;
          await service.upsert(target, 'project');
        } else {
          // 手动/员工写盘尚无元数据：adopt 补写元数据 + 投影。
          await service.adopt(entry.name, 'project');
        }
      }
    } catch (error) {
      console.warn(`[skill-self] 自动 adopt 失败（跳过）：`, error);
    }
  }

  /** D-034：opt-in 自动生成——从 transcript 检测重复模式，达到阈值后生成并注册 Skill。
   *  仅当 skill_self_creation=true 且 transcript_persist=true（resolveMemoryFlags 归一）；best-effort，失败不阻断 runJob。 */
  private async maybeAutoCreateSkill(
    id: string,
    agent: AgentConfig,
    transcriptFile: string | undefined,
  ): Promise<void> {
    const flags = resolveMemoryFlags(agent.memory);
    if (flags.skill_self_creation === false) return;
    if (flags.transcript_persist === false) return;
    if (agent.runtime.provider !== 'claude') return; // 生成依赖本地 claude CLI
    if (!transcriptFile) return;
    try {
      const { registry } = await this.getAgent(id);
      const summary = await this.readTranscriptSummary(id, transcriptFile);
      const signalsFile = path.join(registry.workspace.path, 'knowledge', '.skill-signals.jsonl');
      const history = await readSkillSignals(signalsFile);
      const service = new SkillService(
        registry.workspace.path,
        agent.runtime.provider,
        registry.runtime_home.path,
      );
      const existingSkillNames = (await service.list()).map((skill) => skill.name);
      const detected = detectRepeatedSkillOpportunity(summary, history, existingSkillNames);
      // 记录本次候选 topic 到历史（无论是否命中，供下次累计）。
      const candidate = detected?.topic ?? pickCandidateTopic(summary);
      if (candidate) await appendSkillSignal(signalsFile, candidate);
      if (!detected) return; // 未达阈值
      const skill = await generateSkill(detected.brief);
      const stagingRoot = path.join(
        registry.workspace.path,
        'skills',
        `.staging-self-${skill.name}-${randomUUID()}`,
      );
      await fs.ensureDir(stagingRoot);
      await fs.writeFile(path.join(stagingRoot, 'SKILL.md'), renderSkillFile(skill));
      await service.upsert(stagingRoot, 'project');
      await fs.remove(stagingRoot);
      // D-035：用 console.warn（stderr）而非 log——飞书 bridge 逐消息解析 claude 的 stream-json
      // stdout，任何额外 stdout 行都会污染解析。
      console.warn(`[skill-self] 已自动生成并注册 Skill：${skill.name}@${skill.version}`);
    } catch (error) {
      console.warn(`[skill-self] 自动生成 Skill 失败（跳过）：`, error);
    }
  }

  async listJobs(id: string): Promise<JobConfig[]> {
    const { registry } = await this.getAgent(id);
    return new JobStore(registry.workspace.path).list();
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

  async chat(id: string): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    await this.prepareRuntime(registry, agent);
    const code = await new ProcessRunner(this.paths.logsDir).runInteractive(
      getRuntimeAdapter(agent.runtime).chat(registry, agent.runtime),
    );
    // OP1 Stage C：chat 交互不落盘 transcript（D-006），仅当显式 opt-in 时经 runLogged 持久化。
    return code;
  }

  async runtimeAuth(id: string, operation: 'login' | 'status'): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    if (agent.runtime.provider === 'claude') {
      await this.prepareRuntime(registry, agent);
      // status 只是查询（prepareRuntime 成功即证明当前 Provider 配置可用），不写登录事件；
      // 仅 login 才算生命周期事件，写入事件行。
      if (operation === 'login') {
        await this.syncCurrentState(registry.id, registry.workspace.path, {
          runtime_auth: '已登录',
          state: '已就绪',
          last_event: '运行器登录',
        });
      }
      return 0;
    }
    const adapter = getRuntimeAdapter(agent.runtime);
    const code = await new ProcessRunner(this.paths.logsDir).runInteractive(
      operation === 'login' ? adapter.login(registry) : adapter.authStatus(registry),
    );
    if (code === 0) {
      await this.syncCurrentState(registry.id, registry.workspace.path, {
        runtime_auth: '已登录',
        // 查询成功只同步登录状态，不把查询当作登录事件。
        ...(operation === 'login' ? { state: '已就绪', last_event: '运行器登录' } : {}),
      });
    }
    return code;
  }

  async syncRuntime(id: string, options: { provider?: string } = {}) {
    const { registry, agent } = await this.getAgent(id);
    if (agent.runtime.provider !== 'claude') {
      throw new AgentCtlError('VALIDATION_ERROR', `Agent ${id} 使用 Codex，无需同步 CC Switch。`, {
        remediation: `请运行 agentctl runtime login ${id}。`,
      });
    }
    // OP5-D：`--provider <name>` 显式把本机绑定的 CC Switch Provider 写入 Registry（不进便携文件
    // agent.yaml，属 Registry 本机绑定侧），再按该 Provider 同步；`--provider live` 清除绑定回退 live。
    // 显式指定后，后续每次 spawn 都按该 Provider 同步，而非当前 live Provider（短期语义，doctor 告警）。
    if (options.provider) {
      await this.registry.updateAgent(id, (current) => ({
        ...current,
        credential_provider:
          options.provider === 'live' ? undefined : (options.provider ?? undefined),
        updated_at: new Date().toISOString(),
      }));
      const updated = await this.getAgent(id);
      return this.prepareRuntime(updated.registry, updated.agent);
    }
    return this.prepareRuntime(registry, agent);
  }

  /** TASK-048（D-044）：显式 runtime 迁移计划（--dry-run，零写入）。 */
  async runtimeMigratePlan(id: string, to: 'claude' | 'codex'): Promise<RuntimeMigrationPlan> {
    const { registry, agent } = await this.getAgent(id);
    return buildRuntimeMigrationPlan({ registry, agent, runtimesDir: this.paths.runtimesDir, to });
  }

  /** TASK-048（D-044）：显式 runtime 迁移（claude ↔ codex）。内部一致事务 + 服务重启编排。
   *  旧目录默认保留（回滚逃生口）；options.discardOld 在 commit 成功后删除。 */
  async runtimeMigrate(
    id: string,
    to: 'claude' | 'codex',
    options: { discardOld?: boolean } = {},
  ): Promise<RuntimeMigrationResult> {
    const lock = new FileLock(path.join(this.paths.locksDir, `runtime-migrate-${id}.lock`));
    return lock.withLock({ purpose: `迁移 ${id} 的 runtime` }, async () => {
      const { registry, agent } = await this.getAgent(id);
      const workspace = registry.workspace.path;
      const jobs = await new JobStore(workspace).list();

      // 停服务（best-effort，失败告警继续——对齐 archiveAgent 模式）。
      if (registry.bridge.enabled) {
        await bridgeLaunchdService(registry, agent.runtime, this.paths)
          .uninstall()
          .catch(() => undefined);
      }
      await settleLaunchdService(registry, agent.runtime, this.paths, 0)
        .uninstall()
        .catch(() => undefined);
      for (const job of jobs) {
        await jobLaunchdService(registry, agent.runtime, job, this.paths)
          .uninstall()
          .catch(() => undefined);
      }

      // 纯事务迁移（commit 点 = registry 单次原子写）。
      const result = await applyRuntimeMigration({
        registry,
        agent,
        workspace,
        runtimesDir: this.paths.runtimesDir,
        to,
        updateAgent: (agentId, update) => this.registry.updateAgent(agentId, update),
        refreshConfigHash: (agentId, configHash) =>
          this.registry.refreshConfigHash(agentId, configHash),
        ...(options.discardOld !== undefined ? { discardOld: options.discardOld } : {}),
      });

      // 迁移后验证（非硬门，已 commit——失败仅告警）。
      try {
        const { DoctorService } = await import('../core/doctor.js');
        const report = await new DoctorService(this.paths, this.registry).run(id);
        for (const checkId of ['config-drift', 'runtime-home', 'runtime-lock'] as const) {
          const check = report.checks.find((c) => c.id === checkId);
          if (check && check.status === 'fail') {
            console.warn(`[runtime-migrate] 迁移后 doctor 检查 ${checkId} 未通过：${check.detail}`);
          }
        }
      } catch (error) {
        console.warn(
          `[runtime-migrate] 迁移后 doctor 验证失败（跳过）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // 恢复服务（必须重启：plist 烘焙 env CLAUDE_CONFIG_DIR/CODEX_HOME/shim PATH）。
      const migrated = await this.getAgent(id);
      if (registry.bridge.enabled) {
        await bridgeLaunchdService(migrated.registry, migrated.agent.runtime, this.paths)
          .install()
          .catch((error) =>
            console.warn(`[runtime-migrate] 重启 bridge 服务失败（跳过）：`, error),
          );
        await settleLaunchdService(
          migrated.registry,
          migrated.agent.runtime,
          this.paths,
          FEISHU_SETTLE_INTERVAL_SECONDS,
        )
          .install()
          .catch((error) =>
            console.warn(`[runtime-migrate] 重启 settle 服务失败（跳过）：`, error),
          );
      }
      for (const job of jobs) {
        await jobLaunchdService(
          migrated.registry,
          migrated.agent.runtime,
          job,
          this.paths,
          process.argv[1] ?? 'agentctl',
          this.paths.userHome,
        )
          .install()
          .catch((error) => console.warn(`[runtime-migrate] 重启任务服务失败（跳过）：`, error));
      }
      await this.syncCurrentState(registry.id, workspace, {
        state: '运行中',
        last_event: `迁移 runtime 至 ${to}`,
      });
      return result;
    });
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
      await this.syncCurrentState(registry.id, registry.workspace.path, {
        feishu_auth: '已授权',
        state: '已就绪',
        last_event: '飞书授权',
      });
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

  // D-035：飞书 bridge 逐消息入口——由 claude shim 转发的每条 `claude -p -- <args>` + stdin prompt。
  // 用真实 claude 跑 runLogged（真实 transcript），再跑完整沉淀链（skill/记忆/提交/reconcile）。
  async runBridgeMessage(id: string, args: string[], stdin: string): Promise<number> {
    const { registry, agent } = await this.getAgent(id);
    // D-042 Part B：按本条飞书消息召回相关记忆到 knowledge/.retrieved.md（best-effort）。
    await this.recallForTask(id, stdin).catch((error) =>
      console.warn(`[recall-for-task] ${id} 召回写入便签失败（跳过）：`, error),
    );
    const realClaude =
      process.env.AIEMPLOYEES_REAL_CLAUDE || (await resolveRealClaude(process.env));
    const ctx: ExecutionContext = {
      operation: 'bridge-run',
      command: realClaude,
      args,
      cwd: registry.workspace.path,
      env: {
        ...buildRuntimeEnvironment(registry, agent.runtime),
        LARK_CHANNEL_HOME: registry.bridge.home,
        LARK_CHANNEL_PROFILE: registry.bridge.profile ?? id,
      },
    };
    const result = await new ProcessRunner(this.paths.logsDir).runLogged(id, ctx, {
      // D-041 P1-1：transcript 判定经 resolveMemoryFlags 归一（缺失开关按默认 true 启用）。
      transcript: resolveMemoryFlags(agent.memory).transcript_persist,
      stdin,
      // D-036：启用 structured 解析，best-effort 抽取 token/成本（bridge 非 JSON 输出则返回空）。
      provider: agent.runtime.provider,
      structured: true,
    });
    await this.settleActive(id, agent, registry, result.transcriptFile);
    // D-036：记录本条飞书消息的使用（耗时/退出码/token/成本/主题）。best-effort，失败不阻断。
    this.getUsageDb().record({
      agentId: id,
      provider: agent.runtime.provider,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      exitCode: result.exitCode,
      prompt: stdin,
      args,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.transcriptFile ? { topics: readTranscriptTopics(result.transcriptFile) } : {}),
      ...(result.transcriptFile ? { transcriptFile: result.transcriptFile } : {}),
    });
    return result.exitCode;
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
    // D-032：停止＝暂停。改写 plist RunAtLoad 为 false，使「停机」跨重启保持（开机不再自动拉起）；
    // start/restart 由 bridge 默认 RunAtLoad true 重写，保持常驻。
    if (action === 'stop') await service.setRunAtLoad(false);
    // D-035：飞书主入口——周期 settle 任务随 bridge 服务启停（best-effort，失败仅告警）。
    if (action === 'start' || action === 'restart') {
      await settleLaunchdService(
        registry,
        agent.runtime,
        this.paths,
        FEISHU_SETTLE_INTERVAL_SECONDS,
      )
        .start()
        .catch((error) => console.warn(`[settle] 安装周期 settle 任务失败（跳过）：`, error));
    } else if (action === 'stop') {
      await settleLaunchdService(registry, agent.runtime, this.paths, 0)
        .uninstall()
        .catch((error) => console.warn(`[settle] 卸载周期 settle 任务失败（跳过）：`, error));
    }
    const state = action === 'stop' ? 'stopped' : 'running';
    await this.registry.updateAgent(id, (current) => ({
      ...current,
      status: state,
      updated_at: new Date().toISOString(),
    }));
    await this.syncCurrentState(registry.id, registry.workspace.path, {
      state: action === 'stop' ? '已停止' : '运行中',
      last_event: action === 'stop' ? '停止服务' : action === 'restart' ? '重启服务' : '启动服务',
    });
    return { state };
  }

  async archiveAgent(id: string): Promise<void> {
    const { registry, agent } = await this.getAgent(id);
    await bridgeLaunchdService(registry, agent.runtime, this.paths)
      .uninstall()
      .catch(() => undefined);
    // D-035：归档时一并卸载周期 settle 任务。
    await settleLaunchdService(registry, agent.runtime, this.paths, 0)
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
    await this.syncCurrentState(registry.id, registry.workspace.path, {
      state: '已归档',
      last_event: '归档员工',
    });
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
    const entry = (await trash.list()).find((item) => item.trashId === trashId);
    await trash.restore(trashId);
    // R19：恢复后 registry 已重建（authorization 重置为 pending），用 manifest 的 agent_id
    // 从 registry 重读取工作区路径，更新 CURRENT_STATE 状态行（归档→已恢复）。
    const restored = (await this.registry.read()).agents.find(
      (agent) => agent.id === entry?.agentId,
    );
    if (restored) {
      // D-032：回收站恢复的员工不自动常驻——改写 plist RunAtLoad 为 false，需用户重新启动。
      if (restored.bridge.enabled) {
        try {
          const config = await readAgentConfigFile(
            path.join(restored.workspace.path, 'agent.yaml'),
          );
          await bridgeLaunchdService(restored, config.runtime, this.paths).setRunAtLoad(false);
        } catch {
          // best-effort：config 缺失/损坏时跳过常驻开关
        }
      }
      await this.syncCurrentState(restored.id, restored.workspace.path, {
        state: '已恢复',
        last_event: '恢复员工',
      });
    }
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

  // D-036：飞书实际使用日志查询（usage.db）。
  async queryUsage(filter: UsageFilter = {}): Promise<ReturnType<UsageDb['query']>> {
    return this.getUsageDb().query(filter);
  }

  // D-036：飞书使用聚合统计（按天 + 员工）。
  async usageSummary(filter: UsageFilter = {}): Promise<UsageSummaryRow[]> {
    return this.getUsageDb().summary(filter);
  }

  // D-041 P3-1：员工进化历史只读视图——`git log --grep evolve:`（自进化提交，可回溯）+
  // CURRENT_STATE.md 全文 + usageSummary（飞书使用统计）。供 Web「进化历史」tab 与审计。
  // git 记录缺失（非仓库/无 evolve 提交）→ 空数组，不抛错。
  async evolutionLog(id: string): Promise<{
    commits: Awaited<ReturnType<typeof gitLog>>;
    currentState: string;
    usage: UsageSummaryRow[];
  }> {
    const { registry } = await this.getAgent(id);
    const workspace = registry.workspace.path;
    const commits = await gitLog(workspace, { grep: 'evolve:', limit: 100 });
    const stateFile = path.join(workspace, 'agent', 'CURRENT_STATE.md');
    const currentState = await fs.readFile(stateFile, 'utf8').catch(() => '');
    const usage = await this.getUsageDb().summary({ agentId: id });
    return { commits, currentState, usage };
  }

  // D-041 P3-1 增强：进化历史「点提交看内容」——某提交下变更的文件清单（只读）。
  // ref 无效（非仓库/不存在）→ 空数组；文件内容由前端经 /evolution/content 按需读取。
  async evolutionCommitFiles(id: string, ref: string): Promise<GitCommitFile[]> {
    const { registry } = await this.getAgent(id);
    return gitShowCommitFiles(registry.workspace.path, ref);
  }

  // D-041 P3-1 增强：进化历史「点文件看内容」——读取某提交下文件的全文（git show <ref>:<path>）。
  // 仅允许读工作区内的常规文件（禁 .git 内部对象）；文件在该提交不存在 → NOT_FOUND。
  async evolutionFileContent(id: string, ref: string, relPath: string): Promise<string> {
    const { registry } = await this.getAgent(id);
    const workspace = registry.workspace.path;
    // 越界防护：仅允许工作区内的相对路径，禁绝对路径/.. 逃逸/git 对象。
    const resolved = path.resolve(workspace, relPath);
    const inside =
      path.resolve(workspace) === resolved ||
      resolved.startsWith(`${path.resolve(workspace)}${path.sep}`);
    if (!inside || relPath.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new AgentCtlError('VALIDATION_ERROR', `禁止读取工作区外路径：${relPath}`);
    }
    if (relPath === '.git' || relPath.startsWith('.git/') || relPath.split('/').includes('.git')) {
      throw new AgentCtlError('VALIDATION_ERROR', `禁止读取 git 内部路径：${relPath}`);
    }
    const content = await gitShowFile(workspace, relPath, ref);
    if (content === undefined) {
      throw new AgentCtlError('NOT_FOUND', `提交 ${ref.slice(0, 7)} 中不存在文件：${relPath}`, {
        remediation: '该文件可能在该提交中未变更或已被删除。',
      });
    }
    return content;
  }

  // OP4-D：按分类清理 run 日志/registry 备份/员工备份归档/operations 审计日志。
  async prune(options: PruneOptions): Promise<PruneResult> {
    return new PruneService(this.paths).run(options);
  }

  // D-035：员工自进化沉淀链统一入口。抽取自 runJob 后处理，runJob 与飞书 bridge 逐消息共用。
  // D-041：链序升级——经验两级（一级原始始终落盘 → 二级重要性提炼）→ 宿主平台 skill →
  // 系统提示回填 → 提案账本同步 + 身份对账（enforced 拦截）→ 身份基线（排除被拦截文档）→
  // 记忆开关回填 → 员工自建 skill adopt/生成 → 自进化提交 → 任务 reconcile。
  private async settleActive(
    id: string,
    agent: AgentConfig,
    registry: RegistryAgent,
    transcriptFile?: string,
  ): Promise<void> {
    // D-041 P1-2 一级：原始经验记录始终落盘（不依赖任何开关，防丢现场）。
    await this.maybeRecordRawExperience(id, agent, transcriptFile);
    // D-041 P1-2 二级：重要性累积触发经验提炼（门控 experience_extraction / reflection_enabled）。
    await this.maybeRefineExperience(id, agent, transcriptFile);
    // TASK-037（D-037）：存量员工幂等补宿主平台 skill（ai-employee-factory），新建即在
    // renderAgentWorkspace 播种；此处覆盖存量员工（飞书消息/runJob/定时 settle 都会走到）。
    await ensureFactorySkill({
      workspace: registry.workspace.path,
      provider: agent.runtime.provider,
      values: {
        id,
        name: agent.name,
        runtime: agent.runtime.provider,
        workspace: registry.workspace.path,
      },
    });
    // TASK-039（D-039）：存量员工系统提示词回填。D-037 只回填了 skill，旧员工的
    // CLAUDE.md/AGENTS.md 仍缺「宿主平台」小节（与新建员工不一致）。这里仅当缺该小节时
    // 按当前模板重渲一次；已含则跳过（不覆盖员工对系统提示的既有编辑）。写入后由下方
    // commitSelfEvolution 一并单文件提交（进 evolve: 提交历史，可控）。
    await ensureRuntimePrompt({
      workspace: registry.workspace.path,
      provider: agent.runtime.provider,
      values: {
        id,
        name: agent.name,
        runtime: agent.runtime.provider,
        workspace: registry.workspace.path,
      },
      memory: agent.memory,
    });
    // D-041 P1-3：提案账本同步——员工写提案（agent/proposals/*.md）时登记账本；
    // 带 user_anchor 的 applied 提案登记为批准决策（对账时作为批准依据）。账本同步必须在
    // 身份基线重快照之前，否则违规改动会被基线吸收、对账无从发现。
    await this.syncProposalLedger(id, registry.workspace.path);
    // D-041 P1-3：enforced 模式身份对账。返回被拦截的文档集合（供基线排除 + 提交跳过）。
    // 必须在 ensureIdentityBaseline 之前：被拦截的违规改动不吸收进基线，保留既有基线条目，
    // 使下次 settle 仍能发现并继续拦截。
    const blockedRel = await this.enforceIdentityProtocol(agent, registry.workspace.path);
    // D-041 P0-3：身份基线回填（存量员工幂等）。agent.yaml.description 为唯一权威，ROLE.md
    // `# 岗位定位` 段由系统渲染；此处快照四份身份文档到 agent/IDENTITY_BASELINE.md。回填写入
    // 由下方 commitSelfEvolution 单文件提交（evolve: 更新 IDENTITY_BASELINE.md，可回溯）。
    const baseline = await ensureIdentityBaseline({
      workspace: registry.workspace.path,
      description: agent.description,
      // 被对账拦截的文档不吸收进基线（防止违规改动被基线认可）。
      excludeDocs: [...blockedRel],
    });
    if (baseline.wrote) {
      await this.commitAgentFile(
        registry.workspace.path,
        'agent/IDENTITY_BASELINE.md',
        'evolve: 更新 身份基线',
      );
    }
    // D-041 P1-1：存量员工记忆开关幂等回填（undefined→默认 true，显式 false 尊重不回填）。
    // agent.yaml 写入由 commitSelfEvolution 单文件提交（evolve: 更新 agent.yaml，可回溯）。
    if (await this.ensureMemoryFlags(id)) {
      // 回填后需以新 memory 重建 agent 视图，供后续步骤（adopt/commit）使用一致配置。
      agent = (await this.getAgent(id)).agent;
    }
    // D-034 员工自建 Skill：先自动 adopt/upsert 员工写盘的 skill 并投影，
    // 再按需检测重复模式自动生成。顺序在 commitSelfEvolution 之前，使新元数据被 evolve: 提交。
    await this.autoAdoptSelfSkills(id, agent);
    await this.maybeAutoCreateSkill(id, agent, transcriptFile);
    // TASK-029 自我进化：检测并单文件提交员工自维护文档变更。
    await this.commitSelfEvolution(agent, registry.workspace.path, blockedRel);
    // TASK-031（D-028）：员工自我配置定时任务 reconcile。
    await reconcileEmployeeJobs(registry, agent, this.paths);
    // D-041 P2-1：knowledge 遗忘归档——raw/refined 超保留期条目移入 knowledge/.archive/
    // （移走非删除，可恢复），并从索引隐退。settleActive 末尾低频调用（周期 settle 也覆盖）。
    // .archive/ 已 .gitignore：移走即自动从 evolve 提交消失，无需额外提交。
    await this.maybeArchiveStaleKnowledge(id);
  }

  // D-041 P2-1：knowledge 遗忘归档。best-effort：归档/重建索引失败仅告警，不阻断自进化链。
  private async maybeArchiveStaleKnowledge(id: string): Promise<void> {
    try {
      const { registry } = await this.getAgent(id);
      const result = await archiveStaleKnowledge({ workspace: registry.workspace.path });
      if (result.archived.length > 0) {
        await this.knowledgeIndex(registry).then((index) => index.ingest());
        console.warn(
          `[knowledge-retention] ${id} 已归档 ${result.archived.length} 条陈旧经验到 knowledge/.archive/（保留 ${result.skipped} 条失败跳过）。`,
        );
      }
    } catch (error) {
      console.warn(
        `[knowledge-retention] 归档失败（跳过）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // D-041 P1-3：提案账本同步。扫描 agent/proposals/*.md，将提案登记进账本
  // （recordProposal）；`status: applied` 且带 user_anchor 的提案登记为批准决策
  // （recordDecision, approved），供 appliedWithoutAnchor 对账作为批准依据。best-effort，
  // 失败仅 warn 不阻断。账本写入进 evolve: 提交由 commitSelfEvolution（agent/proposals）处理。
  private async syncProposalLedger(id: string, workspace: string): Promise<void> {
    try {
      const proposalsDir = path.join(workspace, 'agent', 'proposals');
      if (!(await fs.pathExists(proposalsDir))) return;
      const entries = await fs.readdir(proposalsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const file = path.join(proposalsDir, entry);
        const content = await fs.readFile(file, 'utf8').catch(() => '');
        const frontmatter = parseProposalFrontmatter(content);
        if (!frontmatter.proposal_id) continue;
        await recordProposal(this.paths.logsDir, id, frontmatter);
        // 已批准且带 user_anchor 的提案 → 登记批准决策（对账依据）。重复调用幂等由
        // hasApprovedAnchor 判定，不重复登记不影响结论。
        if (
          frontmatter.status === 'applied' &&
          frontmatter.user_anchor?.trim() &&
          frontmatter.target_file
        ) {
          await recordDecision(this.paths.logsDir, id, {
            proposal_id: frontmatter.proposal_id,
            decision: 'approved',
            target_file: frontmatter.target_file,
            user_anchor: frontmatter.user_anchor,
          });
        }
      }
      // P2-3 上限：账本超限截断为最近 N 行。
      await truncateLedger(this.paths.logsDir, id);
    } catch (error) {
      console.warn(
        `[proposal-ledger] 提案账本同步失败（跳过）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // D-041 P1-1：存量员工记忆开关幂等回填。agent.yaml 中 transcript_persist /
  // experience_extraction / skill_self_creation 缺失（undefined）时写默认 true；
  // 显式 false 尊重用户关闭意图，不回填。已含全部开关或值未变则跳过写入（幂等，不产生
  // 空 evolve 提交）。返回是否发生写入。
  private async ensureMemoryFlags(id: string): Promise<boolean> {
    try {
      const { registry } = await this.getAgent(id);
      const yamlFile = path.join(registry.workspace.path, 'agent.yaml');
      const doc = YAML.parse(await fs.readFile(yamlFile, 'utf8')) as {
        memory?: Record<string, unknown>;
      };
      const memory = doc.memory ?? {};
      const changed = (
        ['transcript_persist', 'experience_extraction', 'skill_self_creation'] as const
      )
        .map((key) => {
          if (memory[key] === undefined) {
            memory[key] = true;
            return true;
          }
          return false;
        })
        .some(Boolean);
      if (!changed) return false;
      await atomicWriteFile(yamlFile, YAML.stringify(doc), 0o644);
      console.warn(`[memory-flags] 已回填 ${id} 的缺失自进化开关为默认 true。`);
      return true;
    } catch (error) {
      console.warn(`[memory-flags] 回填失败（跳过）：`, error);
      return false;
    }
  }

  // D-035：对飞书员工执行一次无 transcript 的沉淀（仅 adopt/提交/reconcile，供定时扫描与手动触发）。
  async settleEmployee(id: string): Promise<void> {
    const { registry, agent } = await this.getAgent(id);
    await this.settleActive(id, agent, registry);
  }

  async runJob(id: string, jobId: string, options: LoggedRunOptions = {}) {
    const { registry, agent } = await this.getAgent(id);
    const job = await new JobStore(registry.workspace.path).get(jobId);
    if (job.execution.type === 'agent') await this.prepareRuntime(registry, agent);
    // D-042 Part B：agent 任务按 prompt 内容召回相关记忆到 knowledge/.retrieved.md
    // （job-runner 在内部读 prompt；这里同源再读一次作 query，best-effort 失败仅告警）。
    if (job.execution.type === 'agent') {
      await this.recallForTask(id, await this.jobPrompt(registry, job)).catch((error) =>
        console.warn(`[recall-for-task] ${id} 召回写入便签失败（跳过）：`, error),
      );
    }
    // OP1 Stage C+D：agent.yaml.memory.transcript_persist=true 时持久化会话摘要（经 options 透传），
    // experience_extraction=true 时提取经验写回 knowledge/lessons/（仅当 transcript_persist 已启用）。
    // D-041 P1-1：判定经 resolveMemoryFlags 归一（缺失开关按默认 true 启用）。
    const runOptions: LoggedRunOptions = resolveMemoryFlags(agent.memory).transcript_persist
      ? { ...options, transcript: true }
      : options;
    return new JobRunner(this.paths)
      .run(registry, agent.runtime, job, runOptions)
      .then(async (result) => {
        // D-035：员工自进化沉淀链统一入口（runJob 与飞书 bridge 共用）。
        await this.settleActive(id, agent, registry, result.transcriptFile);
        return result;
      });
  }

  /** 读 agent 任务 prompt 全文（与 job-runner 同源：assertInside 收紧在工作区内）。 */
  private async jobPrompt(registry: RegistryAgent, job: JobConfig): Promise<string> {
    if (job.execution.type !== 'agent') return '';
    const promptPath = path.resolve(registry.workspace.path, job.execution.prompt_file);
    await assertInsideReal(registry.workspace.path, promptPath, '任务 Prompt 文件');
    return fs.readFile(promptPath, 'utf8').catch(() => '');
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
    // OP6-B：存量员工幂等补放行——工作区 .claude/settings.json 无 CURRENT_STATE 放行时合并写入
    // （chat/run/runJob/start 前都会调用，存量自动升级，不覆盖员工其他权限配置）。
    await ensureStateEditAllowed(registry.workspace.path);
    // TASK-029 自我进化：员工四份自维护文档（岗位/目标/工作系统/规则）一并幂等放行。
    await ensureAgentDocsAllowed(registry.workspace.path, [
      agent.identity.role_file,
      agent.identity.goals_file,
      agent.identity.operating_system_file,
      agent.identity.policies_file,
    ]);
    // TASK-031（D-028）：员工自我配置定时任务——放行 automation/jobs 与 automation/prompts，
    // 避免员工写 job/prompt 时被反复确认（glob 放行，幂等；仅 UX 平滑，非硬权限门）。
    await ensureAgentDocsAllowed(registry.workspace.path, [
      'automation/jobs/**',
      'automation/prompts/**',
    ]);
    // D-034：员工自建 Skill——放行 skills/** 的 Edit/Write，使员工在任务中能直接写
    // skills/<name>/SKILL.md 而无需反复确认（与四份身份文档同款 glob 放行，幂等）。
    await ensureAgentDocsAllowed(registry.workspace.path, ['skills/**']);
    // D-035：飞书主入口——幂等安装 claude shim，使 bridge 每条 claude -p 被 Factory 接管
    // （runLogged + 完整沉淀链）。best-effort，失败仅告警不阻断既定流程。
    await installClaudeShim(this.paths, registry.id, process.argv[1] ?? 'agentctl').catch((error) =>
      console.warn(`[claude-shim] 安装 claude shim 失败（跳过）：`, error),
    );
    const config = await readConfig(this.paths);
    // OP5-D：Registry 本机绑定的 Provider 名（不进便携文件），指定时按该 Provider 同步；缺省 live。
    const summary = await syncCcSwitchClaudeProvider(
      registry,
      agent.runtime,
      this.paths.userHome,
      this.paths.runtimesDir,
      config.sync.sanitize_non_whitelist,
      this.ccSwitchSyncCache,
      registry.credential_provider,
    );
    if (summary.routedFieldsChanged.length > 0) {
      console.warn(
        `⚠️  员工 ${registry.id} 的 CC Switch 流量路由字段已变更：${summary.routedFieldsChanged.join(', ')}。请核对 CC Switch Provider 配置。`,
      );
    }
    return summary;
  }

  async installSkill(id: string, source: string, scope: SkillScope = 'project') {
    const { registry, agent } = await this.getAgent(id);
    return new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).install(source, scope);
  }

  /** D-034：按需/任务驱动——用本地 Claude 为一个 brief 生成 Skill 蓝图并注册到员工。 */
  async createSkillForAgent(
    id: string,
    brief: string,
    options: { model?: string; scope?: SkillScope } = {},
  ): Promise<SkillMetadata> {
    const { registry, agent } = await this.getAgent(id);
    const skill = await generateSkill(brief, options.model ? { model: options.model } : {});
    const stagingRoot = path.join(
      registry.workspace.path,
      'skills',
      `.staging-self-${skill.name}-${randomUUID()}`,
    );
    await fs.ensureDir(stagingRoot);
    await fs.writeFile(path.join(stagingRoot, 'SKILL.md'), renderSkillFile(skill));
    try {
      const metadata = await new SkillService(
        registry.workspace.path,
        agent.runtime.provider,
        registry.runtime_home.path,
      ).upsert(stagingRoot, options.scope ?? 'project');
      // 按需生成直接落盘新 skill，随 self-evolution 提交。
      await this.commitSelfEvolution(agent, registry.workspace.path);
      return metadata;
    } finally {
      await fs.remove(stagingRoot);
    }
  }

  /** D-034：给员工某手动写盘的 skill 补写元数据并投影（原位修复，零 LLM）。 */
  async adoptSkill(
    id: string,
    name: string,
    scope: SkillScope = 'project',
  ): Promise<SkillMetadata> {
    const { registry, agent } = await this.getAgent(id);
    return new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).adopt(name, scope);
  }

  /** D-034：从 .archive 恢复员工某 skill 的历史版本。 */
  async rollbackSkill(
    id: string,
    name: string,
    scope: SkillScope = 'project',
    archiveRef?: string,
  ): Promise<SkillMetadata> {
    const { registry, agent } = await this.getAgent(id);
    return new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    ).rollback(name, scope, archiveRef);
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

  // 一键安装仓库全部技能：逐个安装，已存在（CONFLICT）跳过，其余失败逐条记录，不中断。
  async installAllSkillFromStore(
    repoName: string,
    agentId: string,
    scope: SkillScope = 'project',
  ): Promise<{ total: number; installed: SkillMetadata[]; skipped: string[]; failed: string[] }> {
    const { registry, agent } = await this.getAgent(agentId);
    const store = new SkillStoreService(this.paths);
    const skills = await store.listSkills(repoName);
    const service = new SkillService(
      registry.workspace.path,
      agent.runtime.provider,
      registry.runtime_home.path,
    );
    const installed: SkillMetadata[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const skill of skills) {
      try {
        const source = await store.resolveSkillSource(repoName, skill.path);
        installed.push(await service.install(source, scope));
      } catch (error) {
        if (error instanceof AgentCtlError && error.code === 'CONFLICT') {
          skipped.push(skill.name);
        } else {
          failed.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { total: skills.length, installed, skipped, failed };
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
    const restored = await new BackupService(this.paths, this.registry).restore(backup, options);
    if (!options.dryRun) {
      await this.syncCurrentState(restored.id, restored.workspace, {
        state: '已恢复',
        last_event: '恢复员工',
      });
    }
    return restored;
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
    const restored = await new BackupService(this.paths, this.registry).restore(
      backupPath,
      options,
    );
    if (!options.dryRun) {
      await this.syncCurrentState(restored.id, restored.workspace, {
        state: '已恢复',
        last_event: '恢复员工',
      });
    }
    return restored;
  }

  // OP6-B：生命周期事件后自动更新 CURRENT_STATE.md（仅标记块内行）并单文件 git 提交。
  // best-effort：内容更新失败与提交失败（缺 git 身份等）都不阻断主流程，仅 console.warn。
  // 统一入口：registry 恢复路径（backup/trash）不依赖 registry 查找，直接传 workspace。
  private async syncCurrentState(id: string, workspace: string, row: StateRow): Promise<void> {
    const file = path.join(workspace, 'agent', 'CURRENT_STATE.md');
    const result = await updateCurrentState(file, row).catch((error: unknown) => {
      console.warn(
        `[current-state] 更新 ${id} 的当前状态失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
    if (result === undefined) return;
    let committed: boolean;
    try {
      committed = await gitCommitFile(workspace, 'agent/CURRENT_STATE.md', 'chore: 更新当前状态');
    } catch (error) {
      console.warn(
        `[current-state] 提交 ${id} 的状态文件失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // gitCommitFile 缺 git 身份时返回 false（不抛错），同样提示，避免静默失败。
    if (!committed) {
      console.warn(
        `[current-state] 提交 ${id} 的状态文件失败：工作区缺少 git 身份配置（user.name / user.email）。`,
      );
    }
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
      role: agent.role,
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

  // D-032：容错读完整 runtime（供观测真实状态）。配置缺失/损坏返回 null，list 不因单员工失败。
  private async tryReadRuntime(agent: RegistryAgent): Promise<AgentConfig['runtime'] | null> {
    try {
      const config = await readAgentConfigFile(path.join(agent.workspace.path, 'agent.yaml'));
      return config.runtime;
    } catch {
      return null;
    }
  }

  // D-032：观测 launchd 真实运行状态并回写 registry。桥接未启用→stopped；观测失败（如无 launchctl）
  // 返回原值不抛、不自动启动，保证测试/CI 确定性。仅观测，不触发启动。
  private async refreshAgentStatus(
    registry: RegistryAgent,
    runtime: AgentConfig['runtime'],
  ): Promise<RegistryAgent['status']> {
    if (registry.archived) return registry.status;
    if (!registry.bridge.enabled) return 'stopped';
    let state: 'running' | 'stopped' = registry.status === 'running' ? 'running' : 'stopped';
    try {
      const service = bridgeLaunchdService(registry, runtime, this.paths);
      const real = await service.status();
      state = real.state === 'running' ? 'running' : 'stopped';
    } catch {
      return registry.status;
    }
    if (state !== registry.status) {
      await this.registry.updateAgent(registry.id, (current) => ({
        ...current,
        status: state,
        updated_at: new Date().toISOString(),
      }));
    }
    return state;
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

  // OP6-B：生命周期事件后自动更新 CURRENT_STATE.md（仅标记块内行）并单文件 git 提交。
  // best-effort：内容更新失败与提交失败（缺 git 身份等）都不阻断主流程，仅 console.warn。

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

// D-036：best-effort 从 transcript.jsonl 提取主题关键词（供 usage 记录）。transcript 文件内容为
// 一行 JSON（TranscriptSummary，含 topics 数组）。读取失败/无 topics 返回空数组（不阻断）。
function readTranscriptTopics(transcriptFile: string): string[] {
  try {
    const content = fs.readFileSync(transcriptFile, 'utf8');
    const line = content.split('\n').find((l) => l.trim());
    if (!line) return [];
    const parsed = JSON.parse(line) as { topics?: unknown };
    if (Array.isArray(parsed.topics)) {
      return parsed.topics.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    /* best-effort */
  }
  return [];
}
