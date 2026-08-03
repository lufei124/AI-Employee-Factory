import { useEffect, useState } from 'react';
import { Activity, ChevronRight, X } from 'lucide-react';
import { api, type OperationDto } from '../api.js';

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
      <button className="operation-trigger" onClick={() => changeOpen(!open)}>
        <Activity size={17} />
        <span>操作中心</span>
        {running > 0 && <b>{running}</b>}
      </button>
      <aside className={`operations-drawer ${open ? 'open' : ''}`} aria-label="操作中心">
        <header>
          <div>
            <p className="eyebrow">ACTIVITY STREAM</p>
            <h2>操作中心</h2>
          </div>
          <button
            className="icon-button"
            aria-label="关闭操作中心"
            onClick={() => changeOpen(false)}
          >
            <X />
          </button>
        </header>
        {selected ? (
          <div className="operation-detail">
            <button
              className="back-link"
              onClick={() => {
                setSelected(undefined);
                setStreamAfter(undefined);
              }}
            >
              ← 返回操作列表
            </button>
            <div className="operation-title">
              <strong>{selected.type}</strong>
              <span className={`status-badge ${selected.state}`}>{selected.state}</span>
            </div>
            <p>
              {selected.agentId ?? 'Factory 全局'} · {selected.id}
            </p>
            <div className="progress-track">
              <span style={{ width: `${selected.progress ?? 0}%` }} />
            </div>
            {selected.error && (
              <div className="notice danger">
                <strong>{selected.error.message}</strong>
                {selected.error.remediation && <p>{selected.error.remediation}</p>}
              </div>
            )}
            <pre className="event-log">
              {events.map((event) => `[${event.kind}] ${event.message ?? ''}`).join('\n') ||
                '等待事件…'}
            </pre>
          </div>
        ) : (
          <div className="operation-list">
            {operations.map((operation) => (
              <button onClick={() => void inspect(operation)} key={operation.id}>
                <span className={`operation-state ${operation.state}`} />
                <div>
                  <strong>{operation.type}</strong>
                  <small>
                    {operation.agentId ?? 'Factory'} · {operation.state}
                  </small>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
            {operations.length === 0 && (
              <div className="empty-state compact">
                <Activity size={24} />
                <h3>暂无操作记录</h3>
                <p>运行任务、诊断或备份后会显示在这里。</p>
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
