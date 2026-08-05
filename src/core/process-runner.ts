import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import type { ExecutionContext } from '../runtimes/runtime-adapter.js';
import { FileTranscriptSink, summarizeTranscript, type TranscriptSummary } from './transcript.js';
import { parseStructuredUsage, type RunUsage, type StructuredOutputProvider } from './usage.js';

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
  /** OP4-C 前置：structured 解析出的用量（best-effort，失败/未启用则省略）。 */
  usage?: RunUsage;
  /** OP1 Stage C：transcript 启用时持久化的摘要文件（best-effort，失败则省略）。 */
  transcriptFile?: string;
}

export interface LoggedRunOptions {
  mirror?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** OP4-B：trace 关联三件套，写入 metadata.json，缺省则字段省略（向后兼容）。 */
  operationId?: string;
  traceId?: string;
  /** OP4-C 前置：provider + structured 同时启用时，run 结束后解析 stdout 抽取 usage。 */
  provider?: StructuredOutputProvider;
  structured?: boolean;
  /** OP1 Stage C：true 时把会话摘要写入 transcript.jsonl（0600，best-effort）。 */
  transcript?: boolean;
  /** TASK-029 自我进化：true 表示本次 run 是只读编排探针（规划/审查/拆解），
   *  runAgent 成功后的 commitSelfEvolution 跳过——避免把规划门违规的改动当作合法进化提交。 */
  skipSelfEvolution?: boolean;
  /** 摘要收集器覆盖（默认内部收集全部 stdout 行；测试可注入）。 */
  transcriptSummary?: (input: {
    agentId: string;
    operation: string;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    outputLines: string[];
  }) => Promise<TranscriptSummary>;
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
    // OP1 Stage C：启用时收集 stdout 行用于生成会话摘要（摘要非全量原文）。
    const collectedLines: string[] = [];
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
      if (options.transcript) {
        for (const line of chunk.toString('utf8').split('\n')) {
          const trimmed = line.trim();
          if (trimmed) collectedLines.push(trimmed);
        }
      }
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
    // OP4-C 前置：structured 启用时读取 stdout 文件做 best-effort 用量解析（纯函数，失败返回 undefined）。
    let usage: RunUsage | undefined;
    if (options.structured && options.provider) {
      const stdoutContent = await fs.readFile(stdoutFile, 'utf8').catch(() => '');
      usage = parseStructuredUsage(options.provider, stdoutContent);
    }
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
        // OP4-C 前置：用量字段，仅 structured 解析成功时写入。
        ...(usage ? { usage } : {}),
      },
      { spaces: 2, mode: 0o600 },
    );
    // OP1 Stage C：transcript 启用时把会话摘要写入 transcript.jsonl（best-effort，失败不阻断）。
    let transcriptFile: string | undefined;
    if (options.transcript) {
      try {
        const summary =
          options.transcriptSummary !== undefined
            ? await options.transcriptSummary({
                agentId,
                operation: context.operation,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                exitCode,
                outputLines: collectedLines,
              })
            : summarizeTranscript({
                agentId,
                operation: context.operation,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                exitCode,
                outputLines: collectedLines,
              });
        transcriptFile = await new FileTranscriptSink(
          path.join(logDir, 'transcript.jsonl'),
        ).persist(summary);
      } catch {
        transcriptFile = undefined;
      }
    }
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
      ...(usage ? { usage } : {}),
      ...(transcriptFile ? { transcriptFile } : {}),
    };
  }
}
