import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { ToastViewport } from './components/ui/sonner.js';
import { initializeWebSession } from './api.js';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);

try {
  await initializeWebSession();
  root.render(
    <StrictMode>
      <TooltipProvider>
        <App />
        <ToastViewport />
      </TooltipProvider>
    </StrictMode>,
  );
} catch (error) {
  root.render(
    <main className="flex min-h-dvh items-center justify-center p-8 bg-background text-foreground">
      <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 shadow-overlay">
        <span className="text-xs font-semibold uppercase tracking-wide text-destructive">
          会话异常
        </span>
        <h1 className="mt-2 text-xl font-semibold">无法进入本地控制台</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          请回到终端重新运行{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono">agentctl web</code>。
        </p>
      </div>
    </main>,
  );
}
