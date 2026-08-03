import { useEffect, useState } from 'react';
import { Bot, CircleAlert, Play, Users } from 'lucide-react';
import { api, type DashboardData } from '../api.js';

export function DashboardPage() {
  const [initialized, setInitialized] = useState<boolean>();
  const [dashboard, setDashboard] = useState<DashboardData>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDashboard = async () => setDashboard(await api.dashboard());

  useEffect(() => {
    void api
      .factoryStatus()
      .then(async (status) => {
        setInitialized(status.initialized);
        if (status.initialized) await loadDashboard();
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const initialize = async () => {
    setBusy(true);
    setError('');
    try {
      await api.initializeFactory();
      setInitialized(true);
      await loadDashboard();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="notice danger">{error}</div>;
  if (initialized === undefined) return <div className="skeleton-page">正在读取 Factory 状态…</div>;
  if (!initialized)
    return (
      <section className="welcome-panel">
        <div className="welcome-icon">
          <Bot size={36} />
        </div>
        <p className="eyebrow">LOCAL-FIRST AGENT OPERATIONS</p>
        <h1>欢迎来到 AI Employee Factory</h1>
        <p>先初始化本机控制面，然后通过向导创建第一个完全隔离的 AI 员工。</p>
        <button className="button primary" onClick={() => void initialize()} disabled={busy}>
          {busy ? '初始化中…' : '初始化 Factory'}
        </button>
      </section>
    );

  if (!dashboard) return <div className="skeleton-page">正在汇总员工状态…</div>;
  const metrics = [
    { label: 'AI 员工', value: dashboard.total, icon: Users, tone: 'violet' },
    { label: '运行中', value: dashboard.running, icon: Play, tone: 'green' },
    { label: '待授权', value: dashboard.pendingAuthorization, icon: CircleAlert, tone: 'amber' },
    { label: '已归档', value: dashboard.archived, icon: Bot, tone: 'slate' },
  ];
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CONTROL ROOM</p>
          <h1>运行总览</h1>
          <p>集中查看员工健康度、授权状态与最近活动。</p>
        </div>
        <a className="button primary" href="#/create">
          创建员工
        </a>
      </header>
      <section className="metric-grid">
        {metrics.map(({ label, value, icon: Icon, tone }) => (
          <article className="metric-card" key={label}>
            <div className={`metric-icon ${tone}`}>
              <Icon size={20} />
            </div>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>员工状态</h2>
          <a href="#/agents">查看全部</a>
        </div>
        {dashboard.agents.length === 0 ? (
          <div className="empty-state">
            <Bot size={28} />
            <h3>尚未创建 AI 员工</h3>
            <p>从经过审查的岗位预设开始，几分钟内完成隔离配置。</p>
            <a href="#/create" className="button secondary">
              开始创建
            </a>
          </div>
        ) : (
          <div className="agent-grid">
            {dashboard.agents.map((agent) => (
              <a className="agent-card" href={`#/agents/${agent.id}`} key={agent.id}>
                <div className="avatar">{agent.name.slice(0, 1)}</div>
                <div>
                  <h3>{agent.name}</h3>
                  <p>
                    {agent.id} · {agent.runtime}
                  </p>
                </div>
                <span className={`status-dot ${agent.status}`} />
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
