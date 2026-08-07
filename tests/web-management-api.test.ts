import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { JobStore } from '../src/core/scheduler.js';
import { buildWebServer } from '../src/web/server.js';

const roots: string[] = [];

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-web-management-'));
  roots.push(root);
  const paths = resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
  const app = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
  await app.initialize();
  await app.createAgent({
    id: 'user-operations',
    name: '用户运营专员',
    runtime: 'claude',
    description: '负责用户反馈收集、分析与闭环跟进',
    goals: ['收集并分析用户反馈', '闭环跟进问题'],
    feishu: 'disabled',
  });
  const server = buildWebServer({ application: app, bootstrapToken: 'secret' });
  const exchange = await server.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: { host: '127.0.0.1:41000' },
    payload: { token: 'secret' },
  });
  const cookie = exchange.headers['set-cookie']?.split(';')[0] ?? '';
  const csrf = exchange.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return {
    app,
    paths,
    server,
    readHeaders: { host: '127.0.0.1:41000', cookie },
    writeHeaders: {
      host: '127.0.0.1:41000',
      origin: 'http://127.0.0.1:41000',
      cookie,
      'x-csrf-token': csrf,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Web management API', () => {
  it('lists jobs (read-only) and exposes skills, logs, and terminal guidance', async () => {
    const { paths, server, readHeaders } = await setup();
    await fs.outputFile(
      path.join(paths.workspaceRoot, 'user-operations/prompts/review.md'),
      '# review\n',
    );
    // 定时任务由员工（AI）经 JobStore 落盘；Web 仅只读列举（D-033）。
    await new JobStore(path.join(paths.workspaceRoot, 'user-operations')).create({
      schema_version: 1,
      id: 'daily-review',
      enabled: false,
      schedule: { type: 'daily', time: '09:30' },
      execution: {
        type: 'agent',
        prompt_file: 'prompts/review.md',
        timeout_seconds: 300,
        concurrency: 'forbid',
      },
    });
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/jobs',
          headers: readHeaders,
        })
      ).json().data,
    ).toHaveLength(1);
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/jobs',
          headers: readHeaders,
        })
      ).json().data[0].schedule.time,
    ).toBe('09:30');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/skills',
          headers: readHeaders,
        })
      ).json().data,
    ).toHaveLength(1); // 预置宿主平台 skill（ai-employee-factory）

    await fs.outputFile(path.join(paths.logsDir, 'user-operations/manual/latest.log'), 'a\nb\n');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/logs?lines=1',
          headers: readHeaders,
        })
      ).json().data.content,
    ).toBe('b\n');
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/terminal-guidance',
          headers: readHeaders,
        })
      ).json().data.runtimeLogin,
    ).toBe('agentctl runtime sync user-operations');
    await server.close();
  });

  it('requires matching confirmation objects for destructive archives', async () => {
    const { server, writeHeaders } = await setup();
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/actions/archive',
      headers: writeHeaders,
      payload: { confirmId: 'another-agent' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.exitCode).toBe(2);

    const archived = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/actions/archive',
      headers: writeHeaders,
      payload: { confirmId: 'user-operations' },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.state).toBe('archived');
    await server.close();
  });

  it('moves and restores an Agent through confirmed trash endpoints', async () => {
    const { server, readHeaders, writeHeaders } = await setup();
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/actions/trash',
      headers: writeHeaders,
      payload: { confirmId: 'another-agent' },
    });
    expect(rejected.statusCode).toBe(400);

    const moved = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/actions/trash',
      headers: writeHeaders,
      payload: { confirmId: 'user-operations' },
    });
    expect(moved.statusCode).toBe(200);
    const trashId = moved.json<{ data: { trashId: string } }>().data.trashId;
    expect(
      (await server.inject({ method: 'GET', url: '/api/v1/agents', headers: readHeaders })).json()
        .data,
    ).toEqual([]);
    expect(
      (await server.inject({ method: 'GET', url: '/api/v1/trash', headers: readHeaders })).json()
        .data[0].trashId,
    ).toBe(trashId);

    const restored = await server.inject({
      method: 'POST',
      url: `/api/v1/trash/${trashId}/actions/restore`,
      headers: writeHeaders,
      payload: { confirmTrashId: trashId },
    });
    expect(restored.statusCode).toBe(200);
    expect(
      (await server.inject({ method: 'GET', url: '/api/v1/agents', headers: readHeaders })).json()
        .data[0].id,
    ).toBe('user-operations');
    await server.close();
  });

  it('runs backup as an observable operation and lists the artifact', async () => {
    const { server, readHeaders, writeHeaders } = await setup();
    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/backup',
      headers: writeHeaders,
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const operationId = started.json<{ data: { id: string } }>().data.id;

    let operation: { state: string } = { state: 'queued' };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/operations/${operationId}`,
        headers: readHeaders,
      });
      operation = response.json<{ data: { state: string } }>().data;
      if (!['queued', 'running'].includes(operation.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(operation.state).toBe('succeeded');
    expect(
      (await server.inject({ method: 'GET', url: '/api/v1/backups', headers: readHeaders })).json()
        .data,
    ).toHaveLength(1);
    await server.close();
  });

  it('imports a browser-selected Skill directory through safe multipart staging', async () => {
    const { server, readHeaders, writeHeaders } = await setup();
    const boundary = '----agentctl-skill-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="research-helper/SKILL.md"',
      'Content-Type: text/markdown',
      '',
      '---\nname: research-helper\nversion: 1.0.0\n---\n# Research helper\n',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/skills/upload',
      headers: { ...writeHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ name: 'research-helper', version: '1.0.0' });
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/skills',
          headers: readHeaders,
        })
      ).json().data,
    ).toHaveLength(2); // 预置 ai-employee-factory + research-helper
    await server.close();
  });

  it('rejects path traversal in a browser-selected Skill directory', async () => {
    const { server, writeHeaders } = await setup();
    const boundary = '----agentctl-escape-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="../SKILL.md"',
      'Content-Type: text/markdown',
      '',
      '# escape',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/skills/upload',
      headers: { ...writeHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    await server.close();
  });

  it('uninstalls a Skill via DELETE and rejects a mismatched confirmName', async () => {
    const { server, readHeaders, writeHeaders } = await setup();
    const boundary = '----agentctl-remove-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="remove-me/SKILL.md"',
      'Content-Type: text/markdown',
      '',
      '---\nname: remove-me\nversion: 1.0.0\n---\n# Remove me\n',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const uploaded = await server.inject({
      method: 'POST',
      url: '/api/v1/agents/user-operations/skills/upload',
      headers: { ...writeHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploaded.statusCode).toBe(201);

    const removed = await server.inject({
      method: 'DELETE',
      url: '/api/v1/agents/user-operations/skills/remove-me',
      headers: writeHeaders,
      payload: { confirmName: 'remove-me', scope: 'project' },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ removed: true, scope: 'project' });
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/api/v1/agents/user-operations/skills',
          headers: readHeaders,
        })
      ).json().data,
    ).toHaveLength(1); // 预置 ai-employee-factory 仍在（remove-me 已卸载）
    const mismatched = await server.inject({
      method: 'DELETE',
      url: '/api/v1/agents/user-operations/skills/remove-me',
      headers: writeHeaders,
      payload: { confirmName: 'other-name', scope: 'project' },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error.code).toBe('VALIDATION_ERROR');
    expect(mismatched.json().error.message).toContain('卸载确认不匹配');
    await server.close();
  });

  it('rejects identity document edits with 403 READONLY (D-041 决策①)', async () => {
    const { server, writeHeaders } = await setup();
    const denied = await server.inject({
      method: 'PUT',
      url: '/api/v1/agents/user-operations/documents/role',
      headers: writeHeaders,
      payload: { content: '# 岗位定位\n\n私自改写' },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('READONLY');
    expect(denied.json().error.message).toContain('身份文档只读');
    // GET 仍只读可用（文档内容未被修改）。
    const doc = await server.inject({
      method: 'GET',
      url: '/api/v1/agents/user-operations/documents/role',
      headers: writeHeaders,
    });
    expect(doc.statusCode).toBe(200);
    expect(doc.json().data.path).toContain('ROLE.md');
    await server.close();
  });

  it('streams an imported backup into the controlled backup directory', async () => {
    const { server, readHeaders, writeHeaders } = await setup();
    const boundary = '----agentctl-backup-boundary';
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="backup"; filename="portable-copy.tar.gz"',
      'Content-Type: application/gzip',
      '',
      'fake-archive-for-import-test',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/backups/import',
      headers: { ...writeHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json().data).toMatchObject({ name: 'portable-copy.tar.gz' });
    expect(
      (await server.inject({ method: 'GET', url: '/api/v1/backups', headers: readHeaders })).json()
        .data,
    ).toHaveLength(1);
    await server.close();
  });

  it('exposes the evolution history endpoint read-only (D-041 P3-1)', async () => {
    const { app, paths, server, readHeaders } = await setup();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/agents/user-operations/evolution',
      headers: readHeaders,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json<{
      data: { commits: unknown[]; currentState: string; usage: unknown[] };
    }>().data;
    expect(Array.isArray(data.commits)).toBe(true);
    expect(typeof data.currentState).toBe('string');
    expect(Array.isArray(data.usage)).toBe(true);
    // 新建员工尚无 evolve: 提交（空数组不抛错），但 CURRENT_STATE 有内容。
    expect(data.currentState.length).toBeGreaterThan(0);

    // 制造一条 evolve: 提交后应出现在历史里（git log --grep evolve:）。
    const workspace = path.join(paths.workspaceRoot, 'user-operations');
    await fs.writeFile(
      path.join(workspace, 'agent', 'GOALS.md'),
      `# 核心目标\n\n## 演进记录\n\n- 2026-08-07 evolve: 新增目标「复盘用户反馈闭环」\n`,
    );
    await app.settleEmployee('user-operations');
    const response2 = await server.inject({
      method: 'GET',
      url: '/api/v1/agents/user-operations/evolution',
      headers: readHeaders,
    });
    const commits = response2.json<{ data: { commits: Array<{ subject: string }> } }>().data
      .commits;
    expect(commits.some((commit) => commit.subject.includes('evolve:'))).toBe(true);
    await server.close();
  });

  it('exposes evolution commit files + content endpoints read-only, rejects path traversal (D-041 P3-1 点开看)', async () => {
    const { app, paths, server, readHeaders } = await setup();
    // 制造一条 evolve: 提交并拿到 hash。
    const workspace = path.join(paths.workspaceRoot, 'user-operations');
    await fs.writeFile(
      path.join(workspace, 'agent', 'GOALS.md'),
      `# 核心目标\n\n## 演进记录\n\n- 2026-08-07 evolve: 新增目标「复盘用户反馈闭环」\n`,
    );
    await app.settleEmployee('user-operations');
    const logResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/agents/user-operations/evolution',
      headers: readHeaders,
    });
    const commits = logResponse.json<{ data: { commits: Array<{ hash: string }> } }>().data.commits;
    // settle 会落多条 evolve 提交（GOALS/CURRENT_STATE/基线等），逐条找改动 GOALS.md 的那条。
    let ref = '';
    for (const commit of commits) {
      const probe = await server.inject({
        method: 'GET',
        url: `/api/v1/agents/user-operations/evolution/files?ref=${encodeURIComponent(commit.hash)}`,
        headers: readHeaders,
      });
      const probeFiles = probe.json<{ data: Array<{ path: string }> }>().data;
      if (probeFiles.some((f) => f.path === 'agent/GOALS.md')) {
        ref = commit.hash;
        break;
      }
    }
    expect(ref).not.toBe('');

    // 文件清单：能读到该提交变更的文件（含目录层级），ref 缺失报 400。
    const filesResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/agents/user-operations/evolution/files?ref=${encodeURIComponent(ref)}`,
      headers: readHeaders,
    });
    expect(filesResponse.statusCode).toBe(200);
    const files = filesResponse.json<{ data: Array<{ status: string; path: string }> }>().data;
    expect(files.some((f) => f.path === 'agent/GOALS.md')).toBe(true);
    const missingRefResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/agents/user-operations/evolution/files',
      headers: readHeaders,
    });
    expect(missingRefResponse.statusCode).toBe(400);

    // 文件内容：读提交下的全文（只读）。
    const contentResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/agents/user-operations/evolution/content?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent('agent/GOALS.md')}`,
      headers: readHeaders,
    });
    expect(contentResponse.statusCode).toBe(200);
    const content = contentResponse.json<{ data: { content: string } }>().data.content;
    expect(content).toContain('# 核心目标');

    // 路径穿越拒绝：.. 越界 / .git 内部路径 → 4xx。
    const traversal = await server.inject({
      method: 'GET',
      url: `/api/v1/agents/user-operations/evolution/content?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent('../.git/config')}`,
      headers: readHeaders,
    });
    expect(traversal.statusCode).toBeGreaterThanOrEqual(400);
    const gitInternals = await server.inject({
      method: 'GET',
      url: `/api/v1/agents/user-operations/evolution/content?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent('.git/config')}`,
      headers: readHeaders,
    });
    expect(gitInternals.statusCode).toBeGreaterThanOrEqual(400);

    // 提交中不存在的文件 → 404。
    const missingFile = await server.inject({
      method: 'GET',
      url: `/api/v1/agents/user-operations/evolution/content?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent('agent/NOPE.md')}`,
      headers: readHeaders,
    });
    expect(missingFile.statusCode).toBe(404);
    await server.close();
  });
});
