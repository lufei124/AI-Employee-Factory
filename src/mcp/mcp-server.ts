import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

// T11（D-018）：MCP Streamable HTTP 端点。用 @modelcontextprotocol/sdk 的
// StreamableHTTPServerTransport 直接接到既有 Fastify 实例（request.raw/reply.raw），
// 共享进程生命周期，而非引入会自建 Fastify 实例的独立包。
// 认证：静态 bearer（无 Authorization Server，D-018 降级）。T12/T13 再注册 read/orchestrate 工具。

export interface McpEndpoint {
  server: Server;
  transport: StreamableHTTPServerTransport;
  /** Fastify 路由处理器：把请求转交给 MCP transport。 */
  handle(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}

export function createMcpEndpoint(): McpEndpoint {
  const server = new Server(
    { name: 'ai-employee-factory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  // T11 仅传输+认证；工具在 T12/T13 接入。tools/list 现返回空列表，仍满足 MCP 初始化握手。
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  server.onerror = (error) => {
    console.error(`[mcp] ${error instanceof Error ? error.message : String(error)}`);
  };
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
