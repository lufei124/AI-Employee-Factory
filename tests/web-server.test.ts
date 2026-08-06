import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { OperationManager } from '../src/core/operation-manager.js';
import { buildWebServer } from '../src/web/server.js';

const roots: string[] = [];

function setup(operationManager?: OperationManager) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-web-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const manager = operationManager ?? new OperationManager();
  const application = new FactoryApplication(paths, new RegistryStore(paths.registryFile), {
    operationManager: manager,
  });
  return {
    server: buildWebServer({
      application,
      bootstrapToken: 'bootstrap-secret',
      operationManager: manager,
    }),
    application,
    operationManager: manager,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('local Web API security', () => {
  it('exchanges the bootstrap token once and requires its session cookie', async () => {
    const { server } = setup();

    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/factory/status',
          headers: { host: '127.0.0.1:48123' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/v1/session',
          headers: { host: '127.0.0.1:48123' },
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(401);

    const exchange = await server.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: '127.0.0.1:48123' },
      payload: { token: 'bootstrap-secret' },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['set-cookie']).toContain('HttpOnly');
    expect(exchange.headers['set-cookie']).toContain('SameSite=Strict');
    expect(exchange.json()).toEqual({ data: { csrfToken: expect.any(String) } });

    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/v1/session',
          headers: { host: '127.0.0.1:48123' },
          payload: { token: 'bootstrap-secret' },
        })
      ).statusCode,
    ).toBe(401);

    const cookie = exchange.headers['set-cookie']?.split(';')[0];
    const resumed = await server.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { host: '127.0.0.1:48123', cookie },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ data: { csrfToken: exchange.json().data.csrfToken } });
    const status = await server.inject({
      method: 'GET',
      url: '/api/v1/factory/status',
      headers: { host: '127.0.0.1:48123', cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ data: { initialized: false } });
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.headers['x-content-type-options']).toBe('nosniff');
    await server.close();
  });

  it('rejects invalid Host, Origin, and CSRF before mutations', async () => {
    const { server } = setup();
    const exchange = await server.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: '127.0.0.1:48123' },
      payload: { token: 'bootstrap-secret' },
    });
    const cookie = exchange.headers['set-cookie']?.split(';')[0];
    const csrf = exchange.json<{ data: { csrfToken: string } }>().data.csrfToken;

    const cases = [
      { host: 'localhost:48123', origin: 'http://127.0.0.1:48123', csrf },
      { host: '127.0.0.1:48123', origin: 'https://evil.example', csrf },
      { host: '127.0.0.1:48123', origin: 'http://127.0.0.1:48123', csrf: 'wrong' },
    ];
    for (const item of cases) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/factory/init',
        headers: {
          host: item.host,
          origin: item.origin,
          cookie,
          'x-csrf-token': item.csrf,
        },
      });
      expect(response.statusCode).toBe(403);
    }
    await server.close();
  });

  it('initializes and creates an Agent through validated application APIs', async () => {
    const { server } = setup();
    const exchange = await server.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: '127.0.0.1:48123' },
      payload: { token: 'bootstrap-secret' },
    });
    const cookie = exchange.headers['set-cookie']?.split(';')[0];
    const csrf = exchange.json<{ data: { csrfToken: string } }>().data.csrfToken;
    const headers = {
      host: '127.0.0.1:48123',
      origin: 'http://127.0.0.1:48123',
      cookie,
      'x-csrf-token': csrf,
    };

    expect(
      (await server.inject({ method: 'POST', url: '/api/v1/factory/init', headers })).statusCode,
    ).toBe(200);
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: {
        id: 'user-operations',
        name: '用户运营专员',
        runtime: 'claude',
        description: '负责用户反馈收集、分析与闭环跟进',
        goals: ['收集并分析用户反馈', '闭环跟进问题'],
        feishu: 'disabled',
      },
    });
    expect(created.statusCode).toBe(201);
    const dashboard = await server.inject({
      method: 'GET',
      url: '/api/v1/dashboard',
      headers: { host: '127.0.0.1:48123', cookie },
    });
    expect(dashboard.json().data).toMatchObject({ total: 1, pendingAuthorization: 0 });
    await server.close();
  });

  it('manages skill-store repositories through the API', async () => {
    const { server } = setup();
    const exchange = await server.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { host: '127.0.0.1:48123' },
      payload: { token: 'bootstrap-secret' },
    });
    const cookie = exchange.headers['set-cookie']?.split(';')[0];
    const csrf = exchange.json<{ data: { csrfToken: string } }>().data.csrfToken;
    const headers = {
      host: '127.0.0.1:48123',
      origin: 'http://127.0.0.1:48123',
      cookie,
      'x-csrf-token': csrf,
    };

    const added = await server.inject({
      method: 'POST',
      url: '/api/v1/skill-store/repositories',
      headers,
      payload: { name: 'my-skills', url: 'https://github.com/owner/repo' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().data).toMatchObject({ name: 'my-skills', cached: false });

    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/skill-store/repositories',
      headers,
      payload: { name: 'bad', url: 'https://example.com/repo' },
    });
    expect(rejected.statusCode).toBe(400);

    const listed = await server.inject({
      method: 'GET',
      url: '/api/v1/skill-store/repositories',
      headers: { host: '127.0.0.1:48123', cookie },
    });
    expect(listed.json().data).toContainEqual(
      expect.objectContaining({ name: 'my-skills', url: 'https://github.com/owner/repo' }),
    );

    const removed = await server.inject({
      method: 'DELETE',
      url: '/api/v1/skill-store/repositories/my-skills',
      headers,
      payload: { confirmName: 'my-skills' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ removed: true });
    await server.close();
  });

  it('cancels unfinished Web operations when the server closes', async () => {
    const operations = new OperationManager();
    const { server } = setup(operations);
    const operation = operations.start('run', 'user-operations', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    });

    await server.ready();
    await server.close();
    await operations.wait(operation.id);

    expect(operations.get(operation.id).state).toBe('cancelled');
  });
});
