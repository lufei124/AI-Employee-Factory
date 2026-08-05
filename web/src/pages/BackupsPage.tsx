import { useEffect, useState } from 'react';
import { Archive, Download, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { api, type TrashEntry } from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { notify, errorText } from '../components/ToastFeedback.js';
import { EmptyState } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { cn } from '../lib/utils.js';

type Backup = { name: string; size: number; modifiedAt: string; encrypted: boolean };

export function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [newId, setNewId] = useState('');
  const [error, setError] = useState('');
  const [pendingRestore, setPendingRestore] = useState<Backup>();
  const [pendingTrash, setPendingTrash] = useState<TrashEntry>();
  const load = async () => {
    const [nextBackups, nextTrash] = await Promise.all([api.listBackups(), api.listTrash()]);
    setBackups(nextBackups);
    setTrash(nextTrash);
  };
  useEffect(() => {
    void load().catch((cause: unknown) => setError(errorText(cause)));
  }, []);
  const openRestore = (backup: Backup) => {
    if (!newId) {
      setError('恢复副本必须填写新的 Agent ID。');
      return;
    }
    setPendingRestore(backup);
  };
  const restore = async () => {
    if (!pendingRestore) return;
    try {
      await api.restoreBackup({ name: pendingRestore.name, newId });
      setPendingRestore(undefined);
      setError('');
      notify.success(`已从 ${pendingRestore.name} 恢复为 ${newId}`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const importBackup = async (files: FileList | null) => {
    if (!files?.[0]) return;
    try {
      await api.importBackup(files[0]);
      await load();
      notify.success('备份已导入');
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const restoreTrash = async () => {
    if (!pendingTrash) return;
    try {
      await api.restoreTrash(pendingTrash.trashId);
      setPendingTrash(undefined);
      await load();
      setError('');
      notify.success(`已恢复员工 ${pendingTrash.name}`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="便携备份"
        title="备份与恢复"
        description="管理包含 Workspace、Git 和正式记忆的可迁移备份。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <label className="cursor-pointer">
                <Upload className="size-4" />
                导入备份
                <input
                  type="file"
                  accept=".tar.gz,.enc"
                  hidden
                  onChange={(event) => void importBackup(event.target.files)}
                />
              </label>
            </Button>
            <Button variant="ghost" onClick={() => void load()}>
              <RefreshCw className="size-4" />
              刷新
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Factory 备份</h2>
            <span className="text-xs text-muted-foreground">{backups.length} 个可用归档</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">恢复为新 ID</span>
            <Input
              value={newId}
              onChange={(event) => setNewId(event.target.value)}
              placeholder="agent-copy"
              className="w-44 font-mono"
            />
          </div>
        </div>
        {backups.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Archive className="size-5" />}
              title="尚无备份"
              description="前往员工详情创建第一个脱敏备份。"
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {backups.map((backup) => (
              <li key={backup.name} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <Archive className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <strong className="block truncate font-mono text-sm font-medium">
                    {backup.name}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {(backup.size / 1024 / 1024).toFixed(2)} MiB ·{' '}
                    {new Date(backup.modifiedAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                {backup.encrypted && (
                  <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    已加密
                  </span>
                )}
                <Button variant="ghost" size="sm" asChild>
                  <a href={api.backupDownloadUrl(backup.name)}>
                    <Download className="size-4" />
                    下载
                  </a>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openRestore(backup)}>
                  <RotateCcw className="size-4" />
                  恢复副本
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">员工回收站</h2>
            <span className="text-xs text-muted-foreground">
              {trash.length} 个可恢复员工 · 保留 7 天
            </span>
          </div>
        </div>
        {trash.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={<Trash2 className="size-5" />}
              title="回收站为空"
              description="从员工详情移入的全部数据会在这里保留 7 天。"
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {trash.map((entry) => (
              <li key={entry.trashId} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <Trash2 className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">{entry.name}</strong>
                  <span className="font-mono text-xs text-muted-foreground">
                    {entry.agentId} · {new Date(entry.deletedAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    entry.state === 'ready'
                      ? 'bg-success/15 text-success'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {entry.state === 'ready' ? `剩余 ${entry.remainingDays} 天` : entry.state}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={entry.state !== 'ready'}
                  onClick={() => setPendingTrash(entry)}
                >
                  <RotateCcw className="size-4" />
                  恢复员工
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(pendingRestore)}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(undefined);
        }}
        title="恢复备份副本"
        description={
          pendingRestore
            ? `从 ${pendingRestore.name} 恢复为 ${newId}？将新建一个独立员工副本。`
            : ''
        }
        confirmLabel="确认恢复"
        onConfirm={() => void restore()}
      />

      <ConfirmDialog
        open={Boolean(pendingTrash)}
        onOpenChange={(open) => {
          if (!open) setPendingTrash(undefined);
        }}
        title="恢复员工"
        description={
          pendingTrash
            ? `恢复员工 ${pendingTrash.name} (${pendingTrash.agentId})？恢复后保持停止状态。`
            : ''
        }
        confirmLabel="确认恢复"
        onConfirm={() => void restoreTrash()}
      />
    </div>
  );
}
