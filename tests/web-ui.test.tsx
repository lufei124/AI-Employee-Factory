// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateAgentPage } from '../web/src/pages/CreateAgentPage.js';
import { DashboardPage } from '../web/src/pages/DashboardPage.js';
import { AgentDetailPage } from '../web/src/pages/AgentDetailPage.js';
import { OperationsDrawer } from '../web/src/components/OperationsDrawer.js';
import { api } from '../web/src/api.js';

vi.mock('../web/src/api.js', () => ({
  api: {
    factoryStatus: vi.fn(),
    initializeFactory: vi.fn(),
    dashboard: vi.fn(),
    createAgent: vi.fn(),
    getAgent: vi.fn(),
    terminalGuidance: vi.fn(),
    lifecycle: vi.fn(),
    listDocuments: vi.fn(),
    listSkills: vi.fn(),
    listOperations: vi.fn(),
    operationEvents: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Web console core flows', () => {
  it('initializes an empty Factory from the dashboard', async () => {
    vi.mocked(api.factoryStatus).mockResolvedValue({ initialized: false });
    vi.mocked(api.initializeFactory).mockResolvedValue({ initialized: true });
    vi.mocked(api.dashboard).mockResolvedValue({
      total: 0,
      running: 0,
      pendingAuthorization: 0,
      archived: 0,
      agents: [],
    });
    const user = userEvent.setup();

    render(<DashboardPage />);
    expect(await screen.findByText('欢迎来到 AI Employee Factory')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '初始化 Factory' }));

    expect(api.initializeFactory).toHaveBeenCalledOnce();
    expect(await screen.findByText('尚未创建 AI 员工')).toBeInTheDocument();
  });

  it('creates an employee through a reviewable multi-step wizard', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard permission denied'));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    vi.mocked(api.createAgent).mockResolvedValue({
      id: 'content-operator',
      workspace: '/tmp/agents/content-operator',
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CreateAgentPage />);
    await user.clear(screen.getByLabelText('员工名称'));
    await user.type(screen.getByLabelText('员工名称'), 'Content Operator');
    expect(screen.getByLabelText('Agent ID')).toHaveValue('content-operator');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByLabelText('Claude Code'));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('创建预览')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建员工' }));

    expect(api.createAgent).toHaveBeenCalledWith({
      id: 'content-operator',
      name: 'Content Operator',
      runtime: 'claude',
      preset: 'user-operations',
      feishu: 'dedicated',
    });
    expect(await screen.findByText('员工创建完成')).toBeInTheDocument();
    expect(screen.getByText('agentctl runtime login content-operator')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: '复制命令 agentctl runtime login content-operator',
      }),
    );
    expect(writeText).toHaveBeenCalledWith('agentctl runtime login content-operator');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('opens the operation center without a page-blocking backdrop', async () => {
    vi.mocked(api.listOperations).mockResolvedValue([]);
    const user = userEvent.setup();

    render(<OperationsDrawer />);
    await user.click(screen.getByRole('button', { name: '操作中心' }));

    expect(screen.getByRole('complementary', { name: '操作中心' })).toHaveClass('open');
    expect(document.querySelector('.drawer-backdrop')).not.toBeInTheDocument();
  });

  it('shows immutable runtime data and terminal guidance on Agent detail', async () => {
    vi.mocked(api.getAgent).mockResolvedValue({
      registry: {
        id: 'ops',
        name: '运营专员',
        status: 'stopped',
        runtime: { provider: 'claude', locked: true, model: 'sonnet' },
        runtime_home: { path: '/private/runtimes/ops/claude' },
        bridge: { enabled: true, authorization: 'pending', home: '/private/bridges/ops' },
      },
      agent: { description: '负责用户运营' },
    } as never);
    vi.mocked(api.terminalGuidance).mockResolvedValue({
      runtimeLogin: 'agentctl runtime login ops',
      bridgeAuthorize: 'agentctl bridge authorize ops',
      chat: 'agentctl chat ops',
    });

    render(<AgentDetailPage agentId="ops" />);

    expect(await screen.findByText('运营专员')).toBeInTheDocument();
    expect(screen.getByText('Claude · sonnet')).toBeInTheDocument();
    expect(screen.getByText('运行器已锁定')).toBeInTheDocument();
    expect(screen.getByText('登录 AI 运行器')).toBeInTheDocument();
    expect(
      screen.getByText('首次使用或登录失效时执行；登录该员工专属的 Claude/Codex 环境。'),
    ).toBeInTheDocument();
    expect(screen.getByText('agentctl runtime login ops')).toBeInTheDocument();
    expect(screen.getByText('授权飞书机器人')).toBeInTheDocument();
    expect(
      screen.getByText('启用飞书后执行；通过扫码或应用授权，让该员工连接独立飞书机器人。'),
    ).toBeInTheDocument();
    expect(screen.getByText('开始终端对话')).toBeInTheDocument();
    expect(
      screen.getByText('登录完成后执行；在员工 Workspace 中开启与 AI 员工的交互会话。'),
    ).toBeInTheDocument();
  });

  it('shows lifecycle progress and success instead of silently reloading', async () => {
    const detail = {
      registry: {
        id: 'ops',
        name: '运营专员',
        status: 'stopped',
        runtime: { provider: 'claude', locked: true, model: 'sonnet' },
        runtime_home: { path: '/private/runtimes/ops/claude' },
        bridge: { enabled: true, authorization: 'ready', home: '/private/bridges/ops' },
      },
      agent: { description: '负责用户运营' },
    };
    vi.mocked(api.getAgent).mockResolvedValue(detail as never);
    vi.mocked(api.terminalGuidance).mockResolvedValue({
      runtimeLogin: 'agentctl runtime login ops',
      bridgeAuthorize: 'agentctl bridge authorize ops',
      chat: 'agentctl chat ops',
    });
    let finishLifecycle!: (value: { state: string }) => void;
    vi.mocked(api.lifecycle).mockReturnValue(
      new Promise((resolve) => {
        finishLifecycle = resolve;
      }),
    );
    const user = userEvent.setup();

    render(<AgentDetailPage agentId="ops" />);
    await user.click(await screen.findByRole('button', { name: '启动' }));

    expect(screen.getByRole('button', { name: '启动中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled();
    finishLifecycle({ state: 'running' });
    expect(await screen.findByText('启动成功，当前状态：运行中')).toBeInTheDocument();
    expect(api.getAgent).toHaveBeenCalledTimes(2);
  });
});
