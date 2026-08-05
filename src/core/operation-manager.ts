import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AgentCtlError } from '../core/errors.js';
import type { OperationStore } from '../core/operation-store.js';
import {
  defaultObservabilitySink,
  toGenAiAttrs,
  type ObservabilitySink,
} from '../core/observability.js';
import type { RunUsage } from '../core/usage.js';

export type OperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ApiError {
  code: string;
  message: string;
  exitCode: number;
  remediation?: string;
  fieldErrors?: Record<string, string[]>;
}

export interface OperationDto {
  id: string;
  type: string;
  agentId?: string;
  state: OperationState;
  progress?: number;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: ApiError;
  traceId?: string;
}

export interface OperationEvent {
  seq: number;
  kind: 'state' | 'progress' | 'output';
  timestamp: string;
  progress?: number;
  message?: string;
  stream?: 'stdout' | 'stderr';
  /** 计划派发等操作的聚合摘要（如「2/3 完成 · 执行中 t1」）。 */
  summary?: string;
}

export interface OperationTaskContext {
  signal: AbortSignal;
  emit(event: Omit<OperationEvent, 'seq' | 'timestamp'>): void;
  operationId: string;
  traceId: string;
}

export type OperationTask = (
  context: OperationTaskContext,
) => Promise<{ exitCode?: number; usage?: RunUsage } | void>;

interface InternalOperation {
  dto: OperationDto;
  controller: AbortController;
  events: OperationEvent[];
  emitter: EventEmitter;
}

function clone(dto: OperationDto): OperationDto {
  return structuredClone(dto);
}

function toApiError(error: unknown): ApiError {
  if (error instanceof AgentCtlError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      ...(error.remediation ? { remediation: error.remediation } : {}),
    };
  }
  return {
    code: 'OPERATION_FAILED',
    message: error instanceof Error ? error.message : '操作失败。',
    exitCode: 1,
  };
}

export class OperationManager {
  private readonly operations = new Map<string, InternalOperation>();
  private readonly completions = new Map<string, Promise<void>>();
  private readonly maxOperations: number;
  private readonly maxEventsPerOperation: number;
  private readonly store: OperationStore | undefined;
  private readonly sink: ObservabilitySink;

  constructor(
    options: {
      maxOperations?: number;
      maxEventsPerOperation?: number;
      store?: OperationStore;
      sink?: ObservabilitySink;
    } = {},
  ) {
    this.maxOperations = options.maxOperations ?? 200;
    this.maxEventsPerOperation = options.maxEventsPerOperation ?? 1000;
    this.store = options.store;
    this.sink = options.sink ?? defaultObservabilitySink;
  }

  start(type: string, agentId: string | undefined, task: OperationTask): OperationDto {
    const id = randomUUID();
    const traceId = randomUUID();
    const dto: OperationDto = {
      id,
      type,
      state: 'queued',
      progress: 0,
      traceId,
      ...(agentId ? { agentId } : {}),
    };
    const internal: InternalOperation = {
      dto,
      controller: new AbortController(),
      events: [],
      emitter: new EventEmitter(),
    };
    this.operations.set(id, internal);
    this.trim();
    const completion = Promise.resolve().then(() => this.execute(internal, task));
    this.completions.set(id, completion);
    void completion.finally(() => this.completions.delete(id));
    return clone(dto);
  }

  get(id: string): OperationDto {
    const operation = this.operations.get(id);
    if (!operation) throw new AgentCtlError('NOT_FOUND', `操作不存在：${id}`);
    return clone(operation.dto);
  }

  list(): OperationDto[] {
    return [...this.operations.values()].map((operation) => clone(operation.dto)).reverse();
  }

  events(id: string, afterSeq = 0): OperationEvent[] {
    const operation = this.operations.get(id);
    if (!operation) throw new AgentCtlError('NOT_FOUND', `操作不存在：${id}`);
    return operation.events.filter((event) => event.seq > afterSeq).map((event) => ({ ...event }));
  }

  subscribe(id: string, listener: (event: OperationEvent) => void): () => void {
    const operation = this.operations.get(id);
    if (!operation) throw new AgentCtlError('NOT_FOUND', `操作不存在：${id}`);
    operation.emitter.on('event', listener);
    return () => operation.emitter.off('event', listener);
  }

  async wait(id: string): Promise<void> {
    const completion = this.completions.get(id);
    if (completion) await completion;
  }

  cancelAll(): void {
    for (const operation of this.operations.values()) {
      if (operation.dto.state === 'queued' || operation.dto.state === 'running') {
        operation.controller.abort();
      }
    }
  }

  // T03：按 id 取消单个操作（MCP 取消工具与 Todo 取消任务的基础）。仅能取消
  // 排队/运行中的操作；已结束（成功/失败/已取消）的操作不可重复取消。
  cancel(id: string): OperationDto {
    const operation = this.operations.get(id);
    if (!operation) throw new AgentCtlError('NOT_FOUND', `操作不存在：${id}`);
    if (operation.dto.state !== 'queued' && operation.dto.state !== 'running') {
      throw new AgentCtlError('CONFLICT', `操作已结束，无法取消：${id}`);
    }
    operation.controller.abort();
    return clone(operation.dto);
  }

  private async execute(operation: InternalOperation, task: OperationTask): Promise<void> {
    const span = this.sink.spanStart('operation', {
      operation_id: operation.dto.id,
      trace_id: operation.dto.traceId ?? '',
      kind: operation.dto.type,
      ...(operation.dto.agentId ? { agent_id: operation.dto.agentId } : {}),
    });
    // OP4-C：task 返回的 CLI 结构化用量，在 finally 经 span.end 上报为 gen_ai.* 属性。
    let usage: RunUsage | undefined;
    try {
      if (operation.controller.signal.aborted) {
        await this.finishCancelled(operation);
        return;
      }
      operation.dto.state = 'running';
      operation.dto.startedAt = new Date().toISOString();
      this.emit(operation, { kind: 'state', message: 'running' });
      try {
        const result = await task({
          signal: operation.controller.signal,
          emit: (event) => {
            if (event.kind === 'progress' && event.progress !== undefined) {
              operation.dto.progress = Math.max(0, Math.min(100, event.progress));
            }
            // 聚合摘要（计划派发等）随事件同步到 DTO，供列表/进度行展示。
            if (typeof event.summary === 'string') operation.dto.summary = event.summary;
            this.emit(operation, event);
          },
          operationId: operation.dto.id,
          traceId: operation.dto.traceId ?? '',
        });
        usage = result?.usage;
        if (operation.controller.signal.aborted) {
          await this.finishCancelled(operation);
          return;
        }
        const exitCode = result?.exitCode ?? 0;
        operation.dto.exitCode = exitCode;
        operation.dto.finishedAt = new Date().toISOString();
        if (exitCode === 0) {
          operation.dto.state = 'succeeded';
          operation.dto.progress = 100;
        } else {
          operation.dto.state = 'failed';
          operation.dto.error = {
            code: 'OPERATION_FAILED',
            message: `操作退出码：${exitCode}`,
            exitCode,
          };
        }
        this.emit(operation, { kind: 'state', message: operation.dto.state });
      } catch (error) {
        if (operation.controller.signal.aborted) {
          await this.finishCancelled(operation);
          return;
        }
        operation.dto.state = 'failed';
        operation.dto.error = toApiError(error);
        operation.dto.exitCode = operation.dto.error.exitCode;
        operation.dto.finishedAt = new Date().toISOString();
        this.emit(operation, { kind: 'state', message: 'failed' });
      }
      await this.persist(operation);
    } finally {
      span.end(usage !== undefined ? toGenAiAttrs(usage) : {});
    }
  }

  private async finishCancelled(operation: InternalOperation): Promise<void> {
    operation.dto.state = 'cancelled';
    operation.dto.exitCode = 130;
    operation.dto.finishedAt = new Date().toISOString();
    this.emit(operation, { kind: 'state', message: 'cancelled' });
    await this.persist(operation);
  }

  // OP4-A：终态 best-effort 持久化摘要到 operations.jsonl（无 store 时跳过，行为不变）。
  private async persist(operation: InternalOperation): Promise<void> {
    if (!this.store) return;
    const dto = operation.dto;
    if (!dto.startedAt || !dto.finishedAt) return;
    try {
      await this.store.record({
        operation_id: dto.id,
        ...(dto.agentId ? { agent_id: dto.agentId } : {}),
        kind: dto.type,
        started_at: dto.startedAt,
        finished_at: dto.finishedAt,
        exit_code: dto.exitCode ?? 0,
        ...(dto.error ? { error_message: dto.error.message } : {}),
        ...(dto.traceId ? { trace_id: dto.traceId } : {}),
      });
    } catch {
      // 持久化是 best-effort，不影响操作结果。
    }
  }

  private emit(
    operation: InternalOperation,
    event: Omit<OperationEvent, 'seq' | 'timestamp'>,
  ): void {
    const complete: OperationEvent = {
      ...event,
      seq: (operation.events.at(-1)?.seq ?? 0) + 1,
      timestamp: new Date().toISOString(),
    };
    operation.events.push(complete);
    while (operation.events.length > this.maxEventsPerOperation) operation.events.shift();
    operation.emitter.emit('event', complete);
  }

  private trim(): void {
    while (this.operations.size > this.maxOperations) {
      const oldest = this.operations.keys().next().value as string | undefined;
      if (!oldest) return;
      this.operations.delete(oldest);
      this.completions.delete(oldest);
    }
  }
}
