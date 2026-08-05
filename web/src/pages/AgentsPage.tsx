import { useMemo, useState } from 'react';
import { Bot, Search } from 'lucide-react';
import { api, type DashboardData } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Badge } from '../components/ui/badge.js';
import { AgentStatusBadge } from '../components/StatusBadge.js';
import { EmptyState, ErrorState, PageSkeleton } from '../components/PageState.js';
import { useAsync } from '../lib/useAsync.js';

export function AgentsPage() {
  const {
    data: agents = [],
    loading,
    error,
    reload,
  } = useAsync<DashboardData['agents']>(() => api.listAgents(), []);
  const [query, setQuery] = useState('');
  const [runtime, setRuntime] = useState('all');

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
    <div className="space-y-6">
      <PageHeader
        eyebrow="员工目录"
        title="AI 员工"
        description="查看每位员工的隔离运行环境与生命周期状态。"
        actions={
          <Button asChild>
            <a href="#/create">创建员工</a>
          </Button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索员工"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或 ID"
            className="pl-9"
          />
        </div>
        <select
          aria-label="Runtime 筛选"
          value={runtime}
          onChange={(event) => setRuntime(event.target.value)}
          className="h-9 w-full max-w-xs rounded-md border border-input bg-card px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
        >
          <option value="all">全部 Runtime</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>

      {loading ? (
        <PageSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void reload()} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((agent) => (
            <a
              key={agent.id}
              href={`#/agents/${agent.id}`}
              className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-muted-foreground/30 hover:bg-accent/40"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-sm font-semibold text-primary">
                  {agent.name.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold">{agent.name}</h2>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{agent.id}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {agent.runtime}
                    </Badge>
                    <Badge variant="muted" className="text-[10px]">
                      {agent.bridgeEnabled
                        ? `Bridge ${agent.bridgeAuthorization}`
                        : 'Bridge disabled'}
                    </Badge>
                  </div>
                </div>
                <AgentStatusBadge status={agent.status} />
              </div>
            </a>
          ))}
          {!loading && visible.length === 0 && (
            <div className="sm:col-span-2">
              <EmptyState
                icon={<Bot className="size-5" />}
                title="没有匹配的员工"
                description="调整搜索条件，或创建新的 AI 员工。"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
