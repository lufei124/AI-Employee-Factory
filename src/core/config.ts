import fs from 'fs-extra';
import YAML from 'yaml';
import { z } from 'zod';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import type { FactoryPaths } from './paths.js';
import { RegistryStore } from './registry.js';

// R5：Factory 配置 schema。sync.sanitize_non_whitelist 控制 CC Switch 同步时是否
// 移除员工 settings.json 中残留的非白名单 env（默认 false，保留兼容）。
export const factoryConfigSchema = z.object({
  version: z.number(),
  home: z.string(),
  workspace_root: z.string(),
  service_provider: z.string(),
  sync: z
    .object({
      sanitize_non_whitelist: z.boolean().default(false),
    })
    .optional()
    .default({ sanitize_non_whitelist: false }),
});

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

export async function readConfig(paths: FactoryPaths): Promise<FactoryConfig> {
  const fallback = {
    version: 1,
    home: paths.home,
    workspace_root: paths.workspaceRoot,
    service_provider: process.platform === 'darwin' ? 'launchd' : 'unsupported',
  };
  if (!(await fs.pathExists(paths.configFile))) return factoryConfigSchema.parse(fallback);
  let raw: unknown;
  try {
    raw = YAML.parse(await fs.readFile(paths.configFile, 'utf8'));
  } catch (error) {
    throw new AgentCtlError('VALIDATION_ERROR', `Factory 配置解析失败：${paths.configFile}`, {
      cause: error,
    });
  }
  const parsed = factoryConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentCtlError('VALIDATION_ERROR', `Factory 配置无效：${paths.configFile}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function initializeFactory(paths: FactoryPaths): Promise<void> {
  await Promise.all(
    [
      paths.home,
      paths.workspaceRoot,
      paths.registryDir,
      paths.runtimesDir,
      paths.bridgesDir,
      paths.servicesDir,
      paths.schedulesDir,
      paths.logsDir,
      paths.backupsDir,
      paths.trashDir,
      paths.locksDir,
    ].map((directory) => fs.ensureDir(directory)),
  );
  if (!(await fs.pathExists(paths.configFile))) {
    await atomicWriteFile(
      paths.configFile,
      YAML.stringify({
        version: 1,
        home: paths.home,
        workspace_root: paths.workspaceRoot,
        service_provider: process.platform === 'darwin' ? 'launchd' : 'unsupported',
      }),
      0o600,
    );
  }
  await new RegistryStore(paths.registryFile).initialize();
  await Promise.all([
    fs.chmod(paths.home, 0o700),
    fs.chmod(paths.registryDir, 0o700),
    fs.chmod(paths.runtimesDir, 0o700),
    fs.chmod(paths.bridgesDir, 0o700),
    fs.chmod(paths.trashDir, 0o700),
    fs.chmod(paths.locksDir, 0o700),
  ]);
}
