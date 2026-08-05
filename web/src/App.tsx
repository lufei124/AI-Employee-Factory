import { useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useParams } from 'react-router-dom';
import {
  Activity,
  Archive,
  Bot,
  Factory,
  LayoutDashboard,
  Plus,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { OperationsDrawer } from './components/OperationsDrawer.js';
import { AgentDetailPage } from './pages/AgentDetailPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { BackupsPage } from './pages/BackupsPage.js';
import { CreateAgentPage } from './pages/CreateAgentPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DoctorPage } from './pages/DoctorPage.js';
import { SkillStorePage } from './pages/SkillStorePage.js';

const navGroups = [
  {
    key: 'manage',
    items: [
      { to: '/', label: '总览', icon: LayoutDashboard },
      { to: '/agents', label: 'AI 员工', icon: Bot },
      { to: '/create', label: '创建员工', icon: Plus },
    ],
  },
  {
    key: 'ops',
    items: [
      { to: '/skill-store', label: 'Skill 商店', icon: Store },
      { to: '/backups', label: '备份恢复', icon: Archive },
      { to: '/doctor', label: '系统诊断', icon: ShieldCheck },
    ],
  },
];

function DetailRoute() {
  const { id } = useParams();
  return id ? <AgentDetailPage agentId={id} /> : <AgentsPage />;
}

function NotFound() {
  return (
    <section className="welcome-panel">
      <div className="welcome-icon">
        <Factory size={36} />
      </div>
      <p className="eyebrow">页面未找到</p>
      <h1>这个页面不存在</h1>
      <p>地址可能有误，或页面已被移动。返回控制台继续工作。</p>
      <a className="button primary" href="#/">
        返回运行总览
      </a>
    </section>
  );
}

function Shell() {
  const [operationsOpen, setOperationsOpen] = useState(false);
  return (
    <div className={`app-shell ${operationsOpen ? 'operations-open' : ''}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="#/">
          <span>
            <Factory size={22} />
          </span>
          <div>
            <strong>AI Employee</strong>
            <small>Factory</small>
          </div>
        </a>
        <nav>
          {navGroups.map(({ key, items }) => (
            <div className="nav-group" key={key}>
              {items.map(({ to, label, icon: Icon }) => (
                <NavLink end={to === '/'} to={to} key={to}>
                  <Icon size={18} />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-pulse" />
          <div>
            <strong>仅本机运行</strong>
            <small>127.0.0.1 · 安全会话</small>
          </div>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Activity size={15} />
            本地控制面
          </div>
        </header>
        <main className="main-content" id="main-content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:id" element={<DetailRoute />} />
            <Route path="/create" element={<CreateAgentPage />} />
            <Route path="/backups" element={<BackupsPage />} />
            <Route path="/skill-store" element={<SkillStorePage />} />
            <Route path="/doctor" element={<DoctorPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
      <OperationsDrawer onOpenChange={setOperationsOpen} />
    </div>
  );
}

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
