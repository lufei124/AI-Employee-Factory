import { NavLink } from 'react-router-dom';
import { Archive, Bot, Factory, LayoutDashboard, Plus, ShieldCheck, Store } from 'lucide-react';
import { cn } from '../lib/utils.js';

const navGroups = [
  {
    label: '管理',
    items: [
      { to: '/', label: '总览', icon: LayoutDashboard, end: true },
      { to: '/agents', label: 'AI 员工', icon: Bot },
      { to: '/create', label: '创建员工', icon: Plus },
    ],
  },
  {
    label: '运维',
    items: [
      { to: '/skill-store', label: 'Skill 商店', icon: Store },
      { to: '/backups', label: '备份恢复', icon: Archive },
      { to: '/doctor', label: '系统诊断', icon: ShieldCheck },
    ],
  },
];

export function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-[232px] flex-col border-r border-border bg-muted/40 px-3 py-4">
      <a href="#/" className="mb-6 flex items-center gap-3 px-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Factory className="size-5" />
        </span>
        <span className="flex flex-col leading-tight">
          <strong className="text-sm font-semibold tracking-tight">AI Employee</strong>
          <span className="text-[11px] text-muted-foreground">Factory · 本地控制面</span>
        </span>
      </a>

      <nav className="flex-1 space-y-6 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end ?? false}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )
                  }
                >
                  <Icon className="size-[18px] shrink-0" />
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-4 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-success" />
          </span>
          <div className="flex flex-col leading-tight">
            <strong className="text-xs font-semibold">仅本机运行</strong>
            <span className="text-[10px] text-muted-foreground">127.0.0.1 · 安全会话</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
