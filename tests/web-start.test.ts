import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryApplication } from '../src/application/factory-application.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import { RegistryStore } from '../src/core/registry.js';
import { startWebConsole } from '../src/web/start.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('startWebConsole', () => {
  it('listens only on 127.0.0.1 and serves the bundled SPA with a fragment token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-web-start-'));
    roots.push(root);
    const publicDir = path.join(root, 'public');
    await fs.outputFile(path.join(publicDir, 'index.html'), '<main>AI Employee Factory</main>');
    const paths = resolveFactoryPaths({
      HOME: root,
      AI_EMPLOYEES_HOME: path.join(root, 'private'),
      AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
    });
    const application = new FactoryApplication(paths, new RegistryStore(paths.registryFile));
    const purge = vi.spyOn(application, 'purgeExpiredTrash').mockResolvedValue({
      purged: [],
      wouldPurge: [],
    });
    // D-032：Web 启动时拉起常驻员工（reconcileServices 被调用）。
    const reconcile = vi
      .spyOn(application, 'reconcileServices')
      .mockResolvedValue({ activated: [] });

    const running = await startWebConsole({
      application,
      publicDir,
      port: 0,
      openBrowser: false,
      bootstrapToken: 'fragment-secret',
      listen: async (_server, options) => {
        expect(options).toEqual({ host: '127.0.0.1', port: 0 });
        return 'http://127.0.0.1:45678';
      },
    });

    expect(running.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.url).toBe(`${running.origin}/#session=fragment-secret`);
    expect(purge).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    const response = await running.server.inject({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:45678' },
    });
    expect(response.body).toContain('AI Employee Factory');
    await running.server.close();
  });
});
