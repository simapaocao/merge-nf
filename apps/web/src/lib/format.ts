import type { Instance, PublishScope, SessionRow, SessionStatus } from '@nf-hub/protocol';

export const statusLabels: Record<SessionStatus, string> = { working: '运行中', waiting: '等待中', idle: '空闲', archived: '已归档', unknown: '未知' };
export const embedLabels = { unverified: '待验证', verified: '已人工验证', blocked: '嵌入受阻' } as const;
export function countLabel(value: number | null | undefined) { return value == null ? '—' : value.toLocaleString('zh-CN'); }
export function absoluteTime(value: number | null | undefined): string {
  return value == null ? '尚无记录' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}
export function relativeTime(value: number | null | undefined, now = Date.now()): string {
  if (value == null) return '—';
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}
export function connectionLabel(instance: Pick<Instance, 'connection' | 'freshness' | 'lastError'>): string {
  if (instance.connection === 'unpaired') return '未连接';
  if (instance.connection === 'revoked') return '已撤销';
  if (instance.connection === 'lost') return '上报失联';
  if (instance.freshness === 'never') return '等待首次同步';
  if (instance.lastError) return '同步失败';
  return instance.freshness === 'fresh' ? '数据有效' : '数据过期';
}
export function scopeLabel(scope: PublishScope): string {
  if (scope.mode === 'none') return '未发布（范围为空）';
  const archived = scope.includeArchived ? '，含归档' : '，不含归档';
  if (scope.mode === 'all') return `全部已选范围${archived}`;
  if (scope.mode === 'sessions') return `${scope.sessionIds.length} 个指定会话${archived}`;
  return `${scope.projectIds.length} 个项目${scope.includeStandalone ? '及独立会话' : ''}${archived}`;
}
export function sessionKey(row: Pick<SessionRow, 'instanceId' | 'id'>): string { return JSON.stringify([row.instanceId, row.id]); }
export function projectLabel(row: Pick<SessionRow, 'projectId' | 'projectName'>): string {
  return row.projectId === null ? '独立会话' : (row.projectName || row.projectId);
}
export function sortedInstances(items: readonly Instance[]): Instance[] {
  return [...items].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.alias.localeCompare(b.alias, 'zh-CN') || a.id.localeCompare(b.id));
}
export function emptySessionMessage(hasInstances: boolean, filtered: boolean): { title: string; detail: string } {
  if (!hasInstances) return { title: '先接入一台 NF', detail: '添加实例并启用摘要插件后，这里会展示你明确授权发布的会话。' };
  if (filtered) return { title: '没有匹配的会话', detail: '试试调整搜索条件、实例或项目筛选。' };
  return { title: '暂时没有已同步会话', detail: '未首次同步与成功同步的空列表不同；请在连接管理中检查范围和同步状态。' };
}
