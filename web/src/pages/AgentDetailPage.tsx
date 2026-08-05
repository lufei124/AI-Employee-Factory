import { useState, useRef, useEffect, Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import YAML from 'yaml';
import {
  Activity,
  Archive,
  Bot,
  CheckCircle2,
  FileText,
  ListTodo,
  LockKeyhole,
  MessageSquare,
  Play,
  PlugZap,
  RefreshCw,
  Save,
  Square,
  Store,
  Terminal,
  Trash2,
  Upload,
  Workflow,
  XCircle,
} from 'lucide-react';
import {
  api,
  type AgentDetail,
  type AgentDocument,
  type JobConfig,
  type OperationDto,
  type SkillMetadata,
  type SkillScope,
  type TaskItem,
  type TaskPlan,
} from '../api.js';
import { CopyButton } from '../components/CopyButton.js';

interface AgentDetailPageProps {
  agentId: string;
}

const tabs = ['概览', '身份文档', '任务', 'Todo', 'Skills', '日志', '备份', '诊断'] as const;
type Tab = (typeof tabs)[number] | 'Chief 编排';

const documentKeys = [
  ['role', '岗位'],
  ['goals', '目标'],
  ['operating-system', '工作系统'],
  ['policies', '规则'],
  ['current-state', '当前状态'],
] as const;

function Command({ children }: { children: string }) {
  return (
    <code>
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
  const [task, setTask] = useState('');
  const [operation, setOperation] = useState<OperationDto>();
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
  return (
    <>
      <div className="action-bar">
        <button
          className="button secondary"
          disabled={Boolean(pendingAction) || registry.status === 'running'}
          onClick={() => void action('start')}
        >
          <Play size={15} />
          {pendingAction === 'start' ? '启动中…' : '启动'}
        </button>
        <button
          className="button secondary"
          disabled={Boolean(pendingAction) || registry.status === 'stopped'}
          onClick={() => void action('stop')}
        >
          <Square size={15} />
          {pendingAction === 'stop' ? '停止中…' : '停止'}
        </button>
        <button
          className="button ghost"
          disabled={Boolean(pendingAction)}
          onClick={() => void action('restart')}
        >
          <RefreshCw size={15} />
          {pendingAction === 'restart' ? '重启中…' : '重启'}
        </button>
        <button
          className="button ghost danger-text"
          onClick={async () => {
            const confirmation = window.prompt(`输入 ${registry.id} 以确认非破坏性归档`);
            if (confirmation === registry.id) {
              await api.lifecycle(registry.id, 'archive', confirmation);
              await reload();
            }
          }}
        >
          <Archive size={15} />
          归档
        </button>
        <button
          className="button ghost danger-text"
          disabled={trashing || Boolean(pendingAction)}
          onClick={async () => {
            if (
              !window.confirm(
                `将 ${registry.name} 的 Workspace、Runtime、飞书配置、日志和任务全部移入回收站？7 天内可以恢复。`,
              )
            )
              return;
            setError('');
            setTrashing(true);
            try {
              await api.trashAgent(registry.id);
              window.location.hash = '#/agents';
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setTrashing(false);
            }
          }}
        >
          <Trash2 size={15} />
          {trashing ? '正在移入…' : '移入回收站'}
        </button>
      </div>
      {feedback && (
        <div className="notice info" role="status">
          {feedback}
        </div>
      )}
      {error && <div className="notice danger">{error}</div>}
      <div className="detail-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>隔离运行环境</h2>
            <LockKeyhole size={18} />
          </div>
          <div className="fact-list">
            <div>
              <Bot />
              <span>
                Runtime
                <strong>
                  {provider} · {detail.agent.runtime.model ?? 'CLI 默认模型'}
                </strong>
              </span>
            </div>
            <div>
              <LockKeyhole />
              <span>
                策略<strong>运行器已锁定</strong>
              </span>
            </div>
            <div>
              <Terminal />
              <span>
                Runtime Home<code>{registry.runtime_home.path}</code>
              </span>
            </div>
            <div>
              <PlugZap />
              <span>
                Bridge
                <strong>
                  {registry.bridge.enabled ? registry.bridge.authorization : '未启用'}
                </strong>
              </span>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>终端操作引导</h2>
            <MessageSquare size={18} />
          </div>
          <p className="muted">
            涉及凭据、扫码或交互会话的操作始终在隔离终端中执行。复制命令后粘贴到本机终端运行。
          </p>
          <div className="command-list">
            {terminalGuidance.map(({ label, description, command }) => (
              <div className="onboarding-command terminal-command" key={command}>
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <Command>{command}</Command>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="panel run-panel">
        <div className="panel-heading">
          <div>
            <h2>执行一次性任务</h2>
            <span>输出会实时进入操作中心，并完整写入隔离日志</span>
          </div>
        </div>
        <textarea
          aria-label="任务内容"
          rows={4}
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="例如：整理今天的用户反馈并给出优先级建议"
        />
        <div className="wizard-actions">
          <span>{operation ? `Operation ${operation.id}` : '默认超时 900 秒'}</span>
          <button
            className="button primary"
            disabled={!task.trim()}
            onClick={async () => {
              setOperation(await api.runAgent(registry.id, task));
              setTask('');
            }}
          >
            <Play size={15} />
            运行任务
          </button>
        </div>
      </section>
    </>
  );
}

function DocumentsTab({ agentId }: { agentId: string }) {
  const [key, setKey] = useState<string>('role');
  const [document, setDocument] = useState<AgentDocument>();
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const load = async (nextKey: string) => {
    setError('');
    try {
      const value = await api.readDocument(agentId, nextKey);
      setDocument(value);
      setContent(value.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void load(key);
  }, [agentId, key]);
  const save = async () => {
    try {
      const saved = await api.saveDocument(agentId, key, content);
      setDocument(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="document-layout">
      <aside className="document-nav">
        {documentKeys.map(([value, label]) => (
          <button
            className={key === value ? 'active' : ''}
            onClick={() => setKey(value)}
            key={value}
          >
            <FileText size={16} />
            {label}
          </button>
        ))}
      </aside>
      <section className="panel editor-panel">
        <div className="panel-heading">
          <div>
            <h2>{documentKeys.find(([value]) => value === key)?.[1]}</h2>
            <span>
              {document?.path}
              {document?.dirty ? ' · Git 未提交' : ''}
            </span>
          </div>
          <button className="button primary" onClick={() => void save()}>
            <Save size={15} />
            保存
          </button>
        </div>
        {error && <div className="notice danger">{error}</div>}
        <div className="editor-split">
          <textarea
            aria-label="Markdown 内容"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <article className="markdown-preview">
            <ReactMarkdown>{content}</ReactMarkdown>
          </article>
        </div>
      </section>
    </div>
  );
}

function JobsTab({ agentId }: { agentId: string }) {
  const [jobs, setJobs] = useState<JobConfig[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [kind, setKind] = useState<'agent' | 'script'>('agent');
  const [id, setId] = useState('');
  const [time, setTime] = useState('09:00');
  const [file, setFile] = useState('prompts/daily.md');
  const [timeout, setTimeoutValue] = useState(900);
  const [interpreter, setInterpreter] = useState<'node' | 'bash' | 'direct'>('node');
  const [args, setArgs] = useState('');
  const [precheck, setPrecheck] = useState(false);
  const [precheckFile, setPrecheckFile] = useState('scripts/precheck.mjs');
  const [noDataExitCode, setNoDataExitCode] = useState(3);
  const [error, setError] = useState('');
  const load = async () => setJobs(await api.listJobs(agentId));
  useEffect(() => {
    void load().catch((cause: unknown) => setError(String(cause)));
  }, [agentId]);
  const save = async () => {
    const base = {
      schema_version: 1 as const,
      id,
      enabled: false,
      schedule: { type: 'daily' as const, time },
    };
    const parsedArgs = args.split(/\s+/).filter(Boolean);
    const job: JobConfig =
      kind === 'agent'
        ? {
            ...base,
            execution: {
              type: 'agent',
              prompt_file: file,
              timeout_seconds: timeout,
              concurrency: 'forbid',
              ...(precheck
                ? {
                    precheck: {
                      script_file: precheckFile,
                      interpreter,
                      args: parsedArgs,
                      no_data_exit_code: noDataExitCode,
                    },
                  }
                : {}),
            },
          }
        : {
            ...base,
            execution: {
              type: 'script',
              script_file: file,
              interpreter,
              args: parsedArgs,
              timeout_seconds: timeout,
              concurrency: 'forbid',
            },
          };
    try {
      if (editingId) await api.updateJob(agentId, job);
      else await api.createJob(agentId, job);
      setShowForm(false);
      setEditingId(undefined);
      setId('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const edit = (job: JobConfig) => {
    setEditingId(job.id);
    setId(job.id);
    setTime(job.schedule.time);
    setKind(job.execution.type);
    setTimeoutValue(job.execution.timeout_seconds);
    if (job.execution.type === 'script') {
      setFile(job.execution.script_file);
      setInterpreter(job.execution.interpreter);
      setArgs(job.execution.args.join(' '));
      setPrecheck(false);
    } else {
      setFile(job.execution.prompt_file);
      setPrecheck(Boolean(job.execution.precheck));
      setPrecheckFile(job.execution.precheck?.script_file ?? 'scripts/precheck.mjs');
      setInterpreter(job.execution.precheck?.interpreter ?? 'node');
      setArgs(job.execution.precheck?.args.join(' ') ?? '');
      setNoDataExitCode(job.execution.precheck?.no_data_exit_code ?? 3);
    }
    setShowForm(true);
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>定时任务</h2>
          <span>daily · concurrency forbid</span>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setEditingId(undefined);
            setId('');
            setShowForm(!showForm);
          }}
        >
          {showForm ? '收起表单' : '新建任务'}
        </button>
      </div>
      {error && <div className="notice danger">{error}</div>}
      {showForm && (
        <div className="inline-form">
          <div className="form-grid two">
            <label>
              Job ID
              <input
                value={id}
                disabled={Boolean(editingId)}
                onChange={(event) => setId(event.target.value)}
              />
            </label>
            <label>
              每天执行时间
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
            <label>
              执行类型
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as 'agent' | 'script')}
              >
                <option value="agent">Agent prompt</option>
                <option value="script">Script</option>
              </select>
            </label>
            <label>
              {kind === 'agent' ? 'Prompt 文件' : '脚本文件'}
              <input value={file} onChange={(event) => setFile(event.target.value)} />
            </label>
            <label>
              超时秒数
              <input
                type="number"
                value={timeout}
                onChange={(event) => setTimeoutValue(Number(event.target.value))}
              />
            </label>
            <label>
              解释器
              <select
                value={interpreter}
                onChange={(event) =>
                  setInterpreter(event.target.value as 'node' | 'bash' | 'direct')
                }
              >
                <option value="node">Node.js</option>
                <option value="bash">Bash</option>
                <option value="direct">直接执行</option>
              </select>
            </label>
            <label>
              参数（空格分隔）
              <input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                placeholder="--limit 20"
              />
            </label>
          </div>
          {kind === 'agent' && (
            <div className="form-stack">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={precheck}
                  onChange={(event) => setPrecheck(event.target.checked)}
                />
                <span>
                  <strong>启用 precheck</strong>
                  <small>退出 0 才调用模型；无数据退出码正常跳过</small>
                </span>
              </label>
              {precheck && (
                <div className="form-grid two">
                  <label>
                    预检脚本
                    <input
                      value={precheckFile}
                      onChange={(event) => setPrecheckFile(event.target.value)}
                    />
                  </label>
                  <label>
                    无数据退出码
                    <input
                      type="number"
                      value={noDataExitCode}
                      onChange={(event) => setNoDataExitCode(Number(event.target.value))}
                    />
                  </label>
                </div>
              )}
            </div>
          )}
          <pre>
            {YAML.stringify({
              schema_version: 1,
              id,
              enabled: false,
              schedule: { type: 'daily', time },
              execution: {
                type: kind,
                [kind === 'agent' ? 'prompt_file' : 'script_file']: file,
                ...(kind === 'script'
                  ? { interpreter, args: args.split(/\s+/).filter(Boolean) }
                  : {}),
                ...(kind === 'agent' && precheck
                  ? {
                      precheck: {
                        script_file: precheckFile,
                        interpreter,
                        args: args.split(/\s+/).filter(Boolean),
                        no_data_exit_code: noDataExitCode,
                      },
                    }
                  : {}),
                timeout_seconds: timeout,
                concurrency: 'forbid',
              },
            })}
          </pre>
          <button className="button primary" onClick={() => void save()}>
            {editingId ? '更新任务' : '保存任务'}
          </button>
        </div>
      )}
      {jobs.length === 0 ? (
        <div className="empty-state">
          <Terminal size={26} />
          <h3>暂无定时任务</h3>
          <p>创建脚本或 Agent 任务，并明确执行时间与超时。</p>
        </div>
      ) : (
        <div className="data-list">
          {jobs.map((job) => (
            <article key={job.id}>
              <div>
                <strong>{job.id}</strong>
                <span>
                  每天 {job.schedule.time} · {job.execution.type}
                </span>
              </div>
              <span className={`status-badge ${job.enabled ? 'running' : 'stopped'}`}>
                {job.enabled ? 'enabled' : 'disabled'}
              </span>
              <button
                className="button ghost"
                onClick={async () => {
                  try {
                    await api.jobAction(agentId, job.id, 'run');
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              >
                运行
              </button>
              <button className="button ghost" onClick={() => edit(job)}>
                编辑
              </button>
              <button
                className="button ghost"
                onClick={async () => {
                  try {
                    await api.jobAction(agentId, job.id, job.enabled ? 'disable' : 'enable');
                    await load();
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              >
                {job.enabled ? '禁用' : '启用'}
              </button>
              <button
                className="button ghost danger-text"
                onClick={async () => {
                  if (!window.confirm(`归档 Job ${job.id}？`)) return;
                  try {
                    await api.jobAction(agentId, job.id, 'archive');
                    await load();
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              >
                归档
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const planStateLabel: Record<TaskPlan['status'], string> = {
  draft: '待确认',
  active: '执行中',
  completed: '已完成',
  cancelled: '已驳回',
};

const planStateClass: Record<TaskPlan['status'], string> = {
  draft: 'queued',
  active: 'running',
  completed: 'succeeded',
  cancelled: 'failed',
};

const itemStateLabel: Record<TaskItem['status'], string> = {
  pending: '待处理',
  queued: '排队中',
  planning: '规划中',
  awaiting_confirmation: '待确认',
  developing: '执行中',
  awaiting_review: '待审查',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const itemStateClass: Record<TaskItem['status'], string> = {
  pending: '',
  queued: 'queued',
  planning: 'queued',
  awaiting_confirmation: 'queued',
  developing: 'running',
  awaiting_review: 'queued',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'failed',
};

// 共享任务计划轮询 + 闸门执行（TodoTab 与 ChiefPipelineTab 复用）。
// 2s 轮询；busyRef 在闸门操作期间暂停轮询，避免刷新覆盖操作结果。
function useTaskPlansPolling(agentId: string) {
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const busyRef = useRef(false);
  const refresh = async () => {
    try {
      setPlans(await api.listTaskPlans(agentId));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!busyRef.current) void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [agentId]);
  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    busyRef.current = true;
    setBusy(label);
    setError('');
    setFeedback('');
    try {
      await action();
      await refresh();
      if (success) setFeedback(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };
  return { plans, busy, error, feedback, refresh, run };
}

// 展开/收起一组 plan 的共享状态（TodoTab 与 ChiefPipelineTab 复用）。
function useExpandSet() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (planId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  return { expanded, toggle };
}

function TodoTab({ agentId }: { agentId: string }) {
  const { plans, busy, error, feedback, refresh, run } = useTaskPlansPolling(agentId);
  const { expanded, toggle } = useExpandSet();
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Todo 任务</h2>
          <span>计划状态机 · 2 秒轮询刷新</span>
        </div>
        <button className="button ghost" onClick={() => void run('refresh', refresh)}>
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      {error && <div className="notice danger">{error}</div>}
      {feedback && (
        <div className="notice info" role="status">
          {feedback}
        </div>
      )}
      {plans.length === 0 ? (
        <div className="empty-state">
          <ListTodo size={26} />
          <h3>暂无 Todo 计划</h3>
          <p>通过 CLI 的 plan / chief 命令创建计划后，在此确认、派发与合并审查。</p>
        </div>
      ) : (
        <div className="todo-list">
          {plans.map((plan) => (
            <article className="todo-plan" key={plan.id}>
              <div className="todo-plan-head">
                <button className="todo-plan-toggle" onClick={() => toggle(plan.id)}>
                  <span className={`status-badge ${planStateClass[plan.status]}`}>
                    {planStateLabel[plan.status]}
                  </span>
                  <strong>{plan.name}</strong>
                  <small>
                    {plan.id} · items {plan.items.length}
                  </small>
                </button>
                <div className="button-row">
                  {plan.status === 'draft' && (
                    <>
                      <button
                        className="button primary"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void run(
                            `confirm:${plan.id}`,
                            () => api.confirmPlan(agentId, plan.id),
                            `已确认计划 ${plan.id}，可派发执行。`,
                          )
                        }
                      >
                        <CheckCircle2 size={15} />
                        确认计划
                      </button>
                      <button
                        className="button ghost danger-text"
                        disabled={Boolean(busy)}
                        onClick={async () => {
                          const note = window.prompt(`驳回计划 ${plan.id}（可附理由）：`) ?? '';
                          await run(
                            `reject:${plan.id}`,
                            () => api.rejectPlan(agentId, plan.id, note || undefined),
                            `已驳回计划 ${plan.id}。`,
                          );
                        }}
                      >
                        <XCircle size={15} />
                        驳回计划
                      </button>
                    </>
                  )}
                </div>
              </div>
              {plan.note && <p className="muted">驳回/取消理由：{plan.note}</p>}
              {expanded.has(plan.id) && (
                <div className="todo-items">
                  {plan.items.map((item) => (
                    <TaskItemRow
                      key={item.id}
                      agentId={agentId}
                      plan={plan}
                      item={item}
                      busy={busy}
                      run={run}
                    />
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// 共享任务项卡片：worker/状态徽章 + 审查结论 + 确认合并/驳回返工门（TodoTab 与 ChiefPipelineTab 复用）。
function TaskItemRow({
  agentId,
  plan,
  item,
  busy,
  run,
}: {
  agentId: string;
  plan: TaskPlan;
  item: TaskItem;
  busy: string | undefined;
  run: (label: string, action: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  return (
    <article className="todo-item">
      <div className="todo-item-head">
        <div>
          <strong>{item.title}</strong>
          <span>
            {item.agent} · {item.id}
          </span>
        </div>
        <span className={`status-badge ${itemStateClass[item.status]}`}>
          {itemStateLabel[item.status]}
        </span>
      </div>
      <p className="todo-prompt">{item.prompt}</p>
      {item.status === 'awaiting_review' && (
        <div className="todo-review">
          <div className="panel-heading">
            <h3>审查结论</h3>
          </div>
          {item.review ? (
            <p className="muted">
              <span
                className={`status-badge ${item.review.verdict === 'approved' ? 'succeeded' : 'failed'}`}
              >
                {item.review.verdict === 'approved' ? '已通过' : '已驳回'}
              </span>
              {item.review.note ?? '（无补充说明）'}
            </p>
          ) : (
            <p className="muted">尚未发起 Chief 交叉审查（CLI：chief review）。</p>
          )}
          <div className="button-row">
            <button
              className="button primary"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  `merge:${item.id}`,
                  () => api.confirmReview(agentId, plan.id, item.id),
                  `已确认合并 ${item.id}。`,
                )
              }
            >
              <CheckCircle2 size={15} />
              确认合并
            </button>
            <button
              className="button ghost danger-text"
              disabled={Boolean(busy)}
              onClick={async () => {
                const note = window.prompt(`驳回任务 ${item.id} 返工（可附理由）：`) ?? '';
                await run(
                  `reject-review:${item.id}`,
                  () => api.rejectReview(agentId, plan.id, item.id, note || undefined),
                  `已驳回 ${item.id} 返工。`,
                );
              }}
            >
              <XCircle size={15} />
              驳回返工
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// 目标流水线阶段（issue 10）：拆解 → 计划确认 → 执行 → 审查 → 结果。
// 纯派生，不含副作用，便于测试。
interface PipelineStageFlags {
  decomposeDone: boolean;
  gateDone: boolean;
  executing: boolean;
  reviewing: boolean;
  resultDone: boolean;
}

function derivePipeline(plan: TaskPlan): PipelineStageFlags {
  const nonCancelled = plan.items.filter((item) => item.status !== 'cancelled');
  const allDone =
    nonCancelled.length > 0 && nonCancelled.every((item) => item.status === 'completed');
  // 已派发：任一任务实际运行过（离开 pending 且非 cancelled）；计划内被单独取消的项不算派发。
  const anyDispatched = plan.items.some(
    (item) => item.status !== 'pending' && item.status !== 'cancelled',
  );
  // 计划确认门已过：active/completed，或 cancelled 但曾派发（中途终止）；驳回未派发（全项 pending）不算。
  const gateDone =
    plan.status === 'active' ||
    plan.status === 'completed' ||
    (plan.status === 'cancelled' && anyDispatched);
  // 审查门已到达：有待审查项/已存审查结论，或计划已结束（审查是必经门，完成后不熄灭）。
  const reviewing =
    plan.status === 'completed' ||
    allDone ||
    plan.items.some(
      (item) =>
        item.status === 'awaiting_review' || (item.status !== 'cancelled' && Boolean(item.review)),
    );
  return {
    // 阶段点亮语义为「已到达」：一旦达成即常亮，不随执行结束熄灭（拆解/执行/审查/结果均如此）。
    decomposeDone: plan.items.length > 0,
    gateDone,
    executing: gateDone && anyDispatched,
    reviewing,
    resultDone: plan.status === 'completed' || allDone,
  };
}

// 目标整体派生状态 + 进度文本（按 item 状态分布计数）。
function summarizePlan(plan: TaskPlan): { label: string; cls: string; progress: string } {
  let completed = 0;
  let awaitingReview = 0;
  let developing = 0;
  let failed = 0;
  for (const item of plan.items) {
    if (item.status === 'cancelled') continue; // 取消项不进任何桶也不进分母（不可能完成）
    if (item.status === 'completed') completed++;
    else if (item.status === 'awaiting_review') awaitingReview++;
    else if (item.status === 'developing' || item.status === 'queued' || item.status === 'planning')
      developing++;
    else if (item.status === 'failed') failed++;
    // 其余 pending / awaiting_confirmation 未派发，不单独计数
  }
  const total = plan.items.filter((item) => item.status !== 'cancelled').length;
  if (plan.status === 'cancelled')
    return { label: '已取消', cls: 'failed', progress: `计划已取消 · ${plan.items.length} 个任务` };
  if (plan.status === 'completed' || (total > 0 && completed === total))
    return { label: '已完成', cls: 'succeeded', progress: `${completed}/${total} 完成` };
  if (failed > 0)
    return {
      label: '有失败',
      cls: 'failed',
      progress: `${completed}/${total} 完成 · ${failed} 失败${developing > 0 ? ` · ${developing} 执行中` : ''}`,
    };
  if (awaitingReview > 0)
    return {
      label: '待审查',
      cls: 'queued',
      progress: `${completed}/${total} 完成 · ${awaitingReview} 待审查`,
    };
  if (plan.status === 'draft')
    return { label: '待确认', cls: 'queued', progress: `${completed}/${total} 完成 · 待计划确认` };
  if (developing === 0 && completed === 0)
    return { label: '待派发', cls: 'queued', progress: `已确认 · ${total} 个任务待派发` };
  return {
    label: '执行中',
    cls: 'running',
    progress: `${completed}/${total} 完成 · ${developing} 执行中`,
  };
}

const pipelineStagesMeta: { key: keyof PipelineStageFlags; label: string }[] = [
  { key: 'decomposeDone', label: '拆解' },
  { key: 'gateDone', label: '计划确认' },
  { key: 'executing', label: '执行' },
  { key: 'reviewing', label: '审查' },
  { key: 'resultDone', label: '结果' },
];

function PipelineStages({ stages }: { stages: PipelineStageFlags }) {
  return (
    <div className="pipeline-stages" aria-label="编排流水线">
      {pipelineStagesMeta.map(({ key, label }, i) => (
        <Fragment key={key}>
          {i > 0 && <span className="pipeline-arrow">→</span>}
          <span className={`pipeline-stage ${stages[key] ? 'done' : ''}`}>{label}</span>
        </Fragment>
      ))}
    </div>
  );
}

// Chief 视角页（issue 10）：对一个目标看整条编排流水线（计划→执行→审查→结果），
// 聚合整体进度 + 阶段点亮，2s 轮询。纯流水线视图——发起/派发仍走 CLI（D-022 边界）。
function ChiefPipelineTab({ agentId }: { agentId: string }) {
  const { plans, busy, error, feedback, refresh, run } = useTaskPlansPolling(agentId);
  const { expanded, toggle } = useExpandSet();
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Chief 编排</h2>
          <span>目标流水线 · 拆解 → 计划确认 → 执行 → 审查 → 结果 · 2 秒轮询</span>
        </div>
        <button className="button ghost" onClick={() => void run('refresh', refresh)}>
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      {error && <div className="notice danger">{error}</div>}
      {feedback && (
        <div className="notice info" role="status">
          {feedback}
        </div>
      )}
      {plans.length === 0 ? (
        <div className="empty-state">
          <Workflow size={26} />
          <h3>暂无编排目标</h3>
          <p>通过 CLI 的 chief run 发起目标编排后，在此查看整条流水线。</p>
        </div>
      ) : (
        <div className="todo-list">
          {plans.map((plan) => {
            const summary = summarizePlan(plan);
            return (
              <article className="todo-plan" key={plan.id}>
                <div className="todo-plan-head">
                  <button className="todo-plan-toggle" onClick={() => toggle(plan.id)}>
                    <span className={`status-badge ${summary.cls}`}>{summary.label}</span>
                    <strong>{plan.name}</strong>
                    <small>
                      {plan.id} · {summary.progress}
                    </small>
                  </button>
                  <div className="button-row">
                    {plan.status === 'draft' && (
                      <>
                        <button
                          className="button primary"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(
                              `confirm:${plan.id}`,
                              () => api.confirmPlan(agentId, plan.id),
                              `已确认计划 ${plan.id}，可派发执行。`,
                            )
                          }
                        >
                          <CheckCircle2 size={15} />
                          确认计划
                        </button>
                        <button
                          className="button ghost danger-text"
                          disabled={Boolean(busy)}
                          onClick={async () => {
                            const note = window.prompt(`驳回计划 ${plan.id}（可附理由）：`) ?? '';
                            await run(
                              `reject:${plan.id}`,
                              () => api.rejectPlan(agentId, plan.id, note || undefined),
                              `已驳回计划 ${plan.id}。`,
                            );
                          }}
                        >
                          <XCircle size={15} />
                          驳回计划
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {plan.note && <p className="muted">驳回/取消理由：{plan.note}</p>}
                <PipelineStages stages={derivePipeline(plan)} />
                {expanded.has(plan.id) && (
                  <div className="todo-items">
                    {plan.items.map((item) => (
                      <TaskItemRow
                        key={item.id}
                        agentId={agentId}
                        plan={plan}
                        item={item}
                        busy={busy}
                        run={run}
                      />
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SkillsTab({ agentId }: { agentId: string }) {
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [scope, setScope] = useState<SkillScope>('project');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const load = async () => setSkills(await api.listSkills(agentId));
  useEffect(() => {
    inputRef.current?.setAttribute('webkitdirectory', '');
    void load().catch((cause: unknown) => setError(String(cause)));
  }, [agentId]);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      await api.uploadSkill(agentId, [...files], scope);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const remove = async (skill: SkillMetadata) => {
    const label = skill.scope === 'project' ? '项目级' : '用户级';
    if (!window.confirm(`卸载 Skill ${skill.name}（${label}）？此操作不可恢复。`)) return;
    try {
      await api.removeSkill(agentId, skill.name, skill.scope);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const groups: Array<{ scope: SkillScope; label: string; hint: string }> = [
    { scope: 'project', label: '项目级', hint: '随工作区版本管理，进入默认备份' },
    { scope: 'user', label: '用户级', hint: '员工运行时身份，仅随 Runtime 备份' },
  ];
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Skills</h2>
          <span>按项目级 / 用户级分类展示</span>
        </div>
        <div className="button-row">
          <button
            className="button secondary"
            onClick={() => navigate(`/skill-store?agent=${encodeURIComponent(agentId)}`)}
          >
            <Store size={15} />
            从商店安装
          </button>
          <label className="button primary">
            <Upload size={15} />
            导入目录
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => void upload(event.target.files)}
            />
          </label>
        </div>
      </div>
      <div className="scope-picker">
        {groups.map(({ scope: s, label }) => (
          <button key={s} className={scope === s ? 'active' : ''} onClick={() => setScope(s)}>
            {label}
          </button>
        ))}
      </div>
      {error && <div className="notice danger">{error}</div>}
      {groups.map(({ scope: s, label, hint }) => {
        if (s !== scope) return null; // 切换生效：只显示选中的作用域
        const items = skills.filter((skill) => skill.scope === s);
        if (!items.length) {
          return (
            <div className="empty-state" key={s}>
              <Store size={26} />
              <h3>暂无 {label} Skill</h3>
              <p>从商店安装，或按上方选中的作用域导入本地 Skill 目录。</p>
            </div>
          );
        }
        return (
          <div className="scope-group" key={s}>
            <div className="scope-group-head">
              <strong>{label}</strong>
              <span>{hint}</span>
              <em>{items.length}</em>
            </div>
            <div className="data-list">
              {items.map((skill) => (
                <article key={skill.name}>
                  <div>
                    <strong>{skill.name}</strong>
                    <span>
                      v{skill.version} · {skill.digest.slice(0, 12)}
                    </span>
                  </div>
                  <span className={`status-badge ${s}`}>{label}</span>
                  <button className="button ghost danger-text" onClick={() => void remove(skill)}>
                    <Trash2 size={14} />
                    卸载
                  </button>
                </article>
              ))}
            </div>
          </div>
        );
      })}
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
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>最近日志</h2>
          <span>{log?.file ?? '尚无日志文件'}</span>
        </div>
        <div className="button-row">
          <button className="button ghost" onClick={() => setFollowing(!following)}>
            <Activity size={15} />
            {following ? '停止跟随' : '实时跟随'}
          </button>
          <button className="button ghost" onClick={() => void load()}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
      </div>
      {error ? (
        <div className="empty-state">
          <Terminal size={26} />
          <h3>{error}</h3>
        </div>
      ) : (
        <pre className="log-viewer">{log?.content}</pre>
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
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>员工备份</h2>
          <span>默认排除 Runtime、日志和 Secret</span>
        </div>
        <button className="button primary" onClick={() => void create()}>
          创建备份
        </button>
      </div>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={includeRuntime}
          onChange={(event) => setIncludeRuntime(event.target.checked)}
        />
        <span>
          <strong>包含 Runtime</strong>
          <small>强制使用 scrypt + AES-256-GCM 加密</small>
        </span>
      </label>
      {includeRuntime && (
        <label>
          当次备份密码
          <input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
      )}
      {error && <div className="notice danger">{error}</div>}
      {operation ? (
        <div className="notice info">备份任务已提交：{operation.id}</div>
      ) : (
        <div className="empty-state">
          <Archive size={26} />
          <h3>创建可迁移备份</h3>
          <p>备份包含 Workspace、Git、正式记忆、Job 和脱敏配置。</p>
        </div>
      )}
    </section>
  );
}

function DoctorTab({ agentId }: { agentId: string }) {
  const [operation, setOperation] = useState<OperationDto>();
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>员工诊断</h2>
          <span>只诊断，不静默修复</span>
        </div>
        <button
          className="button primary"
          onClick={async () => setOperation(await api.runDoctor(agentId))}
        >
          运行 Doctor
        </button>
      </div>
      {operation && <div className="notice info">诊断任务 {operation.id} 已进入操作中心。</div>}
      <div className="empty-state">
        <CheckCircle2 size={26} />
        <h3>检查身份与运行隔离</h3>
        <p>覆盖 Schema、Registry、Runtime、Bridge、launchd、日志和敏感文件。</p>
      </div>
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
  const [tab, setTab] = useState<Tab>('概览');
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
  if (error) return <div className="notice danger">{error}</div>;
  if (!detail || !guidance) return <div className="skeleton-page">正在读取员工配置…</div>;
  const registry = detail.registry;
  // Chief 编排视图仅对 role=chief 的员工展示（issue 10）。
  const visibleTabs: Tab[] =
    registry.role === 'chief' ? [...tabs.slice(0, 4), 'Chief 编排', ...tabs.slice(4)] : [...tabs];
  return (
    <div className="page-stack">
      <header className="agent-hero">
        <div className="avatar large">{registry.name.slice(0, 1)}</div>
        <div>
          <p className="eyebrow">{registry.id}</p>
          <h1>{registry.name}</h1>
          <p>{detail.agent.description}</p>
        </div>
        <span className={`status-badge ${registry.status}`}>{registry.status}</span>
      </header>
      <nav className="tabs">
        {visibleTabs.map((item) => (
          <button className={item === tab ? 'active' : ''} onClick={() => setTab(item)} key={item}>
            {item}
          </button>
        ))}
      </nav>
      {tab === '概览' && <OverviewTab detail={detail} guidance={guidance} reload={load} />}
      {tab === '身份文档' && <DocumentsTab agentId={agentId} />}
      {tab === '任务' && <JobsTab agentId={agentId} />}
      {tab === 'Todo' && <TodoTab agentId={agentId} />}
      {tab === 'Chief 编排' && registry.role === 'chief' && <ChiefPipelineTab agentId={agentId} />}
      {tab === 'Skills' && <SkillsTab agentId={agentId} />}
      {tab === '日志' && <LogsTab agentId={agentId} />}
      {tab === '备份' && <BackupTab agentId={agentId} />}
      {tab === '诊断' && <DoctorTab agentId={agentId} />}
    </div>
  );
}
