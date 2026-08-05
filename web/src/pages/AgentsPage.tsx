import { useEffect, useMemo, useState } from 'react';
import { Bot, Search } from 'lucide-react';
import { api, type DashboardData } from '../api.js';

export function AgentsPage() {
  const [agents, setAgents] = useState<DashboardData['agents']>([]);
  const [query, setQuery] = useState('');
  const [runtime, setRuntime] = useState('all');
  const [error, setError] = useState('');
  useEffect(() => {
    void api
      .listAgents()
      .then(setAgents)
      .catch((cause: unknown) => setError(String(cause)));
  }, []);
  const visible = useMemo(
    () =>
      agents.filter(
        (agent) =>
          (runtime === 'all' || agent.runtime === runtime) &&
          `${agent.id} ${agent.name}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [agents, query, runtime],
  );
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">员工目录</p>
          <h1>AI 员工</h1>
          <p>查看每位员工的隔离运行环境与生命周期状态。</p>
        </div>
        <a className="button primary" href="#/create">
          创建员工
        </a>
      </header>
      <div className="toolbar">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="搜索员工"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或 ID"
          />
        </label>
        <select
          aria-label="Runtime 筛选"
          value={runtime}
          onChange={(event) => setRuntime(event.target.value)}
        >
          <option value="all">全部 Runtime</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      {error && <div className="notice danger">{error}</div>}
      <section className="agent-directory">
        {visible.map((agent) => (
          <a className="directory-card" href={`#/agents/${agent.id}`} key={agent.id}>
            <div className="avatar">{agent.name.slice(0, 1)}</div>
            <div className="directory-main">
              <h2>{agent.name}</h2>
              <p>{agent.id}</p>
              <div className="tag-row">
                <span>{agent.runtime}</span>
                <span>
                  {agent.bridgeEnabled ? `Bridge ${agent.bridgeAuthorization}` : 'Bridge disabled'}
                </span>
              </div>
            </div>
            <span className={`status-badge ${agent.status}`}>{agent.status}</span>
          </a>
        ))}
        {visible.length === 0 && (
          <div className="empty-state">
            <Bot size={28} />
            <h3>没有匹配的员工</h3>
            <p>调整搜索条件，或创建新的 AI 员工。</p>
          </div>
        )}
      </section>
    </div>
  );
}
