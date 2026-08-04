import { AgentCtlError } from '../core/errors.js';
import type { FactoryPaths } from '../core/paths.js';
import type { AgentConfig } from '../schemas/agent-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { JobConfig } from '../schemas/job-schema.js';
import type { ServiceAdapter, ServiceStatus } from './service-adapter.js';
import type { ServiceAdapterFactory } from './factory-services.js';

// OP5-A：systemd 服务适配器**桩**。Linux 仅保留适配器边界（D-002/ASSUMPTIONS：v1 正式支持 macOS，
// systemd 待后续映射实现）。install() 抛 DEPENDENCY_MISSING，便于测试多态分发；不会产生副作用。
// 语义映射（计划）见 docs/ARCHITECTURE.md OP5-A 段。

const STUB_MESSAGE = 'systemd 服务未实现：v1 仅正式支持 macOS launchd。';

/** systemd 桩：install/start/stop/restart/uninstall 抛 DEPENDENCY_MISSING，status 返回 error。 */
class SystemdServiceAdapter implements ServiceAdapter {
  constructor(
    private readonly unitName: string,
    private readonly unitFile: string,
  ) {}

  async install(): Promise<void> {
    throw this.stub('install');
  }

  async start(): Promise<void> {
    throw this.stub('start');
  }

  async stop(): Promise<void> {
    throw this.stub('stop');
  }

  async restart(): Promise<void> {
    throw this.stub('restart');
  }

  async status(): Promise<ServiceStatus> {
    return { state: 'error', detail: `${STUB_MESSAGE} unit=${this.unitFile}` };
  }

  async uninstall(): Promise<void> {
    throw this.stub('uninstall');
  }

  private stub(operation: string): AgentCtlError {
    return new AgentCtlError(
      'DEPENDENCY_MISSING',
      `${STUB_MESSAGE} ${operation}=${this.unitName}`,
      { remediation: '在 macOS 上使用 launchd，或在 Linux 等待 systemd 映射实现。' },
    );
  }
}

/** systemd 工厂桩：install() 抛 DEPENDENCY_MISSING，便于测试多态分发。 */
export class SystemdServiceAdapterFactory implements ServiceAdapterFactory {
  readonly provider = 'systemd' as const;

  bridge(
    agent: RegistryAgent,
    _runtime: AgentConfig['runtime'],
    paths: FactoryPaths,
  ): ServiceAdapter {
    return new SystemdServiceAdapter(
      `com.aiemployees.${agent.id}.bridge.service`,
      `${paths.servicesDir}/${agent.id}/bridge.unit`,
    );
  }

  job(
    agent: RegistryAgent,
    _runtime: AgentConfig['runtime'],
    job: JobConfig,
    paths: FactoryPaths,
  ): ServiceAdapter {
    return new SystemdServiceAdapter(
      `com.aiemployees.${agent.id}.job.${job.id}.service`,
      `${paths.schedulesDir}/${agent.id}/${job.id}.unit`,
    );
  }
}
