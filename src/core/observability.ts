// OP4-B：可观测性抽象 seam。填补 cross-check-report §3.2 O-6「日志/可观测无抽象」。
//
// Stage B 只落抽象 + no-op 默认实现：OperationManager 在操作生命周期调
// spanStart/spanEnd，默认 NoopObservabilitySink 零行为变化。
//
// Stage C（OP4-C，TASK-020 阶段 3）：`gen_ai.*` span 属性在 CLI 结构化输出可达后落地。
// 门控结论（.scratch/cli-structured-output.md）：Claude 的 model/usage/cost 全部可达；
// Codex 仅 usage 可达（事件 schema 无 model/cost），故 gen_ai.request.model 仅 Claude 上报。

export interface SpanAttrs {
  operation_id: string;
  trace_id: string;
  kind: string;
  agent_id?: string;
  /** OP4-C（gated on CLI 结构化输出）：模型名。仅 Claude 可达；Codex 事件 schema 无模型字段。 */
  'gen_ai.request.model'?: string;
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  /** OP4-C：成本 USD。仅 Claude 可达。 */
  'gen_ai.usage.cost_usd'?: number;
}

/** 把 CLI 解析出的 RunUsage 映射为 gen_ai.* span 属性（无用量则返回空对象）。 */
export function toGenAiAttrs(usage: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}): Partial<SpanAttrs> {
  return {
    ...(usage.model !== undefined ? { 'gen_ai.request.model': usage.model } : {}),
    ...(usage.inputTokens !== undefined ? { 'gen_ai.usage.input_tokens': usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined
      ? { 'gen_ai.usage.output_tokens': usage.outputTokens }
      : {}),
    ...(usage.totalCostUsd !== undefined ? { 'gen_ai.usage.cost_usd': usage.totalCostUsd } : {}),
  };
}

export interface Span {
  /** 结束 span；attrs 可补终态属性（如 exit_code、error）。no-op 实现为空。 */
  end(attrs?: Partial<SpanAttrs>): void;
}

export interface ObservabilitySink {
  spanStart(name: string, attrs: SpanAttrs): Span;
}

/** 默认 no-op：spanStart 返回 end 为空的 Span，零行为变化。 */
export class NoopObservabilitySink implements ObservabilitySink {
  spanStart(): Span {
    return {
      end() {
        /* no-op */
      },
    };
  }
}

export const defaultObservabilitySink: ObservabilitySink = new NoopObservabilitySink();
