import { useState } from 'react';
import { HashRouter, Route, Routes, useParams } from 'react-router-dom';
import { Factory } from 'lucide-react';
import { AppSidebar } from './components/AppSidebar.js';
import { AppTopbar } from './components/AppTopbar.js';
import { OperationsDrawer } from './components/OperationsDrawer.js';
import { PageHeader } from './components/PageHeader.js';
import { Button } from './components/ui/button.js';
import { AgentDetailPage } from './pages/AgentDetailPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { BackupsPage } from './pages/BackupsPage.js';
import { CreateAgentPage } from './pages/CreateAgentPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DoctorPage } from './pages/DoctorPage.js';
import { SkillStorePage } from './pages/SkillStorePage.js';

function DetailRoute() {
  const { id } = useParams();
  return id ? <AgentDetailPage agentId={id} /> : <AgentsPage />;
}

function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Factory className="size-7" />
        </div>
        <PageHeader eyebrow="页面未找到" title="这个页面不存在" />
        <p className="mb-6 mt-2 text-sm text-muted-foreground">
          地址可能有误，或页面已被移动。返回控制台继续工作。
        </p>
        <Button asChild>
          <a href="#/">返回运行总览</a>
        </Button>
      </div>
    </div>
  );
}

function Shell() {
  const [operationsOpen, setOperationsOpen] = useState(false);
  return (
    <div className={`app-shell ${operationsOpen ? 'operations-open' : ''}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <AppSidebar />
      <div className="workspace-shell">
        <AppTopbar />
        <main className="mx-auto max-w-[1440px] px-6 py-8 sm:px-8" id="main-content">
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
