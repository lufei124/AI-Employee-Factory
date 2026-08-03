import fs from 'fs-extra';
import YAML from 'yaml';
import { atomicWriteFile } from './atomic.js';
import type { FactoryPaths } from './paths.js';
import { RegistryStore } from './registry.js';

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
