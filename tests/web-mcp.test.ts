import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { buildWebServer, type BuildWebServerOptions } from '../src/web/server.js';

const roots: string[] = [];

async function setupMcp(options: Partial<BuildWebServerOptions> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-web-mcp-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  await app.initialize();
  const server = buildWebServer({
    application: app,
    bootstrapToken: 'secret',
    enableMcp: true,
    mcpToken: 'mcp-test-token',
    ...options,
  });
  return { app, paths, server };
}

const host = { host: '127.0.0.1:41000' };

function initializePayload() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('MCP transmit + static bearer auth (T11 / D-018)', () => {
  it('accepts a correct bearer token and completes the MCP initialize handshake', async () => {
    const { server } = await setupMcp();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...host,
        authorization: 'Bearer mcp-test-token',
        accept: 'application/json, text/event-stream',
      },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(200);
    // enableJsonResponse：主路径轮询（spec 阶段 3「SSE→MCP 主路径轮询」），
    // POST 请求以 JSON-RPC 响应体返回，而非 SSE 帧。后续请求须带 mcp-session-id。
    const body = response.json<{ jsonrpc: string; result?: { protocolVersion: string } }>();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result?.protocolVersion).toBe('2025-06-18');
    expect((response.headers['mcp-session-id'] as string | undefined)?.length).toBeGreaterThan(0);
  });

  it('rejects a request with a missing token (401)', async () => {
    const { server } = await setupMcp();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...host, accept: 'application/json' },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a request with a wrong token (401)', async () => {
    const { server } = await setupMcp();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...host, authorization: 'Bearer wrong-token', accept: 'application/json' },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a non-bearer Authorization scheme (401)', async () => {
    const { server } = await setupMcp();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...host, authorization: 'Basic abc123', accept: 'application/json' },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('enforces the loopback host check on /mcp (403 for non-127.0.0.1)', async () => {
    const { server } = await setupMcp();
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'evil.example.com:41000', authorization: 'Bearer mcp-test-token' },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not expose /mcp when MCP is disabled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-web-mcp-off-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
    await app.initialize();
    const server = buildWebServer({ application: app, bootstrapToken: 'secret' });
    const response = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...host, authorization: 'Bearer mcp-test-token' },
      payload: initializePayload(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('serves GET /mcp (SSE) with a valid token', async () => {
    const { server } = await setupMcp();
    const response = await server.inject({
      method: 'GET',
      url: '/mcp?sessionId=missing',
      headers: { ...host, authorization: 'Bearer mcp-test-token', accept: 'text/event-stream' },
    });
    // 认证已放行（未 401）；无有效 session 的 GET 由 transport 按 Streamable HTTP 规范返回 400。
    expect(response.statusCode).toBe(400);
  });
});
