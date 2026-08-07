import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Archive,
  Bot,
  CheckCircle2,
  FileText,
  LockKeyhole,
  MessageSquare,
  Play,
  PlugZap,
  RefreshCw,
  Square,
  Store,
  Terminal,
  Trash2,
  Activity,
} from 'lucide-react';
import {
  api,
  type AgentDetail,
  type AgentDocument,
  type EvolutionLog,
  type JobConfig,
  type OperationDto,
  type SkillMetadata,
  type SkillScope,
} from '../api.js';
import { CopyButton } from '../components/CopyButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { PromptDialog } from '../components/PromptDialog.js';
import { notify } from '../components/ToastFeedback.js';
import { AgentStatusBadge } from '../components/StatusBadge.js';
import { EmptyState } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Switch } from '../components/ui/switch.js';
import { cn } from '../lib/utils.js';

interface AgentDetailPageProps {
  agentId: string;
}

const documentKeys = [
  ['role', '岗位'],
  ['goals', '目标'],
  ['operating-system', '工作系统'],
  ['policies', '规则'],
  ['current-state', '当前状态'],
] as const;

function Command({ children }: { children: string }) {
  return (
    <code className="flex shrink-0 items-center gap-2 rounded-md bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
      {children}
      <CopyButton text={children} />
    </code>
  );
}

function OverviewTab({
  detail,
  guidance,
  reload,
}: {
  detail: AgentDetail;
  guidance: { runtimeLogin: string; bridgeAuthorize: string; chat: string };
  reload: () => Promise<void>;
}) {
  const registry = detail.registry;
  const provider = detail.agent.runtime.provider === 'claude' ? 'Claude' : 'Codex';
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<'start' | 'stop' | 'restart'>();
  const [feedback, setFeedback] = useState('');
  const [trashing, setTrashing] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const terminalGuidance = [
    {
      label: detail.agent.runtime.provider === 'claude' ? '同步 CC Switch Provider' : '登录 Codex',
      description:
        detail.agent.runtime.provider === 'claude'
          ? '读取 CC Switch 当前 Claude Provider，并安全同步到该员工的隔离环境。'
          : '首次使用或登录失效时执行；登录该员工专属的 Codex 环境。',
      command: guidance.runtimeLogin,
    },
    {
      label: '授权飞书机器人',
      description: registry.bridge.enabled
        ? '启用飞书后执行；通过扫码或应用授权，让该员工连接独立飞书机器人。'
        : '当前员工未启用飞书，无需执行；如后续启用，再运行此授权命令。',
      command: guidance.bridgeAuthorize,
    },
    {
      label: '开始终端对话',
      description: 'Provider 同步或登录完成后执行；在员工 Workspace 中开启交互会话。',
      command: guidance.chat,
    },
  ];
  const action = async (name: 'start' | 'stop' | 'restart') => {
    setError('');
    setFeedback('');
    setPendingAction(name);
    try {
      const result = await api.lifecycle(registry.id, name);
      await reload();
      const label = { start: '启动', stop: '停止', restart: '重启' }[name];
      const state = result.state === 'running' ? '运行中' : '已停止';
      setFeedback(`${label}成功，当前状态：${state}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingAction(undefined);
    }
  };
  const trash = async () => {
    setError('');
    setTrashing(true);
    try {
      await api.trashAgent(registry.id);
      notify.success(`已将 ${registry.name} 移入回收站`);
      window.location.hash = '#/agents';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setTrashing(false);
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(pendingAction) || registry.status === 'running'}
          onClick={() => void action('start')}
        >
          <Play className="size-4" />
          {pendingAction === 'start' ? '启动中…' : '启动'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(pendingAction) || registry.status === 'stopped'}
          onClick={() => void action('stop')}
        >
          <Square className="size-4" />
          {pendingAction === 'stop' ? '停止中…' : '停止'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(pendingAction)}
          onClick={() => void action('restart')}
        >
          <RefreshCw className="size-4" />
          {pendingAction === 'restart' ? '重启中…' : '重启'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setArchiveOpen(true)}>
          <Archive className="size-4" />
          归档
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={trashing || Boolean(pendingAction)}
          onClick={() => setTrashOpen(true)}
        >
          <Trash2 className="size-4" />
          {trashing ? '正在移入…' : '移入回收站'}
        </Button>
      </div>

      {feedback && (
        <div
          className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary"
          role="status"
        >
          {feedback}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">隔离运行环境</h2>
            <LockKeyhole className="size-4 text-muted-foreground" />
          </div>
          <dl className="divide-y divide-border">
            {[
              {
                icon: Bot,
                label: 'Runtime',
                value: `${provider} · ${detail.agent.runtime.model ?? 'CLI 默认模型'}`,
              },
              { icon: LockKeyhole, label: '策略', value: '运行器已锁定' },
              {
                icon: Terminal,
                label: 'Runtime Home',
                value: registry.runtime_home.path,
                mono: true,
              },
              {
                icon: PlugZap,
                label: 'Bridge',
                value: registry.bridge.enabled ? registry.bridge.authorization : '未启用',
              },
            ].map(({ icon: Icon, label: l, value, mono }) => (
              <div key={l} className="flex items-center gap-3 px-5 py-3.5">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted-foreground">{l}</span>
                  <strong className={cn('block truncate text-sm font-medium', mono && 'font-mono')}>
                    {value}
                  </strong>
                </span>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">终端操作引导</h2>
            <MessageSquare className="size-4 text-muted-foreground" />
          </div>
          <div className="space-y-3 p-5">
            <p className="text-xs text-muted-foreground">
              涉及凭据、扫码或交互会话的操作始终在隔离终端中执行。复制命令后粘贴到本机终端运行。
            </p>
            {terminalGuidance.map(({ label, description, command }) => (
              <div
                key={command}
                className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <strong className="block text-sm font-medium">{label}</strong>
                  <small className="block text-xs text-muted-foreground">{description}</small>
                </div>
                <Command>{command}</Command>
              </div>
            ))}
          </div>
        </section>
      </div>

      <PromptDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="归档员工"
        description="归档会停止该员工并将其移出活跃列表，属于非破坏性操作。"
        expected={registry.id}
        expectedLabel="员工 ID"
        confirmLabel="确认归档"
        onConfirm={async () => {
          await api.lifecycle(registry.id, 'archive', registry.id);
          setArchiveOpen(false);
          await reload();
          notify.success('员工已归档');
        }}
      />

      <ConfirmDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title="移入回收站"
        description={`将 ${registry.name} 的 Workspace、Runtime、飞书配置、日志和任务全部移入回收站？7 天内可以恢复。`}
        confirmLabel="确认移入回收站"
        busy={trashing}
        onConfirm={() => void trash()}
      />
    </div>
  );
}

function DocumentsTab({ agentId }: { agentId: string }) {
  const [key, setKey] = useState<string>('role');
  const [document, setDocument] = useState<AgentDocument>();
  const [error, setError] = useState('');
  const load = async (nextKey: string) => {
    setError('');
    try {
      const value = await api.readDocument(agentId, nextKey);
      setDocument(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load(key);
  }, [agentId, key]);
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="flex flex-col gap-1">
        {documentKeys.map(([value, label]) => (
          <button
            type="button"
            key={value}
            onClick={() => setKey(value)}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
              key === value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            <FileText className="size-4" />
            {label}
          </button>
        ))}
      </aside>
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">
              {documentKeys.find(([value]) => value === key)?.[1]}
              <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                （只读）
              </span>
            </h2>
            <span className="text-xs text-muted-foreground">
              {document?.path}
              {document?.dirty ? ' · Git 未提交' : ''}
            </span>
          </div>
          {document?.dirty && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
              工作区有未提交改动
            </span>
          )}
        </div>
        {error && (
          <div className="mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <article className="max-h-[560px] overflow-auto p-5 text-sm leading-relaxed [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-code [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:text-code-ink [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
          <ReactMarkdown>{document?.content ?? ''}</ReactMarkdown>
        </article>
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          身份文档只能通过飞书聊天修改（向员工提出变更，经批准后由员工更新）。
        </p>
      </section>
    </div>
  );
}

function JobsTab({ agentId }: { agentId: string }) {
  const [jobs, setJobs] = useState<JobConfig[]>([]);
  const [error, setError] = useState('');
  const load = async () => setJobs(await api.listJobs(agentId));
  useEffect(() => {
    void load().catch((cause: unknown) => setError(String(cause)));
  }, [agentId]);
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">定时任务</h2>
          <span className="text-xs text-muted-foreground">由员工（AI）自行配置 · 只读展示</span>
        </div>
      </div>
      {error && (
        <div className="mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="p-5">
        {jobs.length === 0 ? (
          <EmptyState
            icon={<Terminal className="size-5" />}
            title="暂无定时任务"
            description="员工（AI）会自行配置定时任务，此处只读展示。"
          />
        ) : (
          <ul className="divide-y divide-border">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <strong className="text-sm font-medium">{job.id}</strong>
                  <span
                    className={cn(
                      'ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                      job.managed_by === 'employee'
                        ? 'bg-warning/15 text-warning'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {job.managed_by === 'employee' ? '员工' : '管理员'}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    每天 {job.schedule.time} · {job.execution.type}
                  </span>
                </div>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    job.enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {job.enabled ? 'enabled' : 'disabled'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SkillsTab({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [scope, setScope] = useState<SkillScope>('project');
  const [error, setError] = useState('');
  const load = async () => setSkills(await api.listSkills(agentId));
  useEffect(() => {
    void load().catch((cause: unknown) => setError(String(cause)));
  }, [agentId]);
  const groups: Array<{ scope: SkillScope; label: string; hint: string }> = [
    { scope: 'project', label: '项目级', hint: '随工作区版本管理，进入默认备份' },
    { scope: 'user', label: '用户级', hint: '员工运行时身份，仅随 Runtime 备份' },
  ];
  const items = skills.filter((skill) => skill.scope === scope);
  const activeGroup = groups.find((group) => group.scope === scope)!;
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">Skills</h2>
          <span className="text-xs text-muted-foreground">
            由员工（AI）自主生成/沉淀 · 只读展示
          </span>
        </div>
      </div>
      <div className="flex gap-1 border-b border-border px-5 py-3">
        {groups.map(({ scope: s, label }) => (
          <button
            type="button"
            key={s}
            onClick={() => setScope(s)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              scope === s
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="mx-5 mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="p-5">
        <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <strong className="text-sm font-medium text-foreground">{activeGroup.label}</strong>
          <span>{activeGroup.hint}</span>
          <em className="ml-auto not-italic">{items.length}</em>
        </div>
        {items.length === 0 ? (
          <EmptyState
            icon={<Store className="size-5" />}
            title={`暂无 ${activeGroup.label} Skill`}
            description="员工（AI）会在工作中自主生成并沉淀 Skill，此处只读展示。"
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((skill) => (
              <li key={skill.name} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <strong className="text-sm font-medium">{skill.name}</strong>
                  <span className="ml-2 text-xs text-muted-foreground">
                    v{skill.version} · {skill.digest.slice(0, 12)}
                  </span>
                </div>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    scope === 'project'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {activeGroup.label}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
        Skill 的安装、导入与卸载由员工（AI）自主管理，Web 只读展示。
      </p>
    </section>
  );
}

function LogsTab({ agentId }: { agentId: string }) {
  const [log, setLog] = useState<{ file: string; content: string }>();
  const [error, setError] = useState('');
  const [following, setFollowing] = useState(false);
  const load = async () => {
    try {
      setLog(await api.latestLog(agentId));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load();
  }, [agentId]);
  useEffect(() => {
    if (!following) return;
    const source = new EventSource(
      `/api/v1/agents/${encodeURIComponent(agentId)}/logs/stream?lines=500`,
    );
    source.onmessage = (message) => {
      setLog(JSON.parse(message.data) as { file: string; content: string });
      setError('');
    };
    source.onerror = () => setError('日志跟随已断开，浏览器将自动重连。');
    return () => source.close();
  }, [agentId, following]);
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">最近日志</h2>
          <span className="text-xs text-muted-foreground">{log?.file ?? '尚无日志文件'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setFollowing(!following)}>
            <Activity className="size-4" />
            {following ? '停止跟随' : '实时跟随'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>
      {error ? (
        <div className="p-5">
          <EmptyState icon={<Terminal className="size-5" />} title={error} />
        </div>
      ) : (
        <pre className="max-h-[560px] overflow-auto p-5 font-mono text-[11px] leading-relaxed text-code-ink">
          {log?.content}
        </pre>
      )}
    </section>
  );
}

function BackupTab({ agentId }: { agentId: string }) {
  const [operation, setOperation] = useState<OperationDto>();
  const [includeRuntime, setIncludeRuntime] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    setError('');
    try {
      if (includeRuntime && passphrase.length < 8) {
        setError('包含 Runtime 时需要至少 8 位的加密密码。');
        return;
      }
      setOperation(await api.createBackup(agentId, includeRuntime, passphrase || undefined));
      setPassphrase('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">员工备份</h2>
          <span className="text-xs text-muted-foreground">默认排除 Runtime、日志和 Secret</span>
        </div>
        <Button onClick={() => void create()}>创建备份</Button>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <span>
            <strong className="block text-sm font-medium">包含 Runtime</strong>
            <small className="block text-xs text-muted-foreground">
              强制使用 scrypt + AES-256-GCM 加密
            </small>
          </span>
          <Switch
            checked={includeRuntime}
            onCheckedChange={setIncludeRuntime}
            aria-label="包含 Runtime"
          />
        </div>
        {includeRuntime && (
          <div className="grid gap-1.5">
            <Label htmlFor="backup-passphrase">当次备份密码</Label>
            <Input
              id="backup-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {operation ? (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary">
            备份任务已提交：{operation.id}
          </div>
        ) : (
          <EmptyState
            icon={<Archive className="size-5" />}
            title="创建可迁移备份"
            description="备份包含 Workspace、Git、正式记忆、Job 和脱敏配置。"
          />
        )}
      </div>
    </section>
  );
}

function DoctorTab({ agentId }: { agentId: string }) {
  const [operation, setOperation] = useState<OperationDto>();
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">员工诊断</h2>
          <span className="text-xs text-muted-foreground">只诊断，不静默修复</span>
        </div>
        <Button
          onClick={async () => {
            const next = await api.runDoctor(agentId);
            setOperation(next);
          }}
        >
          运行 Doctor
        </Button>
      </div>
      <div className="p-5">
        {operation && (
          <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary">
            诊断任务 {operation.id} 已进入操作中心。
          </div>
        )}
        <EmptyState
          icon={<CheckCircle2 className="size-5" />}
          title="检查身份与运行隔离"
          description="覆盖 Schema、Registry、Runtime、Bridge、launchd、日志和敏感文件。"
        />
      </div>
    </section>
  );
}

// D-041 P3-1：员工「进化历史」只读 tab——evolve: 提交流（可回溯）+ CURRENT_STATE 全文 + 使用统计。
// 纯展示：不提供任何编辑/回滚入口，人工修正走飞书聊天或 CLI（agentctl identity rollback）。
function EvolutionTab({ agentId }: { agentId: string }) {
  const [data, setData] = useState<EvolutionLog>();
  const [error, setError] = useState('');
  const load = async () => {
    try {
      setData(await api.evolutionLog(agentId));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load();
  }, [agentId]);
  const commits = data?.commits ?? [];
  const usage = data?.usage ?? [];
  const totalMessages = usage.reduce((sum, row) => sum + row.count, 0);
  const totalCost = usage.reduce((sum, row) => sum + row.totalCostUsd, 0);
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">进化历史</h2>
          <span className="text-xs text-muted-foreground">
            只读——evolve: 自进化提交与工作区状态
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>
      {error ? (
        <div className="p-5">
          <EmptyState icon={<Activity className="size-5" />} title={error} />
        </div>
      ) : !data ? (
        <div className="p-5">
          <EmptyState icon={<Activity className="size-5" />} title="加载中…" />
        </div>
      ) : (
        <div className="grid gap-5 p-5 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              自进化提交（{commits.length}）
            </h3>
            {commits.length === 0 ? (
              <p className="text-sm text-muted-foreground">尚无 evolve: 提交。</p>
            ) : (
              <ul className="max-h-[420px] space-y-2 overflow-auto pr-1">
                {commits.map((commit) => (
                  <li
                    key={commit.hash}
                    className="rounded-md border border-border bg-card px-3 py-2 text-sm"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-mono text-xs">{commit.subject}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {commit.hash.slice(0, 7)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {new Date(commit.date).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mb-2 mt-5 text-xs font-semibold uppercase text-muted-foreground">
              使用统计（{totalMessages} 条消息）
            </h3>
            {usage.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无使用记录。</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">日期</th>
                    <th className="py-1 pr-2 font-medium">消息</th>
                    <th className="py-1 pr-2 font-medium">平均耗时</th>
                    <th className="py-1 font-medium">费用</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.slice(0, 14).map((row) => (
                    <tr key={row.day} className="border-t border-border">
                      <td className="py-1 pr-2 font-mono">{row.day}</td>
                      <td className="py-1 pr-2">{row.count}</td>
                      <td className="py-1 pr-2">{(row.avgDurationMs / 1000).toFixed(1)}s</td>
                      <td className="py-1">${row.totalCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              合计费用：${totalCost.toFixed(4)}
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              当前状态（CURRENT_STATE.md）
            </h3>
            <div className="max-h-[560px] overflow-auto rounded-md border border-border bg-muted/40 p-4 text-sm leading-relaxed">
              {data.currentState.trim() ? (
                <ReactMarkdown>{data.currentState}</ReactMarkdown>
              ) : (
                <p className="text-muted-foreground">尚无当前状态记录。</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function AgentDetailPage({ agentId }: AgentDetailPageProps) {
  const [detail, setDetail] = useState<AgentDetail>();
  const [guidance, setGuidance] = useState<{
    runtimeLogin: string;
    bridgeAuthorize: string;
    chat: string;
  }>();
  const [tab, setTab] = useState<string>('概览');
  const [error, setError] = useState('');
  const load = async () => {
    const [agent, commands] = await Promise.all([
      api.getAgent(agentId),
      api.terminalGuidance(agentId),
    ]);
    setDetail(agent);
    setGuidance(commands);
  };
  useEffect(() => {
    void load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [agentId]);
  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!detail || !guidance) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl border border-border bg-muted" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-muted" />
      </div>
    );
  }
  const registry = detail.registry;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-lg font-semibold text-primary">
          {registry.name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-muted-foreground">{registry.id}</p>
          <h1 className="text-xl font-semibold tracking-tight">{registry.name}</h1>
          <p className="text-sm text-muted-foreground">{detail.agent.description}</p>
        </div>
        <AgentStatusBadge status={registry.status} />
      </header>

      <nav
        aria-label="员工详情"
        className="-mb-px flex gap-1 overflow-x-auto border-b border-border"
      >
        {['概览', '身份文档', '任务', 'Skills', '日志', '备份', '诊断', '进化历史'].map((item) => (
          <button
            key={item}
            type="button"
            aria-current={tab === item ? 'true' : undefined}
            onClick={() => setTab(item)}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-sm transition-colors',
              tab === item
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="mt-6">
        {tab === '概览' && <OverviewTab detail={detail} guidance={guidance} reload={load} />}
        {tab === '身份文档' && <DocumentsTab agentId={agentId} />}
        {tab === '任务' && <JobsTab agentId={agentId} />}
        {tab === 'Skills' && <SkillsTab agentId={agentId} />}
        {tab === '日志' && <LogsTab agentId={agentId} />}
        {tab === '备份' && <BackupTab agentId={agentId} />}
        {tab === '诊断' && <DoctorTab agentId={agentId} />}
        {tab === '进化历史' && <EvolutionTab agentId={agentId} />}
      </div>
    </div>
  );
}
