import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeFactory } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { ProcessRunner } from '../src/core/process-runner.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

describe('initializeFactory', () => {
  it('creates private roots, config, and registry without touching default runtime homes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-init-'));
    roots.push(root);
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });

    await initializeFactory(paths);

    expect(await fs.pathExists(paths.registryFile)).toBe(true);
    expect(await fs.pathExists(paths.configFile)).toBe(true);
    expect((await fs.stat(paths.registryFile)).mode & 0o777).toBe(0o600);
    expect(await fs.pathExists(path.join(root, '.claude'))).toBe(false);
    expect(await fs.pathExists(path.join(root, '.codex'))).toBe(false);
  });
});

describe('ProcessRunner', () => {
  it('records stdout, stderr, timing, and the real exit code', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-process-'));
    roots.push(root);
    const runner = new ProcessRunner(path.join(root, 'logs'));
    const previousSecret = process.env.PERSONAL_SECRET;
    process.env.PERSONAL_SECRET = 'must-not-leak';

    let result;
    try {
      result = await runner.runLogged(
        'employee',
        {
          operation: 'run',
          command: process.execPath,
          args: [
            '-e',
            "console.log('out:' + (process.env.PERSONAL_SECRET ?? 'absent')); console.error('err'); process.exit(7)",
          ],
          cwd: root,
          env: { HOME: root, PATH: process.env.PATH ?? '' },
        },
        { mirror: false },
      );
    } finally {
      if (previousSecret === undefined) delete process.env.PERSONAL_SECRET;
      else process.env.PERSONAL_SECRET = previousSecret;
    }

    expect(result.exitCode).toBe(7);
    expect(await fs.readFile(result.stdoutFile, 'utf8')).toContain('out:absent');
    expect(await fs.readFile(result.stderrFile, 'utf8')).toContain('err');
    const metadata = await fs.readJson(result.metadataFile);
    expect(metadata.started_at).toBeTruthy();
    expect(metadata.finished_at).toBeTruthy();
    expect(metadata.exit_code).toBe(7);
    expect(JSON.stringify(metadata)).not.toContain('secret');
  });

  it('streams output callbacks and cancels a child with an AbortSignal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-process-'));
    roots.push(root);
    const runner = new ProcessRunner(path.join(root, 'logs'));
    const controller = new AbortController();
    const output: string[] = [];

    const result = await runner.runLogged(
      'employee',
      {
        operation: 'run',
        command: process.execPath,
        args: ['-e', "console.log('ready'); setInterval(() => {}, 1000)"],
        cwd: root,
        env: { HOME: root, PATH: process.env.PATH ?? '' },
        timeoutMs: 300,
      },
      {
        mirror: false,
        signal: controller.signal,
        onStdout(chunk) {
          output.push(chunk);
          controller.abort();
        },
      },
    );

    expect(output.join('')).toContain('ready');
    expect(result.exitCode).toBe(130);
    expect((await fs.readJson(result.metadataFile)).cancelled).toBe(true);
  });
});
