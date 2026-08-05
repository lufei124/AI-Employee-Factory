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
import { KnowledgeIndexImpl } from '../core/knowledge-index.js';
import type {
  KnowledgeConsistency,
  KnowledgeIndexResult,
  KnowledgeRecallResult,
} from '../core/knowledge.js';
import { FileLock } from '../core/locks.js';
import { initializeFactory, readConfig } from '../core/config.js';
import { CreateAgentService, type CreateAgentInput } from '../core/create-agent.js';
import { DefaultExperienceExtractor } from '../core/experience.js';
import { DoctorService } from '../core/doctor.js';
import { AgentCtlError } from '../core/errors.js';
import { JobRunner } from '../core/job-runner.js';
import { assertInside, assertInsideReal, type FactoryPaths } from '../core/paths.js';
import type { RegistryStore } from '../core/registry.js';
import { JobStore } from '../core/scheduler.js';
import { SkillService, type SkillMetadata, type SkillScope } from '../core/skills.js';
import { SkillStoreService } from '../core/skill-store.js';
import { OperationStore, type OperationSummary } from '../core/operation-store.js';
import { OperationManager, type OperationDto } from '../core/operation-manager.js';
import { PruneService, type PruneOptions, type PruneResult } from '../core/prune.js';
import { TrashService, type TrashEntryDto, type TrashPreview } from '../core/trash.js';
import { ProcessRunner, type LoggedRunOptions } from '../core/process-runner.js';
import { redactSecrets } from '../core/secrets.js';
import { TaskStore } from '../core/task-store.js';
import {
  gitCommitFile,
  gitDiff,
  gitStatusShort,
  snapshotWorkspaceHash,
  type GitStatusEntry,
} from '../core/git.js';
import {
  updateCurrentState,
  ensureStateEditAllowed,
  type StateRow,
} from '../core/current-state.js';
import { parseStructuredResult } from '../core/usage.js';
import type { TranscriptSummary } from '../core/transcript.js';
import type { TaskItem, TaskPlan } from '../schemas/task-schema.js';
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

// ===== Chief 编排核心闭环：提示词与结构化解析（纯函数，零 I/O）=====

function planningPrompt(item: TaskItem): string {
  return (
    `你是任务「${item.title}」的规划阶段。请只用纯文本简述你计划如何完成该任务（步骤/产出）。\n` +
    `严格约束：不要创建、修改或删除工作区任何文件（规划阶段只出计划）。\n` +
    `任务提示词：\n${item.prompt}`
  );
}

/** 计划派发进度事件（Operation 事件流）；summary 为计划级聚合摘要。 */
type DispatchEmit = (event: {
  kind: 'progress';
  progress: number;
  message: string;
  summary?: string;
}) => void;

/** 终态项占比（0-100），与 dispatchPlan 的 pct 计算一致。 */
function progressOf(plan: TaskPlan): number {
  const total = plan.items.length;
  if (total === 0) return 100;
  const done = plan.items.filter(
    (item) =>
      item.status === 'completed' ||
      item.status === 'awaiting_review' ||
      item.status === 'failed' ||
      item.status === 'cancelled',
  ).length;
  return Math.round((done / total) * 100);
}

/** 从计划任务项状态聚合一行摘要（「N/M 完成 · 执行中 t1,t2 · 等待中 1」），供 OperationDto.summary。 */
function summaryOf(plan: TaskPlan): string {
  const total = plan.items.length;
  const done = plan.items.filter(
    (item) =>
      item.status === 'completed' ||
      item.status === 'awaiting_review' ||
      item.status === 'failed' ||
      item.status === 'cancelled',
  ).length;
  const active = plan.items
    .filter((item) => item.status === 'developing' || item.status === 'planning')
    .map((item) => item.id);
  const waiting = plan.items.filter(
    (item) => item.status === 'pending' || item.status === 'queued',
  ).length;
  const parts = [`${done}/${total} 完成`];
  if (active.length > 0)
    parts.push(`执行中 ${active.slice(0, 3).join(',')}${active.length > 3 ? ',…' : ''}`);
  if (waiting > 0) parts.push(`等待中 ${waiting}`);
  return parts.join(' · ');
}

function reviewPrompt(plan: TaskPlan, item: TaskItem, diff: string, stdout: string): string {
  return (
    `你是主管 Chief。请对下列工人任务的开发产物做交叉审查（跨 worker 只读评审）。\n` +
    `目标（计划）：${plan.name}\n` +
    `任务：${item.title}\n` +
    `任务提示词：${item.prompt}\n` +
    `--- 工人工作区 git diff ---\n` +
    `${diff || '（无变更）'}\n` +
    `--- 工人输出 ---\n` +
    `${stdout || '（无输出）'}\n` +
    `请只输出纯 JSON（不要其它文字）：{"verdict":"approved"|"rejected","note":"一句话评审结论"}`
  );
}

function decomposePrompt(goal: string, agentIds: string): string {
  return (
    `你是主管 Chief。请把下列目标拆解为若干可交给不同 AI 员工（worker）执行的任务。\n` +
    `当前可用员工：${agentIds || '（未知，请用合理的 agent id 占位）'}\n` +
    `目标：${goal}\n` +
    `为每个任务指定执行员工 id（agent，须从可用员工中选）。数组中第 N 个任务（从 1 开始）的 id 固定为 "item-N"\n` +
    `（如第 1 个是 "item-1"、第 2 个是 "item-2"），任务依赖用该 id 引用前面的任务。只输出纯 JSON 数组（不要其它文字）：\n` +
    `[{"title":"任务标题","agent":"员工id","prompt":"给该员工的完整执行指令","dependencies":["item-N",...]（无依赖则省略）}]`
  );
}

export interface DecomposedTask {
  title: string;
  agent: string;
  prompt: string;
  dependencies?: string[];
}

// 解析 Chief 拆解输出；任何结构不符即返回空数组（调用方回落可编辑空计划）。
function parseDecompose(text: string | undefined): DecomposedTask[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const items: DecomposedTask[] = [];
    for (const raw of parsed) {
      if (
        typeof raw?.title !== 'string' ||
        typeof raw?.agent !== 'string' ||
        typeof raw?.prompt !== 'string'
      ) {
        return [];
      }
      items.push({
        title: raw.title,
        agent: raw.agent,
        prompt: raw.prompt,
        dependencies: Array.isArray(raw.dependencies)
          ? raw.dependencies.filter((dep: unknown): dep is string => typeof dep === 'string')
          : [],
      });
    }
    return items;
  } catch {
    return [];
  }
}

// 解析 Chief 评审输出；解析失败回落为「驳回待人工」。
function parseReview(text: string | undefined): TaskItem['review'] {
  if (!text) return { verdict: 'rejected', note: '评审输出解析失败（无输出），待人工确认。' };
  try {
    const parsed = JSON.parse(text) as { verdict?: unknown; note?: unknown };
    if (parsed.verdict === 'approved' || parsed.verdict === 'rejected') {
      return {
        verdict: parsed.verdict,
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
      };
    }
  } catch {
    // fallthrough
  }
  return { verdict: 'rejected', note: '评审输出解析失败，待人工确认。' };
}

// gitStatusShort 前后比对（忽略顺序，按 path 排序后比较）。
function gitStateEqual(a: GitStatusEntry[], b: GitStatusEntry[]): boolean {
  const key = (entries: GitStatusEntry[]) =>
    JSON.stringify([...entries].sort((x, y) => x.path.localeCompare(y.path)));
  return key(a) === key(b);
}

export class FactoryApplication {
  // OP5-B：CC Switch 同步的 mtime 缓存（源 settings.json 未变则跳过重写，降低 spawn 延迟与无谓 I/O）。
  private readonly ccSwitchSyncCache: SyncCache = createSyncCache();
  // 计划文件并发互斥：runTaskPlan 波次并发派发时，多个 dispatchItem 会对同一计划 YAML 做
  // 读改写。若不加锁，丢失更新会把其它任务项的状态回滚（触发非法转移）。用 in-process
  // promise 链按「计划文件路径」串行化对计划状态机的全部变更（worker 执行仍可各自并发）。
  private readonly planLocks = new Map<string, Promise<unknown>>();

  // 按计划路径串行执行 fn：前一个计划变更落定后才跑下一个，保证对同一 plan 文件的读改写原子。
  // 成功/失败两路都释放 gate——否则 fn 抛错会让后续排队者永久挂起（死锁）。
  private async withPlanLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.planLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    void new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(fn).then(
      (value) => {
        release();
        return value;
      },
      (error) => {
        release();
        throw error;
      },
    );
    this.planLocks.set(key, tail);
    try {
      return await tail;
    } finally {
      if (this.planLocks.get(key) === tail) this.planLocks.delete(key);
    }
  }

  private injectedOperationManager: OperationManager | undefined;

  // 编排 Operation 可观测（spec user story 16）：编排动作（runTaskPlan/orchestrate）注册一个
  // Operation 供查询进度/取消，并返回 OperationDto。CLI/web 可注入同一实例，使编排操作在
  // agentctl operations query 与 web 控制台 operations 列表中都可见。未注入时懒加载默认实例。
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
    return { relPath: path.relative(root, file), content };
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
        return result;
      });
  }

  // ===== Chief 编排核心闭环（spec-chief-orchestration）=====
  // 计划归属：计划文件存于「owner agent」的工作区 workspace/tasks/plans（编排时 owner=Chief）。
  // 所有编排方法显式传 ownerId——runTaskPlan 派发 item.agent 到各 worker 自己的工作区执行。
  // Cross-review 守 D-017：编排器读 worker 的受控产物（git diff + 计划目录内 result 文件），
  // redactSecrets 脱敏后喂给 Chief；Chief 自始至终零 worker 文件系统访问。
  // 唯一 seam = FactoryApplication（worker/Chief 跑真实 runAgent，测试注入 mock）。

  private async plans(ownerId: string): Promise<TaskStore> {
    const { registry } = await this.getAgent(ownerId);
    return new TaskStore(registry.workspace.path);
  }

  async createTaskPlan(ownerId: string, input: { id: string; name: string }): Promise<TaskPlan> {
    if (!input.id.trim() || !input.name.trim())
      throw new AgentCtlError('VALIDATION_ERROR', '计划 id 与 name 不能为空。');
    const now = new Date().toISOString();
    return (await this.plans(ownerId)).create({
      schema_version: 1,
      id: input.id,
      name: input.name,
      creator: ownerId,
      status: 'draft',
      items: [],
      created_at: now,
      updated_at: now,
    });
  }

  async listTaskPlans(ownerId: string): Promise<TaskPlan[]> {
    return (await this.plans(ownerId)).list();
  }

  async getTaskPlan(ownerId: string, planId: string): Promise<TaskPlan> {
    return (await this.plans(ownerId)).get(planId);
  }

  async addTaskItem(
    ownerId: string,
    planId: string,
    input: {
      id: string;
      title: string;
      agent: string;
      prompt: string;
      dependencies?: string[];
    },
  ): Promise<TaskPlan> {
    if (!input.title.trim() || !input.prompt.trim())
      throw new AgentCtlError('VALIDATION_ERROR', '任务标题与提示词不能为空。');
    await this.getAgent(input.agent); // 校验执行员工存在
    return (await this.plans(ownerId)).addItem(planId, input);
  }

  // 计划确认门：draft→active（可派发）。驳回→cancelled（draft→cancelled 否决，可附反馈 note）。
  async confirmPlan(ownerId: string, planId: string): Promise<TaskPlan> {
    return (await this.plans(ownerId)).setPlanStatus(planId, 'active');
  }

  async rejectPlan(ownerId: string, planId: string, note?: string): Promise<TaskPlan> {
    return (await this.plans(ownerId)).setPlanStatus(planId, 'cancelled', note);
  }

  // 派发计划：串行（可选并发）、依赖阻塞、失败不阻塞同级、已成功跳过、终态项跳过。
  // 每项依次 pending→queued→planning（规划门脏审计）→awaiting_confirmation（计划级已确认故自动推进）
  // →developing（worker 实际执行）→awaiting_review / failed。deps 依赖仅 completed 才放行。
  // 可观测性（spec user story 16）：注册一个 kind='task_plan' 的 Operation 在后台派发，返回
  // OperationDto 供 follow 进度/取消；同步调用方用 waitOperation(id) 等终态后再 getTaskPlan 取结果。
  async runTaskPlan(
    ownerId: string,
    planId: string,
    options: { concurrency?: number; timeoutSeconds?: number } = {},
  ): Promise<OperationDto> {
    const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 1)));
    const timeout = options.timeoutSeconds ?? 900;
    const store = await this.plans(ownerId);
    // 重启恢复（user story 17）：编排器中断后遗留的 planning/developing 孤儿项标记失败，
    // 避免父操作悬空欺骗 UI。runTaskPlan 是派发入口，重跑前先 reconcile 一次。
    await store.reconcile();
    let plan = await store.get(planId);
    if (plan.status !== 'active')
      throw new AgentCtlError(
        'CONFLICT',
        `计划未确认（当前 ${plan.status}），请先 confirm 后 run。`,
      );
    for (const item of plan.items) await this.getAgent(item.agent); // 校验全部执行员工存在

    // pre-flight 校验通过后，派发主循环在后台 Operation 内执行（可轮询/取消）；校验失败仍在此同步
    // 抛出（reject），不进入后台——与先前同步语义一致。个别 item 失败（dev.exitCode≠0）不使操作
    // 失败——派发循环完整跑完即视为操作成功，item 级状态是唯一事实源（见 plan.items）。
    return this.operationManager.start('task_plan', ownerId, async ({ signal, emit, traceId }) => {
      // 把父 Operation 的 traceId 穿给每个 worker 的 runAgent，使 task_plan 操作与其排程的
      // 各 agent 运行落在同一条 trace（observability 关联），而非各自孤立的随机 trace。
      await this.dispatchPlan(ownerId, planId, concurrency, timeout, signal, emit, traceId);
      return { exitCode: 0 };
    });
  }

  // 波次调度主循环：每波启动最多 concurrency 个「依赖已齐且未启动」的项，全部完成后进入下一波。
  // dispatchItem 内部只用短锁串行化计划文件的状态机读改写，worker 执行阶段不加锁——故同波
  // 内互不依赖的任务项可真正并发执行（--concurrency 生效）。signal 透传给正在运行的 worker
  // （取消 Operation 时中止当前轮），emit 上报进度供 Operation 事件流观测；traceId 为父操作
  // 的 trace，穿给各 worker 使关联。进度按「已完成项」计而非「已启动项」——避免最后一项刚
  // 启动就报 100% 的误导。
  private async dispatchPlan(
    ownerId: string,
    planId: string,
    concurrency: number,
    timeout: number,
    signal: AbortSignal | undefined,
    emit: DispatchEmit,
    parentTraceId: string,
  ): Promise<TaskPlan> {
    const store = await this.plans(ownerId);
    let plan = await store.get(planId);
    const total = plan.items.length;
    const runnable = (item: TaskItem) =>
      item.status !== 'completed' &&
      item.status !== 'awaiting_review' &&
      item.status !== 'failed' &&
      item.status !== 'cancelled';
    const depsDone = (item: TaskItem) =>
      item.dependencies.every((dep) => {
        const depItem = plan.items.find((candidate) => candidate.id === dep);
        return depItem?.status === 'completed';
      });
    const doneCount = (p: TaskPlan) =>
      p.items.filter(
        (item) =>
          item.status === 'completed' ||
          item.status === 'awaiting_review' ||
          item.status === 'failed' ||
          item.status === 'cancelled',
      ).length;

    const started = new Set<string>();
    for (;;) {
      if (signal?.aborted) break; // 取消：不再调度新波次（当前波跑完后 operation 进入 cancelled）
      plan = await store.get(planId);
      const wave = plan.items
        .filter((item) => runnable(item) && depsDone(item) && !started.has(item.id))
        .slice(0, concurrency);
      if (wave.length === 0) break; // 无可启动项（全部结束或被失败依赖阻塞）
      for (const item of wave) started.add(item.id);
      emit({
        kind: 'progress',
        progress: progressOf(plan),
        message: `开始执行 ${wave.map((w) => w.id).join(', ')}`,
        summary: summaryOf(plan),
      });
      await Promise.all(
        wave.map((item) =>
          this.dispatchItem(store, planId, item.id, timeout, signal, parentTraceId, emit),
        ),
      );
      plan = await store.get(planId);
      emit({
        kind: 'progress',
        progress: progressOf(plan),
        message: `已完成 ${doneCount(plan)}/${total} 项`,
        summary: summaryOf(plan),
      });
    }
    return store.get(planId);
  }

  // 等一个 Operation 到终态；失败/取消抛错（供同步调用方在 await 后台派发后感知结果）。
  async waitOperation(id: string): Promise<void> {
    const manager = this.operationManager;
    await manager.wait(id);
    const dto = manager.get(id);
    if (dto.state === 'failed') {
      throw new AgentCtlError('OPERATION_FAILED', dto.error?.message ?? '操作失败。');
    }
    if (dto.state === 'cancelled') {
      throw new AgentCtlError('CANCELLED', '操作已取消。');
    }
  }

  // 派发单任务项：推进状态 + 规划门脏审计 + worker 执行。可安全续跑（处理 pending/queued/planning/
  // awaiting_confirmation/developing 各态），供重跑时跳过已完成的项。
  // 并发正确性：仅「计划文件状态机读改写」用 withPlanLock 短锁串行化；worker 执行（planning/
  // developing 的 runAgent）在锁外运行，故同波互不依赖的任务可真正并行。
  private async dispatchItem(
    store: TaskStore,
    planId: string,
    itemId: string,
    timeoutSeconds: number,
    signal: AbortSignal | undefined,
    parentTraceId: string,
    emit?: DispatchEmit,
  ): Promise<void> {
    const operationId = randomUUID();
    // 无父操作（直接调用）时退化为每条目独立 trace；编排派发时沿用父 task_plan 的 trace 关联。
    const traceId = parentTraceId || randomUUID();
    const lockKey = `${store.plansDir}/${planId}`;
    // 阶段进度事件（OP6-C）：带 item 标识，progress 统一按计划终态项占比（progressOf）。
    const stageEmit = (plan: TaskPlan, message: string) =>
      emit?.({ kind: 'progress', progress: progressOf(plan), message, summary: summaryOf(plan) });

    // 阶段 1（锁内）：pending→queued→planning，返回该 item 推进后的状态。
    let status = await this.withPlanLock(lockKey, async () => {
      let plan = await store.get(planId);
      let item = this.findItem(plan, itemId);
      if (item.status === 'pending') {
        plan = await store.transitionItem(planId, itemId, 'queued');
        item = this.findItem(plan, itemId);
      }
      if (item.status === 'queued') {
        plan = await store.transitionItem(planId, itemId, 'planning');
        item = this.findItem(plan, itemId);
      }
      return item.status; // planning | awaiting_confirmation | developing（重跑）
    });

    // 规划门脏审计（T02）：仅本次进入 planning 才做。worker 被指示「只出计划不改文件」，
    // 前后快照硬兜底——违背只读指示则 planning→failed。
    if (status === 'planning') {
      const item = this.findItem(await store.get(planId), itemId);
      stageEmit(await store.get(planId), `[${item.id}]「${item.title}」规划中…`);
      const { registry } = await this.getAgent(item.agent);
      const workspace = registry.workspace.path;
      const beforeHash = await snapshotWorkspaceHash(workspace);
      const beforeGit = await gitStatusShort(workspace);
      const planning = await this.runAgent(item.agent, planningPrompt(item), timeoutSeconds, {
        operationId,
        traceId,
        ...(signal ? { signal } : {}),
      });
      const afterHash = await snapshotWorkspaceHash(workspace);
      const afterGit = await gitStatusShort(workspace);
      const dirty =
        planning.exitCode !== 0 || beforeHash !== afterHash || !gitStateEqual(beforeGit, afterGit);
      // 阶段 2（锁内）：提交规划结果——脏/失败→failed；干净→awaiting_confirmation→developing。
      status = await this.withPlanLock(lockKey, async () => {
        if (dirty) {
          await store.transitionItem(planId, itemId, 'failed', {
            exit_code: planning.exitCode,
            review: { verdict: 'rejected', note: '规划阶段违背只读指示（脏审计）或规划失败。' },
          });
          stageEmit(
            await store.get(planId),
            `[${item.id}]「${item.title}」规划失败（脏审计：规划阶段改动了文件）`,
          );
          return 'failed';
        }
        await store.transitionItem(planId, itemId, 'awaiting_confirmation');
        await store.transitionItem(planId, itemId, 'developing');
        stageEmit(await store.get(planId), `[${item.id}]「${item.title}」规划完成，进入执行`);
        return 'developing';
      });
    }

    if (status === 'failed') return;
    if (status === 'awaiting_confirmation') {
      // 重跑：计划级确认门已在 confirmPlan 完成，故 item 级 awaiting_confirmation 自动推进到 developing。
      status = await this.withPlanLock(lockKey, async () => {
        const item = this.findItem(await store.get(planId), itemId);
        if (item.status === 'awaiting_confirmation') {
          await store.transitionItem(planId, itemId, 'developing');
          return 'developing';
        }
        return item.status;
      });
    }

    // 阶段 3（锁外）：worker 实际执行（并发窗口）。此刻 item.status === 'developing'。
    const item = this.findItem(await store.get(planId), itemId);
    stageEmit(await store.get(planId), `[${item.id}]「${item.title}」执行中…`);
    const dev = await this.runAgent(item.agent, item.prompt, timeoutSeconds, {
      operationId,
      traceId,
      ...(signal ? { signal } : {}),
    });

    // 阶段 4（锁内）：提交执行结果——成功后记录 worker stdout（供审查门单向搬运）→awaiting_review。
    await this.withPlanLock(lockKey, async () => {
      if (this.findItem(await store.get(planId), itemId).status !== 'developing') return;
      if (dev.exitCode === 0) {
        // worker 工作区保持只读给编排器；stdout 记到计划目录供审查门读取。
        const resultFile = path.join(store.plansDir, planId, `${itemId}.result`);
        await fs.ensureDir(path.dirname(resultFile));
        await fs.writeFile(resultFile, await fs.readFile(dev.stdoutFile, 'utf8').catch(() => ''), {
          mode: 0o600,
        });
        await store.transitionItem(planId, itemId, 'awaiting_review', { exit_code: 0 });
        stageEmit(await store.get(planId), `[${item.id}]「${item.title}」执行完成`);
      } else {
        await store.transitionItem(planId, itemId, 'failed', { exit_code: dev.exitCode });
        stageEmit(
          await store.get(planId),
          `[${item.id}]「${item.title}」执行失败（exit=${dev.exitCode}）`,
        );
      }
    });
  }

  // 从计划中取任务项助手；缺失抛 NOT_FOUND（替代散落的 `!` 非空断言）。
  private findItem(plan: TaskPlan, itemId: string): TaskItem {
    const item = plan.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new AgentCtlError('NOT_FOUND', `任务项不存在：${itemId}`);
    return item;
  }

  // 审查门（D-017 单向搬运）：对 awaiting_review 项读 worker 的 git diff + result 文件，脱敏后喂 Chief
  // 取回结构化 verdict+note，写入 item.review（item 停留 awaiting_review 待人工确认合并）。
  async reviewTaskPlan(ownerId: string, chiefId: string, planId: string): Promise<TaskPlan> {
    const store = await this.plans(ownerId);
    let plan = await store.get(planId);
    const { agent: chiefAgent } = await this.getAgent(chiefId);
    const awaiting = plan.items.filter((item) => item.status === 'awaiting_review');
    for (const item of awaiting) {
      const { registry } = await this.getAgent(item.agent);
      const diff = redactSecrets(await gitDiff(registry.workspace.path));
      const stdout = redactSecrets(
        await fs
          .readFile(path.join(store.plansDir, planId, `${item.id}.result`), 'utf8')
          .catch(() => ''),
      );
      const result = await this.runAgent(chiefId, reviewPrompt(plan, item, diff, stdout), 900, {
        operationId: randomUUID(),
        traceId: randomUUID(),
      });
      const text = parseStructuredResult(
        chiefAgent.runtime.provider,
        await fs.readFile(result.stdoutFile, 'utf8').catch(() => ''),
      );
      await store.updateItem(planId, item.id, { review: parseReview(text) });
    }
    return store.get(planId);
  }

  // 审查门人工合并：确认合并→completed；驳回→developing（返工，可附 note）。
  async confirmReview(ownerId: string, planId: string, itemId: string): Promise<TaskPlan> {
    return (await this.plans(ownerId)).transitionItem(planId, itemId, 'completed');
  }

  async rejectReview(
    ownerId: string,
    planId: string,
    itemId: string,
    note?: string,
  ): Promise<TaskPlan> {
    const store = await this.plans(ownerId);
    let plan = await store.transitionItem(planId, itemId, 'developing');
    if (note) {
      plan = await store.updateItem(planId, itemId, { review: { verdict: 'rejected', note } });
    }
    return plan;
  }

  // Chief 拆解：跑 Chief 读取目标产出结构化任务列表。解析失败回落为可编辑空计划（不抛错）。
  async planWithChief(
    chiefId: string,
    goal: string,
  ): Promise<{ plan: TaskPlan; source: 'chief' | 'manual-fallback' }> {
    if (!goal.trim()) throw new AgentCtlError('VALIDATION_ERROR', '目标不能为空。');
    const planId = `plan-${randomUUID().slice(0, 8)}`;
    const plan = await this.createTaskPlan(chiefId, {
      id: planId,
      name: goal.trim().slice(0, 60),
    });
    const { agent } = await this.getAgent(chiefId);
    const agents = await this.listAgents();
    const agentIds = agents.map((a) => `${a.id}(${a.role})`).join(', ');
    const result = await this.runAgent(chiefId, decomposePrompt(goal, agentIds), 900, {
      operationId: randomUUID(),
      traceId: randomUUID(),
    });
    const text = parseStructuredResult(
      agent.runtime.provider,
      await fs.readFile(result.stdoutFile, 'utf8').catch(() => ''),
    );
    const items = parseDecompose(text);
    if (items.length === 0) return { plan, source: 'manual-fallback' };
    let current = plan;
    let index = 0;
    for (const item of items) {
      index += 1;
      const exists = await this.getAgent(item.agent)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue; // 未知员工跳过该项
      current = await this.addTaskItem(chiefId, planId, {
        id: `item-${index}`,
        title: item.title,
        agent: item.agent,
        prompt: item.prompt,
        ...(item.dependencies && item.dependencies.length > 0
          ? { dependencies: item.dependencies }
          : {}),
      });
    }
    return { plan: current, source: 'chief' };
  }

  // Web 发起入口（D-024）：把「Chief 拆解」放进后台 Operation，避免同步阻塞 HTTP。
  // 拆解完成后停在 draft 等人工确认（confirm/reject 由 Web 显式调用，等价 CLI 的 inquirer 门）。
  // concurrency 仅作参数透传，派发时由 runTaskPlan 使用——Web 侧发起目标时不派发。
  async startPlanWithChief(
    chiefId: string,
    goal: string,
    _options: { concurrency?: number } = {},
  ): Promise<OperationDto> {
    return this.operationManager.start('task_plan', chiefId, async () => {
      await this.planWithChief(chiefId, goal);
      return { exitCode: 0 };
    });
  }

  // 顶层一句话闭环：planWithChief → 等确认（confirm 回调）→ 派发 → 交叉审查。审查合并留给调用方。
  // 派发以后台 Operation 执行；orchestrate 自身保持同步（交互确认门），内部 await 派发终态后返回
  // 最终计划并附 operation（OperationDto，供进度/取消观测）。onProgress 在派发期间逐进度回调
  // （summary 字符串），供 CLI 打印进度行。
  async orchestrate(
    chiefId: string,
    goal: string,
    options: {
      concurrency?: number;
      confirm?: (plan: TaskPlan) => Promise<boolean>;
      onProgress?: (summary: string) => void;
    } = {},
  ): Promise<{
    plan: TaskPlan;
    source: 'chief' | 'manual-fallback';
    confirmed: boolean;
    operation?: OperationDto;
  }> {
    const { plan, source } = await this.planWithChief(chiefId, goal);
    const confirm = options.confirm ?? (async () => true);
    const ok = await confirm(plan);
    if (!ok) return { plan, source, confirmed: false };
    await this.confirmPlan(chiefId, plan.id);
    const operation = await this.runTaskPlan(chiefId, plan.id, {
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    });
    // 订阅派发进度（summary）回调，终态后取消。
    const unsubscribe = this.operationManager.subscribe(operation.id, (event) => {
      if (typeof event.summary === 'string') options.onProgress?.(event.summary);
    });
    try {
      await this.waitOperation(operation.id);
    } finally {
      unsubscribe();
    }
    // 取 live 终态 DTO（runTaskPlan 返回的只是排队态快照）
    const finalOperation = this.operationManager.get(operation.id);
    await this.reviewTaskPlan(chiefId, chiefId, plan.id);
    return {
      plan: await this.getTaskPlan(chiefId, plan.id),
      source,
      confirmed: true,
      operation: finalOperation,
    };
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
