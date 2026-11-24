import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SESSION_GROUP_PREVIEW, sessionGroupsSchema, type ActivityCoverage, type GroupSessionRow, type Instance, type SessionGroups as SessionGroupsData } from '@nf-hub/protocol';
import { initialFilters, sessionGroupsPath, sessionsPath, type SessionFilters } from '../src/hooks/useData';
import {
  SessionCard, SessionGroupSection, SessionGroupSections, activityReasonLabels, applyFilterPatch, attentionScopeNote, clearGroupPatch, dedupeSessionRows, groupCountText, groupCoverageText, groupEmptyText,
  reasonLabel, resolveSessionView, sessionGroupOrder, sessionGroupMeta, sessionGroupsState, sessionListCountText, readState, listUnavailableDetail, unavailableDetail, viewAllPatch,
} from '../src/components/SessionCards';

const instanceIdA = '11111111-1111-4111-8111-111111111111';
const instanceIdB = '22222222-2222-4222-8222-222222222222';
const now = 1_760_000_000_000;

const baseRow = (id: string): GroupSessionRow => ({
  id, title: `会话 ${id}`, status: 'idle', projectId: null, lastMessageAt: now - 60_000, updatedAt: now - 60_000,
  instanceId: instanceIdA, freshness: 'fresh', lastSuccessAt: now - 30_000, activity: null,
});
const row = (patch: Partial<GroupSessionRow> & { id: string }): GroupSessionRow => ({ ...baseRow(patch.id), ...patch });
const activity = (patch: Partial<NonNullable<GroupSessionRow['activity']>> = {}): NonNullable<GroupSessionRow['activity']> => ({
  reply: false, approval: false, error: false, unread: false, backgroundWorkCount: 0, ...patch,
});
function section<T extends number | null = number>(items: GroupSessionRow[], total: T = items.length as T, supported = true, coverage: ActivityCoverage = supported ? 'complete' : 'none') {
  return { supported, total, items, coverage };
}
function groupsData(patch: Partial<SessionGroupsData> = {}): SessionGroupsData {
  return { total: 0, previewSize: 6, attention: section([]), running: section([]), recent: section([]), ...patch };
}
const instances: Instance[] = [
  { id: instanceIdA, alias: '10.8.0.12', color: '#396B78', browserBaseUrl: 'https://nf-a.example.com' },
  { id: instanceIdB, alias: '10.8.0.2', color: '#B4553F', browserBaseUrl: 'https://nf-b.example.com' },
] as unknown as Instance[];
const noop = () => {};
const visibleText = (html: string) => html.replace(/<[^>]*>/g, '');

describe('会话卡片分区', () => {
  test('固定三分区顺序，标题使用产品文案', () => {
    expect(sessionGroupOrder).toEqual(['attention', 'running', 'recent']);
    const html = renderToStaticMarkup(<SessionGroupSections groups={groupsData({ total: 1, recent: section([row({ id: 's1' })]) })} instances={instances} onOpen={noop} onViewAll={noop} />);
    const order = [
      html.indexOf('id="session-group-attention"'),
      html.indexOf('id="session-group-running"'),
      html.indexOf('id="session-group-recent"'),
    ] as const;
    expect(order.every(index => index > -1)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(html).toContain(sessionGroupMeta.attention.title);
  });

  test('每分区最多渲染服务端预览条数，剩余数量只显示为总数', () => {
    const rows = Array.from({ length: 6 }, (_, index) => row({ id: `s${index}` }));
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="running" group={section(rows, 240)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html.match(/session-card-link/g)?.length).toBe(6);
    expect(html).toContain('240');
    expect(html).toContain('查看更多');
  });

  test('总数等于预览数时不再显示查看更多', () => {
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="recent" group={section([row({ id: 's1' })], 1)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html).not.toContain('查看全部会话');
    expect(html).not.toContain('查看更多');
  });

  test('不支持的能力仅显示未提供和 —，不是 0 或无待处理', () => {
    const attention = section([], null, false);
    expect(groupCountText(attention)).toBe('—');
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="attention" group={attention} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(visibleText(html)).toContain('未提供');
    expect(html).toContain('title="未提供或已过期"');
    expect(html).toContain('—');
    expect(html).not.toContain('没有需要处理');
    expect(html).not.toContain('无待处理');
    expect(html).not.toContain('>0<');
  });

  test('需要处理分区标注权限以原站账号为准，且不渲染审批或正文', () => {
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="attention" group={section([row({ id: 's1' })], 1)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html).toContain(sessionGroupMeta.attention.title);
    expect(html).toContain('需要处理');
    expect(html).toContain(`title="${attentionScopeNote}"`);
    expect(visibleText(html)).not.toContain(attentionScopeNote);
    for (const forbidden of ['批准', '拒绝', '回复输入框', '<textarea', 'permission', 'approve']) expect(html).not.toContain(forbidden);
  });

  test('真实空 0 与未知 null 文案不同', () => {
    expect(groupCountText(section([], 0))).toBe('0');
    expect(groupCountText(section([], null))).toBe('—');
    const empty = groupEmptyText('attention', section([], 0));
    const unknown = groupEmptyText('attention', section([], null));
    expect(empty).toBe('暂无待处理');
    expect(unknown).toBe('暂不可用');
    expect(empty).not.toBe(unknown);
    expect(groupEmptyText('recent', section([], null, false))).toBe('未提供');
  });

  test('未知状态不伪装为空闲，等待中不写成需要回复', () => {
    const html = renderToStaticMarkup(<SessionCard row={row({ id: 's1', status: 'unknown' })} instance={instances[0]} onOpen={noop} />);
    expect(html).toContain('未知');
    expect(html).not.toContain('空闲');
    const waiting = renderToStaticMarkup(<SessionCard row={row({ id: 's2', status: 'waiting' })} instance={instances[0]} onOpen={noop} />);
    expect(waiting).toContain('等待中');
    expect(waiting).not.toContain('等待你的回复');
  });

  test('旧快照标注并降级配色，同时显示最后同步时间', () => {
    const html = renderToStaticMarkup(<SessionCard row={row({ id: 's1', status: 'working', freshness: 'stale' })} instance={instances[0]} onOpen={noop} />);
    expect(html).toContain('旧快照');
    expect(html).toContain('snapshot-card');
    expect(html).toContain('pill neutral');
    expect(html).not.toContain('pill teal');
    expect(html).toContain('同步');
  });

  test('卡片展示实例 IP、项目回退 ID 与两行标题上限', () => {
    const html = renderToStaticMarkup(<SessionCard row={row({ id: 's1', projectId: 'proj-7', title: '  长标题  ' })} instance={instances[1]} onOpen={noop} />);
    expect(html).toContain('10.8.0.2');
    expect(html).toContain('#B4553F');
    expect(html).toContain('proj-7');
    expect(html).toContain('session-card-title');
    expect(html).toContain('长标题');
    expect(html).not.toContain('  长标题  ');
  });

  test('没有项目时回退为独立会话', () => {
    const html = renderToStaticMarkup(<SessionCard row={row({ id: 's1' })} instance={instances[0]} onOpen={noop} />);
    expect(html).toContain('独立会话');
  });

  test('只允许预定义处理原因，未知字符串不渲染', () => {
    expect(reasonLabel('awaiting_reply')).toBe('等待回复');
    expect(reasonLabel('tool_body')).toBeNull();
    expect(reasonLabel(null)).toBeNull();
    const html = renderToStaticMarkup(<SessionCard row={row({ id: 's1', activity: activity({ unread: true }) })} instance={instances[0]} onOpen={noop} />);
    expect(html).toContain('有未读结果');
  });

  test('卡片不渲染工具参数、日志、正文、堆栈或本机路径', () => {
    const noisy = {
      ...row({ id: 's1' }), toolArgs: '{"path":"C:\\\\Users\\\\me\\\\secret"}', log: 'exec tail -f', body: 'private message body',
      stack: 'at /home/me/app.js:12', cwd: '/home/me/work', lastError: 'ECONNREFUSED internal',
    } as unknown as GroupSessionRow;
    const html = renderToStaticMarkup(<SessionCard row={noisy} instance={instances[0]} onOpen={noop} />);
    for (const leaked of ['toolArgs', 'C:\\\\Users', 'exec tail', 'private message body', '/home/me', 'ECONNREFUSED']) expect(html).not.toContain(leaked);
  });

  test('同一 (instanceId, id) 只渲染一次，不同实例同 id 各自保留', () => {
    const rows = [row({ id: 'same' }), row({ id: 'same' }), row({ id: 'same', instanceId: instanceIdB })];
    expect(dedupeSessionRows(rows)).toHaveLength(2);
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="recent" group={section(rows, 2)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html.match(/session-card-link/g)?.length).toBe(2);
  });

  test('卡片是可用键盘打开的链接，并指向对应实例会话', () => {
    const html = renderToStaticMarkup(<SessionCard row={row({ id: 'abc' })} instance={instances[0]} onOpen={noop} />);
    expect(html).toContain('href="#workbench?instance=');
    expect(html).toContain('session=abc');
    expect(html).toContain('<a ');
    expect(html).toContain('session-card-link');
  });

  test('分区标题有 aria 关联，列表语义为 list', () => {
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="running" group={section([row({ id: 's1' })], 1)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html).toContain('aria-labelledby="session-group-running"');
    expect(html).toContain('id="session-group-running"');
    expect(html).toContain('role="list"');
  });
});

describe('卡片与完整列表的衔接', () => {
  test('查看更多切到列表并带 group，页码重置为 1', () => {
    expect(viewAllPatch('attention')).toEqual({ group: 'attention', page: 1 });
    expect(clearGroupPatch()).toEqual({ group: '', page: 1 });
  });

  test('常规筛选变动只重置页码，不动分区筛选', () => {
    const filters: SessionFilters = { ...initialFilters, page: 4, group: 'running' };
    expect(applyFilterPatch(filters, { q: '部署' })).toEqual({ ...filters, q: '部署', page: 1 });
    expect(applyFilterPatch(filters, { status: 'working' }).page).toBe(1);
    expect(applyFilterPatch(filters, { status: 'working' }).group).toBe('running');
  });

  test('有 group 筛选时一定回到完整列表，卡片只在无 group 时出现', () => {
    expect(resolveSessionView('cards', '')).toBe('cards');
    expect(resolveSessionView('cards', 'running')).toBe('list');
    expect(resolveSessionView('list', '')).toBe('list');
    expect(resolveSessionView('list', 'recent')).toBe('list');
  });

  test('总数为 0 时三个分区都不显示卡片但仍保留分区标题', () => {
    const html = renderToStaticMarkup(<SessionGroupSections groups={groupsData({ total: 0 })} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html).not.toContain('session-card-link');
    expect(html).toContain('session-group-note');
  });

  test('共享 hook 路径：列表带 group 分页，卡片预览不带 page/group', () => {
    const base = { ...initialFilters, page: 3, pageSize: 25, group: 'attention' as const };
    const list = sessionsPath(base);
    expect(list).toContain('page=3');
    expect(list).toContain('pageSize=25');
    expect(list).toContain('group=attention');
    const preview = sessionGroupsPath(base);
    expect(preview).not.toContain('page=');
    expect(preview).not.toContain('group=');
    expect(preview).toContain(`previewSize=${SESSION_GROUP_PREVIEW}`);
  });
});

describe('结构化活动与覆盖范围', () => {
  test('第一批 JSON 解析后 coverage 默认 none、activity 默认 null', () => {
    const { activity: omittedActivity, ...legacyRow } = row({ id: 'legacy' });
    expect(omittedActivity).toBeNull();
    const parsed = sessionGroupsSchema.parse({ total: 1, previewSize: 6,
      attention: { supported: false, total: null, items: [] },
      running: { supported: true, total: 0, items: [] },
      recent: { supported: true, total: 1, items: [legacyRow] },
    });
    expect(parsed.attention.coverage).toBe('none');
    expect(parsed.recent.items[0]?.activity).toBeNull();
    expect(groupCountText(parsed.attention)).toBe('—');
    expect(groupCoverageText('running', parsed.running.coverage)).toBe('仅含基础运行状态');
  });

  test('部分覆盖的数量明确为已知数，不冒充完整数量', () => {
    const partial = section([row({ id: 'partial', activity: activity({ reply: true }) })], 7, true, 'partial');
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="attention" group={partial} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(groupCountText(partial)).toBe('已知 7');
    expect(html).toContain('已知 7');
    expect(html).toContain('title="部分实例未提供"');
    expect(visibleText(html)).not.toContain('部分实例未提供');
    expect(html).not.toContain('活动信息已提供');
    expect(sessionListCountText(7, 'attention', partial)).toBe('已知 7 条（需要处理）');
  });

  test('部分覆盖的已知零不宣称没有待处理；完整零仍是真实空', () => {
    const partial = section([], 0, true, 'partial');
    expect(groupCountText(partial)).toBe('已知 0');
    expect(groupEmptyText('attention', partial)).toBe('暂无已知会话');
    expect(groupEmptyText('attention', partial)).not.toContain('暂无待处理');
    const complete = section([], 0, true, 'complete');
    expect(groupCountText(complete)).toBe('0');
    expect(groupEmptyText('attention', complete)).toBe('暂无待处理');
    expect(groupCoverageText('attention', complete.coverage)).toBe('活动信息已提供');
  });

  test('未提供或覆盖情况未知时，分区列表数量不显示 0', () => {
    expect(sessionListCountText(0, 'attention', section([], null, false))).toBe('分区数量 —');
    expect(sessionListCountText(0, 'attention')).toBe('分区数量 —');
    expect(sessionListCountText(undefined, '')).toBe('共 — 条');
    expect(sessionListCountText(0, '')).toBe('共 0 条');
  });

  test('同一会话可显示多个安全原因，但分区计数只取服务端 total', () => {
    const item = row({ id: 'multi', activity: activity({ reply: true, approval: true, error: true, unread: true, backgroundWorkCount: 2 }) });
    expect(activityReasonLabels(item)).toEqual(['等待回复', '等待授权或确认', '会话报错', '有未读结果', '后台运行 · 2 个任务']);
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="attention" group={section([item], 1)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html.match(/session-card-link/g)?.length).toBe(1);
    expect(groupCountText(section([item], 1))).toBe('1');
    for (const label of ['等待回复', '等待授权或确认', '会话报错', '有未读结果', '后台运行']) expect(html).toContain(label);
    expect(html).not.toContain('个人待办数量');
  });

  test('activity null 与全 false 不混同，旧快照不显示当前活动原因', () => {
    const unknown = row({ id: 'unknown' });
    const known = row({ id: 'known', activity: activity() });
    expect(activityReasonLabels(unknown)).toBeNull();
    expect(activityReasonLabels(known)).toEqual([]);
    expect(renderToStaticMarkup(<SessionCard row={unknown} onOpen={noop} />)).not.toContain('活动信息未提供');
    expect(renderToStaticMarkup(<SessionCard row={known} onOpen={noop} />)).not.toContain('活动信息未提供');
    const old = row({ id: 'old', freshness: 'stale', activity: activity({ reply: true, backgroundWorkCount: 5 }) });
    expect(activityReasonLabels(old, 'running')).toBeNull();
    const html = renderToStaticMarkup(<SessionCard row={old} onOpen={noop} groupKey="running" />);
    expect(html).toContain('旧快照');
    expect(html).not.toContain('等待回复');
    expect(html).not.toContain('后台运行');
  });

  test('仅运行分区内有效增强且无待办的 waiting 标注等待系统', () => {
    const automatic = row({ id: 'auto', status: 'waiting', activity: activity() });
    expect(activityReasonLabels(automatic, 'running')).toEqual(['等待系统']);
    expect(activityReasonLabels(automatic, 'recent')).toEqual([]);
    const unsupported = row({ id: 'legacy-waiting', status: 'waiting' });
    expect(activityReasonLabels(unsupported, 'running')).toBeNull();
    const html = renderToStaticMarkup(<SessionCard row={unsupported} onOpen={noop} groupKey="recent" />);
    expect(html).toContain('等待中');
    expect(html).not.toContain('等待系统');
    const reply = row({ id: 'waiting-reply', status: 'waiting', activity: activity({ reply: true }) });
    expect(activityReasonLabels(reply, 'running')).toEqual(['等待回复']);
  });

  test('主状态 idle 加真实后台任务时明确后台运行，不只显示空闲', () => {
    const background = row({ id: 'background', status: 'idle', activity: activity({ backgroundWorkCount: 3 }) });
    const html = renderToStaticMarkup(<SessionCard row={background} onOpen={noop} groupKey="running" />);
    expect(html).toContain('后台运行');
    expect(html).toContain('3 个任务');
    expect(html).not.toContain('等待回复');
    expect(activityReasonLabels(background, 'running')).toEqual(['后台运行 · 3 个任务']);
  });

  test('异常超大预览仍最多六张，未支持分区不展示意外 items', () => {
    const items = Array.from({ length: 5000 }, (_, index) => row({ id: `bounded-${index}` }));
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="recent" group={section(items, 5000)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html.match(/session-card-link/g)?.length).toBe(SESSION_GROUP_PREVIEW);
    expect(html).not.toContain('会话 bounded-6');
    const unavailable = renderToStaticMarkup(<SessionGroupSection groupKey="attention" group={section(items, null, false)} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(unavailable).not.toContain('session-card-link');
  });
});

describe('未验证读视图与请求失败', () => {
  test('readState 区分 pending / unavailable / error / ready，data 存在才算 ready', () => {
    expect(readState(undefined, false, true)).toBe('pending');
    expect(readState(undefined, false, false)).toBe('unavailable');
    expect(readState(undefined, true, false)).toBe('error');
    expect(readState(groupsData(), false, false)).toBe('ready');
  });

  test('isSuccess 但 data 为 undefined 不当成真实空集合', () => {
    const state = sessionGroupsState({ data: undefined, isError: false, isPending: false });
    expect(state.kind).toBe('unavailable');
    expect(state).not.toHaveProperty('groups');
    expect(unavailableDetail(false)).toBe('数据暂不可用');
    expect(unavailableDetail(false)).not.toContain('没有需要处理');
  });

  test('仍在读取时不显示 0 或空分区文案', () => {
    const state = sessionGroupsState({ data: undefined, isError: false, isPending: true });
    expect(state).toEqual({ kind: 'unavailable', pending: true });
    expect(unavailableDetail(true)).toBe('正在读取会话…');
    expect(unavailableDetail(true)).not.toContain('0');
  });

  test('请求失败与真实空结果是两种状态', () => {
    expect(sessionGroupsState({ data: undefined, isError: true, isPending: false }).kind).toBe('error');
    expect(sessionGroupsState({ data: groupsData({ total: 0 }), isError: false, isPending: false }).kind).toBe('ready');
    expect(sessionGroupsState({ data: groupsData({ total: 3, recent: section([row({ id: 's1' })]) }), isError: false, isPending: false }).kind).toBe('ready');
  });

  test('未验证时保留旧数据不当作 0，但也不渲染分区卡片', () => {
    const state = sessionGroupsState({ data: undefined, isError: false, isPending: false });
    expect(state.kind === 'unavailable').toBe(true);
    if (state.kind === 'unavailable') expect(state.pending).toBe(false);
  });

  test('列表与卡片使用同一套四态文案，未验证不显示“共 0 条”', () => {
    expect(listUnavailableDetail(false)).toBe('数据暂不可用');
    expect(listUnavailableDetail(false)).not.toContain('共 0 条');
    expect(listUnavailableDetail(true)).toBe('正在读取会话…');
  });
});

describe('精简文案', () => {
  test('分区仅保留标题数量，必要含义为短悬停提示', () => {
    const html = renderToStaticMarkup(<SessionGroupSection groupKey="running" group={section([row({ id: 'clean' })], 4, true, 'partial')} instances={instances} onOpen={noop} onViewAll={noop} />);
    expect(html).toContain('title="含后台任务与系统等待"');
    expect(html).toContain('title="部分实例未提供"');
    expect(visibleText(html)).toContain('已知 4');
    for (const explanation of ['含后台任务与系统等待', '部分实例未提供', attentionScopeNote, '活动信息未提供']) expect(visibleText(html)).not.toContain(explanation);
    for (const removedClass of ['session-group-scope', 'session-group-coverage', 'session-card-activity-unavailable']) expect(html).not.toContain(removedClass);
  });

  test('页面删除重复说明，概览保留原统计表达式与短提示', () => {
    const overview = readFileSync(new URL('../src/components/OverviewCards.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/pages/SessionsPage.tsx', import.meta.url), 'utf8');
    expect(overview).toContain('有效会话');
    expect(overview).toContain('title="仅统计基础主状态"');
    expect(overview).not.toContain('summary-caption');
    expect(overview).not.toContain('明确空快照显示');
    expect(page).not.toContain('PageHeading');
    expect(page).not.toContain('把分散的工作放在一处查看');
    expect(page).not.toContain('上方概览计数不是当前筛选结果');
    for (const field of ['configuredInstances', 'connectedInstances', 'freshInstances', 'freshCounts?.total', 'freshCounts?.working', 'freshCounts?.waiting', 'freshCounts?.idle', 'staleInstances', 'lostInstances', 'staleSessions']) expect(overview).toContain(`countLabel(overview?.${field})`);
  });
});

describe('响应式与样式隔离', () => {
  const css = readFileSync(new URL('../src/components/SessionCards.css', import.meta.url), 'utf8');
  test('桌面三列、平板两列、手机一列', () => {
    expect(css).toContain('grid-template-columns:repeat(3,minmax(0,1fr))');
    expect(css).toContain('@media(max-width:1200px)');
    expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(css).toContain('@media(max-width:720px)');
    expect(css).toContain('grid-template-columns:1fr');
  });
  test('标题限制两行，样式不改动全局文件', () => {
    expect(css).toContain('-webkit-line-clamp:2');
    expect(css).not.toContain(':root');
    expect(css).not.toContain('.session-table');
  });
});
