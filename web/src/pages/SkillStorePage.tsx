import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type DashboardData,
  type SkillScope,
  type StoreRepository,
  type StoreSkill,
} from '../api.js';

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
  const [installAgent, setInstallAgent] = useState(preselectAgent);
  const [installScope, setInstallScope] = useState<SkillScope>('project');
  const [installing, setInstalling] = useState(false);

  const load = async () => {
    try {
      const [repoList, agentList] = await Promise.all([
        api.listSkillStoreRepositories(),
        api.dashboard(),
      ]);
      setRepos(repoList);
      setAgents(agentList.agents);
      setError('');
      // 统计每个已缓存仓库的技能数量；单个仓库失败不阻塞页面。
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeRepo = async (repo: StoreRepository) => {
    if (!window.confirm(`移除仓库源 ${repo.name}？缓存将一并删除。`)) return;
    try {
      await api.removeSkillStoreRepository(repo.name);
      if (expanded === repo.name) {
        setExpanded(undefined);
        setSkills([]);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const addRepo = async () => {
    setError('');
    try {
      await api.addSkillStoreRepository(addForm);
      setAddForm({ name: '', url: '', description: '' });
      setShowAdd(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openInstall = (skill: StoreSkill) => {
    setInstall({ skill, repo: expanded ?? '' });
    setInstallAgent(preselectAgent || agents[0]?.id || '');
    setInstallScope('project');
  };

  // 一键安装：直接装到当前预选员工或第一个员工，作用域 project，跳过弹窗。
  const quickInstall = async (skill: StoreSkill) => {
    const target = preselectAgent || agents[0]?.id || '';
    if (!target) {
      openInstall(skill); // 无默认员工时退回选择弹窗
      return;
    }
    setInstalling(true);
    setError('');
    try {
      const result = await api.installSkillFromStore({
        repoName: expanded ?? '',
        skillPath: skill.path,
        agentId: target,
        scope: 'project',
      });
      const targetName = agents.find((agent) => agent.id === target)?.name ?? target;
      setFeedback(`已一键安装 ${result.name}@${result.version} 到 ${targetName}（project）。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };

  const filteredSkills = skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="page-stack">
      <header className="page-heading store-heading">
        <div>
          <p className="eyebrow">SKILL STORE</p>
          <h1>Skill 商店</h1>
          <p>浏览远端 GitHub 仓库源并安装技能，不影响已有安装方式。</p>
        </div>
        <button className="button primary" onClick={() => setShowAdd(!showAdd)}>
          <Plus size={15} />
          {showAdd ? '收起表单' : '添加仓库'}
        </button>
      </header>

      {showAdd && (
        <section className="panel store-add-form">
          <div className="form-grid two">
            <label>
              仓库名
              <input
                value={addForm.name}
                onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
                placeholder="my-skills"
              />
            </label>
            <label>
              GitHub URL
              <input
                value={addForm.url}
                onChange={(event) => setAddForm({ ...addForm, url: event.target.value })}
                placeholder="https://github.com/owner/repo"
              />
            </label>
            <label className="store-field-wide">
              描述
              <input
                value={addForm.description}
                onChange={(event) => setAddForm({ ...addForm, description: event.target.value })}
                placeholder="可选"
              />
            </label>
          </div>
          <div className="wizard-actions">
            <span className="field-help">仅接受 https://github.com/ 的公开仓库</span>
            <button className="button primary" onClick={() => void addRepo()}>
              添加仓库源
            </button>
          </div>
        </section>
      )}

      {error && <div className="notice danger">{error}</div>}
      {feedback && <div className="notice info">{feedback}</div>}

      {repos.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <Store size={26} />
            <h3>暂无仓库源</h3>
            <p>添加一个 GitHub 仓库源，即可浏览并安装其中的技能。</p>
          </div>
        </section>
      ) : (
        <section className="store-repo-grid">
          {repos.map((repo) => (
            <article className="store-repo-card" key={repo.name}>
              <div className="store-repo-top">
                <div className="store-repo-title">
                  <span className="store-repo-icon">
                    <Store size={16} />
                  </span>
                  <div>
                    <strong>{repo.name}</strong>
                    <span>{repo.description ?? repo.url}</span>
                  </div>
                </div>
                <div className="store-repo-badges">
                  <span className={`status-badge ${repo.cached ? 'succeeded' : 'queued'}`}>
                    {repo.cached ? '已缓存' : '未缓存'}
                  </span>
                  {counts[repo.name] != null && (
                    <span className="status-badge store-count-badge">
                      {counts[repo.name]} 个技能
                    </span>
                  )}
                </div>
              </div>
              <a className="store-repo-url" href={repo.url} target="_blank" rel="noreferrer">
                <ExternalLink size={12} />
                {repo.url}
              </a>
              <div className="store-repo-actions">
                <button className="button ghost" onClick={() => void openRepo(repo.name)}>
                  {expanded === repo.name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {expanded === repo.name ? '收起' : '浏览技能'}
                </button>
                <button className="button ghost" onClick={() => void refresh(repo.name)}>
                  <RefreshCw size={14} />
                  刷新
                </button>
                <button className="button ghost danger-text" onClick={() => void removeRepo(repo)}>
                  <Trash2 size={14} />
                  移除
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {expanded && (
        <section className="panel store-skills-panel">
          <div className="panel-heading">
            <div>
              <h2>{expanded}</h2>
              <span>仓库技能列表{counts[expanded] != null ? ` · ${counts[expanded]} 个` : ''}</span>
            </div>
            <div className="search">
              <Search size={15} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索技能"
              />
            </div>
          </div>
          {skillsLoading ? (
            <div className="empty-state compact">
              <RefreshCw size={22} className="spin" />
              <h3>正在读取技能…</h3>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="empty-state compact">
              <Store size={22} />
              <h3>未发现技能</h3>
              <p>仓库可能未包含 SKILL.md 或 agent-skills.yaml 清单。</p>
            </div>
          ) : (
            <div className="store-skill-list">
              {filteredSkills.map((skill) => (
                <article key={skill.path}>
                  <div className="store-skill-main">
                    <strong>{skill.name}</strong>
                    <p>{skill.description || '暂无描述'}</p>
                    <span>
                      v{skill.version} · {skill.path}
                    </span>
                  </div>
                  <div className="store-skill-actions">
                    <button
                      className="button primary"
                      onClick={() => void quickInstall(skill)}
                      disabled={installing}
                      title={`装到 ${preselectAgent || agents[0]?.name || '…'}（project 作用域）`}
                    >
                      <Plus size={14} />
                      一键安装
                    </button>
                    <button className="button ghost" onClick={() => openInstall(skill)}>
                      选择目标
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {install && (
        <div className="modal-overlay" onClick={() => setInstall(undefined)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <div>
                <strong>安装 Skill</strong>
                <span>
                  {install.skill.name} · {install.repo}
                </span>
              </div>
              <button className="icon-button" onClick={() => setInstall(undefined)}>
                <X size={16} />
              </button>
            </header>
            <div className="form-stack">
              <label>
                目标员工
                <select
                  value={installAgent}
                  onChange={(event) => setInstallAgent(event.target.value)}
                >
                  <option value="">选择员工…</option>
                  {agents
                    .filter((agent) => !agent.archived)
                    .map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name}（{agent.id}）
                      </option>
                    ))}
                </select>
              </label>
              <label>
                安装作用域
                <div className="scope-picker">
                  <button
                    className={installScope === 'project' ? 'active' : ''}
                    onClick={() => setInstallScope('project')}
                  >
                    项目级
                  </button>
                  <button
                    className={installScope === 'user' ? 'active' : ''}
                    onClick={() => setInstallScope('user')}
                  >
                    用户级
                  </button>
                </div>
              </label>
              <div className="wizard-actions">
                <span className="field-help">项目级随工作区备份；用户级仅随 Runtime 备份。</span>
                <button
                  className="button primary"
                  disabled={!installAgent || installing}
                  onClick={() => void confirmInstall()}
                >
                  {installing ? '安装中…' : '确认安装'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
