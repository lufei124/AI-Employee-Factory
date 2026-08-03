import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { api, type CreateAgentRequest } from '../api.js';
import { CopyButton } from '../components/CopyButton.js';

const presets = [
  { id: 'user-operations', name: '用户运营专员', description: '反馈收集、分析与闭环跟进' },
  { id: 'growth', name: '增长专员', description: '实验设计、渠道复盘和增长建议' },
  { id: 'monetization', name: '商业化专员', description: '商业机会分析与变现方案' },
  { id: 'engineering', name: '工程专员', description: '需求实现、测试和技术维护' },
];

function agentIdFromName(name: string, fallback: string): string {
  const generated = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return generated || fallback;
}

export function CreateAgentPage() {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState('user-operations');
  const [id, setId] = useState('user-operations');
  const [name, setName] = useState('用户运营专员');
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [runtime, setRuntime] = useState<'claude' | 'codex'>('claude');
  const [feishu, setFeishu] = useState<'dedicated' | 'disabled'>('dedicated');
  const [created, setCreated] = useState<{ id: string; workspace: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const input: CreateAgentRequest = { id, name, runtime, preset, feishu };
  const canContinue = id.length > 0 && name.length > 0;
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
        <p className="eyebrow">READY FOR ONBOARDING</p>
        <h1>员工创建完成</h1>
        <p>{created.id} 的基础目录已创建，但还需在本机终端完成下面的初始化步骤。</p>
        <div className="command-list">
          {[
            {
              label: '1. 登录运行器',
              description: '在员工专属 Runtime Home 中登录 Claude/Codex',
              command: `agentctl runtime login ${created.id}`,
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
          <p className="eyebrow">EMPLOYEE BLUEPRINT</p>
          <h1>创建 AI 员工</h1>
          <p>通过三步向导生成可迁移、可诊断且身份隔离的本地员工。</p>
        </div>
      </header>
      <ol className="stepper">
        {['身份与预设', '运行环境', '确认创建'].map((label, index) => (
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
              <span className="field-label">岗位预设</span>
              <div className="preset-grid">
                {presets.map((item) => (
                  <button
                    type="button"
                    className={`preset-card ${preset === item.id ? 'selected' : ''}`}
                    onClick={() => {
                      setPreset(item.id);
                      setName(item.name);
                      setId(item.id);
                      setIdManuallyEdited(false);
                    }}
                    key={item.id}
                  >
                    <Sparkles size={18} />
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="form-grid two">
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
              <label>
                员工名称
                <input
                  aria-label="员工名称"
                  value={name}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setName(nextName);
                    if (!idManuallyEdited) setId(agentIdFromName(nextName, preset));
                  }}
                  placeholder="例如 内容运营"
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
                <dt>岗位预设</dt>
                <dd>{preset}</dd>
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
