import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { api, type GeneratedProfile } from '../api.js';
import { CopyButton } from '../components/CopyButton.js';

function agentIdFromName(name: string, fallback: string): string {
  const generated = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return generated || fallback;
}

function toLines(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

function fromLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function CreateAgentPage() {
  // D-029：描述 → AI 生成可编辑蓝图；不再使用岗位预设。
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [id, setId] = useState('');
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [goals, setGoals] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [policies, setPolicies] = useState('');
  const [escalation, setEscalation] = useState('');
  const [skills, setSkills] = useState('');
  const [runtime, setRuntime] = useState<'claude' | 'codex'>('claude');
  const [feishu, setFeishu] = useState<'dedicated' | 'disabled'>('dedicated');
  const [created, setCreated] = useState<{ id: string; workspace: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const input = {
    id,
    name,
    runtime,
    feishu,
    description,
    goals: fromLines(goals),
    responsibilities: fromLines(responsibilities),
    policies: fromLines(policies),
    escalation_conditions: fromLines(escalation),
    skills: fromLines(skills),
  };
  const canContinue = id.length > 0 && description.length > 0 && fromLines(goals).length > 0;

  const applyProfile = (profile: GeneratedProfile) => {
    setName(profile.name);
    setDescription(profile.description);
    setGoals(toLines(profile.goals));
    setResponsibilities(toLines(profile.responsibilities));
    setPolicies(toLines(profile.policies));
    setEscalation(toLines(profile.escalation_conditions));
    setSkills(toLines(profile.skills));
    if (!idManuallyEdited) {
      const id =
        profile.id && /^[a-z0-9][a-z0-9-]*$/.test(profile.id)
          ? profile.id
          : agentIdFromName(profile.name, '');
      setId(id);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError('');
    try {
      const profile = await api.generateEmployeeProfile(brief);
      applyProfile(profile);
      setGenerated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      setCreated(await api.createAgent(input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (created)
    return (
      <section className="success-panel">
        <div className="success-mark">
          <Check size={34} />
        </div>
        <p className="eyebrow">准备就绪</p>
        <h1>员工创建完成</h1>
        <p>{created.id} 的基础目录已创建，但还需在本机终端完成下面的初始化步骤。</p>
        <div className="command-list">
          {[
            {
              label: runtime === 'claude' ? '1. 同步 CC Switch Provider' : '1. 登录 Codex',
              description:
                runtime === 'claude'
                  ? '同步 CC Switch 当前 Claude Provider 到员工隔离环境'
                  : '在员工专属 CODEX_HOME 中完成 Codex 登录',
              command:
                runtime === 'claude'
                  ? `agentctl runtime sync ${created.id}`
                  : `agentctl runtime login ${created.id}`,
            },
            {
              label: '2. 授权飞书',
              description: '如已启用独立飞书机器人，在终端扫码或授权',
              command: `agentctl bridge authorize ${created.id}`,
            },
            {
              label: '3. 运行诊断',
              description: '检查目录、隔离环境、Runtime 和 Bridge 状态',
              command: `agentctl doctor ${created.id}`,
            },
          ].map(({ label, description, command }) => (
            <div className="onboarding-command" key={command}>
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <code>
                {command}
                <CopyButton text={command} />
              </code>
            </div>
          ))}
        </div>
        <a className="button primary" href={`#/agents/${created.id}`}>
          进入员工详情
        </a>
      </section>
    );

  return (
    <div className="wizard-layout">
      <header className="page-heading">
        <div>
          <p className="eyebrow">员工蓝图</p>
          <h1>创建 AI 员工</h1>
          <p>用一句话描述员工用法，AI 生成可编辑蓝图；生成可迁移、可诊断且身份隔离的本地员工。</p>
        </div>
      </header>
      <ol className="stepper">
        {['描述与蓝图', '运行环境', '确认创建'].map((label, index) => (
          <li className={index <= step ? 'active' : ''} key={label}>
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <section className="panel wizard-panel">
        {step === 0 && (
          <div className="form-stack">
            <div>
              <span className="field-label">一句话描述你的员工</span>
              <textarea
                aria-label="员工描述"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder="例如：帮我建一个负责收集用户反馈、分析并闭环跟进的产品运营……"
                rows={3}
              />
              <div className="field-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={generating || brief.trim().length === 0}
                  onClick={() => void generate()}
                >
                  <Sparkles size={16} />
                  {generating ? 'AI 生成中…' : 'AI 生成蓝图'}
                </button>
                {generated ? (
                  <span className="field-help">已生成，可修改下方字段后继续。</span>
                ) : (
                  <span className="field-help">AI 会生成岗位名、职责、目标与权限边界。</span>
                )}
              </div>
            </div>
            {!generated && (
              <p className="field-help">
                AI 生成会预填下方字段；也可跳过生成，直接手动填写员工蓝图。
              </p>
            )}
            <div className="form-grid two">
              <label>
                员工名称
                <input
                  aria-label="员工名称"
                  value={name}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setName(nextName);
                    if (!idManuallyEdited) setId(agentIdFromName(nextName, ''));
                  }}
                />
              </label>
              <label>
                Agent ID（自动生成）
                <input
                  aria-label="Agent ID"
                  value={id}
                  onChange={(event) => {
                    setId(event.target.value);
                    setIdManuallyEdited(true);
                  }}
                  placeholder="例如 content-operator"
                />
                <small className="field-help">
                  用于工作区和终端命令，系统会自动生成，也可手动修改。
                </small>
              </label>
            </div>
            <div className="form-grid two">
              <label className="grid-span-2">
                职责描述
                <textarea
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                核心目标（每行一条）
                <textarea
                  rows={4}
                  value={goals}
                  onChange={(event) => setGoals(event.target.value)}
                />
              </label>
              <label>
                长期职责（每行一条）
                <textarea
                  rows={4}
                  value={responsibilities}
                  onChange={(event) => setResponsibilities(event.target.value)}
                />
              </label>
              <label>
                权限与上报规则（每行一条）
                <textarea
                  rows={4}
                  value={policies}
                  onChange={(event) => setPolicies(event.target.value)}
                />
              </label>
              <label>
                主动上报情形（每行一条）
                <textarea
                  rows={3}
                  value={escalation}
                  onChange={(event) => setEscalation(event.target.value)}
                />
              </label>
              <label>
                技能（每行一个，英文 kebab-case）
                <textarea
                  rows={3}
                  value={skills}
                  onChange={(event) => setSkills(event.target.value)}
                />
              </label>
            </div>
          </div>
        )}
        {step === 1 && (
          <div className="form-stack">
            <h2>运行环境与沟通方式</h2>
            <div className="choice-grid">
              <label className={runtime === 'claude' ? 'choice selected' : 'choice'}>
                <input
                  type="radio"
                  aria-label="Claude Code"
                  checked={runtime === 'claude'}
                  onChange={() => setRuntime('claude')}
                />
                <strong>Claude Code</strong>
                <span>默认 sonnet，专属 CLAUDE_CONFIG_DIR</span>
              </label>
              <label className={runtime === 'codex' ? 'choice selected' : 'choice'}>
                <input
                  type="radio"
                  aria-label="OpenAI Codex"
                  checked={runtime === 'codex'}
                  onChange={() => setRuntime('codex')}
                />
                <strong>OpenAI Codex</strong>
                <span>workspace-write，专属 CODEX_HOME</span>
              </label>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={feishu === 'dedicated'}
                onChange={(event) => setFeishu(event.target.checked ? 'dedicated' : 'disabled')}
              />
              <span>
                <strong>启用独立飞书机器人</strong>
                <small>创建后在隔离终端中完成扫码或 App 授权</small>
              </span>
            </label>
          </div>
        )}
        {step === 2 && (
          <div className="review-card">
            <p className="eyebrow">创建预览</p>
            <h2>确认员工蓝图</h2>
            <dl>
              <div>
                <dt>Agent</dt>
                <dd>
                  {name}
                  <small>{id}</small>
                </dd>
              </div>
              <div>
                <dt>职责描述</dt>
                <dd>{description}</dd>
              </div>
              <div>
                <dt>核心目标</dt>
                <dd>{fromLines(goals).length} 条</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>
                  {runtime === 'claude' ? 'Claude Code' : 'OpenAI Codex'}
                  <small>创建后锁定</small>
                </dd>
              </div>
              <div>
                <dt>飞书</dt>
                <dd>{feishu === 'dedicated' ? '独立机器人' : '不启用'}</dd>
              </div>
            </dl>
            <div className="notice info">
              不会访问真实模型或飞书 API；登录和授权将在创建后单独完成。
            </div>
          </div>
        )}
        {error && <div className="notice danger">{error}</div>}
        <footer className="wizard-actions">
          {step > 0 ? (
            <button className="button ghost" onClick={() => setStep(step - 1)}>
              <ChevronLeft size={16} />
              上一步
            </button>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <button
              className="button primary"
              disabled={step === 0 && !canContinue}
              onClick={() => setStep(step + 1)}
            >
              下一步
              <ChevronRight size={16} />
            </button>
          ) : (
            <button className="button primary" disabled={busy} onClick={() => void submit()}>
              {busy ? '创建中…' : '创建员工'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
