import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'node:path';
import { atomicWriteFile } from './atomic.js';
import { AgentCtlError } from './errors.js';
import { buildRuntimeEnvironment } from './runtime.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';

export interface BridgeExecutionContext {
  operation: 'bridge';
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface BridgeCapabilities {
  compatible: boolean;
  missing: string[];
  help: string;
  version: string;
}

export class BridgeAdapter {
  run(agent: RegistryAgent): BridgeExecutionContext {
    this.assertEnabled(agent);
    return this.context(agent, [
      'run',
      '--profile',
      agent.bridge.profile as string,
      '--agent',
      agent.runtime.provider,
      '--workspace',
      agent.workspace.path,
    ]);
  }

  authorize(
    agent: RegistryAgent,
    options: { appId?: string; tenant?: 'feishu' | 'lark' } = {},
  ): BridgeExecutionContext {
    this.assertEnabled(agent);
    const args = [
      'profile',
      'create',
      agent.bridge.profile as string,
      '--agent',
      agent.runtime.provider,
      '--workspace',
      agent.workspace.path,
    ];
    if (options.appId) args.push('--app-id', options.appId);
    if (options.tenant) args.push('--tenant', options.tenant);
    return this.context(agent, args);
  }

  status(agent: RegistryAgent): BridgeExecutionContext {
    this.assertEnabled(agent);
    return this.context(agent, ['profile', 'export', agent.bridge.profile as string]);
  }

  async inspectCapabilities(env?: Record<string, string>): Promise<BridgeCapabilities> {
    try {
      const execute = (args: string[]) =>
        execa('lark-channel-bridge', args, {
          shell: false,
          reject: false,
          ...(env ? { env, extendEnv: false } : {}),
        });
      const [versionResult, runResult, createResult, exportResult] = await Promise.all([
        execute(['--version']),
        execute(['run', '--help']),
        execute(['profile', 'create', '--help']),
        execute(['profile', 'export', '--help']),
      ]);
      const version = `${versionResult.stdout}\n${versionResult.stderr}`.trim() || 'unknown';
      const runHelp = `${runResult.stdout}\n${runResult.stderr}`;
      const createHelp = `${createResult.stdout}\n${createResult.stderr}`;
      const exportHelp = `${exportResult.stdout}\n${exportResult.stderr}`;
      const missing = [
        ...['--profile', '--agent', '--workspace']
          .filter((flag) => !runHelp.includes(flag))
          .map((flag) => `run:${flag}`),
        ...['--agent', '--workspace', '--app-id', '--tenant']
          .filter((flag) => !createHelp.includes(flag))
          .map((flag) => `profile create:${flag}`),
        ...(exportResult.exitCode === 0 ? [] : ['profile export']),
      ];
      const successful = [versionResult, runResult, createResult, exportResult].every(
        (result) => result.exitCode === 0,
      );
      return {
        compatible: successful && missing.length === 0,
        missing,
        help: [runHelp, createHelp, exportHelp].join('\n'),
        version,
      };
    } catch (error) {
      return {
        compatible: false,
        missing: ['lark-channel-bridge'],
        help: String(error),
        version: 'unavailable',
      };
    }
  }

  async secureProfile(agent: RegistryAgent): Promise<void> {
    this.assertEnabled(agent);
    const profileName = agent.bridge.profile as string;
    const configFile = path.join(agent.bridge.home, 'config.json');
    if (!(await fs.pathExists(configFile))) {
      throw new AgentCtlError('AUTH_REQUIRED', `未找到 Bridge Profile：${profileName}`, {
        remediation: `请先运行 agentctl bridge authorize ${agent.id}。`,
      });
    }
    let root: Record<string, unknown>;
    try {
      root = (await fs.readJson(configFile)) as Record<string, unknown>;
    } catch (error) {
      throw new AgentCtlError('VALIDATION_ERROR', 'Bridge 配置不是有效 JSON。', { cause: error });
    }
    const profiles = root.profiles;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
      throw new AgentCtlError('VALIDATION_ERROR', 'Bridge 配置缺少 profiles。');
    }
    const profile = (profiles as Record<string, unknown>)[profileName];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new AgentCtlError('AUTH_REQUIRED', `Bridge Profile 不存在：${profileName}`);
    }
    const profileRecord = { ...(profile as Record<string, unknown>) };
    if (profileRecord.agentKind !== agent.runtime.provider) {
      throw new AgentCtlError('CONFLICT', 'Bridge Profile 的 Runtime 与员工配置不一致。');
    }
    profileRecord.permissions = { defaultAccess: 'workspace', maxAccess: 'workspace' };
    delete profileRecord.sandbox;
    const migrations =
      root.migrations && typeof root.migrations === 'object' && !Array.isArray(root.migrations)
        ? { ...(root.migrations as Record<string, unknown>) }
        : {};
    const migrated = Array.isArray(migrations.permissionDefaultsV1)
      ? migrations.permissionDefaultsV1.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    migrations.permissionDefaultsV1 = [...new Set([...migrated, profileName])].sort();
    await atomicWriteFile(
      configFile,
      `${JSON.stringify(
        {
          ...root,
          migrations,
          profiles: { ...(profiles as Record<string, unknown>), [profileName]: profileRecord },
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  }

  private context(agent: RegistryAgent, args: string[]): BridgeExecutionContext {
    return {
      operation: 'bridge',
      command: 'lark-channel-bridge',
      args,
      cwd: agent.workspace.path,
      env: {
        ...buildRuntimeEnvironment(agent),
        LARK_CHANNEL_HOME: agent.bridge.home,
        LARK_CHANNEL_PROFILE: agent.bridge.profile as string,
      },
    };
  }

  private assertEnabled(agent: RegistryAgent): void {
    if (!agent.bridge.enabled || !agent.bridge.profile) {
      throw new AgentCtlError('VALIDATION_ERROR', `Agent ${agent.id} 未启用飞书 Bridge。`);
    }
  }
}
