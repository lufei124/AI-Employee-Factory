import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import type { LoggedRunResult } from '../src/core/process-runner.js';
import { buildWebServer } from '../src/web/server.js';

// MCP 工具集成测（spec-chief-todo-mcp 阶段 3 / issue 12-13）。
// 起 buildWebServer(enableMcp:true) + POST /mcp 走 JSON-RPC，静态 bearer 认证。
// 编排写工具经 vi.spyOn(app.runAgent) 假运行，worker/Chief 均不真正 spawn。

const roots: string[] = [];
const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
});

function now(): string {
  return new Date().toISOString();
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-mcp-'));
  roots.push(root);
  const gitConfig = path.join(root, 'gitconfig');
  await fs.writeFile(
    gitConfig,
    '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n',
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  await app.initialize();
  await app.createAgent({
    id: 'chief',
    name: '主管',
    runtime: 'claude',
    preset: 'user-operations',
    feishu: 'disabled',
    role: 'chief',
  });
  await app.createAgent({
    id: 'worker-a',
    name: '员工 A',
    runtime: 'claude',
    preset: 'user-operations',
    feishu: 'disabled',
  });
  const server = buildWebServer({
    application: app,
    bootstrapToken: 'bootstrap-secret',
    enableMcp: true,
    mcpToken: 'mcp-secret',
  });
  return { root, paths, app, server };
}

interface RpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
  error?: { message?: string };
}

// MCP 客户端：initialize 后自动携带 mcp-session-id（真实客户端同样如此）。
class McpClient {
  private sessionId: string | undefined;
  constructor(
    private readonly server: ReturnType<typeof buildWebServer>,
    private readonly token: string | undefined,
  ) {}

  async request(body: Record<string, unknown>): Promise<RpcResponse> {
    const res = await this.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        host: '127.0.0.1:48123',
        accept: 'application/json, text/event-stream',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      payload: body,
    });
    const session = res.headers['mcp-session-id'];
    if (session) this.sessionId = session;
    return res.json() as RpcResponse;
  }

  initialize(): Promise<RpcResponse> {
    return this.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
  }

  listTools(): Promise<RpcResponse> {
    return this.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  }

  callTool(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
    return this.request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  }
}

function textOf(res: RpcResponse): string {
  return res.result?.content?.[0]?.text ?? '';
}

function fakeResult(stdout: string): LoggedRunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-mcp-stdout-'));
  roots.push(dir);
  const stdoutFile = path.join(dir, 'stdout.log');
  fs.writeFileSync(stdoutFile, stdout);
  return {
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    logDir: dir,
    stdoutFile,
    stderrFile: path.join(dir, 'stderr.log'),
    metadataFile: path.join(dir, 'metadata.json'),
    startedAt: now(),
    finishedAt: now(),
  };
}

function claudeResult(text: string): LoggedRunResult {
  return fakeResult(JSON.stringify({ result: text }));
}

function mockRunAgent(app: FactoryApplication) {
  vi.spyOn(app, 'runAgent').mockImplementation(async (_id, task) => {
    if (task.includes('交叉审查')) return claudeResult('{"verdict":"approved","note":"很好"}');
    if (task.includes('拆解')) return claudeResult('[]');
    if (task.includes('规划阶段')) return fakeResult('计划：分两步完成。');
    return { ...fakeResult('完成。'), exitCode: 0 };
  });
}

describe('MCP 端点（D-018 static bearer + 工具集）', () => {
  it('拒绝无/错 bearer token 的 /mcp 请求', async () => {
    const { server } = await setup();
    const noToken = await new McpClient(server, undefined).initialize();
    expect(noToken).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    const badToken = await new McpClient(server, 'wrong').initialize();
    expect(badToken).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('注册 13 个读 + 编排写工具', async () => {
    const { server } = await setup();
    const client = new McpClient(server, 'mcp-secret');
    await client.initialize();
    const listed = await client.listTools();
    const names = listed.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toHaveLength(13);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_agents',
        'get_agent',
        'list_operations',
        'get_operation',
        'list_jobs',
        'list_skills',
        'read_latest_log',
        'knowledge_recall',
        'create_task_plan',
        'run_task_plan',
        'approve_plan',
        'review_task_plan',
        'cancel_operation',
      ]),
    );
  });

  it('读工具：列员工/查员工/列 Job/列 Skill/读日志/召回记忆', async () => {
    const { paths, server } = await setup();
    const client = new McpClient(server, 'mcp-secret');
    await client.initialize();

    const agents = await client.callTool('list_agents', {});
    expect(JSON.parse(textOf(agents))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'chief', role: 'chief' }),
        expect.objectContaining({ id: 'worker-a' }),
      ]),
    );

    const one = await client.callTool('get_agent', { id: 'worker-a' });
    expect(JSON.parse(textOf(one))).toMatchObject({ registry: { id: 'worker-a' } });

    const jobs = await client.callTool('list_jobs', { agent_id: 'worker-a' });
    expect(JSON.parse(textOf(jobs))).toEqual([]);

    const skills = await client.callTool('list_skills', { agent_id: 'worker-a' });
    expect(JSON.parse(textOf(skills))).toBeDefined();

    // 写一条运行日志，read_latest_log 应读到其末尾。
    const logDir = path.join(paths.logsDir, 'worker-a', 'run');
    await fs.ensureDir(logDir);
    await fs.writeFile(path.join(logDir, '1.log'), 'line one\nline two\n');
    const log = await client.callTool('read_latest_log', { agent_id: 'worker-a', lines: 5 });
    expect(JSON.parse(textOf(log))).toMatchObject({ content: 'line one\nline two\n' });

    // 空知识索引召回不出结果，但调用成功。
    const recall = await client.callTool('knowledge_recall', {
      agent_id: 'worker-a',
      query: '目标',
    });
    expect(JSON.parse(textOf(recall))).toMatchObject({ query: '目标', hits: [] });

    const ops = await client.callTool('list_operations', {});
    expect(JSON.parse(textOf(ops))).toEqual([]);
  });

  it('读工具不泄露原始 Secret（脱敏约束回归）', async () => {
    const { app, server } = await setup();
    const client = new McpClient(server, 'mcp-secret');
    await client.initialize();

    // 往员工工作区注入一个 secret 形态的 token，断言任何读工具都不把它带回客户端。
    const secret = 'sk-AB12cdef3456ghij7890klmn';
    const { registry } = await app.getAgent('worker-a');
    await fs.writeFile(
      path.join(registry.workspace.path, 'README.md'),
      `# 端口\nAPP_TOKEN=${secret}\n`,
    );

    const responses = [
      { name: 'list_agents', args: {} },
      { name: 'get_agent', args: { id: 'worker-a' } },
      { name: 'list_jobs', args: { agent_id: 'worker-a' } },
      { name: 'list_skills', args: { agent_id: 'worker-a' } },
      { name: 'knowledge_recall', args: { agent_id: 'worker-a', query: 'token' } },
    ];
    for (const { name, args } of responses) {
      const res = await client.callTool(name, args);
      expect(textOf(res), name).not.toContain(secret);
    }
  });

  it('编排写工具：创建/确认/派发/复查/取消', async () => {
    const { app, server } = await setup();
    const client = new McpClient(server, 'mcp-secret');
    await client.initialize();

    const created = await client.callTool('create_task_plan', {
      owner_id: 'chief',
      plan_id: 'plan-1',
      name: '示例计划',
    });
    expect(JSON.parse(textOf(created))).toMatchObject({ id: 'plan-1', status: 'draft' });

    await app.addTaskItem('chief', 'plan-1', {
      id: 't1',
      title: '任务一',
      agent: 'worker-a',
      prompt: '执行',
    });

    const approved = await client.callTool('approve_plan', {
      owner_id: 'chief',
      plan_id: 'plan-1',
    });
    expect(JSON.parse(textOf(approved))).toMatchObject({ id: 'plan-1', status: 'active' });

    mockRunAgent(app);
    const ran = await client.callTool('run_task_plan', {
      owner_id: 'chief',
      plan_id: 'plan-1',
      concurrency: 1,
    });
    const op = JSON.parse(textOf(ran)) as { id: string };
    expect(op.id).toBeTruthy();
    await app.waitOperation(op.id);

    const fetched = await client.callTool('get_operation', { id: op.id });
    expect(JSON.parse(textOf(fetched))).toMatchObject({ id: op.id, state: 'succeeded' });

    // 审查：把已到 awaiting_review 的计划交给 Chief 复查。
    const reviewed = await client.callTool('review_task_plan', {
      owner_id: 'chief',
      chief_id: 'chief',
      plan_id: 'plan-1',
    });
    const plan = JSON.parse(textOf(reviewed)) as { items: Array<{ review?: { verdict: string } }> };
    expect(plan.items[0]?.review?.verdict).toBe('approved');

    // 取消：手动起一个挂起的操作，经 cancel_operation 取消。
    const pending = app.operationManager.start(
      'test',
      'worker-a',
      ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const cancelled = await client.callTool('cancel_operation', { id: pending.id });
    expect(cancelled.result?.isError).toBeFalsy();
    await vi.waitFor(() => {
      expect(app.operationManager.get(pending.id).state).toBe('cancelled');
    });
  });

  it('未知工具与参数校验失败返回 isError', async () => {
    const { server } = await setup();
    const client = new McpClient(server, 'mcp-secret');
    await client.initialize();

    const unknown = await client.callTool('no_such_tool', {});
    expect(unknown.result?.isError).toBe(true);

    const badArgs = await client.callTool('get_agent', {});
    expect(badArgs.result?.isError).toBe(true);
  });
});
