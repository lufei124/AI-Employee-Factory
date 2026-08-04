import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import YAML from 'yaml';
import {
  Activity,
  Archive,
  Bot,
  CheckCircle2,
  FileText,
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
} from 'lucide-react';
import {
  api,
  type AgentDetail,
  type AgentDocument,
  type JobConfig,
  type OperationDto,
  type SkillMetadata,
  type SkillScope,
} from '../api.js';
import { CopyButton } from '../components/CopyButton.js';

interface AgentDetailPageProps {
  agentId: string;
}

const tabs = ['概览', '身份文档', '任务', 'Skills', '日志', '备份', '诊断'] as const;
type Tab = (typeof tabs)[number];

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
    if (!window.confirm(`归档 Skill ${skill.name}（${label}）？`)) return;
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
      {skills.length === 0 ? (
        <div className="empty-state">
          <Store size={26} />
          <h3>暂无 Skill</h3>
          <p>从商店安装，或按上方选中的作用域导入本地 Skill 目录。</p>
        </div>
      ) : (
        groups.map(({ scope: s, label, hint }) => {
          const items = skills.filter((skill) => skill.scope === s);
          if (!items.length) return null;
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
                      <Archive size={14} />
                      归档
                    </button>
                  </article>
                ))}
              </div>
            </div>
          );
        })
      )}
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
        {tabs.map((item) => (
          <button className={item === tab ? 'active' : ''} onClick={() => setTab(item)} key={item}>
            {item}
          </button>
        ))}
      </nav>
      {tab === '概览' && <OverviewTab detail={detail} guidance={guidance} reload={load} />}
      {tab === '身份文档' && <DocumentsTab agentId={agentId} />}
      {tab === '任务' && <JobsTab agentId={agentId} />}
      {tab === 'Skills' && <SkillsTab agentId={agentId} />}
      {tab === '日志' && <LogsTab agentId={agentId} />}
      {tab === '备份' && <BackupTab agentId={agentId} />}
      {tab === '诊断' && <DoctorTab agentId={agentId} />}
    </div>
  );
}
