import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentCtlError } from '../core/errors.js';
import type { OperationDto } from '../core/operation-manager.js';
import type { KnowledgeRecallResult } from '../core/knowledge.js';
import type { SkillMetadata } from '../core/skills.js';
import type { AgentSummary } from '../application/factory-application.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { JobConfig } from '../schemas/job-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { TaskPlan } from '../schemas/task-schema.js';

// T11/D-018：MCP Streamable HTTP 端点。认证：静态 bearer（无 Authorization Server）。
// T12/T13：读工具 + 编排写工具。工具是 FactoryApplication 的薄适配器——穿过应用编排层
// 单一入口，与 Web/CLI 共享同一行为（spec 阶段 3 的测试 seam 原则）。

export interface McpBackend {
  // 读工具
  listAgents(): Promise<AgentSummary[]>;
  getAgent(id: string): Promise<{ registry: RegistryAgent; agent: AgentConfig }>;
  listJobs(id: string): Promise<JobConfig[]>;
  listSkills(id: string): Promise<SkillMetadata[]>;
  readLatestLog(id: string, lines?: number): Promise<{ file: string; content: string }>;
  knowledgeRecall(id: string, query: string): Promise<KnowledgeRecallResult>;
  // 编排写工具
  createTaskPlan(ownerId: string, input: { id: string; name: string }): Promise<TaskPlan>;
  runTaskPlan(
    ownerId: string,
    planId: string,
    options?: { concurrency?: number; timeoutSeconds?: number },
  ): Promise<OperationDto>;
  confirmPlan(ownerId: string, planId: string): Promise<TaskPlan>;
  reviewTaskPlan(ownerId: string, chiefId: string, planId: string): Promise<TaskPlan>;
  operationManager: {
    list(): OperationDto[];
    get(id: string): OperationDto;
    cancel(id: string): OperationDto;
  };
}

export interface McpEndpoint {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** Fastify 路由处理器：把请求转交给 MCP transport。 */
  handle(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: (args: unknown, backend: McpBackend) => Promise<unknown> | unknown;
}

/** 把带具体参数类型的工具收窄为 ToolDef（args 经 schema.parse 校验，落位为 unknown）。 */
function tool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, backend: McpBackend) => Promise<unknown> | unknown,
): ToolDef {
  return { name, description, schema, run } as ToolDef;
}

// 三个工具共用的参数形状：按 id 查单一对象，按 agent_id 查某员工的资源。
const idSchema = z.object({ id: z.string().min(1) });
const agentIdSchema = z.object({ agent_id: z.string().min(1) });

const TOOLS: ToolDef[] = [
  tool(
    'list_agents',
    '列出所有 AI 员工的摘要（id、角色、状态、运行时、桥接授权）。',
    z.object({}),
    (_args, backend) => backend.listAgents(),
  ),
  tool('get_agent', '查询单个 AI 员工的注册信息与可移植配置。', idSchema, ({ id }, backend) =>
    backend.getAgent(id),
  ),
  tool(
    'list_operations',
    '列出当前在内存中的编排操作（最近的在最前），可按员工或操作类型过滤。',
    z.object({
      agent_id: z.string().optional(),
      kind: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    ({ agent_id, kind, limit }, backend) => {
      let ops = backend.operationManager.list();
      if (agent_id) ops = ops.filter((o) => o.agentId === agent_id);
      if (kind) ops = ops.filter((o) => o.type === kind);
      return limit ? ops.slice(0, limit) : ops;
    },
  ),
  tool(
    'get_operation',
    '按 id 查询单个操作（含 state、progress、traceId、错误）。',
    idSchema,
    ({ id }, backend) => backend.operationManager.get(id),
  ),
  tool('list_jobs', '列出某员工的定时任务。', agentIdSchema, ({ agent_id }, backend) =>
    backend.listJobs(agent_id),
  ),
  tool('list_skills', '列出某员工可用的 Skill。', agentIdSchema, ({ agent_id }, backend) =>
    backend.listSkills(agent_id),
  ),
  tool(
    'read_latest_log',
    '读取某员工最新运行日志的末尾若干行（1–5000）。',
    z.object({ agent_id: z.string().min(1), lines: z.number().int().min(1).max(5000).optional() }),
    ({ agent_id, lines }, backend) =>
      lines === undefined
        ? backend.readLatestLog(agent_id)
        : backend.readLatestLog(agent_id, lines),
  ),
  tool(
    'knowledge_recall',
    '按查询召回某员工的正式记忆。',
    agentIdSchema.extend({ query: z.string().min(1) }),
    ({ agent_id, query }, backend) => backend.knowledgeRecall(agent_id, query),
  ),
  tool(
    'create_task_plan',
    '为指定主人创建草稿任务计划（status=draft，items 为空）。',
    z.object({ owner_id: z.string().min(1), plan_id: z.string().min(1), name: z.string().min(1) }),
    ({ owner_id, plan_id, name }, backend) =>
      backend.createTaskPlan(owner_id, { id: plan_id, name }),
  ),
  tool(
    'approve_plan',
    '确认计划，把它从等待确认推进到可派发状态（触发 Todo 状态机转移）。',
    z.object({ owner_id: z.string().min(1), plan_id: z.string().min(1) }),
    ({ owner_id, plan_id }, backend) => backend.confirmPlan(owner_id, plan_id),
  ),
  tool(
    'run_task_plan',
    '派发计划：后台注册 task_plan 操作并逐项执行，立即返回排队态 OperationDto，可轮询 get_operation。',
    z.object({
      owner_id: z.string().min(1),
      plan_id: z.string().min(1),
      concurrency: z.number().int().min(1).max(8).optional(),
      timeout_seconds: z.number().int().positive().optional(),
    }),
    ({ owner_id, plan_id, concurrency, timeout_seconds }, backend) =>
      backend.runTaskPlan(owner_id, plan_id, {
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(timeout_seconds !== undefined ? { timeoutSeconds: timeout_seconds } : {}),
      }),
  ),
  tool(
    'review_task_plan',
    '让 Chief 交叉审查指定计划（D-017 单向传输），推进待审查项。',
    z.object({
      owner_id: z.string().min(1),
      chief_id: z.string().min(1),
      plan_id: z.string().min(1),
    }),
    ({ owner_id, chief_id, plan_id }, backend) =>
      backend.reviewTaskPlan(owner_id, chief_id, plan_id),
  ),
  tool(
    'cancel_operation',
    '按 id 取消排队/运行中的操作（已结束的操作不可取消）。',
    idSchema,
    ({ id }, backend) => backend.operationManager.cancel(id),
  ),
];

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  const message =
    error instanceof AgentCtlError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createMcpEndpoint(backend: McpBackend): McpEndpoint {
  const server = new Server(
    { name: 'ai-employee-factory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  // enableJsonResponse：主路径轮询（工具返回 OperationDto，客户端拉 get_operation），
  // 用 JSON 响应而非 SSE 流，简化客户端集成（spec 阶段 3「SSE→MCP 主路径轮询」）。
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  server.onerror = (error) => {
    console.error(`[mcp] ${error instanceof Error ? error.message : String(error)}`);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: z.toJSONSchema(toolDef.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolDef = TOOLS.find((t) => t.name === request.params.name);
    if (!toolDef) return errorResult(`未知工具：${request.params.name}`);
    try {
      const args = toolDef.schema.parse(request.params.arguments ?? {});
      const data = await toolDef.run(args, backend);
      return textResult(data);
    } catch (error) {
      if (error instanceof z.ZodError)
        return errorResult(`参数校验失败：${z.prettifyError(error)}`);
      return errorResult(error);
    }
  });

  // connect 接线 transport.onmessage → server.handleMessage 并回连关闭。SDK 在
  // exactOptionalPropertyTypes 下 Transport.onclose 为可选签名而 connect 期望必填，
  // 属 SDK 类型宽松度问题；语义不变，故经类型断言接入。
  void server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  return {
    server,
    transport,
    async handle(request, reply) {
      // 直接转发底层 Node req/res 与已解析的 body（Fastify 已按 JSON 解析 JSON-RPC 请求）。
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  };
}
