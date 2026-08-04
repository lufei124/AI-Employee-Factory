import fs from 'fs-extra';
import path from 'node:path';
import { assertInsideReal, type FactoryPaths } from './paths.js';
import { FileLock } from './locks.js';
import { ProcessRunner, type LoggedRunOptions, type LoggedRunResult } from './process-runner.js';
import { buildRuntimeEnvironment, getRuntimeAdapter } from './runtime.js';
import type { JobConfig } from '../schemas/job-schema.js';
import type { RegistryAgent } from '../schemas/registry-schema.js';
import type { ExecutionContext } from '../runtimes/runtime-adapter.js';

export interface JobRunResult extends Partial<LoggedRunResult> {
  exitCode: number;
  skipped?: boolean;
}

export class JobRunner {
  constructor(private readonly paths: FactoryPaths) {}

  async run(
    agent: RegistryAgent,
    job: JobConfig,
    options: LoggedRunOptions = {},
  ): Promise<JobRunResult> {
    const lock = new FileLock(path.join(this.paths.locksDir, `job-${agent.id}-${job.id}.lock`));
    return lock.withLock({ purpose: `job:${agent.id}:${job.id}` }, async () => {
      const runner = new ProcessRunner(this.paths.logsDir);
      if (job.execution.type === 'script') {
        return runner.runLogged(agent.id, await this.scriptContext(agent, job.execution), options);
      }
      if (job.execution.precheck) {
        const result = await runner.runLogged(
          agent.id,
          await this.scriptContext(agent, {
            ...job.execution.precheck,
            timeout_seconds: job.execution.timeout_seconds,
          }),
          options,
        );
        if (result.exitCode === job.execution.precheck.no_data_exit_code)
          return { ...result, exitCode: 0, skipped: true };
        if (result.exitCode !== 0) return result;
      }
      const promptPath = path.resolve(agent.workspace.path, job.execution.prompt_file);
      await assertInsideReal(agent.workspace.path, promptPath, '任务 Prompt 文件');
      const prompt = await fs.readFile(promptPath, 'utf8');
      const context = getRuntimeAdapter(agent).run(
        agent,
        prompt,
        job.execution.timeout_seconds * 1000,
      );
      context.operation = 'job';
      return runner.runLogged(agent.id, context, options);
    });
  }

  private async scriptContext(
    agent: RegistryAgent,
    execution: {
      script_file: string;
      interpreter: 'node' | 'bash' | 'direct';
      args: string[];
      timeout_seconds: number;
    },
  ): Promise<ExecutionContext> {
    const script = path.resolve(agent.workspace.path, execution.script_file);
    await assertInsideReal(agent.workspace.path, script, '任务脚本');
    const command =
      execution.interpreter === 'node'
        ? process.execPath
        : execution.interpreter === 'bash'
          ? '/bin/bash'
          : script;
    const args = execution.interpreter === 'direct' ? execution.args : [script, ...execution.args];
    return {
      operation: 'job',
      command,
      args,
      cwd: agent.workspace.path,
      env: buildRuntimeEnvironment(agent),
      timeoutMs: execution.timeout_seconds * 1000,
    };
  }
}
