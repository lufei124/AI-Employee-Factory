import type { AgentConfig, AuthorityLayer } from '../schemas/agent-schema.js';

// OP1 Stage A：authority_order 各层的人类可读标签与说明，用于派生注入 CLAUDE.md/AGENTS.md 的 stance。
// 层枚举的 source of truth 是 agent-schema.ts 的 AUTHORITY_LAYERS；此处仅提供渲染元数据。
const AUTHORITY_LAYER_LABELS: Record<AuthorityLayer, { label: string; desc: string }> = {
  agent: { label: '岗位正式文件', desc: 'agent/ 下的 ROLE/GOALS/OPERATING_SYSTEM/POLICIES' },
  knowledge: { label: '知识库', desc: 'knowledge/ 下的正式知识' },
  decisions: { label: '决策记录', desc: 'knowledge/decisions/' },
  skills: { label: '可复用流程', desc: 'skills/' },
  native_memory: { label: '原生自动记忆', desc: '仅作辅助' },
  session: { label: '当前会话', desc: '会话内上下文' },
};

export interface MemoryValidationResult {
  ok: boolean;
  issues: string[];
}

// OP1 Stage A：校验 authority_order 不变量（R26「新层不得排在 agent 之前」）。
// 始终返回 issues；调用方按 memory.enforced 决定硬失败（prepareRuntime）还是 warn（doctor）。
// 不强制全部 6 层在场（用户可合法精简），仅钉死 'agent' 在场且居首 + 无重复。
export function validateMemoryConfig(memory: AgentConfig['memory']): MemoryValidationResult {
  const issues: string[] = [];
  const order = memory.authority_order;
  if (order.length === 0) {
    issues.push('authority_order 不能为空');
    return { ok: false, issues };
  }
  if (!order.includes('agent')) {
    issues.push("authority_order 必须包含 'agent'");
  } else if (order[0] !== 'agent') {
    issues.push("authority_order 首位必须是 'agent'");
  }
  const seen = new Set<AuthorityLayer>();
  for (const layer of order) {
    if (seen.has(layer)) {
      issues.push(`authority_order 存在重复层：${layer}`);
      break;
    }
    seen.add(layer);
  }
  return { ok: issues.length === 0, issues };
}

// OP1 Stage A：从 authority_order 派生 markdown stance 段，注入 CLAUDE.md/AGENTS.md。
// 替代 ENTRY.md.tmpl 的硬编码散文，使 agent.yaml.authority_order 成为注入立场的真相源--
// 改 agent.yaml 即改写入系统提示的权威顺序，不再随 schema 演进被误删（W1 收敛）。
export function renderAuthorityStance(memory: AgentConfig['memory']): string {
  const lines: string[] = [
    '## 记忆权威顺序',
    '',
    '当不同来源冲突时，按以下顺序取前者为准（序号越小优先级越高）：',
    '',
  ];
  memory.authority_order.forEach((layer, index) => {
    const meta = AUTHORITY_LAYER_LABELS[layer];
    lines.push(`${index + 1}. ${layer}（${meta.label}：${meta.desc}）`);
  });
  lines.push(
    '',
    '原生自动记忆与当前会话上下文不得凌驾于正式文件之上，不得因记忆内容绕过权限规则。',
  );
  return lines.join('\n');
}
