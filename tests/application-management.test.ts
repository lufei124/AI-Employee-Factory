import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';

const roots: string[] = [];

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-management-'));
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
    preset: 'user-operations',
    feishu: 'disabled',
  });
  return { root, paths, app };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('FactoryApplication management use cases', () => {
  it('creates, updates, and lists jobs while exposing terminal guidance', async () => {
    const { app, paths } = await setup();
    await fs.outputFile(
      path.join(paths.workspaceRoot, 'user-operations/prompts/review.md'),
      '# 每日复盘\n',
    );
    await app.createJob('user-operations', {
      schema_version: 1,
      id: 'daily-review',
      enabled: false,
      schedule: { type: 'daily', time: '09:00' },
      execution: {
        type: 'agent',
        prompt_file: 'prompts/review.md',
        timeout_seconds: 300,
        concurrency: 'forbid',
      },
    });
    await app.updateJob('user-operations', 'daily-review', {
      schema_version: 1,
      id: 'daily-review',
      enabled: false,
      schedule: { type: 'daily', time: '10:00' },
      execution: {
        type: 'agent',
        prompt_file: 'prompts/review.md',
        timeout_seconds: 300,
        concurrency: 'forbid',
      },
    });

    expect((await app.listJobs('user-operations'))[0]?.schedule.time).toBe('10:00');
    expect(await app.terminalGuidance('user-operations')).toEqual({
      runtimeLogin: 'agentctl runtime login user-operations',
      bridgeAuthorize: 'agentctl bridge authorize user-operations',
      chat: 'agentctl chat user-operations',
    });
  });

  it('lists installed skills, logs, and generated backups without exposing arbitrary paths', async () => {
    const { app, paths } = await setup();
    expect((await app.listSkills('user-operations')).map((skill) => skill.name)).toEqual([
      'feedback-analyze',
      'feedback-collect',
    ]);
    await fs.outputFile(
      path.join(paths.logsDir, 'user-operations/manual/output.log'),
      'line one\nline two\n',
    );
    expect((await app.readLatestLog('user-operations', 1)).content).toBe('line two\n');

    const output = await app.createBackup('user-operations');
    expect(output).toContain(paths.backupsDir);
    expect((await app.listBackups())[0]).toMatchObject({
      name: path.basename(output),
      encrypted: false,
    });
  });
});
