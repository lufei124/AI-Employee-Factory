import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/core/scheduler.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('JobStore', () => {
  it('loads, enables, and disables validated job yaml', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-job-'));
    roots.push(workspace);
    const store = new JobStore(workspace);
    await fs.outputFile(
      path.join(workspace, 'automation/jobs/daily.yaml'),
      `schema_version: 1\nid: daily\nenabled: false\nschedule:\n  type: daily\n  time: "09:00"\nexecution:\n  type: script\n  script_file: scripts/check.mjs\n  interpreter: node\n  args: []\n  timeout_seconds: 30\n  concurrency: forbid\n`,
    );

    expect((await store.list())[0]?.enabled).toBe(false);
    await store.setEnabled('daily', true);
    expect((await store.get('daily')).enabled).toBe(true);
    await store.setEnabled('daily', false);
    expect((await store.get('daily')).enabled).toBe(false);
  });

  it('rejects script files outside the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-job-'));
    roots.push(workspace);
    const store = new JobStore(workspace);
    await fs.outputFile(
      path.join(workspace, 'automation/jobs/escape.yaml'),
      `schema_version: 1\nid: escape\nenabled: true\nschedule: { type: daily, time: "09:00" }\nexecution: { type: script, script_file: ../../escape.sh, interpreter: bash, args: [], timeout_seconds: 30, concurrency: forbid }\n`,
    );

    await expect(store.get('escape')).rejects.toThrow();
  });

  it('creates and updates validated jobs without accepting duplicate creates', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-job-'));
    roots.push(workspace);
    const store = new JobStore(workspace);
    const job = {
      schema_version: 1 as const,
      id: 'daily-review',
      enabled: false,
      schedule: { type: 'daily' as const, time: '10:30' },
      execution: {
        type: 'agent' as const,
        prompt_file: 'prompts/daily.md',
        timeout_seconds: 300,
        concurrency: 'forbid' as const,
      },
    };

    await store.create(job);
    await expect(store.create(job)).rejects.toThrow('已存在');
    const updated = await store.update('daily-review', {
      ...job,
      schedule: { type: 'daily', time: '11:00' },
    });

    expect(updated.schedule.time).toBe('11:00');
    expect((await store.get('daily-review')).schedule.time).toBe('11:00');
  });
});
