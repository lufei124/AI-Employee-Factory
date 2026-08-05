export type BadgeVariant =
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info' | 'muted';

/** 员工生命周期状态 → Badge 变体 + 中文标签。 */
export function agentStatus(status: string): { variant: BadgeVariant; label: string } {
  switch (status) {
    case 'running':
      return { variant: 'success', label: '运行中' };
    case 'stopped':
      return { variant: 'muted', label: '已停止' };
    case 'error':
      return { variant: 'destructive', label: '异常' };
    case 'archived':
      return { variant: 'warning', label: '已归档' };
    default:
      return { variant: 'secondary', label: status };
  }
}

/** Operation 状态 → Badge 变体 + 中文标签。 */
export function operationState(state: string): { variant: BadgeVariant; label: string } {
  switch (state) {
    case 'queued':
      return { variant: 'warning', label: '排队中' };
    case 'running':
      return { variant: 'info', label: '运行中' };
    case 'succeeded':
      return { variant: 'success', label: '成功' };
    case 'failed':
      return { variant: 'destructive', label: '失败' };
    case 'cancelled':
      return { variant: 'muted', label: '已取消' };
    default:
      return { variant: 'secondary', label: state };
  }
}

/** Skill 作用域 → Badge 变体 + 中文标签。 */
export function skillScope(scope: string): { variant: BadgeVariant; label: string } {
  if (scope === 'project') return { variant: 'info', label: '项目级' };
  if (scope === 'user') return { variant: 'success', label: '用户级' };
  return { variant: 'secondary', label: scope };
}

/** Bridge 授权状态 → Badge 变体 + 中文标签。 */
export function bridgeStatus(authorization: string): { variant: BadgeVariant; label: string } {
  switch (authorization) {
    case 'ready':
      return { variant: 'success', label: '已授权' };
    case 'pending':
      return { variant: 'warning', label: '待授权' };
    case 'error':
      return { variant: 'destructive', label: '异常' };
    default:
      return { variant: 'muted', label: authorization };
  }
}

/** 仓库缓存状态 → Badge 变体 + 中文标签。 */
export function repoCached(cached: boolean): { variant: BadgeVariant; label: string } {
  return cached ? { variant: 'success', label: '已缓存' } : { variant: 'warning', label: '未缓存' };
}

/** 回收站条目状态 → 中文标签。 */
export function trashState(state: string, remainingDays: number): string {
  if (state === 'ready') return `剩余 ${remainingDays} 天`;
  if (state === 'moving') return '移入中';
  if (state === 'restoring') return '恢复中';
  if (state === 'purging') return '清除中';
  if (state === 'failed') return '失败';
  return state;
}
