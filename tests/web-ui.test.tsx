// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateAgentPage } from '../web/src/pages/CreateAgentPage.js';
import { DashboardPage } from '../web/src/pages/DashboardPage.js';
import { AgentDetailPage } from '../web/src/pages/AgentDetailPage.js';
import { SkillStorePage } from '../web/src/pages/SkillStorePage.js';
import { OperationsDrawer } from '../web/src/components/OperationsDrawer.js';
import { BackupsPage } from '../web/src/pages/BackupsPage.js';
import { api } from '../web/src/api.js';

vi.mock('../web/src/api.js', () => ({
  api: {
    factoryStatus: vi.fn(),
    initializeFactory: vi.fn(),
    dashboard: vi.fn(),
    createAgent: vi.fn(),
    generateEmployeeProfile: vi.fn(),
    getAgent: vi.fn(),
    terminalGuidance: vi.fn(),
    lifecycle: vi.fn(),
    listDocuments: vi.fn(),
    listSkills: vi.fn(),
    removeSkill: vi.fn(),
    listSkillStoreRepositories: vi.fn(),
    addSkillStoreRepository: vi.fn(),
    removeSkillStoreRepository: vi.fn(),
    refreshSkillStoreRepository: vi.fn(),
    listSkillStoreSkills: vi.fn(),
    installSkillFromStore: vi.fn(),
    installAllSkillFromStore: vi.fn(),
    listOperations: vi.fn(),
    operationEvents: vi.fn(),
    trashAgent: vi.fn(),
    listTrash: vi.fn(),
    restoreTrash: vi.fn(),
    listBackups: vi.fn(),
    operation: vi.fn(),
    listAgents: vi.fn(),
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

  it('creates an employee via AI blueprint generation and a reviewable wizard', async () => {
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
    vi.mocked(api.generateEmployeeProfile).mockResolvedValue({
      id: 'content-operator',
      name: '内容运营',
      description: '负责内容选题与撰写',
      goals: ['每周输出报告'],
      responsibilities: ['选题策划'],
      policies: ['对外发布须审批'],
      escalation_conditions: ['需要管理决策'],
      skills: [],
    });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<CreateAgentPage />);
    await user.type(screen.getByLabelText('员工描述'), '帮我建一个内容运营');
    await user.click(screen.getByRole('button', { name: 'AI 生成蓝图' }));
    // 生成后预填字段，用户可编辑名称（id 由名称派生）。
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
      feishu: 'dedicated',
      description: '负责内容选题与撰写',
      goals: ['每周输出报告'],
      responsibilities: ['选题策划'],
      policies: ['对外发布须审批'],
      escalation_conditions: ['需要管理决策'],
      skills: [],
    });
    expect(await screen.findByText('员工创建完成')).toBeInTheDocument();
    expect(screen.getByText('agentctl runtime sync content-operator')).toBeInTheDocument();
    expect(
      screen.getByText('同步 CC Switch 当前 Claude Provider 到员工隔离环境'),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: '复制命令 agentctl runtime sync content-operator',
      }),
    );
    expect(writeText).toHaveBeenCalledWith('agentctl runtime sync content-operator');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(await screen.findByText('已复制')).toBeInTheDocument();
  });

  it('prefills a default blueprint on entry, then allows manual override (D-029)', async () => {
    vi.mocked(api.createAgent).mockResolvedValue({
      id: 'manual-ops',
      workspace: '/tmp/agents/manual-ops',
    });
    const user = userEvent.setup();

    render(<CreateAgentPage />);
    // 进入向导即预填可编辑的默认蓝图（无需触发 AI 生成）。
    expect(screen.getByLabelText('员工名称')).toHaveValue('用户运营专员');
    expect(screen.getByLabelText('Agent ID')).toHaveValue('user-operations');
    expect(api.generateEmployeeProfile).not.toHaveBeenCalled();
    // 用户仍可手动覆盖。
    await user.clear(screen.getByLabelText('员工名称'));
    await user.type(screen.getByLabelText('员工名称'), 'Manual Ops');
    await user.clear(screen.getByLabelText('Agent ID'));
    await user.type(screen.getByLabelText('Agent ID'), 'manual-ops');
    await user.clear(screen.getByLabelText('职责描述'));
    await user.type(screen.getByLabelText('职责描述'), '手工创建的员工');
    await user.clear(screen.getByLabelText('核心目标（每行一条）'));
    await user.type(screen.getByLabelText('核心目标（每行一条）'), '目标一');
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByLabelText('Claude Code'));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '创建员工' }));

    expect(api.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'manual-ops',
        name: 'Manual Ops',
        description: '手工创建的员工',
        goals: ['目标一'],
      }),
    );
    expect(await screen.findByText('员工创建完成')).toBeInTheDocument();
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
        runtime_home: { path: '/private/runtimes/ops/claude' },
        bridge: { enabled: true, authorization: 'pending', home: '/private/bridges/ops' },
      },
      agent: {
        description: '负责用户运营',
        runtime: { provider: 'claude', locked: true, model: 'sonnet' },
      },
    } as never);
    vi.mocked(api.terminalGuidance).mockResolvedValue({
      runtimeLogin: 'agentctl runtime sync ops',
      bridgeAuthorize: 'agentctl bridge authorize ops',
      chat: 'agentctl chat ops',
    });

    render(<AgentDetailPage agentId="ops" />);

    expect(await screen.findByText('运营专员')).toBeInTheDocument();
    expect(screen.getByText('Claude · sonnet')).toBeInTheDocument();
    expect(screen.getByText('运行器已锁定')).toBeInTheDocument();
    expect(screen.getByText('同步 CC Switch Provider')).toBeInTheDocument();
    expect(
      screen.getByText('读取 CC Switch 当前 Claude Provider，并安全同步到该员工的隔离环境。'),
    ).toBeInTheDocument();
    expect(screen.getByText('agentctl runtime sync ops')).toBeInTheDocument();
    expect(screen.getByText('授权飞书机器人')).toBeInTheDocument();
    expect(
      screen.getByText('启用飞书后执行；通过扫码或应用授权，让该员工连接独立飞书机器人。'),
    ).toBeInTheDocument();
    expect(screen.getByText('开始终端对话')).toBeInTheDocument();
    expect(
      screen.getByText('Provider 同步或登录完成后执行；在员工 Workspace 中开启交互会话。'),
    ).toBeInTheDocument();
  });

  it('shows lifecycle progress and success instead of silently reloading', async () => {
    const detail = {
      registry: {
        id: 'ops',
        name: '运营专员',
        status: 'stopped',
        runtime_home: { path: '/private/runtimes/ops/claude' },
        bridge: { enabled: true, authorization: 'ready', home: '/private/bridges/ops' },
      },
      agent: {
        description: '负责用户运营',
        runtime: { provider: 'claude', locked: true, model: 'sonnet' },
      },
    };
    vi.mocked(api.getAgent).mockResolvedValue(detail as never);
    vi.mocked(api.terminalGuidance).mockResolvedValue({
      runtimeLogin: 'agentctl runtime sync ops',
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

  it('moves an employee into recoverable trash with one confirmation', async () => {
    vi.mocked(api.getAgent).mockResolvedValue({
      registry: {
        id: 'ops',
        name: '运营专员',
        status: 'stopped',
        runtime_home: { path: '/private/runtimes/ops/claude' },
        bridge: { enabled: false, authorization: 'pending', home: '/private/bridges/ops' },
      },
      agent: {
        description: '测试员工',
        runtime: { provider: 'claude', locked: true },
      },
    } as never);
    vi.mocked(api.terminalGuidance).mockResolvedValue({
      runtimeLogin: 'agentctl runtime sync ops',
      bridgeAuthorize: 'agentctl bridge authorize ops',
      chat: 'agentctl chat ops',
    });
    vi.mocked(api.trashAgent).mockResolvedValue({
      trashId: '018f6b77-82d4-7c80-8000-000000000001',
      agentId: 'ops',
      state: 'ready',
    } as never);
    const user = userEvent.setup();

    render(<AgentDetailPage agentId="ops" />);
    await user.click(await screen.findByRole('button', { name: '移入回收站' }));
    await user.click(screen.getByRole('button', { name: '确认移入回收站' }));

    expect(api.trashAgent).toHaveBeenCalledWith('ops');
    expect(window.location.hash).toBe('#/agents');
  });

  it('lists recoverable employees and restores after confirmation', async () => {
    vi.mocked(api.listBackups).mockResolvedValue([]);
    vi.mocked(api.listTrash).mockResolvedValue([
      {
        trashId: '018f6b77-82d4-7c80-8000-000000000001',
        agentId: 'ops',
        name: '运营专员',
        deletedAt: '2026-08-03T00:00:00.000Z',
        expiresAt: '2026-08-10T00:00:00.000Z',
        remainingDays: 7,
        state: 'ready',
      },
    ]);
    vi.mocked(api.restoreTrash).mockResolvedValue({ restored: true } as never);
    const user = userEvent.setup();

    render(<BackupsPage />);
    expect(await screen.findByText('员工回收站')).toBeInTheDocument();
    expect(screen.getByText('剩余 7 天')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复员工' }));
    await user.click(screen.getByRole('button', { name: '确认恢复' }));

    expect(api.restoreTrash).toHaveBeenCalledWith('018f6b77-82d4-7c80-8000-000000000001');
  });

  it('browses a skill store repository and installs a skill to an agent', async () => {
    vi.mocked(api.listSkillStoreRepositories).mockResolvedValue([
      {
        name: 'superpowers',
        url: 'https://github.com/obra/superpowers',
        description: '社区技能',
        cached: false,
      },
    ]);
    vi.mocked(api.dashboard).mockResolvedValue({
      total: 1,
      running: 0,
      pendingAuthorization: 0,
      archived: 0,
      agents: [{ id: 'ops', name: '运营专员', status: 'stopped', archived: false }],
    } as never);
    vi.mocked(api.listSkillStoreSkills).mockResolvedValue([
      {
        name: 'hello',
        description: 'says hi',
        version: '1.0.0',
        path: 'skills/hello',
        repository: 'superpowers',
      },
    ]);
    vi.mocked(api.installSkillFromStore).mockResolvedValue({
      name: 'hello',
      version: '1.0.0',
      source: '/cache/superpowers/skills/hello',
      installed_at: '2026-08-04T00:00:00.000Z',
      digest: 'ab',
      scope: 'project',
    } as never);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/skill-store']}>
        <SkillStorePage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('superpowers')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '浏览技能' }));
    expect(await screen.findByText('says hi')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '安装' }));
    await user.click(screen.getByRole('button', { name: '确认安装' }));

    expect(api.installSkillFromStore).toHaveBeenCalledWith({
      repoName: 'superpowers',
      skillPath: 'skills/hello',
      agentId: 'ops',
      scope: 'project',
    });
    expect(await screen.findByText(/已安装 hello@1.0.0/)).toBeInTheDocument();
  });

  it('shows the skill count for each cached store repository', async () => {
    vi.mocked(api.listSkillStoreRepositories).mockResolvedValue([
      {
        name: 'larksuite-cli',
        url: 'https://github.com/larksuite/cli',
        description: '飞书 CLI',
        cached: true,
      },
    ]);
    vi.mocked(api.dashboard).mockResolvedValue({
      total: 0,
      running: 0,
      pendingAuthorization: 0,
      archived: 0,
      agents: [],
    } as never);
    vi.mocked(api.listSkillStoreSkills).mockResolvedValue([
      {
        name: 'lark-shared',
        description: '共享鉴权',
        version: '1.0.0',
        path: 'skills/lark-shared',
        repository: 'larksuite-cli',
      },
    ] as never);

    render(
      <MemoryRouter initialEntries={['/skill-store']}>
        <SkillStorePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('1 个技能')).toBeInTheDocument();
  });

  it('one-click installs all skills of a repository to the first agent', async () => {
    vi.mocked(api.listSkillStoreRepositories).mockResolvedValue([
      {
        name: 'larksuite-cli',
        url: 'https://github.com/larksuite/cli',
        description: '飞书 CLI',
        cached: true,
      },
    ]);
    vi.mocked(api.dashboard).mockResolvedValue({
      total: 1,
      running: 0,
      pendingAuthorization: 0,
      archived: 0,
      agents: [{ id: 'ops', name: '运营专员', status: 'stopped', archived: false }],
    } as never);
    vi.mocked(api.listSkillStoreSkills).mockResolvedValue([
      {
        name: 'lark-shared',
        description: '共享鉴权',
        version: '1.0.0',
        path: 'skills/lark-shared',
        repository: 'larksuite-cli',
      },
    ] as never);
    vi.mocked(api.installAllSkillFromStore).mockResolvedValue({
      total: 1,
      installed: [{ name: 'lark-shared', version: '1.0.0', scope: 'project' }],
      skipped: [],
      failed: [],
    } as never);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/skill-store']}>
        <SkillStorePage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: '一键安装全部' }));
    await user.click(screen.getByRole('button', { name: '确认一键安装' }));

    expect(api.installAllSkillFromStore).toHaveBeenCalledWith({
      repoName: 'larksuite-cli',
      agentId: 'ops',
      scope: 'project',
    });
    expect(
      await screen.findByText(/一键安装 larksuite-cli 全部技能（项目级）：成功 1\/1/),
    ).toBeInTheDocument();
  });

  it('bulk install modal lets choosing user scope and a target agent', async () => {
    vi.mocked(api.listSkillStoreRepositories).mockResolvedValue([
      {
        name: 'superpowers',
        url: 'https://github.com/obra/superpowers',
        description: '社区技能',
        cached: true,
      },
    ]);
    vi.mocked(api.dashboard).mockResolvedValue({
      total: 2,
      running: 0,
      pendingAuthorization: 0,
      archived: 0,
      agents: [
        { id: 'ops', name: '运营专员', status: 'stopped', archived: false },
        { id: 'growth', name: '增长专员', status: 'stopped', archived: false },
      ],
    } as never);
    vi.mocked(api.listSkillStoreSkills).mockResolvedValue([
      {
        name: 'hello',
        description: 'says hi',
        version: '1.0.0',
        path: 'skills/hello',
        repository: 'superpowers',
      },
    ] as never);
    vi.mocked(api.installAllSkillFromStore).mockResolvedValue({
      total: 1,
      installed: [{ name: 'hello', version: '1.0.0', scope: 'user' }],
      skipped: [],
      failed: [],
    } as never);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/skill-store']}>
        <SkillStorePage />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: '一键安装全部' }));
    // 选用户级作用域 + 切到增长专员
    await user.click(screen.getByRole('button', { name: '用户级' }));
    await user.selectOptions(screen.getByRole('combobox'), 'growth');
    await user.click(screen.getByRole('button', { name: '确认一键安装' }));

    expect(api.installAllSkillFromStore).toHaveBeenCalledWith({
      repoName: 'superpowers',
      agentId: 'growth',
      scope: 'user',
    });
    expect(
      await screen.findByText(/一键安装 superpowers 全部技能（用户级）：成功 1\/1/),
    ).toBeInTheDocument();
  });

  it('uninstalls a Skill from the Skills tab after an irreversible confirmation', async () => {
    vi.mocked(api.getAgent).mockResolvedValue({
      registry: {
        id: 'ops',
        name: '运营专员',
        status: 'stopped',
        runtime_home: { path: '/private/runtimes/ops/claude' },
        bridge: { enabled: false, authorization: 'pending', home: '/private/bridges/ops' },
      },
      agent: {
        description: '负责用户运营',
        runtime: { provider: 'claude', locked: true, model: 'sonnet' },
      },
    } as never);
    vi.mocked(api.terminalGuidance).mockResolvedValue({
      runtimeLogin: 'agentctl runtime sync ops',
      bridgeAuthorize: 'agentctl bridge authorize ops',
      chat: 'agentctl chat ops',
    });
    vi.mocked(api.listSkills)
      .mockResolvedValueOnce([
        {
          name: 'research-helper',
          version: '1.0.0',
          source: '/tmp/research-helper',
          installed_at: '2026-08-04T00:00:00.000Z',
          digest: 'abcdef0123456789',
          scope: 'project',
        },
      ])
      .mockResolvedValue([]);
    vi.mocked(api.removeSkill).mockResolvedValue({ removed: true, scope: 'project' });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/agents/ops']}>
        <AgentDetailPage agentId="ops" />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Skills' }));
    await user.click(await screen.findByRole('button', { name: '卸载' }));
    await user.click(screen.getByRole('button', { name: '确认卸载' }));

    expect(api.removeSkill).toHaveBeenCalledWith('ops', 'research-helper', 'project');
    // 卸载后列表刷新（getAgent 重载 + listSkills 重新拉取）
    expect(await screen.findByText('暂无 项目级 Skill')).toBeInTheDocument();
  });
});
