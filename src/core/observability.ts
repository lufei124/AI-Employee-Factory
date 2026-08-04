// OP4-B：可观测性抽象 seam。填补 cross-check-report §3.2 O-6「日志/可观测无抽象」。
//
// Stage B 只落抽象 + no-op 默认实现：OperationManager 在操作生命周期调
// spanStart/spanEnd，默认 NoopObservabilitySink 零行为变化。
//
// Stage C 门控（诚实）：`gen_ai.*` span 的 token/成本指标（gen_ai.usage.input_tokens
// 等）只在 Claude/Codex CLI 提供结构化用量输出并被 Factory 解析时才可达（未决问题
// §4.2 第 6 项）。未达门前 ObservabilitySink 只发进程执行级 span，不发 GenAI span--
// 不虚假承诺「高性价比」掩盖「核心指标不可达」（A2 收敛）。

export interface SpanAttrs {
  operation_id: string;
  trace_id: string;
  kind: string;
  agent_id?: string;
  // Stage C（gated）：gen_ai.request.model / gen_ai.usage.* 待 CLI 结构化输出可达后扩。
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
