import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  Store,
  Trash2,
} from 'lucide-react';
import {
  api,
  type DashboardData,
  type SkillScope,
  type StoreRepository,
  type StoreSkill,
} from '../api.js';
import { PageHeader } from '../components/PageHeader.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { notify, errorText } from '../components/ToastFeedback.js';
import { EmptyState } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { cn } from '../lib/utils.js';

function SkillInstallDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  scope,
  agent,
  agents,
  installing,
  confirmLabel = '确认安装',
  onScopeChange,
  onAgentChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle: string;
  scope: SkillScope;
  agent: string;
  agents: DashboardData['agents'];
  installing: boolean;
  confirmLabel?: string;
  onScopeChange: (scope: SkillScope) => void;
  onAgentChange: (agentId: string) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="install-agent">目标员工</Label>
            <select
              id="install-agent"
              value={agent}
              onChange={(event) => onAgentChange(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {agents
                .filter((agent) => !agent.archived)
                .map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name}（{agent.id}）
                  </option>
                ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>安装作用域</Label>
            <div className="flex gap-1">
              {(
                [
                  { value: 'project', label: '项目级' },
                  { value: 'user', label: '用户级' },
                ] as const
              ).map((option) => (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => onScopeChange(option.value)}
                  className={cn(
                    'flex-1 rounded-md px-3 py-2 text-sm transition-colors',
                    scope === option.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            取消
          </Button>
          <Button disabled={installing} onClick={onConfirm}>
            {installing ? '安装中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SkillStorePage() {
  const [searchParams] = useSearchParams();
  const preselectAgent = searchParams.get('agent') ?? '';
  const [repos, setRepos] = useState<StoreRepository[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [agents, setAgents] = useState<DashboardData['agents']>([]);
  const [expanded, setExpanded] = useState<string>();
  const [skills, setSkills] = useState<StoreSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', url: '', description: '' });
  const [install, setInstall] = useState<{ skill: StoreSkill; repo: string }>();
  const [bulkRepo, setBulkRepo] = useState<string>();
  const [bulkCount, setBulkCount] = useState<number>();
  const [installAgent, setInstallAgent] = useState(preselectAgent);
  const [installScope, setInstallScope] = useState<SkillScope>('project');
  const [installing, setInstalling] = useState(false);
  const [removingRepo, setRemovingRepo] = useState<StoreRepository>();

  const load = async () => {
    try {
      const [repoList, agentList] = await Promise.all([
        api.listSkillStoreRepositories(),
        api.dashboard(),
      ]);
      setRepos(repoList);
      setAgents(agentList.agents);
      setError('');
      const counts: Record<string, number> = {};
      await Promise.all(
        repoList
          .filter((repo) => repo.cached)
          .map(async (repo) => {
            try {
              counts[repo.name] = (await api.listSkillStoreSkills(repo.name)).length;
            } catch {
              /* 忽略单个仓库计数失败 */
            }
          }),
      );
      setCounts(counts);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openRepo = async (name: string) => {
    if (expanded === name) {
      setExpanded(undefined);
      setSkills([]);
      return;
    }
    setExpanded(name);
    setSkillsLoading(true);
    setError('');
    try {
      setSkills(await api.listSkillStoreSkills(name));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSkillsLoading(false);
    }
  };

  const refresh = async (name: string) => {
    setError('');
    setFeedback('');
    try {
      await api.refreshSkillStoreRepository(name);
      await load();
      if (expanded === name) {
        setSkills(await api.listSkillStoreSkills(name));
      }
      setFeedback(`仓库 ${name} 已刷新。`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const removeRepo = async () => {
    if (!removingRepo) return;
    try {
      await api.removeSkillStoreRepository(removingRepo.name);
      if (expanded === removingRepo.name) {
        setExpanded(undefined);
        setSkills([]);
      }
      setRemovingRepo(undefined);
      await load();
      notify.success(`仓库源 ${removingRepo.name} 已移除`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const addRepo = async () => {
    setError('');
    try {
      await api.addSkillStoreRepository(addForm);
      setAddForm({ name: '', url: '', description: '' });
      setShowAdd(false);
      await load();
      notify.success('仓库源已添加');
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const openInstall = (skill: StoreSkill) => {
    setInstall({ skill, repo: expanded ?? '' });
    setInstallAgent(preselectAgent || agents[0]?.id || '');
    setInstallScope('project');
  };

  const openBulkInstall = async (repo: StoreRepository) => {
    let repoSkills: StoreSkill[];
    try {
      repoSkills = await api.listSkillStoreSkills(repo.name);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    if (repoSkills.length === 0) {
      setFeedback(`仓库 ${repo.name} 没有可安装的技能。`);
      return;
    }
    setBulkRepo(repo.name);
    setBulkCount(repoSkills.length);
    setInstallAgent(preselectAgent || agents[0]?.id || '');
    setInstallScope('project');
  };

  const installAll = async (repoName: string) => {
    const target = installAgent;
    if (!target || !bulkRepo) return;
    setInstalling(true);
    setError('');
    try {
      const result = await api.installAllSkillFromStore({
        repoName,
        agentId: target,
        scope: installScope,
      });
      setBulkRepo(undefined);
      setBulkCount(undefined);
      const targetName = agents.find((agent) => agent.id === target)?.name ?? target;
      const scopeLabel = installScope === 'project' ? '项目级' : '用户级';
      const parts = [
        `已向 ${targetName} 一键安装 ${repoName} 全部技能（${scopeLabel}）：成功 ${result.installed.length}/${result.total}`,
      ];
      if (result.skipped.length) parts.push(`已存在跳过 ${result.skipped.length}`);
      if (result.failed.length)
        parts.push(`失败 ${result.failed.length}（${result.failed.join('；')}）`);
      setFeedback(`${parts.join('，')}。`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setInstalling(false);
    }
  };

  const confirmInstall = async () => {
    if (!install) return;
    setInstalling(true);
    setError('');
    try {
      const result = await api.installSkillFromStore({
        repoName: install.repo,
        skillPath: install.skill.path,
        agentId: installAgent,
        scope: installScope,
      });
      setInstall(undefined);
      setFeedback(
        `已安装 ${result.name}@${result.version}（${result.scope === 'project' ? '项目级' : '用户级'}）到 ${installAgent}。`,
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setInstalling(false);
    }
  };

  const filteredSkills = skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="技能市场"
        title="Skill 商店"
        description="浏览远端 GitHub 仓库源并安装技能，不影响已有安装方式。"
        actions={
          <Button variant="outline" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="size-4" />
            {showAdd ? '收起表单' : '添加仓库'}
          </Button>
        }
      />

      {showAdd && (
        <section className="rounded-xl border border-border bg-card p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>仓库名</Label>
              <Input
                value={addForm.name}
                onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
                placeholder="my-skills"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>GitHub URL</Label>
              <Input
                value={addForm.url}
                onChange={(event) => setAddForm({ ...addForm, url: event.target.value })}
                placeholder="https://github.com/owner/repo"
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>描述</Label>
              <Input
                value={addForm.description}
                onChange={(event) => setAddForm({ ...addForm, description: event.target.value })}
                placeholder="可选"
              />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              仅接受 https://github.com/ 的公开仓库
            </span>
            <Button onClick={() => void addRepo()}>添加仓库源</Button>
          </div>
        </section>
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {feedback && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-primary">
          {feedback}
        </div>
      )}

      {repos.length === 0 ? (
        <section className="rounded-xl border border-border bg-card p-6">
          <EmptyState
            icon={<Store className="size-5" />}
            title="暂无仓库源"
            description="添加一个 GitHub 仓库源，即可浏览并安装其中的技能。"
          />
        </section>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {repos.map((repo) => (
            <article key={repo.name} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <Store className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm font-semibold">{repo.name}</strong>
                    <span className="block truncate text-xs text-muted-foreground">
                      {repo.description ?? repo.url}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded px-2 py-0.5 text-[10px] font-semibold',
                      repo.cached ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
                    )}
                  >
                    {repo.cached ? '已缓存' : '未缓存'}
                  </span>
                  {counts[repo.name] != null && (
                    <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {counts[repo.name]} 个技能
                    </span>
                  )}
                </div>
              </div>
              <a
                className="mt-3 flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                href={repo.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="size-3" />
                {repo.url}
              </a>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={installing} onClick={() => void openBulkInstall(repo)}>
                  <Download className="size-4" />
                  一键安装全部
                </Button>
                <Button variant="outline" size="sm" onClick={() => void openRepo(repo.name)}>
                  {expanded === repo.name ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                  {expanded === repo.name ? '收起' : '浏览技能'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void refresh(repo.name)}>
                  <RefreshCw className="size-4" />
                  刷新
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setRemovingRepo(repo)}
                >
                  <Trash2 className="size-4" />
                  移除
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {expanded && (
        <section className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold">{expanded}</h2>
              <span className="text-xs text-muted-foreground">
                仓库技能列表{counts[expanded] != null ? ` · ${counts[expanded]} 个` : ''}
              </span>
            </div>
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能"
                className="pl-9"
              />
            </div>
          </div>
          {skillsLoading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <RefreshCw className="mx-auto mb-2 size-5 animate-spin" />
              正在读取技能…
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<Store className="size-5" />}
                title="未发现技能"
                description="仓库可能未包含 SKILL.md 或 agent-skills.yaml 清单。"
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filteredSkills.map((skill) => (
                <li key={skill.path} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <strong className="block text-sm font-medium">{skill.name}</strong>
                    <p className="truncate text-xs text-muted-foreground">
                      {skill.description || '暂无描述'}
                    </p>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      v{skill.version} · {skill.path}
                    </span>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openInstall(skill)}>
                    <Plus className="size-4" />
                    安装
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <SkillInstallDialog
        open={Boolean(install)}
        onOpenChange={(open) => {
          if (!open && !installing) setInstall(undefined);
        }}
        title="安装 Skill"
        subtitle={install ? `${install.skill.name} · ${install.repo}` : ''}
        scope={installScope}
        agent={installAgent}
        agents={agents}
        installing={installing}
        onAgentChange={setInstallAgent}
        onScopeChange={setInstallScope}
        onConfirm={() => void confirmInstall()}
      />

      <SkillInstallDialog
        open={Boolean(bulkRepo)}
        onOpenChange={(open) => {
          if (!open && !installing) {
            setBulkRepo(undefined);
            setBulkCount(undefined);
          }
        }}
        title="一键安装全部"
        subtitle={bulkRepo ? `${bulkRepo} · ${bulkCount} 个技能` : ''}
        scope={installScope}
        agent={installAgent}
        agents={agents}
        installing={installing}
        confirmLabel="确认一键安装"
        onAgentChange={setInstallAgent}
        onScopeChange={setInstallScope}
        onConfirm={() => void installAll(bulkRepo ?? '')}
      />

      <ConfirmDialog
        open={Boolean(removingRepo)}
        onOpenChange={(open) => {
          if (!open) setRemovingRepo(undefined);
        }}
        title="移除仓库源"
        description={removingRepo ? `移除仓库源 ${removingRepo.name}？缓存将一并删除。` : ''}
        confirmLabel="确认移除"
        onConfirm={() => void removeRepo()}
      />
    </div>
  );
}
