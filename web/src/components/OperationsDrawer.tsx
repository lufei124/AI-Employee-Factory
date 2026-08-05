import { useEffect, useState } from 'react';
import { Activity, ChevronRight, X } from 'lucide-react';
import { api, type OperationDto } from '../api.js';
import { OperationStatusBadge } from './StatusBadge.js';
import { Button } from './ui/button.js';
import { EmptyState } from './PageState.js';
import { cn } from '../lib/utils.js';

export function OperationsDrawer({
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [operations, setOperations] = useState<OperationDto[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<OperationDto>();
  const [events, setEvents] = useState<Array<{ seq: number; kind: string; message?: string }>>([]);
  const [streamAfter, setStreamAfter] = useState<number>();

  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const refresh = async () => setOperations(await api.listOperations());

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected) return;
    const current = operations.find((operation) => operation.id === selected.id);
    if (current) setSelected(current);
  }, [operations, selected]);

  useEffect(() => {
    if (!selected || streamAfter === undefined) return;
    const source = new EventSource(
      `/api/v1/operations/${encodeURIComponent(selected.id)}/stream?after=${streamAfter}`,
    );
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as { seq: number; kind: string; message?: string };
      setEvents((current) =>
        current.some((existing) => existing.seq === event.seq) ? current : [...current, event],
      );
    };
    return () => source.close();
  }, [selected?.id, streamAfter]);

  const running = operations.filter((operation) =>
    ['queued', 'running'].includes(operation.state),
  ).length;

  const inspect = async (operation: OperationDto) => {
    setSelected(operation);
    const history = await api.operationEvents(operation.id);
    setEvents(history);
    setStreamAfter(history.at(-1)?.seq ?? 0);
  };

  return (
    <>
      <button
        className="operation-trigger inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-sm transition-colors hover:border-muted-foreground/40"
        onClick={() => changeOpen(!open)}
      >
        <Activity className="size-[17px]" />
        <span>操作中心</span>
        {running > 0 && (
          <span className="grid size-5 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
            {running}
          </span>
        )}
      </button>

      <aside
        className={cn('operations-drawer', open && 'open')}
        aria-label="操作中心"
        aria-hidden={!open}
      >
        <header className="flex items-start justify-between border-b border-border px-6 py-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Activity stream
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">操作中心</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭操作中心"
            onClick={() => changeOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </header>

        {selected ? (
          <div className="flex flex-col gap-4 overflow-y-auto p-5">
            <Button
              variant="ghost"
              size="sm"
              className="w-fit -ml-2 text-primary"
              onClick={() => {
                setSelected(undefined);
                setStreamAfter(undefined);
              }}
            >
              <ChevronRight className="size-4 rotate-180" />
              返回操作列表
            </Button>
            <div className="flex items-center justify-between gap-3">
              <strong className="font-mono text-sm">{selected.type}</strong>
              <OperationStatusBadge state={selected.state} />
            </div>
            <p className="text-xs text-muted-foreground">
              {selected.agentId ?? 'Factory 全局'} ·{' '}
              <span className="font-mono">{selected.id}</span>
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-200"
                style={{ width: `${selected.progress ?? 0}%` }}
              />
            </div>
            {selected.error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <strong>{selected.error.message}</strong>
                {selected.error.remediation && (
                  <p className="mt-1 text-xs text-muted-foreground">{selected.error.remediation}</p>
                )}
              </div>
            )}
            <pre className="max-h-[46vh] overflow-auto rounded-md bg-code p-4 font-mono text-[11px] leading-relaxed text-code-ink">
              {events.map((event) => `[${event.kind}] ${event.message ?? ''}`).join('\n') ||
                '等待事件…'}
            </pre>
          </div>
        ) : (
          <div className="overflow-y-auto p-2">
            {operations.length === 0 ? (
              <EmptyState
                className="m-3 border-none py-10"
                icon={<Activity className="size-5" />}
                title="暂无操作记录"
                description="运行任务、诊断或备份后会显示在这里。"
              />
            ) : (
              <div className="space-y-0.5">
                {operations.map((operation) => (
                  <button
                    key={operation.id}
                    onClick={() => void inspect(operation)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted"
                  >
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        operation.state === 'running' && 'bg-primary animate-pulse',
                        operation.state === 'queued' && 'bg-warning',
                        operation.state === 'succeeded' && 'bg-success',
                        operation.state === 'failed' && 'bg-destructive',
                        operation.state === 'cancelled' && 'bg-muted-foreground',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <strong className="block truncate font-mono text-xs">{operation.type}</strong>
                      <small className="block truncate text-[11px] text-muted-foreground">
                        {operation.agentId ?? 'Factory'} · {operation.state}
                      </small>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
