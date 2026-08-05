import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { FactoryApplication } from '../application/factory-application.js';
import { AgentCtlError } from '../core/errors.js';
import { createAgentInputSchema } from '../core/create-agent.js';
import { jobConfigSchema } from '../schemas/job-schema.js';
import type { SkillScope } from '../core/skills.js';
import { OperationManager } from '../core/operation-manager.js';
import { OperationStore } from '../core/operation-store.js';
import { createMcpEndpoint } from '../mcp/mcp-server.js';

const skillScopeSchema = z.enum(['project', 'user']);

export interface BuildWebServerOptions {
  application: FactoryApplication;
  bootstrapToken: string;
  operationManager?: OperationManager;
  publicDir?: string;
  // T11（D-018）：启用 MCP Streamable HTTP 端点（POST/GET /mcp），静态 bearer 认证。
  // mcpToken 随服务启动生成并打印；无/错 token 的 /mcp 请求被 401 拒绝。
  enableMcp?: boolean;
  mcpToken?: string;
}

interface SessionState {
  bootstrapToken: string;
  exchanged: boolean;
  sessionToken?: string;
  csrfToken?: string;
}

const exchangeSchema = z.object({ token: z.string().min(1) });
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function apiError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  extras: {
    exitCode?: number;
    remediation?: string;
    fieldErrors?: Record<string, string[]>;
  } = {},
): void {
  const { exitCode, ...details } = extras;
  reply.code(statusCode).send({
    error: {
      code,
      message,
      exitCode: exitCode ?? (statusCode === 401 || statusCode === 403 ? 5 : 1),
      ...details,
    },
  });
}

function validLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^127\.0\.0\.1:\d{1,5}$/.test(host);
}

function isSameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.host === host;
  } catch {
    return false;
  }
}

function authenticated(request: FastifyRequest, state: SessionState): boolean {
  const cookieValue = request.cookies.aief_session;
  return Boolean(cookieValue && state.sessionToken && secureEqual(cookieValue, state.sessionToken));
}

// T11（D-018）：MCP 静态 bearer 认证。请求须带 `Authorization: Bearer <token>`，
// 与启动时生成的 mcpToken 恒定时间比较；缺失/错误 → 401。
function mcpAuthorized(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match?.[1] && secureEqual(match[1], token));
}

export function buildWebServer(options: BuildWebServerOptions): FastifyInstance {
  const server = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: true,
  });
  const state: SessionState = {
    bootstrapToken: options.bootstrapToken,
    exchanged: false,
  };
  const operations =
    options.operationManager ??
    new OperationManager({ store: new OperationStore(options.application.paths.logsDir) });
  // T11（D-018）：MCP 端点共享进程生命周期。启用时生成/取用静态 bearer token，挂 POST/GET /mcp。
  const mcpToken = options.enableMcp
    ? (options.mcpToken ?? randomBytes(32).toString('base64url'))
    : undefined;
  const mcp = options.enableMcp ? createMcpEndpoint(options.application) : undefined;
  void server.register(cookie);
  void server.register(multipart, {
    preservePath: true,
    limits: { files: 2000, fileSize: 25 * 1024 * 1024 },
  });
  if (options.publicDir) {
    void server.register(staticPlugin, {
      root: options.publicDir,
      prefix: '/',
      index: ['index.html'],
      cacheControl: false,
    });
  }

  server.addHook('onClose', async () => {
    operations.cancelAll();
    // T11：MCP 端点随进程关闭，避免 SSE 连接悬空。
    await mcp?.transport.close().catch(() => undefined);
  });

  server.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    if (request.url.startsWith('/api/v1/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  server.addHook('onRequest', async (request, reply) => {
    if (!validLoopbackHost(request.headers.host)) {
      apiError(reply, 403, 'AUTH_REQUIRED', 'Web 控制台只接受 127.0.0.1 本机请求。');
      return reply;
    }
    if (request.url === '/api/v1/session' && request.method === 'POST') return;
    if (!request.url.startsWith('/api/v1/')) return;
    if (!authenticated(request, state)) {
      apiError(reply, 401, 'AUTH_REQUIRED', 'Web 会话无效或已过期。');
      return reply;
    }
    if (mutationMethods.has(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (
        typeof csrf !== 'string' ||
        !state.csrfToken ||
        !secureEqual(csrf, state.csrfToken) ||
        !isSameOrigin(request)
      ) {
        apiError(reply, 403, 'AUTH_REQUIRED', '请求来源或 CSRF token 无效。');
        return reply;
      }
    }
  });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const flattened = z.flattenError(error);
      apiError(reply, 400, 'VALIDATION_ERROR', '请求参数校验失败。', {
        fieldErrors: flattened.fieldErrors,
      });
      return;
    }
    if (error instanceof AgentCtlError) {
      const status =
        error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'CONFLICT' || error.code === 'LOCKED'
            ? 409
            : error.code === 'AUTH_REQUIRED'
              ? 401
              : 400;
      apiError(reply, status, error.code, error.message, {
        exitCode: error.exitCode,
        ...(error.remediation ? { remediation: error.remediation } : {}),
      });
      return;
    }
    apiError(reply, 500, 'OPERATION_FAILED', 'Web 操作失败。');
  });

  server.post('/api/v1/session', async (request, reply) => {
    const { token } = exchangeSchema.parse(request.body);
    if (state.exchanged || !secureEqual(token, state.bootstrapToken)) {
      apiError(reply, 401, 'AUTH_REQUIRED', '启动会话 token 无效或已使用。');
      return;
    }
    state.exchanged = true;
    state.sessionToken = randomBytes(32).toString('base64url');
    state.csrfToken = randomBytes(32).toString('base64url');
    reply.setCookie('aief_session', state.sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
    return { data: { csrfToken: state.csrfToken } };
  });

  server.get('/api/v1/session', async () => ({
    data: { csrfToken: state.csrfToken as string },
  }));

  // T11（D-018）：MCP Streamable HTTP 端点。POST=JSON-RPC，GET=SSE。静态 bearer 认证，
  // 复用全局 onRequest 的 127.0.0.1 校验；非 /api/v1/* 天然绕过 CSRF/会话校验，由本处独立把关。
  if (mcp && mcpToken) {
    const mcpHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!mcpAuthorized(request, mcpToken)) {
        return apiError(reply, 401, 'AUTH_REQUIRED', 'MCP 请求缺少或携带无效的 bearer token。');
      }
      await mcp.handle(request, reply);
      return reply;
    };
    server.post('/mcp', mcpHandler);
    server.get('/mcp', mcpHandler);
  }

  server.get('/api/v1/factory/status', async () => ({
    data: await options.application.factoryStatus(),
  }));

  server.post('/api/v1/factory/init', async () => {
    await options.application.initialize();
    return { data: await options.application.factoryStatus() };
  });

  server.get('/api/v1/dashboard', async () => ({
    data: await options.application.dashboard(),
  }));

  server.get('/api/v1/agents', async () => ({ data: await options.application.listAgents() }));

  server.post('/api/v1/agents', async (request, reply) => {
    const created = await options.application.createAgent(
      createAgentInputSchema.parse(request.body),
    );
    reply.code(201);
    return { data: created };
  });

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id', async (request) => ({
    data: await options.application.getAgent(request.params.id),
  }));

  server.post<{ Params: { id: string; action: string } }>(
    '/api/v1/agents/:id/actions/:action',
    async (request) => {
      const action = z
        .enum(['start', 'stop', 'restart', 'status', 'archive', 'trash'])
        .parse(request.params.action);
      if (action === 'trash') {
        const body = z.object({ confirmId: z.string() }).parse(request.body);
        if (body.confirmId !== request.params.id) {
          throw new AgentCtlError('VALIDATION_ERROR', '回收站确认与 Agent ID 不匹配。');
        }
        return { data: await options.application.trashAgent(request.params.id) };
      }
      if (action === 'archive') {
        const body = z.object({ confirmId: z.string() }).parse(request.body);
        if (body.confirmId !== request.params.id) {
          throw new AgentCtlError('VALIDATION_ERROR', '归档确认必须输入完整 Agent ID。');
        }
        await options.application.archiveAgent(request.params.id);
        return { data: { state: 'archived' } };
      }
      return { data: await options.application.lifecycleAction(request.params.id, action) };
    },
  );

  server.get('/api/v1/trash', async () => ({ data: await options.application.listTrash() }));

  server.post<{ Params: { trashId: string } }>(
    '/api/v1/trash/:trashId/actions/restore',
    async (request) => {
      const body = z.object({ confirmTrashId: z.string() }).parse(request.body);
      if (body.confirmTrashId !== request.params.trashId) {
        throw new AgentCtlError('VALIDATION_ERROR', '恢复确认与回收站 ID 不匹配。');
      }
      return { data: await options.application.restoreTrash(request.params.trashId) };
    },
  );

  server.post('/api/v1/trash/actions/purge-expired', async (request) => {
    const body = z.object({ confirm: z.literal('purge-expired') }).parse(request.body);
    void body;
    return { data: await options.application.purgeExpiredTrash() };
  });

  server.get<{ Params: { id: string; key: string } }>(
    '/api/v1/agents/:id/documents/:key',
    async (request) => ({
      data: await options.application.readDocument(request.params.id, request.params.key),
    }),
  );

  server.put<{ Params: { id: string; key: string } }>(
    '/api/v1/agents/:id/documents/:key',
    async (request) => {
      const body = z.object({ content: z.string() }).parse(request.body);
      return {
        data: await options.application.saveDocument(
          request.params.id,
          request.params.key,
          body.content,
        ),
      };
    },
  );

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/jobs', async (request) => ({
    data: await options.application.listJobs(request.params.id),
  }));

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/jobs', async (request, reply) => {
    const job = await options.application.createJob(
      request.params.id,
      jobConfigSchema.parse(request.body),
    );
    reply.code(201);
    return { data: job };
  });

  server.put<{ Params: { id: string; jobId: string } }>(
    '/api/v1/agents/:id/jobs/:jobId',
    async (request) => ({
      data: await options.application.updateJob(
        request.params.id,
        request.params.jobId,
        jobConfigSchema.parse(request.body),
      ),
    }),
  );

  server.post<{ Params: { id: string; jobId: string; action: string } }>(
    '/api/v1/agents/:id/jobs/:jobId/actions/:action',
    async (request, reply) => {
      const action = z.enum(['enable', 'disable', 'run', 'archive']).parse(request.params.action);
      if (action === 'enable' || action === 'disable') {
        return {
          data: await options.application.setJobEnabled(
            request.params.id,
            request.params.jobId,
            action === 'enable',
          ),
        };
      }
      if (action === 'archive') {
        const body = z.object({ confirmJobId: z.string() }).parse(request.body);
        if (body.confirmJobId !== request.params.jobId) {
          throw new AgentCtlError('VALIDATION_ERROR', '任务归档确认不匹配。');
        }
        await options.application.archiveJob(request.params.id, request.params.jobId);
        return { data: { archived: true } };
      }
      const operation = operations.start(
        'job',
        request.params.id,
        async ({ signal, emit, operationId, traceId }) => {
          const result = await options.application.runJob(request.params.id, request.params.jobId, {
            mirror: false,
            signal,
            operationId,
            traceId,
            onStdout: (message) => emit({ kind: 'output', stream: 'stdout', message }),
            onStderr: (message) => emit({ kind: 'output', stream: 'stderr', message }),
          });
          return { exitCode: result.exitCode };
        },
      );
      reply.code(202);
      return { data: operation };
    },
  );

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/skills', async (request) => ({
    data: await options.application.listSkills(request.params.id),
  }));

  server.post<{ Params: { id: string } }>(
    '/api/v1/agents/:id/skills/path',
    async (request, reply) => {
      const body = z
        .object({ source: z.string().min(1), scope: skillScopeSchema.optional() })
        .parse(request.body);
      const installed = await options.application.installSkill(
        request.params.id,
        body.source,
        body.scope,
      );
      reply.code(201);
      return { data: installed };
    },
  );

  server.post<{ Params: { id: string } }>(
    '/api/v1/agents/:id/skills/upload',
    async (request, reply) => {
      const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-skill-upload-'));
      let total = 0;
      const uploaded: string[] = [];
      let scope: SkillScope | undefined;
      try {
        for await (const part of request.parts()) {
          if (part.type === 'field') {
            if (part.fieldname === 'scope') scope = skillScopeSchema.parse(part.value);
            continue;
          }
          const relative = part.filename.replaceAll('\\', '/');
          const segments = relative.split('/').filter(Boolean);
          if (
            !segments.length ||
            path.posix.isAbsolute(relative) ||
            segments.includes('..') ||
            relative.includes('\0')
          ) {
            throw new AgentCtlError('VALIDATION_ERROR', `Skill 上传包含非法路径：${relative}`);
          }
          const data = await part.toBuffer();
          total += data.length;
          if (total > 25 * 1024 * 1024) {
            throw new AgentCtlError('VALIDATION_ERROR', 'Skill 上传总大小不得超过 25 MiB。');
          }
          const target = path.join(stage, ...segments);
          await fs.outputFile(target, data, { mode: 0o600 });
          uploaded.push(segments.join('/'));
        }
        if (!uploaded.length) throw new AgentCtlError('VALIDATION_ERROR', '未收到 Skill 文件。');
        const topLevels = new Set(uploaded.map((file) => file.split('/')[0] as string));
        const source =
          topLevels.size === 1 && uploaded.every((file) => file.includes('/'))
            ? path.join(stage, [...topLevels][0] as string)
            : stage;
        const installed = await options.application.installSkill(request.params.id, source, scope);
        reply.code(201);
        return { data: installed };
      } finally {
        await fs.remove(stage);
      }
    },
  );

  server.delete<{ Params: { id: string; name: string } }>(
    '/api/v1/agents/:id/skills/:name',
    async (request) => {
      const body = z
        .object({ confirmName: z.string(), scope: skillScopeSchema.optional() })
        .parse(request.body);
      if (body.confirmName !== request.params.name) {
        throw new AgentCtlError('VALIDATION_ERROR', 'Skill 卸载确认不匹配。');
      }
      await options.application.removeSkill(request.params.id, request.params.name, body.scope);
      return { data: { removed: true, scope: body.scope ?? 'project' } };
    },
  );

  // ---- Skill 商店（GitHub 仓库源）----
  server.get('/api/v1/skill-store/repositories', async () => ({
    data: await options.application.listSkillStoreRepositories(),
  }));

  server.post<{ Body: { name: string; url: string; description?: string } }>(
    '/api/v1/skill-store/repositories',
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().min(1),
          url: z.string().min(1),
          description: z.string().min(1).optional(),
        })
        .parse(request.body);
      const added = await options.application.addSkillStoreRepository(
        body.description
          ? { name: body.name, url: body.url, description: body.description }
          : { name: body.name, url: body.url },
      );
      reply.code(201);
      return { data: added };
    },
  );

  server.delete<{ Params: { name: string } }>(
    '/api/v1/skill-store/repositories/:name',
    async (request) => {
      const body = z.object({ confirmName: z.string() }).parse(request.body);
      if (body.confirmName !== request.params.name) {
        throw new AgentCtlError('VALIDATION_ERROR', '仓库源归档确认不匹配。');
      }
      await options.application.removeSkillStoreRepository(request.params.name);
      return { data: { removed: true } };
    },
  );

  server.post<{ Params: { name: string } }>(
    '/api/v1/skill-store/repositories/:name/refresh',
    async (request) => ({
      data: await options.application.refreshSkillStoreRepository(request.params.name),
    }),
  );

  server.get<{ Params: { name: string } }>(
    '/api/v1/skill-store/repositories/:name/skills',
    async (request) => ({
      data: await options.application.listSkillStoreSkills(request.params.name),
    }),
  );

  server.post<{
    Body: { repoName: string; skillPath: string; agentId: string; scope?: SkillScope };
  }>('/api/v1/skill-store/install', async (request, reply) => {
    const body = z
      .object({
        repoName: z.string().min(1),
        skillPath: z.string().min(1),
        agentId: z.string().min(1),
        scope: skillScopeSchema.optional(),
      })
      .parse(request.body);
    const installed = await options.application.installSkillFromStore(
      body.repoName,
      body.skillPath,
      body.agentId,
      body.scope,
    );
    reply.code(201);
    return { data: installed };
  });

  server.post<{
    Body: { repoName: string; agentId: string; scope?: SkillScope };
  }>('/api/v1/skill-store/install-all', async (request, reply) => {
    const body = z
      .object({
        repoName: z.string().min(1),
        agentId: z.string().min(1),
        scope: skillScopeSchema.optional(),
      })
      .parse(request.body);
    const result = await options.application.installAllSkillFromStore(
      body.repoName,
      body.agentId,
      body.scope,
    );
    reply.code(201);
    return { data: result };
  });

  server.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/v1/agents/:id/logs',
    async (request) => {
      const query = z
        .object({ lines: z.coerce.number().int().min(1).max(5000).default(200) })
        .parse(request.query);
      return { data: await options.application.readLatestLog(request.params.id, query.lines) };
    },
  );

  server.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/v1/agents/:id/logs/stream',
    async (request, reply) => {
      const query = z
        .object({ lines: z.coerce.number().int().min(1).max(5000).default(200) })
        .parse(request.query);
      await options.application.getAgent(request.params.id);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
      });
      let previous = '';
      const poll = async () => {
        try {
          const current = await options.application.readLatestLog(request.params.id, query.lines);
          const serialized = JSON.stringify(current);
          if (serialized !== previous) {
            previous = serialized;
            reply.raw.write(`data: ${serialized}\n\n`);
          }
        } catch (error) {
          if (error instanceof AgentCtlError && error.code === 'NOT_FOUND') {
            if (previous !== 'empty') {
              previous = 'empty';
              reply.raw.write('data: {"file":"","content":""}\n\n');
            }
            return;
          }
          reply.raw.write('event: error\ndata: {"message":"日志跟随失败。"}\n\n');
        }
      };
      await poll();
      const timer = setInterval(() => void poll(), 1000);
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
      request.raw.on('close', () => {
        clearInterval(timer);
        clearInterval(heartbeat);
      });
    },
  );

  server.get<{ Params: { id: string } }>(
    '/api/v1/agents/:id/terminal-guidance',
    async (request) => ({ data: await options.application.terminalGuidance(request.params.id) }),
  );

  // OP1 Stage B：知识库 recall API（读路径只读，供 Web/CLI 复用）。
  server.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/v1/agents/:id/knowledge/recall',
    async (request) => {
      const query = request.query.q?.trim() ?? '';
      if (!query) throw new AgentCtlError('VALIDATION_ERROR', '缺少查询参数 q。');
      return { data: await options.application.knowledgeRecall(request.params.id, query) };
    },
  );

  server.get('/api/v1/backups', async () => ({ data: await options.application.listBackups() }));

  server.post('/api/v1/backups/import', async (request, reply) => {
    const part = await request.file({ limits: { files: 1, fileSize: 10 * 1024 ** 3 } });
    if (!part) throw new AgentCtlError('VALIDATION_ERROR', '未收到备份文件。');
    const name = path.basename(part.filename);
    if (name !== part.filename || !/(?:\.tar\.gz|\.aief\.enc|\.enc)$/i.test(name)) {
      throw new AgentCtlError('VALIDATION_ERROR', '备份文件名或扩展名无效。');
    }
    await fs.ensureDir(options.application.paths.backupsDir);
    const temporary = path.join(
      options.application.paths.backupsDir,
      `.upload-${randomBytes(12).toString('hex')}`,
    );
    const target = path.join(options.application.paths.backupsDir, name);
    if (await fs.pathExists(target)) {
      throw new AgentCtlError('CONFLICT', `备份已存在：${name}`);
    }
    let total = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > 10 * 1024 ** 3) callback(new Error('备份文件超过 10 GiB。'));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(part.file, limiter, fs.createWriteStream(temporary, { mode: 0o600 }));
      if (part.file.truncated) {
        throw new AgentCtlError('VALIDATION_ERROR', '备份文件超过 10 GiB。');
      }
      await fs.move(temporary, target, { overwrite: false });
      reply.code(201);
      return {
        data: { name, size: total, encrypted: /\.enc$/i.test(name) },
      };
    } finally {
      await fs.remove(temporary).catch(() => undefined);
    }
  });

  server.get<{ Params: { name: string } }>(
    '/api/v1/backups/:name/download',
    async (request, reply) => {
      const name = request.params.name;
      if (path.basename(name) !== name) {
        throw new AgentCtlError('VALIDATION_ERROR', '备份名称不能包含路径。');
      }
      const file = path.join(options.application.paths.backupsDir, name);
      if (!(await fs.pathExists(file))) throw new AgentCtlError('NOT_FOUND', `备份不存在：${name}`);
      reply.header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      reply.type('application/octet-stream');
      return reply.send(fs.createReadStream(file));
    },
  );

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/backup', async (request, reply) => {
    const body = z
      .object({
        includeRuntime: z.boolean().default(false),
        passphrase: z.string().min(8).optional(),
      })
      .parse(request.body ?? {});
    const operation = operations.start('backup', request.params.id, async ({ emit }) => {
      emit({ kind: 'progress', progress: 10, message: '准备备份' });
      await options.application.createBackup(request.params.id, {
        includeRuntime: body.includeRuntime,
        ...(body.passphrase ? { passphrase: body.passphrase } : {}),
      });
      emit({ kind: 'progress', progress: 90, message: '备份已写入' });
      return { exitCode: 0 };
    });
    reply.code(202);
    return { data: operation };
  });

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/doctor', async (request, reply) => {
    const operation = operations.start('doctor', request.params.id, async ({ emit }) => {
      emit({ kind: 'progress', progress: 10, message: '开始诊断' });
      const report = await options.application.doctor(request.params.id);
      for (const check of report.checks) {
        emit({ kind: 'output', message: `${check.status}: ${check.label} — ${check.detail}` });
      }
      emit({ kind: 'progress', progress: 90, message: '诊断完成' });
      return { exitCode: report.summary.fail > 0 ? 6 : 0 };
    });
    reply.code(202);
    return { data: operation };
  });

  server.post('/api/v1/doctor', async (_request, reply) => {
    const operation = operations.start('doctor', undefined, async ({ emit }) => {
      const report = await options.application.doctor();
      for (const check of report.checks) {
        emit({ kind: 'output', message: `${check.status}: ${check.label} — ${check.detail}` });
      }
      return { exitCode: report.summary.fail > 0 ? 6 : 0 };
    });
    reply.code(202);
    return { data: operation };
  });

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/run', async (request, reply) => {
    const body = z
      .object({
        task: z.string().min(1).max(65_536),
        timeoutSeconds: z.number().int().min(1).max(86_400).default(900),
      })
      .parse(request.body);
    const operation = operations.start(
      'run',
      request.params.id,
      async ({ signal, emit, operationId, traceId }) => {
        const result = await options.application.runAgent(
          request.params.id,
          body.task,
          body.timeoutSeconds,
          {
            mirror: false,
            signal,
            operationId,
            traceId,
            onStdout: (message) => emit({ kind: 'output', stream: 'stdout', message }),
            onStderr: (message) => emit({ kind: 'output', stream: 'stderr', message }),
          },
        );
        return { exitCode: result.exitCode, ...(result.usage ? { usage: result.usage } : {}) };
      },
    );
    reply.code(202);
    return { data: operation };
  });

  server.post('/api/v1/backups/restore', async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1),
        confirmName: z.string().min(1),
        newId: z.string().optional(),
        newName: z.string().optional(),
        passphrase: z.string().optional(),
      })
      .parse(request.body);
    if (body.name !== body.confirmName) {
      throw new AgentCtlError('VALIDATION_ERROR', '备份恢复确认不匹配。');
    }
    const operation = operations.start('restore', undefined, async ({ emit }) => {
      emit({ kind: 'progress', progress: 10, message: '校验备份' });
      await options.application.restoreBackup(body.name, {
        ...(body.newId ? { newId: body.newId } : {}),
        ...(body.newName ? { newName: body.newName } : {}),
        ...(body.passphrase ? { passphrase: body.passphrase } : {}),
      });
      emit({ kind: 'progress', progress: 90, message: '恢复完成' });
      return { exitCode: 0 };
    });
    reply.code(202);
    return { data: operation };
  });

  server.get('/api/v1/operations', async () => ({ data: operations.list() }));

  server.get<{ Params: { id: string } }>('/api/v1/operations/:id', async (request) => ({
    data: operations.get(request.params.id),
  }));

  server.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/v1/operations/:id/events',
    async (request) => {
      const query = z
        .object({ after: z.coerce.number().int().min(0).default(0) })
        .parse(request.query);
      return { data: operations.events(request.params.id, query.after) };
    },
  );

  server.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/v1/operations/:id/stream',
    async (request, reply) => {
      const query = z
        .object({ after: z.coerce.number().int().min(0).default(0) })
        .parse(request.query);
      operations.get(request.params.id);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
      });
      const write = (event: unknown, id?: number) => {
        if (id !== undefined) reply.raw.write(`id: ${id}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      for (const event of operations.events(request.params.id, query.after))
        write(event, event.seq);
      const unsubscribe = operations.subscribe(request.params.id, (event) =>
        write(event, event.seq),
      );
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  return server;
}
