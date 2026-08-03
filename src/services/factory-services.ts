import path from 'node:path';
import type { FactoryPaths } from '../core/paths.js';
import { buildRuntimeEnvironment } from '../core/runtime.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { JobConfig } from '../schemas/job-schema.js';
import { LaunchdServiceAdapter, type LaunchdPlistInput } from './launchd-service.js';

function executable(cliFile: string): { program: string; prefix: string[] } {
  return cliFile.endsWith('.js')
    ? { program: process.execPath, prefix: [cliFile] }
    : { program: cliFile, prefix: [] };
}

export function bridgeLaunchdService(
  agent: RegistryAgent,
  paths: FactoryPaths,
  cliFile = process.argv[1] ?? 'agentctl',
  home = process.env.HOME ?? '',
): LaunchdServiceAdapter {
  const exec = executable(path.resolve(cliFile));
  const logDir = path.join(paths.logsDir, agent.id);
  const env = {
    ...buildRuntimeEnvironment(agent),
    LARK_CHANNEL_HOME: agent.bridge.home,
    LARK_CHANNEL_PROFILE: agent.bridge.profile ?? agent.id,
    AI_EMPLOYEES_HOME: paths.home,
    AI_EMPLOYEES_WORKSPACE_ROOT: paths.workspaceRoot,
  };
  const input: LaunchdPlistInput = {
    label: `com.aiemployees.${agent.id}`,
    program: exec.program,
    args: [...exec.prefix, '_service', 'bridge', agent.id],
    env,
    stdoutPath: path.join(logDir, 'bridge.stdout.log'),
    stderrPath: path.join(logDir, 'bridge.stderr.log'),
  };
  return new LaunchdServiceAdapter(
    input,
    path.join(paths.servicesDir, agent.id, 'bridge.plist'),
    home,
  );
}

export function jobLaunchdService(
  agent: RegistryAgent,
  job: JobConfig,
  paths: FactoryPaths,
  cliFile = process.argv[1] ?? 'agentctl',
  home = process.env.HOME ?? '',
): LaunchdServiceAdapter {
  const exec = executable(path.resolve(cliFile));
  const [hour, minute] = job.schedule.time.split(':').map(Number) as [number, number];
  const input: LaunchdPlistInput = {
    label: `com.aiemployees.${agent.id}.job.${job.id}`,
    program: exec.program,
    args: [...exec.prefix, '_service', 'job', agent.id, job.id],
    env: {
      AI_EMPLOYEES_HOME: paths.home,
      AI_EMPLOYEES_WORKSPACE_ROOT: paths.workspaceRoot,
    },
    stdoutPath: path.join(paths.logsDir, agent.id, `job-${job.id}.stdout.log`),
    stderrPath: path.join(paths.logsDir, agent.id, `job-${job.id}.stderr.log`),
    calendar: { hour, minute },
  };
  return new LaunchdServiceAdapter(
    input,
    path.join(paths.schedulesDir, agent.id, `${job.id}.plist`),
    home,
  );
}
