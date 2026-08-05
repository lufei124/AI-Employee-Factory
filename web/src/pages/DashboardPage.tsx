import { useEffect, useState } from 'react';
import { Bot, CircleAlert, Play, Users } from 'lucide-react';
import { api, type DashboardData } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { Button } from '../components/ui/button.js';
import { AgentStatusBadge } from '../components/StatusBadge.js';
import { EmptyState, PageSkeleton } from '../components/PageState.js';
import { notify, errorText } from '../components/ToastFeedback.js';
import { cn } from '../lib/utils.js';

function StatTile({
  label,
  value,
  icon: Icon,
  tone,
  hero,
}: {
  label: string;
  value: number;
  icon: typeof Users;
  tone: 'primary' | 'success' | 'warning' | 'muted';
  hero?: boolean;
}) {
  const tones = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/15 text-success',
    warning: 'bg-warning/15 text-warning',
    muted: 'bg-muted text-muted-foreground',
  };
  return (
    <div
      className={cn(
        'flex items-center gap-4 rounded-lg border border-border bg-card p-4',
        hero && 'sm:col-span-2 lg:col-span-1',
      )}
    >
      <div className={cn('grid size-10 shrink-0 place-items-center rounded-md', tones[tone])}>
        <Icon className={cn(hero ? 'size-6' : 'size-5')} />
      </div>
      <div className={cn('flex min-w-0 flex-col', hero ? 'gap-1' : 'gap-0.5')}>
        <span className="text-xs text-muted-foreground">{label}</span>
        <strong className="font-mono text-2xl font-semibold leading-none tracking-tight">
          {value}
        </strong>
      </div>
    </div>
  );
}

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
      .catch((cause: unknown) => setError(errorText(cause)));
  }, []);

  const initialize = async () => {
    setBusy(true);
    setError('');
    try {
      await api.initializeFactory();
      setInitialized(true);
      await loadDashboard();
      notify.success('Factory 已初始化');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (initialized === undefined) return <PageSkeleton rows={6} />;

  if (!initialized) {
    return (
      <div className="mx-auto mt-16 flex max-w-xl flex-col items-center rounded-xl border border-border bg-card p-10 text-center shadow-sm">
        <div className="mb-5 grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Bot className="size-8" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary">本地运营</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">欢迎来到 AI Employee Factory</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          先初始化本机控制面，然后通过向导创建第一个完全隔离的 AI 员工。
        </p>
        <Button className="mt-6" onClick={() => void initialize()} disabled={busy}>
          {busy ? '初始化中…' : '初始化 Factory'}
        </Button>
      </div>
    );
  }

  if (!dashboard) return <PageSkeleton rows={6} />;

  const metrics = [
    { label: 'AI 员工', value: dashboard.total, icon: Users, tone: 'primary' as const },
    { label: '运行中', value: dashboard.running, icon: Play, tone: 'success' as const },
    {
      label: '待授权',
      value: dashboard.pendingAuthorization,
      icon: CircleAlert,
      tone: 'warning' as const,
    },
    { label: '已归档', value: dashboard.archived, icon: Bot, tone: 'muted' as const },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="运行总览"
        title="本地控制面"
        description="集中查看员工健康度、授权状态与最近活动。"
        actions={
          <Button asChild>
            <a href="#/create">创建员工</a>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <StatTile key={metric.label} {...metric} />
        ))}
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold">员工状态</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              共 {dashboard.agents.length} 位员工 · 最近活动
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <a href="#/agents">查看全部</a>
          </Button>
        </div>
        {dashboard.agents.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Bot className="size-5" />}
              title="尚未创建 AI 员工"
              description="用一句话描述员工用法，AI 自动生成可编辑的员工蓝图，几分钟内完成隔离配置。"
              action={
                <Button variant="secondary" asChild>
                  <a href="#/create">开始创建</a>
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {dashboard.agents.map((agent) => (
              <li key={agent.id}>
                <a
                  href={`#/agents/${agent.id}`}
                  className="flex items-center gap-3 px-6 py-3.5 transition-colors hover:bg-muted/50"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-sm font-semibold text-primary">
                    {agent.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{agent.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {agent.id} · {agent.runtime}
                    </p>
                  </div>
                  <AgentStatusBadge status={agent.status} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
