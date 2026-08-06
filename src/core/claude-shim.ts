import fs from 'fs-extra';
import path from 'node:path';
import { execa } from 'execa';
import type { FactoryPaths } from './paths.js';

// D-035：飞书 bridge 逐消息拦截。上游 lark-coding-agent-bridge 对每条消息 `spawn('claude', …)`
// （prompt 走 stdin、从 PATH 解析、继承父进程 PATH）。Factory 给 bridge env 的 PATH 前置一个
// `claude` shim 目录，使每条 `claude -p` 都被 shim 接住，转交给 `_service bridge-run` 走
// runLogged（真实 transcript）+ 完整沉淀链，从而让飞书主入口具备与 runJob 同等的 skill/记忆沉淀。

/** 员工专属 claude shim 目录（PATH 前置即可接管该员工 bridge 的 claude 调用）。 */
export function claudeShimDir(paths: FactoryPaths, agentId: string): string {
  return path.join(paths.runtimesDir, agentId, 'claude-shim');
}

/** 由 runtime_home（runtimes/<id>/claude）导出 shim 目录，供 bridge env 在无 FactoryPaths 处注入。 */
export function claudeShimDirForRuntime(runtimeHome: string): string {
  return path.join(path.dirname(runtimeHome), 'claude-shim');
}

/** D-035：把 shim 目录前置到 env 的 PATH，使 bridge spawn 的 `claude` 解析到 shim。 */
export function withClaudeShim(
  env: Record<string, string>,
  runtimeHome: string,
): Record<string, string> {
  const shim = claudeShimDirForRuntime(runtimeHome);
  const current = env.PATH ?? '';
  return { ...env, PATH: current ? `${shim}:${current}` : shim };
}

/** 解析真实 claude 可执行文件。安装时（prepareRuntime）PATH 尚不含 shim 目录，`command -v claude` 即真身。 */
export async function resolveRealClaude(source: NodeJS.ProcessEnv = process.env): Promise<string> {
  // D-035：先剔除 PATH 中的 claude-shim 目录。bridge 进程带着前置 shim 的 PATH 启动后，
  // 若再调 resolveRealClaude（如 bridge 复跑 prepareRuntime），`command -v claude` 会解析到 shim
  // 自身 → 递归。剔除后永远解析到真实 claude。
  const env = { ...source };
  const cleanPath = (env.PATH ?? '').split(':').filter((entry) => !entry.includes('claude-shim'));
  env.PATH = cleanPath.join(':');
  const result = await execa('bash', ['-lc', 'command -v claude'], {
    extendEnv: false,
    env,
    reject: false,
  });
  const resolved = result.stdout.trim();
  if (!resolved || result.exitCode !== 0) {
    throw new Error('未找到真实 claude 可执行文件（command -v claude 为空）。');
  }
  return resolved;
}

/**
 * D-035：幂等安装 claude shim。shim 把每条 `claude -p -- <args>` ＋ stdin prompt 转交给
 * `_service bridge-run <id>`，由 Factory 用真实 claude 跑 runLogged + settle。真实 claude 路径
 * 与 Factory 路径烘焙进脚本（避免 shim 递归解析到自己）。
 */
export async function installClaudeShim(
  paths: FactoryPaths,
  agentId: string,
  cliFile: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = claudeShimDir(paths, agentId);
  const shim = path.join(dir, 'claude');
  // 幂等：shim 已存在时先读，若内容与将写入一致则跳过（避免每次 prepareRuntime 都 execa 解析 claude）。
  const desired = await renderShim(paths, agentId, cliFile, source);
  const existing = await fs.readFile(shim, 'utf8').catch(() => '');
  if (existing === desired) return;
  await fs.ensureDir(dir);
  await fs.writeFile(shim, desired, { mode: 0o700 });
}

/** D-035：渲染 shim 脚本内容（解析真实 claude 路径并烘焙）。 */
export async function renderShim(
  paths: FactoryPaths,
  agentId: string,
  cliFile: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const realClaude = await resolveRealClaude(source);
  return [
    '#!/bin/sh',
    '# AI Employee Factory 飞书 bridge claude shim（D-035）：仅拦截含 -p 的消息调用，送回 settle 链。',
    '# 非 -p 调用（如 --version 预检/help）直接透传真实 claude，避免预检被 stdin 读取挂起超时。',
    '# stdin（bridge 的 prompt）经 exec 继承转发给 _service bridge-run。',
    'found_p=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    -p|--print) found_p=1 ;;',
    '  esac',
    'done',
    `export AI_EMPLOYEES_HOME="${paths.home}"`,
    `export AI_EMPLOYEES_WORKSPACE_ROOT="${paths.workspaceRoot}"`,
    `export AIEMPLOYEES_REAL_CLAUDE="${realClaude}"`,
    'if [ -n "$found_p" ]; then',
    `  exec "${cliFile}" _service bridge-run "${agentId}" "$@"`,
    'fi',
    `exec "${realClaude}" "$@"`,
    '',
  ].join('\n');
}
