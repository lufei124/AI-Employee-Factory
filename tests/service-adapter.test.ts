import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/schemas/agent-schema.js';
import type { JobConfig } from '../src/schemas/job-schema.js';
import type { RegistryAgent } from '../src/schemas/registry-schema.js';
import { resolveFactoryPaths } from '../src/core/paths.js';
import {
  LaunchdServiceAdapterFactory,
  createServiceFactory,
} from '../src/services/factory-services.js';
import { SystemdServiceAdapterFactory } from '../src/services/systemd-service.js';

const runtime: AgentConfig['runtime'] = { provider: 'claude', locked: true, model: 'sonnet' };

const agent: RegistryAgent = {
  id: 'user-operations',
  name: '用户运营专员',
  status: 'stopped',
  archived: false,
  workspace: { path: '/tmp/agents/user-operations', git_repository: true },
  runtime_home: { path: '/tmp/private/runtimes/user-operations/claude' },
  bridge: {
    enabled: true,
    profile: 'user-operations',
    home: '/tmp/private/bridges/user-operations',
    mode: 'dedicated_bot',
    authorization: 'ready',
  },
  permissions: { level: 'workspace', production_write: 'approval_required' },
  created_at: '2026-08-03T00:00:00.000Z',
  updated_at: '2026-08-03T00:00:00.000Z',
};

const job: JobConfig = {
  id: 'daily-report',
  enabled: true,
  schedule: { time: '09:30' },
  execution: {
    type: 'agent',
    prompt_file: 'tasks/daily-report.md',
    timeout_seconds: 600,
  },
};

const paths = resolveFactoryPaths({
  HOME: '/tmp/agentctl-test-home',
  AI_EMPLOYEES_HOME: '/tmp/agentctl-test-home/private',
  AI_EMPLOYEES_WORKSPACE_ROOT: '/tmp/agentctl-test-home/agents',
});

describe('createServiceFactory (OP5-A)', () => {
  it('dispatches launchd to the real factory', () => {
    const factory = createServiceFactory('launchd');
    expect(factory).toBeInstanceOf(LaunchdServiceAdapterFactory);
    expect(factory.provider).toBe('launchd');
    const adapter = factory.bridge(agent, runtime, paths);
    expect(adapter).toBeDefined();
  });

  it('dispatches systemd to the stub factory', () => {
    const factory = createServiceFactory('systemd');
    expect(factory).toBeInstanceOf(SystemdServiceAdapterFactory);
    expect(factory.provider).toBe('systemd');
  });

  it('throws for unknown provider', () => {
    expect(() => createServiceFactory('k8s')).toThrow('不支持的 service_provider');
  });
});

describe('SystemdServiceAdapterFactory stub (OP5-A)', () => {
  it('install throws DEPENDENCY_MISSING (no side effects)', async () => {
    const factory = new SystemdServiceAdapterFactory();
    const bridge = factory.bridge(agent, runtime, paths);
    await expect(bridge.install()).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
    const jobAdapter = factory.job(agent, runtime, job, paths);
    await expect(jobAdapter.install()).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
  });

  it('status reports error without executing anything', async () => {
    const factory = new SystemdServiceAdapterFactory();
    const bridge = factory.bridge(agent, runtime, paths);
    const status = await bridge.status();
    expect(status.state).toBe('error');
    expect(status.detail).toContain('systemd 服务未实现');
  });
});
