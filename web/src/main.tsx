import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initializeWebSession } from './api.js';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);

try {
  await initializeWebSession();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (error) {
  root.render(
    <main className="fatal-screen">
      <div>
        <span>会话异常</span>
        <h1>无法进入本地控制台</h1>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        <p>
          请回到终端重新运行 <code>agentctl web</code>。
        </p>
      </div>
    </main>,
  );
}
