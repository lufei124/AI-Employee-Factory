import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import type { ExecutionContext } from '../runtimes/runtime-adapter.js';

export interface LoggedRunResult {
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  logDir: string;
  stdoutFile: string;
  stderrFile: string;
  metadataFile: string;
  startedAt: string;
  finishedAt: string;
}

export interface LoggedRunOptions {
  mirror?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** OP4-B：trace 关联三件套，写入 metadata.json，缺省则字段省略（向后兼容）。 */
  operationId?: string;
  traceId?: string;
}

export class ProcessRunner {
  constructor(private readonly logsRoot: string) {}

  async runInteractive(context: ExecutionContext): Promise<number> {
    const result = await execa(context.command, context.args, {
      cwd: context.cwd,
      env: context.env,
      extendEnv: false,
      shell: false,
      stdio: 'inherit',
      reject: false,
      ...(context.timeoutMs !== undefined ? { timeout: context.timeoutMs } : {}),
    });
    return result.timedOut ? 124 : (result.exitCode ?? 1);
  }

  async runLogged(
    agentId: string,
    context: ExecutionContext,
    options: LoggedRunOptions = {},
  ): Promise<LoggedRunResult> {
    const startedAt = new Date();
    const slug = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const logDir = path.join(this.logsRoot, agentId, 'runs', slug);
    await fs.ensureDir(logDir);
    const stdoutFile = path.join(logDir, 'stdout.log');
    const stderrFile = path.join(logDir, 'stderr.log');
    const metadataFile = path.join(logDir, 'metadata.json');
    const stdoutStream = fs.createWriteStream(stdoutFile, { mode: 0o600 });
    const stderrStream = fs.createWriteStream(stderrFile, { mode: 0o600 });
    const child = execa(context.command, context.args, {
      cwd: context.cwd,
      env: context.env,
      extendEnv: false,
      shell: false,
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
      ...(options.signal ? { cancelSignal: options.signal } : {}),
      ...(context.timeoutMs !== undefined ? { timeout: context.timeoutMs } : {}),
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutStream.write(chunk);
      options.onStdout?.(chunk.toString('utf8'));
      if (options.mirror !== false) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrStream.write(chunk);
      options.onStderr?.(chunk.toString('utf8'));
      if (options.mirror !== false) process.stderr.write(chunk);
    });
    const result = await child;
    await Promise.all([
      new Promise<void>((resolve) => stdoutStream.end(resolve)),
      new Promise<void>((resolve) => stderrStream.end(resolve)),
    ]);
    const timedOut = result.timedOut;
    const cancelled = result.isCanceled || options.signal?.aborted === true;
    const exitCode = cancelled ? 130 : timedOut ? 124 : (result.exitCode ?? 1);
    const finishedAt = new Date();
    await fs.writeJson(
      metadataFile,
      {
        agent_id: agentId,
        operation: context.operation,
        executable: path.basename(context.command),
        cwd: context.cwd,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        exit_code: exitCode,
        timed_out: timedOut,
        cancelled,
        // OP4-B：trace 关联字段，仅在调用方提供时写入，向后兼容旧 metadata.json。
        ...(options.operationId ? { operation_id: options.operationId } : {}),
        ...(options.traceId ? { trace_id: options.traceId } : {}),
        ...(options.operationId ? { span_id: randomUUID() } : {}),
      },
      { spaces: 2, mode: 0o600 },
    );
    return {
      exitCode,
      timedOut,
      cancelled,
      logDir,
      stdoutFile,
      stderrFile,
      metadataFile,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
  }
}
