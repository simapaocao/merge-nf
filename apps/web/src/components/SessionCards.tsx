import { SESSION_GROUP_PREVIEW, type ActivityCoverage, type GroupSessionRow, type Instance, type SessionGroup, type SessionGroups, type SessionRow } from '@nf-hub/protocol';
import { absoluteTime, countLabel, projectLabel, relativeTime, sessionKey } from '../lib/format';
import { intentHash } from '../lib/navigation';
import { SessionPill } from './Common';
import './SessionCards.css';

export type SessionViewMode = 'cards' | 'list';
/** Only fixed labels may become a card reason. Free text, tool output and host errors never do. */
export type SessionReason = 'awaiting_reply' | 'awaiting_approval' | 'error' | 'unread_result' | 'background_task';
/** Only the new group projection carries structured activity; the full list keeps its existing row contract. */
export type SessionCardRow = GroupSessionRow;
export type SessionGroupView = SessionGroups[SessionGroup];

export const sessionGroupOrder: readonly SessionGroup[] = ['attention', 'running', 'recent'];
export const sessionGroupMeta: Record<SessionGroup, { title: string; description: string }> = {
  attention: { title: '需要处理', description: '需处理会话优先归组' },
  running: { title: '正在运行', description: '含后台任务与系统等待' },
  recent: { title: '最近', description: '按最近活动排序' },
};
export function sessionGroupLabel(group: SessionGroup, focus = false): { title: string; description: string } {
  return focus && group === 'recent' ? { title: '待确认', description: '等待、未知状态或旧快照' } : sessionGroupMeta[group];
}
export function focusModePatch(focus: boolean): { focus: boolean; group: ''; page: number } {
  return { focus, group: '', page: 1 };
}
export function SessionFocusToggle({ focus, onChange }: { focus: boolean; onChange: (focus: boolean) => void }) {
  return <div className="session-view-toggle" role="group" aria-label="会话范围"><button className={focus ? 'active' : ''} aria-pressed={focus} onClick={() => onChange(true)}>需关注</button><button className={!focus ? 'active' : ''} aria-pressed={!focus} onClick={() => onChange(false)}>全部</button></div>;
}
export function SessionFocusEmpty({ onShowAll }: { onShowAll: () => void }) {
  return <div className="session-focus-empty"><span role="status">暂无需要关注的会话</span><button className="text-button" onClick={onShowAll}>全部会话</button></div>;
}
/** Scope note for the attention section: the hub never gains approval/reply rights by showing this. */
export const attentionScopeNote = '权限以原站账号为准';
const reasonLabels: Record<SessionReason, string> = {
  awaiting_reply: '等待回复', awaiting_approval: '等待授权或确认', error: '会话报错', unread_result: '有未读结果', background_task: '后台运行',
};
export function reasonLabel(reason: string | null | undefined): string | null {
  return reason && Object.hasOwn(reasonLabels, reason) ? reasonLabels[reason as SessionReason] : null;
}
/** Null means no current activity projection, not a set of false flags. Labels are fixed, never host text. */
export function activityReasonLabels(row: Pick<GroupSessionRow, 'activity' | 'freshness' | 'status'>, groupKey?: SessionGroup): string[] | null {
  if (row.freshness !== 'fresh' || row.activity == null) return null;
  const activity = row.activity, labels: string[] = [];
  if (groupKey === 'running' && row.status === 'waiting' && !activity.reply && !activity.approval && !activity.error && !activity.unread) labels.push('等待系统');
  if (activity.reply) labels.push(reasonLabels.awaiting_reply);
  if (activity.approval) labels.push(reasonLabels.awaiting_approval);
  if (activity.error) labels.push(reasonLabels.error);
  if (activity.unread) labels.push(reasonLabels.unread_result);
  if (activity.backgroundWorkCount > 0) labels.push(`${reasonLabels.background_task} · ${countLabel(activity.backgroundWorkCount)} 个任务`);
  return labels;
}
export function groupCoverageText(groupKey: SessionGroup, coverage: ActivityCoverage): string {
  if (coverage === 'partial') return '部分实例未提供';
  if (coverage === 'complete') return '活动信息已提供';
  return groupKey === 'attention' ? '未提供或已过期' : '仅含基础运行状态';
}
/** Cards and the full table share `(instanceId, id)` as identity; the same pair is rendered once. */
export function dedupeSessionRows<T extends SessionRow>(rows: readonly T[]): T[] {
  const seen = new Set<string>(), unique: T[] = [];
  for (const row of rows) {
    const key = sessionKey(row);
    if (seen.has(key)) continue;
    seen.add(key); unique.push(row);
  }
  return unique;
}
/** An unsupported capability or an unknown total is not a zero count. */
export function groupCountText(group: Pick<SessionGroupView, 'supported' | 'total' | 'coverage'>): string {
  if (!group.supported || group.total === null) return '—';
  return group.coverage === 'partial' ? `已知 ${countLabel(group.total)}` : countLabel(group.total);
}
export function sessionListCountText(total: number | undefined, group: SessionGroup | '', section?: SessionGroupView, focus = false): string {
  if (!group) return `共 ${countLabel(total)} 条`;
  if (total === undefined || !section || !section.supported || section.total === null) return '分区数量 —';
  return `${section.coverage === 'partial' ? '已知' : '共'} ${countLabel(total)} 条（${sessionGroupLabel(group, focus).title}）`;
}
export function groupEmptyText(groupKey: SessionGroup, group: Pick<SessionGroupView, 'supported' | 'total' | 'coverage'>): string {
  if (!group.supported) return '未提供';
  if (group.total === null) return '暂不可用';
  if (group.coverage === 'partial' && group.total === 0) return '暂无已知会话';
  if (group.total === 0) return groupKey === 'attention' ? '暂无待处理' : '暂无会话';
  return '暂无预览';
}
/** 查看更多 always lands in the existing paginated table, scoped to one group. */
export function resolveSessionView(mode: SessionViewMode, group: SessionGroup | ''): SessionViewMode {
  return mode === 'cards' && !group ? 'cards' : 'list';
}
export function viewAllPatch(group: SessionGroup): { group: SessionGroup; page: number } { return { group, page: 1 }; }
export function clearGroupPatch(): { group: ''; page: number } { return { group: '', page: 1 }; }
/**
 * A regular filter change resets paging and keeps the same filter object for the card preview and the full list,
 * so both views always describe the same set. The group drill-down is only changed by 查看更多 / 清除分区筛选.
 */
export function applyFilterPatch<T extends { page: number }>(filters: T, patch: Partial<T>): T {
  return { ...filters, ...patch, page: 1 } as T;
}
const viewModeKey = 'nf.sessions.view-mode';
export function readSessionViewMode(): SessionViewMode {
  try { return window.sessionStorage.getItem(viewModeKey) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
}
/** Only the display preference is stored: no titles, no filter text, no session content. */
export function saveSessionViewMode(mode: SessionViewMode): void {
  try { window.sessionStorage.setItem(viewModeKey, mode); } catch { /* storage may be unavailable; the view still works */ }
}

export function cardTitle(row: Pick<SessionRow, 'title'>): string { return row.title.trim() || '未命名会话'; }
/** Only the validated authority is displayed; never expose an instance URL path, query or credentials. */
export function instanceDeviceLabel(instance: Pick<Instance, 'alias' | 'browserBaseUrl'> | undefined, fallback: string): string {
  if (!instance) return fallback;
  let authority = '';
  try { authority = new URL(instance.browserBaseUrl).host; } catch { /* Keep a readable alias if the instance is unavailable. */ }
  return authority && authority !== instance.alias ? `${instance.alias} · ${authority}` : instance.alias;
}

/**
 * `usePrivateQuery` can report success with `data: undefined` when the read view is not verified for the current
 * epoch. That is not an empty result set: it must never become a 0 count or an "没有会话" message.
 */
export type ReadState = 'error' | 'pending' | 'unavailable' | 'ready';
export function readState(data: unknown, isError: boolean, isPending: boolean): ReadState {
  if (data !== undefined) return 'ready';
  if (isError) return 'error';
  return isPending ? 'pending' : 'unavailable';
}
export type SessionGroupsState =
  | { kind: 'error' }
  | { kind: 'unavailable'; pending: boolean }
  | { kind: 'ready'; groups: SessionGroups };
export function sessionGroupsState(query: { data: SessionGroups | undefined; isError: boolean; isPending: boolean }): SessionGroupsState {
  const state = readState(query.data, query.isError, query.isPending), data = query.data;
  // total 为 0 时仍渲染三个分区：真实空集合要逐区显示 0，而不支持的分区仍是 —。
  if (state === 'ready' && data) return { kind: 'ready', groups: data };
  if (state === 'error') return { kind: 'error' };
  return { kind: 'unavailable', pending: state === 'pending' };
}
export function unavailableDetail(pending: boolean): string {
  return pending ? '正在读取会话…' : '数据暂不可用';
}
/** The same three-way distinction applies to the paged list, so an unverified view never reads as "共 0 条". */
export function listUnavailableDetail(pending: boolean): string {
  return pending ? '正在读取会话…' : '数据暂不可用';
}

export function SessionKindBadge({ kind }: { kind: SessionRow['kind'] }) {
  const known = kind === 'primary' || kind === 'subagent';
  return <span className={`session-kind-badge ${known ? kind : 'unknown'}`} title={known ? undefined : '需连接器提供'}>{kind === 'primary' ? '主会话' : kind === 'subagent' ? '子代理' : '类型未提供'}</span>;
}

export function SessionParentLabel({ row }: { row: Pick<SessionRow, 'kind' | 'parentKnown' | 'parentId' | 'parentTitle'> }) {
  if (row.kind !== 'subagent') return null;
  if (row.parentKnown === true && typeof row.parentId === 'string' && row.parentId.length > 0) {
    const title = row.parentTitle?.trim() || '未命名会话';
    return <span className="session-parent-label" title={title}>父会话：{title}</span>;
  }
  return <span className="session-parent-label">{row.parentKnown === true && row.parentId === null ? '无父会话' : '父会话未提供'}</span>;
}

export function SessionCard({ row, instance, onOpen, groupKey }: { row: SessionCardRow; instance?: Instance; onOpen: (row: SessionRow) => void; groupKey?: SessionGroup }) {
  const old = row.freshness !== 'fresh', title = cardTitle(row), activityLabels = activityReasonLabels(row, groupKey);
  const device = instanceDeviceLabel(instance, row.instanceId);
  return <li className={`session-card${old ? ' snapshot-card' : ''}`}>
    <a className="session-card-link" href={intentHash({ view: 'workbench', instanceId: row.instanceId, sessionId: row.id })} title={attentionScopeNote}
      onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(row); }}>
      <span className="session-card-head"><span className="instance-inline"><span className="instance-color" style={{ backgroundColor: instance?.color ?? '#71858a' }} /><span className="session-card-device">{device}</span></span><SessionKindBadge kind={row.kind} />{old && <span className="old-label">旧快照</span>}</span>
      <span className="session-card-title" title={title}>{title}</span>
      <SessionParentLabel row={row} />
      <span className="session-card-meta"><span className="project-cell" title={row.projectId ?? undefined}>{projectLabel(row)}</span><SessionPill status={row.status} old={old} /></span>
      {activityLabels && activityLabels.length > 0 && <span className="session-card-reasons" aria-label="会话活动">{activityLabels.map(label => <span key={label} className="session-card-reason">{label}</span>)}</span>}
      <span className="session-card-foot"><span title={absoluteTime(row.lastMessageAt ?? row.updatedAt)}>{relativeTime(row.lastMessageAt ?? row.updatedAt)}</span><span className="session-card-sync" title={absoluteTime(row.lastSuccessAt)}>同步 {relativeTime(row.lastSuccessAt)}</span></span>
    </a>
  </li>;
}

export function SessionGroupSection({ groupKey, group, instances, onOpen, onViewAll, focus = false }: { groupKey: SessionGroup; group: SessionGroupView; instances: readonly Instance[]; onOpen: (row: SessionRow) => void; onViewAll: (group: SessionGroup) => void; focus?: boolean }) {
  const headingId = `session-group-${groupKey}`, rows = group.supported ? dedupeSessionRows(group.items).slice(0, SESSION_GROUP_PREVIEW) : [];
  const byId = new Map(instances.map(item => [item.id, item]));
  const more = group.supported && group.total !== null && group.total > rows.length;
  const meta = sessionGroupLabel(groupKey, focus);
  return <section className={`session-group ${groupKey}`} aria-labelledby={headingId}>
    <div className="session-group-heading"><div><h3 id={headingId} title={meta.description}>{meta.title}<span className="count-badge" title={!group.supported || group.total === null ? '未提供或已过期' : groupCoverageText(groupKey, group.coverage)} data-coverage={group.coverage} aria-label={`${meta.title}${group.coverage === 'partial' ? '已知数量' : '数量'}`}>{groupCountText(group)}</span></h3></div>
      {more && <button className="text-button" onClick={() => onViewAll(groupKey)}>{groupKey === 'recent' ? '查看全部会话' : '查看更多'}</button>}</div>
    {rows.length === 0 ? <p className="session-group-note">{groupEmptyText(groupKey, group)}</p>
      : <ul className="session-card-grid" role="list">{rows.map(row => <SessionCard key={sessionKey(row)} row={row} instance={byId.get(row.instanceId)} onOpen={onOpen} groupKey={groupKey} />)}</ul>}
  </section>;
}

export function SessionGroupSections({ groups, instances, onOpen, onViewAll, focus = false }: { groups: SessionGroups; instances: readonly Instance[]; onOpen: (row: SessionRow) => void; onViewAll: (group: SessionGroup) => void; focus?: boolean }) {
  return <div className="session-groups">{sessionGroupOrder.map(key => <SessionGroupSection key={key} groupKey={key} group={groups[key]} instances={instances} onOpen={onOpen} onViewAll={onViewAll} focus={focus} />)}</div>;
}
