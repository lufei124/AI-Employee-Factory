import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { AgentCtlError } from './errors.js';

export interface FactoryPaths {
  userHome: string;
  home: string;
  workspaceRoot: string;
  registryDir: string;
  registryFile: string;
  configFile: string;
  runtimesDir: string;
  bridgesDir: string;
  servicesDir: string;
  schedulesDir: string;
  logsDir: string;
  backupsDir: string;
  trashDir: string;
  locksDir: string;
}

function homeFrom(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || os.homedir();
  if (!path.isAbsolute(home)) {
    throw new AgentCtlError('VALIDATION_ERROR', 'HOME 必须是绝对路径。');
  }
  return path.resolve(home);
}

export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function absoluteRoot(value: string, home: string, label: string): string {
  const expanded = expandHome(value, home);
  if (!path.isAbsolute(expanded)) {
    throw new AgentCtlError('VALIDATION_ERROR', `${label} 必须是绝对路径。`, {
      remediation: `请将 ${label} 设为以 / 或 ~/ 开头的路径。`,
    });
  }
  return path.resolve(expanded);
}

export function resolveFactoryPaths(env: NodeJS.ProcessEnv = process.env): FactoryPaths {
  const homeDir = homeFrom(env);
  const home = absoluteRoot(
    env.AI_EMPLOYEES_HOME ?? '~/.ai-employees',
    homeDir,
    'AI_EMPLOYEES_HOME',
  );
  const workspaceRoot = absoluteRoot(
    env.AI_EMPLOYEES_WORKSPACE_ROOT ?? '~/AI-Employees/agents',
    homeDir,
    'AI_EMPLOYEES_WORKSPACE_ROOT',
  );
  const registryDir = path.join(home, 'registry');
  return {
    userHome: homeDir,
    home,
    workspaceRoot,
    registryDir,
    registryFile: path.join(registryDir, 'agents.yaml'),
    configFile: path.join(home, 'config.yaml'),
    runtimesDir: path.join(home, 'runtimes'),
    bridgesDir: path.join(home, 'bridges'),
    servicesDir: path.join(home, 'services'),
    schedulesDir: path.join(home, 'schedules'),
    logsDir: path.join(home, 'logs'),
    backupsDir: path.join(home, 'backups'),
    trashDir: path.join(home, 'trash'),
    locksDir: path.join(home, 'locks'),
  };
}

export function assertInside(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new AgentCtlError('VALIDATION_ERROR', `${label} 必须位于 ${resolvedRoot} 内。`, {
      remediation: `请检查 ${label} 路径与根目录配置。`,
    });
  }
  return resolvedCandidate;
}

/**
 * 封存不变量 `assertInside` 的异步强化伴生（D-009 frozen 实现升级）。
 * 在 `assertInside` 的路径包含语义之上，补 `fs.realpath` 解析与软链接拒绝，
 * 抵抗「软链接逃逸」绕过。语义不变（包含校验仍由核心执行），仅升级实现。
 * 不存在路径仅做同步包含校验（向后兼容配置期校验）。
 */
export async function assertInsideReal(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const resolved = assertInside(root, candidate, label);
  if (!(await fs.pathExists(root)) || !(await fs.pathExists(candidate))) {
    return resolved;
  }
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) {
    throw new AgentCtlError('VALIDATION_ERROR', `${label} 不能是软链接。`, {
      remediation: `请检查 ${label} 路径，移除软链接后重试。`,
    });
  }
  const [rootReal, candidateReal] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(rootReal, candidateReal);
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    throw new AgentCtlError(
      'VALIDATION_ERROR',
      `${label} 必须位于 ${rootReal} 内（解析软链接后）。`,
      {
        remediation: `请检查 ${label} 路径与根目录配置。`,
      },
    );
  }
  return resolved;
}

export function displayPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = homeFrom(env);
  return value === home
    ? '~'
    : value.startsWith(`${home}${path.sep}`)
      ? `~/${path.relative(home, value)}`
      : value;
}
