import path from 'node:path';
import type { FactoryPaths } from '../core/paths.js';
import { buildRuntimeEnvironment } from '../core/runtime.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { JobConfig } from '../schemas/job-schema.js';
import { LaunchdServiceAdapter, type LaunchdPlistInput } from './launchd-service.js';
import type { ServiceAdapter } from './service-adapter.js';
import { SystemdServiceAdapterFactory } from './systemd-service.js';

// OP5-A：ServiceAdapter 工厂。按 config.yaml 的 service_provider 选择平台实现；
// LaunchdServiceAdapterFactory 是 v1 唯一正式实现，SystemdServiceAdapterFactory 为桩（install 抛
// DEPENDENCY_MISSING，便于测试多态分发）。ServiceAdapter 接口保持不变（service-adapter.ts）。

/** 生成 bridge/job 服务适配器的工厂契约。 */
export interface ServiceAdapterFactory {
  readonly provider: 'launchd' | 'systemd';
  bridge(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
    paths: FactoryPaths,
    cliFile?: string,
    home?: string,
  ): ServiceAdapter;
  job(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
    job: JobConfig,
    paths: FactoryPaths,
    cliFile?: string,
    home?: string,
  ): ServiceAdapter;
}

/** 按 service_provider 字符串返回工厂；未知 provider 抛 DEPENDENCY_MISSING。 */
export function createServiceFactory(provider: string): ServiceAdapterFactory {
  switch (provider) {
    case 'launchd':
      return new LaunchdServiceAdapterFactory();
    case 'systemd':
      return new SystemdServiceAdapterFactory();
    default:
      throw new Error(`不支持的 service_provider：${provider}`);
  }
}

function executable(cliFile: string): { program: string; prefix: string[] } {
  return cliFile.endsWith('.js')
    ? { program: process.execPath, prefix: [cliFile] }
    : { program: cliFile, prefix: [] };
}

export class LaunchdServiceAdapterFactory implements ServiceAdapterFactory {
  readonly provider = 'launchd' as const;

  bridge(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
    paths: FactoryPaths,
    cliFile = process.argv[1] ?? 'agentctl',
    home = process.env.HOME ?? '',
  ): LaunchdServiceAdapter {
    const exec = executable(path.resolve(cliFile));
    const logDir = path.join(paths.logsDir, agent.id);
    const env = {
      ...buildRuntimeEnvironment(agent, runtime),
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

  job(
    agent: RegistryAgent,
    runtime: AgentConfig['runtime'],
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
        ...buildRuntimeEnvironment(agent, runtime),
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
}

// 兼容旧调用方：模块级函数仍可用（委托到 launchd 工厂）。
export function bridgeLaunchdService(
  agent: RegistryAgent,
  runtime: AgentConfig['runtime'],
  paths: FactoryPaths,
  cliFile?: string,
  home?: string,
): LaunchdServiceAdapter {
  return new LaunchdServiceAdapterFactory().bridge(agent, runtime, paths, cliFile, home);
}

export function jobLaunchdService(
  agent: RegistryAgent,
  runtime: AgentConfig['runtime'],
  job: JobConfig,
  paths: FactoryPaths,
  cliFile?: string,
  home?: string,
): LaunchdServiceAdapter {
  return new LaunchdServiceAdapterFactory().job(agent, runtime, job, paths, cliFile, home);
}
