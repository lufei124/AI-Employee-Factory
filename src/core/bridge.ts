import { execa } from 'execa';
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
      const result = await execa('lark-channel-bridge', ['run', '--help'], {
        shell: false,
        reject: false,
        ...(env ? { env, extendEnv: false } : {}),
      });
      const help = `${result.stdout}\n${result.stderr}`;
      const required = ['--profile', '--agent', '--workspace'];
      const missing = required.filter((flag) => !help.includes(flag));
      return { compatible: result.exitCode === 0 && missing.length === 0, missing, help };
    } catch (error) {
      return { compatible: false, missing: ['lark-channel-bridge'], help: String(error) };
    }
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
