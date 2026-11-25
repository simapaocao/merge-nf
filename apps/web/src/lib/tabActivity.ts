import type { Instance } from '@nf-hub/protocol';

/** View model for the counts a tab may show. Missing or stale data stays unknown instead of becoming 0. */
export type TabActivityView = {
  /**
   * Sessions running in this instance: working sessions plus sessions with known background
   * work, each session counted once. Null when the device has no fresh snapshot.
   */
  running: number | null;
  attention: { supported: boolean; count: number | null };
  background: { supported: boolean; count: number | null };
};
export const unknownActivity: TabActivityView = { running: null, attention: { supported: false, count: null }, background: { supported: false, count: null } };
export const STALE_HINT = '暂无新鲜数据';
export const SCOPE_HINT = '处理权限以原站账号为准';
export const COUNT_SCOPE_HINT = '仅同步范围，未归档会话';

/** The server supplies the deduplicated running count; the view never sums separate counts. */
export type ActivityFacts = Pick<import('@nf-hub/protocol').InstanceActivityItem, 'runningCount' | 'attention' | 'background'>;
const bounded = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null);
/**
 * Stale, lost and revoked devices keep their last record but never count as current activity.
 * Working and background counts stay separate; they are never summed into one number.
 */
export function toActivityView(facts: ActivityFacts | undefined, current: boolean): TabActivityView {
  if (!facts || !current) return unknownActivity;
  const attention = facts.attention.supported ? bounded(facts.attention.count) : null;
  const background = facts.background.supported ? bounded(facts.background.count) : null;
  return {
    running: bounded(facts.runningCount),
    attention: { supported: attention !== null, count: attention },
    background: { supported: background !== null, count: background },
  };
}
/** Known running counts include a genuine zero; unknown values have no numeric badge. */
export function countBadge(value: number | null): { text: string; muted: boolean } | null {
  if (value === null) return null;
  return { text: String(value), muted: false };
}
/** Use the reported instance state when a current running count is unavailable. */
export function tabUnavailableStatus(instance: Pick<Instance, 'connection' | 'freshness' | 'lastError'>): string {
  if (instance.connection === 'unpaired') return '未配对';
  if (instance.connection === 'revoked') return '已撤销';
  if (instance.connection === 'lost') return '离线';
  if (instance.freshness === 'stale') return '数据过期';
  if (instance.lastError) return '同步失败';
  if (instance.freshness === 'never') return '未同步';
  return '暂无数据';
}
/** Absolute time only: the tooltip must render identically on the server and after hydration. */
export function tabCountsTitle(activity: TabActivityView, lastSuccessAt: number | null): string {
  const sync = lastSuccessAt === null ? '未同步' : `最后同步：${new Date(lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}`;
  return activity.running === null ? `${STALE_HINT} · ${sync}` : sync;
}
