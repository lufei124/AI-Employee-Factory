import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import type { FastifyInstance } from 'fastify';
import type { FactoryApplication } from '../application/factory-application.js';
import { buildWebServer } from './server.js';

export interface StartWebConsoleOptions {
  application: FactoryApplication;
  port?: number;
  openBrowser?: boolean;
  publicDir?: string;
  bootstrapToken?: string;
  handleSignals?: boolean;
  // T11（D-018）：MCP 端点。启用时生成随机静态 bearer token（可注入 mcpToken）并打印连接命令。
  enableMcp?: boolean;
  mcpToken?: string;
  listen?: (
    server: FastifyInstance,
    options: { host: '127.0.0.1'; port: number },
  ) => Promise<string>;
}

export async function startWebConsole(options: StartWebConsoleOptions) {
  await options.application.purgeExpiredTrash().catch((error: unknown) => {
    console.warn(
      `警告：回收站过期清理失败：${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const bootstrapToken = options.bootstrapToken ?? randomBytes(32).toString('base64url');
  const publicDir =
    options.publicDir ?? path.dirname(fileURLToPath(new URL('./index.html', import.meta.url)));
  // T11（D-018）：MCP token 随服务启动生成（可注入），与 Web bootstrapToken 分离。
  const mcpToken = options.enableMcp
    ? (options.mcpToken ?? randomBytes(32).toString('base64url'))
    : undefined;
  const server = buildWebServer({
    application: options.application,
    bootstrapToken,
    publicDir,
    // 复用 FactoryApplication 的 OperationManager，使编排动作（runTaskPlan/orchestrate）注册的
    // Operation 与 web 控制台/API 共享同一实例，可在 operations 列表与 /api/v1/operations 中查询。
    operationManager: options.application.operationManager,
    // exactOptionalPropertyTypes：仅启用时传入，避免显式 undefined；mcpToken 在该分支必然已生成。
    ...(options.enableMcp ? { enableMcp: true as const, mcpToken: mcpToken! } : {}),
  });
  if (options.handleSignals) {
    const shutdown = () => {
      void server.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.addHook('onClose', async () => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
    });
  }
  const listenOptions = { host: '127.0.0.1' as const, port: options.port ?? 0 };
  const origin = options.listen
    ? await options.listen(server, listenOptions)
    : await server.listen(listenOptions);
  const url = `${origin}/#session=${encodeURIComponent(bootstrapToken)}`;
  // T11（D-018）：打印外部 MCP 客户端连接命令（含 token），token 仅此一次可见。
  if (mcpToken) {
    console.log(`MCP 端点：${origin}/mcp`);
    console.log(`MCP token：${mcpToken}`);
    console.log(
      `MCP 连接：npx -y @modelcontextprotocol/client@latest --url ${origin}/mcp --bearer ${mcpToken}`,
    );
  }
  if (options.openBrowser !== false) {
    void execa('open', [url], { shell: false, reject: false }).catch(() => undefined);
  }
  return { server, origin, url, mcpToken };
}
