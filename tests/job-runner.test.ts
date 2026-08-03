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
});
