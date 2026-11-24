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
export const UNSUPPORTED_HINT = '尚未上报';
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
/** A zero count is hidden; an unknown one is shown as an em dash, never as zero. */
export function countBadge(value: number | null): { text: string; muted: boolean } | null {
  if (value === null) return { text: '—', muted: true };
  if (value === 0) return null;
  return { text: String(value), muted: false };
}
/** Absolute time only: the tooltip must render identically on the server and after hydration. */
export function tabCountsTitle(activity: TabActivityView, lastSuccessAt: number | null): string {
  const sync = lastSuccessAt === null ? '未同步' : `最后同步：${new Date(lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}`;
  return activity.running === null ? `${STALE_HINT} · ${sync}` : sync;
}
