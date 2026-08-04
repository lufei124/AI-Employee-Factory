import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { factoryConfigSchema, initializeFactory, readConfig } from '../src/core/config.js';
import { resolveFactoryPaths } from '../src/core/paths.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.remove(root))));

function pathsFor(root: string) {
  return resolveFactoryPaths({
    HOME: root,
    AI_EMPLOYEES_HOME: path.join(root, 'private'),
    AI_EMPLOYEES_WORKSPACE_ROOT: path.join(root, 'agents'),
  });
}

describe('factory config (R5)', () => {
  it('readConfig returns defaults with sanitize_non_whitelist=false when config absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-config-'));
    roots.push(root);
    const paths = pathsFor(root);
    // 不调用 initializeFactory，config.yaml 不存在
    const config = await readConfig(paths);
    expect(config.version).toBe(1);
    expect(config.sync.sanitize_non_whitelist).toBe(false);
  });

  it('readConfig defaults sanitize_non_whitelist=false when sync key absent (backward compat)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-config-'));
    roots.push(root);
    const paths = pathsFor(root);
    await initializeFactory(paths); // 写入旧式四字段配置，无 sync 键
    const config = await readConfig(paths);
    expect(config.sync.sanitize_non_whitelist).toBe(false);
  });

  it('readConfig reads sync.sanitize_non_whitelist=true from a written config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentctl-config-'));
    roots.push(root);
    const paths = pathsFor(root);
    await fs.ensureDir(path.dirname(paths.configFile));
    await fs.writeFile(
      paths.configFile,
      YAML.stringify({
        version: 1,
        home: paths.home,
        workspace_root: paths.workspaceRoot,
        service_provider: 'launchd',
        sync: { sanitize_non_whitelist: true },
      }),
    );
    const config = await readConfig(paths);
    expect(config.sync.sanitize_non_whitelist).toBe(true);
  });

  it('factoryConfigSchema rejects an invalid sanitize_non_whitelist type', () => {
    expect(() =>
      factoryConfigSchema.parse({
        version: 1,
        home: '/tmp',
        workspace_root: '/tmp',
        service_provider: 'launchd',
        sync: { sanitize_non_whitelist: 'yes' },
      }),
    ).toThrow();
  });
});
