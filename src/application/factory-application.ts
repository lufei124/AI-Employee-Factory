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
import { KnowledgeIndexImpl } from '../core/knowledge-index.js';
import type {
  KnowledgeConsistency,
  KnowledgeIndexResult,
  KnowledgeRecallResult,
} from '../core/knowledge.js';
import { FileLock } from '../core/locks.js';
import { initializeFactory, readConfig } from '../core/config.js';
import { CreateAgentService, type CreateAgentInput } from '../core/create-agent.js';
import { generateEmployeeProfile } from '../core/employee-generator.js';
import { DefaultExperienceExtractor } from '../core/experience.js';
import { DoctorService } from '../core/doctor.js';
import { AgentCtlError } from '../core/errors.js';
import { JobRunner } from '../core/job-runner.js';
import { assertInside, assertInsideReal, type FactoryPaths } from '../core/paths.js';
import type { RegistryStore } from '../core/registry.js';
import { JobStore } from '../core/scheduler.js';
import { reconcileEmployeeJobs } from '../core/job-reconcile.js';
import { SkillService, type SkillMetadata, type SkillScope } from '../core/skills.js';
import { SkillStoreService } from '../core/skill-store.js';
import { OperationStore, type OperationSummary } from '../core/operation-store.js';
import { OperationManager } from '../core/operation-manager.js';
import { PruneService, type PruneOptions, type PruneResult } from '../core/prune.js';
import { TrashService, type TrashEntryDto, type TrashPreview } from '../core/trash.js';
import { ProcessRunner, type LoggedRunOptions } from '../core/process-runner.js';
import { gitCommitFile, gitStatusShort } from '../core/git.js';
import {
  updateCurrentState,
  ensureAgentDocsAllowed,
  ensureStateEditAllowed,
  type StateRow,
} from '../core/current-state.js';
import { parseStructuredResult } from '../core/usage.js';
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
        if (autoStart && real.state !== 'running' && agent.bridge.authorization === 'ready') {
          await this.prepareRuntime(agent, config);
          await this.secureBridgeProfile(agent, config.runtime);
          await service.start();
          activated.push(agent.id);
          nextStatus = 'running';
        } else if (!autoStart && real.state === 'running') {
          await service.stop();
          await service.setRunAtLoad(false);
          nextStatus = 'stopped';
        } else {
          nextStatus = real.state === 'running' ? 'running' : 'stopped';
        }
        if (nextStatus !== agent.status) {
          await this.registry.updateAgent(agent.id, (current) => ({
            ...current,
            status: nextStatus,
            updated_at: new Date().toISOString(),
          }));
        }
      } catch {
        // best-effort：单个员工故障/未就绪不阻断整体
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

  async knowledgeVerify(id: string): Promise<KnowledgeConsistency> {
    const { registry } = await this.getAgent(id);
    return this.knowledgeIndex(registry).then((index) => index.verifyConsistency());
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
  // 硬约束：仅当 experience_extraction=true 且 transcript_persist=true（Stage C 落地）才生效；
  // 写回复用 knowledgeWrite 的 assertInside+realpath+symlink 硬约束；best-effort，失败不阻断运行。
  // 公开入口：runAgent/runJob 在 transcript 落盘后调用；测试可直接以 transcriptFile 驱动。
  async extractExperience(id: string, transcriptFile: string): Promise<void> {
    const { agent } = await this.getAgent(id);
    await this.maybeExtractExperience(id, agent, transcriptFile);
  }

  private async maybeExtractExperience(
    id: string,
    agent: AgentConfig,
    transcriptFile: string | undefined,
  ): Promise<void> {
    if (agent.memory.experience_extraction !== true) return;
    if (agent.memory.transcript_persist !== true) return;
    if (!transcriptFile) return;
    const summary = await this.readTranscriptSummary(id, transcriptFile);
    const assets = new DefaultExperienceExtractor({ agentId: id }).extract(summary);
    for (const asset of assets) {
      await this.knowledgeWrite(id, asset.relPath, asset.content);
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

  /** 检测并单文件提交员工自维护文档/内容的变更（runAgent/runChat/runJob 成功后调用）。
   *  D-029 拓宽：除四份身份文档外，员工写的内容目录（skills/workflows/knowledge）也自动
   *  版本化——含未跟踪新文件，沿用单文件 git add，绝不用 add -A。 */
  private async commitSelfEvolution(agent: AgentConfig, workspace: string): Promise<void> {
    const relPaths = [
      agent.identity.role_file,
      agent.identity.goals_file,
      agent.identity.operating_system_file,
      agent.identity.policies_file,
      'skills',
      'workflows',
      'knowledge',
    ];
    for (const relPath of relPaths) {
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
    // OP4-C：run 追加结构化输出（claude --output-format json / codex --json），
    // runLogged 解析 usage 供 gen_ai.* span 上报；best-effort，失败不阻断运行。
    // OP1 Stage C+D：agent.yaml.memory.transcript_persist=true 时持久化会话摘要（0600），
    // experience_extraction=true 时提取经验写回 knowledge/lessons/（仅当 transcript_persist 已启用）。
    return new ProcessRunner(this.paths.logsDir)
      .runLogged(
        id,
        getRuntimeAdapter(agent.runtime).run(
          registry,
          agent.runtime,
          task,
          timeoutSeconds * 1000,
          true,
        ),
        {
          ...options,
          provider: agent.runtime.provider,
          structured: true,
          ...(agent.memory.transcript_persist === true ? { transcript: true } : {}),
        },
      )
      .then(async (result) => {
        await this.maybeExtractExperience(id, agent, result.transcriptFile);
        // TASK-029 自我进化：任务执行结束后检测并单文件提交员工自维护文档变更。
        await this.commitSelfEvolution(agent, registry.workspace.path);
        // TASK-031（D-028）：员工自我配置定时任务——任务结束后自动 reconcile 调度。
        await reconcileEmployeeJobs(registry, agent, this.paths);
        return result;
      });
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

  // Web 单轮对话（D-024）：非交互调用（claude -p / codex exec），runLogged 捕获 stdout 到日志，
  // 返回 stdout 文本供前端渲染。无锁（与 CLI chat 一致）；transcript 沿用 runAgent 的 opt-in 管线。
  async runChat(id: string, prompt: string, timeoutSeconds = 300): Promise<{ text: string }> {
    if (!prompt.trim()) throw new AgentCtlError('VALIDATION_ERROR', '消息内容不能为空。');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86_400) {
      throw new AgentCtlError('VALIDATION_ERROR', 'timeout 必须是 1 到 86400 秒。');
    }
    const { registry, agent } = await this.getAgent(id);
    await this.prepareRuntime(registry, agent);
    const result = await new ProcessRunner(this.paths.logsDir).runLogged(
      id,
      // structured: true → claude -p --output-format json / codex exec --json，
      // 与 runAgent 一致：stdout 为结构化 JSON，可经 parseStructuredResult 提取纯文本，
      // runLogged 解析 usage 供 gen_ai.* span 上报（OP4-C，best-effort）。
      getRuntimeAdapter(agent.runtime).run(
        registry,
        agent.runtime,
        prompt,
        timeoutSeconds * 1000,
        true,
      ),
      {
        ...(agent.memory.transcript_persist === true ? { transcript: true } : {}),
        provider: agent.runtime.provider,
        structured: true,
        mirror: false,
      },
    );
    // OP1 Stage D：与 runAgent 一致——experience_extraction=true 且 transcript_persist=true 时
    // 提取经验写回 knowledge/lessons/（仅当 transcriptFile 已生成）。
    await this.maybeExtractExperience(id, agent, result.transcriptFile);
    // TASK-029 自我进化：对话结束后检测并单文件提交员工自维护文档变更。
    await this.commitSelfEvolution(agent, registry.workspace.path);
    // TASK-031（D-028）：员工自我配置定时任务——对话结束后自动 reconcile 调度。
    await reconcileEmployeeJobs(registry, agent, this.paths);
    const raw = await fs.readFile(result.stdoutFile, 'utf8').catch(() => '');
    // 结构化 result 解析失败（非 JSON/空输出）返回 undefined，降级为原始 stdout 文本。
    const text = parseStructuredResult(agent.runtime.provider, raw) ?? raw;
    return { text };
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
    // OP1 Stage C+D：agent.yaml.memory.transcript_persist=true 时持久化会话摘要（经 options 透传），
    // experience_extraction=true 时提取经验写回 knowledge/lessons/（仅当 transcript_persist 已启用）。
    const runOptions: LoggedRunOptions =
      agent.memory.transcript_persist === true ? { ...options, transcript: true } : options;
    return new JobRunner(this.paths)
      .run(registry, agent.runtime, job, runOptions)
      .then(async (result) => {
        await this.maybeExtractExperience(id, agent, result.transcriptFile);
        // TASK-029 自我进化：任务执行结束后检测并单文件提交员工自维护文档变更。
        await this.commitSelfEvolution(agent, registry.workspace.path);
        // TASK-031（D-028）：员工自我配置定时任务——任务结束后自动 reconcile 调度。
        await reconcileEmployeeJobs(registry, agent, this.paths);
        return result;
      });
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
