import { Activity } from 'lucide-react';

/** 顶部栏：左侧面包屑/上下文，右侧留给操作中心触发器（fixed 定位）。 */
export function AppTopbar() {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Activity className="size-4" />
        <span>本地控制面</span>
      </div>
      <div className="text-[11px] text-muted-foreground">AI Employee Factory · v0.1</div>
    </header>
  );
}
