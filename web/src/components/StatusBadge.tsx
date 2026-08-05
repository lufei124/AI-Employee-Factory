import { Badge } from './ui/badge.js';
import {
  agentStatus,
  bridgeStatus,
  operationState,
  repoCached,
  skillScope,
  type BadgeVariant,
} from '../lib/status.js';

/**
 * 状态徽章：把各类状态字符串映射到统一的 Badge 变体 + 中文标签。
 */
export function StatusBadge({
  status,
  label,
  variant,
}: {
  status?: string;
  label?: string;
  variant?: BadgeVariant;
}) {
  return <Badge variant={variant}>{label ?? status}</Badge>;
}

export function AgentStatusBadge({ status }: { status: string }) {
  const s = agentStatus(status);
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function OperationStatusBadge({ state }: { state: string }) {
  const s = operationState(state);
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function SkillScopeBadge({ scope }: { scope: string }) {
  const s = skillScope(scope);
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function BridgeStatusBadge({ authorization }: { authorization: string }) {
  const s = bridgeStatus(authorization);
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function RepoCachedBadge({ cached }: { cached: boolean }) {
  const s = repoCached(cached);
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
