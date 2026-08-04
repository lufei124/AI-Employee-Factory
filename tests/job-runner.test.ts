import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner } from '../src/core/job-runner.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('JobRunner', () => {
  it('runs a deterministic script without a shell and writes isolated logs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-job-run-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await fs.outputFile(path.join(workspace, 'scripts/check.mjs'), "console.log('checked')");
    const agent: RegistryAgent = {
      id: 'employee',
      name: '员工',
      status: 'stopped',
      archived: false,
      runtime: { provider: 'claude', locked: true },
      workspace: { path: workspace, git_repository: true },
      runtime_home: { path: path.join(root, 'private/runtimes/employee/claude') },
      bridge: {
        enabled: false,
        home: path.join(root, 'private/bridges/employee'),
        mode: 'disabled',
        authorization: 'pending',
      },
      permissions: { level: 'workspace', production_write: 'approval_required' },
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    };

    const result = await new JobRunner(paths).run(
      agent,
      {
        schema_version: 1,
        id: 'check',
        enabled: false,
        schedule: { type: 'daily', time: '09:00' },
        execution: {
          type: 'script',
          script_file: 'scripts/check.mjs',
          interpreter: 'node',
          args: [],
          timeout_seconds: 30,
          concurrency: 'forbid',
        },
      },
      { mirror: false },
    );

    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(result.stdoutFile as string, 'utf8')).toContain('checked');
  });

  it('injects the isolated runtime env into script jobs so they never fall back to ~/.claude', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-job-env-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    await fs.outputFile(
      path.join(workspace, 'scripts/env.mjs'),
      'console.log(JSON.stringify({ cfg: process.env.CLAUDE_CONFIG_DIR }))',
    );
    const runtimeHome = path.join(root, 'private/runtimes/employee/claude');
    const agent: RegistryAgent = {
      id: 'employee',
      name: '员工',
      status: 'stopped',
      archived: false,
      runtime: { provider: 'claude', locked: true },
      workspace: { path: workspace, git_repository: true },
      runtime_home: { path: runtimeHome },
      bridge: {
        enabled: false,
        home: path.join(root, 'private/bridges/employee'),
        mode: 'disabled',
        authorization: 'pending',
      },
      permissions: { level: 'workspace', production_write: 'approval_required' },
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    };

    const result = await new JobRunner(paths).run(
      agent,
      {
        schema_version: 1,
        id: 'env',
        enabled: false,
        schedule: { type: 'daily', time: '09:00' },
        execution: {
          type: 'script',
          script_file: 'scripts/env.mjs',
          interpreter: 'node',
          args: [],
          timeout_seconds: 30,
          concurrency: 'forbid',
        },
      },
      { mirror: false },
    );

    const out = JSON.parse(await fs.readFile(result.stdoutFile as string, 'utf8'));
    expect(out.cfg).toBe(runtimeHome);
  });

  it('refuses to run a script job whose script file is a symlink escaping the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-job-symlink-'));
    roots.push(root);
    const workspace = path.join(root, 'agent');
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    const outside = path.join(root, 'outside.mjs');
    await fs.outputFile(outside, "console.log('escaped')");
    await fs.ensureDir(path.join(workspace, 'scripts'));
    await fs.symlink(outside, path.join(workspace, 'scripts/escaped.mjs'));
    const agent: RegistryAgent = {
      id: 'employee',
      name: '员工',
      status: 'stopped',
      archived: false,
      runtime: { provider: 'claude', locked: true },
      workspace: { path: workspace, git_repository: true },
      runtime_home: { path: path.join(root, 'private/runtimes/employee/claude') },
      bridge: {
        enabled: false,
        home: path.join(root, 'private/bridges/employee'),
        mode: 'disabled',
        authorization: 'pending',
      },
      permissions: { level: 'workspace', production_write: 'approval_required' },
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    };

    await expect(
      new JobRunner(paths).run(
        agent,
        {
          schema_version: 1,
          id: 'escaped',
          enabled: false,
          schedule: { type: 'daily', time: '09:00' },
          execution: {
            type: 'script',
            script_file: 'scripts/escaped.mjs',
            interpreter: 'node',
            args: [],
            timeout_seconds: 30,
            concurrency: 'forbid',
          },
        },
        { mirror: false },
      ),
    ).rejects.toThrow('软链接');
  });
});
