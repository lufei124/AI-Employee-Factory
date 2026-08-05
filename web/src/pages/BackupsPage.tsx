import { useEffect, useState } from 'react';
import { Archive, Download, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { api, type TrashEntry } from '../api.js';

type Backup = { name: string; size: number; modifiedAt: string; encrypted: boolean };

export function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [newId, setNewId] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    const [nextBackups, nextTrash] = await Promise.all([api.listBackups(), api.listTrash()]);
    setBackups(nextBackups);
    setTrash(nextTrash);
  };
  useEffect(() => {
    void load().catch((cause: unknown) => setError(String(cause)));
  }, []);
  const restore = async (backup: Backup) => {
    if (!newId) {
      setError('恢复副本必须填写新的 Agent ID。');
      return;
    }
    if (!window.confirm(`从 ${backup.name} 恢复为 ${newId}？`)) return;
    try {
      await api.restoreBackup({ name: backup.name, newId });
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const importBackup = async (files: FileList | null) => {
    if (!files?.[0]) return;
    try {
      await api.importBackup(files[0]);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const restoreTrash = async (entry: TrashEntry) => {
    if (!window.confirm(`恢复员工 ${entry.name} (${entry.agentId})？恢复后保持停止状态。`)) return;
    try {
      await api.restoreTrash(entry.trashId);
      await load();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">便携备份</p>
          <h1>备份与恢复</h1>
          <p>管理包含 Workspace、Git 和正式记忆的可迁移备份。</p>
        </div>
        <div className="action-bar">
          <label className="button secondary">
            <Upload size={15} />
            导入备份
            <input
              type="file"
              accept=".tar.gz,.enc"
              hidden
              onChange={(event) => void importBackup(event.target.files)}
            />
          </label>
          <button className="button ghost" onClick={() => void load()}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
      </header>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Factory 备份</h2>
            <span>{backups.length} 个可用归档</span>
          </div>
          <label className="compact-field">
            恢复为新 ID
            <input
              value={newId}
              onChange={(event) => setNewId(event.target.value)}
              placeholder="agent-copy"
            />
          </label>
        </div>
        {error && <div className="notice danger">{error}</div>}
        {backups.length === 0 ? (
          <div className="empty-state">
            <Archive size={28} />
            <h3>尚无备份</h3>
            <p>前往员工详情创建第一个脱敏备份。</p>
          </div>
        ) : (
          <div className="data-list">
            {backups.map((backup) => (
              <article key={backup.name}>
                <Archive size={18} />
                <div>
                  <strong>{backup.name}</strong>
                  <span>
                    {(backup.size / 1024 / 1024).toFixed(2)} MiB ·{' '}
                    {new Date(backup.modifiedAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                {backup.encrypted && <span className="tag">已加密</span>}
                <a className="button ghost" href={api.backupDownloadUrl(backup.name)}>
                  <Download size={14} />
                  下载
                </a>
                <button className="button ghost" onClick={() => void restore(backup)}>
                  <RotateCcw size={14} />
                  恢复副本
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>员工回收站</h2>
            <span>{trash.length} 个可恢复员工 · 保留 7 天</span>
          </div>
        </div>
        {trash.length === 0 ? (
          <div className="empty-state">
            <Trash2 size={28} />
            <h3>回收站为空</h3>
            <p>从员工详情移入的全部数据会在这里保留 7 天。</p>
          </div>
        ) : (
          <div className="data-list">
            {trash.map((entry) => (
              <article key={entry.trashId}>
                <Trash2 size={18} />
                <div>
                  <strong>{entry.name}</strong>
                  <span>
                    {entry.agentId} · {new Date(entry.deletedAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <span className={`tag ${entry.state}`}>
                  {entry.state === 'ready' ? `剩余 ${entry.remainingDays} 天` : entry.state}
                </span>
                <button
                  className="button ghost"
                  disabled={entry.state !== 'ready'}
                  onClick={() => void restoreTrash(entry)}
                >
                  <RotateCcw size={14} />
                  恢复员工
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
