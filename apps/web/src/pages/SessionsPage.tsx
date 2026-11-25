import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Instance, SessionGroup, SessionRow } from '@nf-hub/protocol';
import { EmptyState, ErrorBanner, SessionPill } from '../components/Common';
import { OverviewCards } from '../components/OverviewCards';
import { Icon } from '../components/Icon';
import {
  SessionFocusEmpty, SessionFocusToggle, SessionGroupSections, SessionKindBadge, SessionParentLabel, applyFilterPatch, clearGroupPatch, focusModePatch, groupCoverageText, groupEmptyText, listUnavailableDetail, readSessionViewMode, readState, resolveSessionView, saveSessionViewMode, sessionGroupLabel, sessionGroupsState, sessionListCountText, unavailableDetail, viewAllPatch,
  type SessionViewMode,
} from '../components/SessionCards';
import { initialFilters, useDebounce, useProjects, useSessionGroups, useSessions, type SessionFilters } from '../hooks/useData';
import { absoluteTime, projectLabel, relativeTime, sessionKey, statusLabels } from '../lib/format';
import { intentHash, navigate } from '../lib/navigation';

const openSession = (row: SessionRow) => navigate({ view: 'workbench', instanceId: row.instanceId, sessionId: row.id });
const groupOf = (filters: SessionFilters): SessionGroup | '' => filters.group ?? '';

/** 完整列表：保留原有搜索、筛选、分页与跳转；“查看更多”后按 group 精确分页。 */
function SessionListView({ filters, instances, setFilters }: { filters: SessionFilters; instances: Instance[]; setFilters: (update: (value: SessionFilters) => SessionFilters) => void }) {
  const sessions = useSessions(filters);
  // Reuse the same bounded, epoch-fenced projection to describe coverage after drilling into the full list.
  const groupsQuery = useSessionGroups(filters);
  const group = groupOf(filters), section = group ? groupsQuery.data?.[group] : undefined;
  const groupUnsupported = !!group && !!section && !section.supported;
  const coverageText = group && section ? groupCoverageText(group, section.coverage) : '未提供或已过期';
  const byId = new Map(instances.map(item => [item.id, item]));
  const hasFilters = !!(filters.q || filters.instanceId || filters.status || filters.projectId || filters.standalone || filters.includeArchived || group);
  const empty = { title: !instances.length ? '尚无实例' : hasFilters ? '暂无匹配会话' : '暂无会话', detail: '' };
  const total = sessions.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / filters.pageSize));
  useEffect(() => {
    if (sessions.data && filters.page > pages) setFilters(value => ({ ...value, page: pages }));
  }, [sessions.data, filters.page, pages, setFilters]);
  const update = (patch: Partial<SessionFilters>) => setFilters(value => applyFilterPatch(value, patch));
  const state = readState(sessions.data, sessions.isError, sessions.isPending);
  const rows = sessions.data ? sessions.data.items : [];

  return <>
    {group && <div className="group-filter-bar"><strong title={coverageText}>{sessionGroupLabel(group, filters.focus).title}</strong><button className="text-button" onClick={() => setFilters(value => ({ ...value, ...clearGroupPatch() }))}>清除分区筛选</button></div>}
    <ErrorBanner error={sessions.error} retry={() => { void sessions.refetch(); }} />
    {group && <ErrorBanner error={groupsQuery.error} retry={() => { void groupsQuery.refetch(); }} />}
    {state === 'error' ? <EmptyState title="读取失败" detail="请重试" />
      : state === 'pending' ? <div className="loading-state" role="status">{listUnavailableDetail(true)}</div>
      : state === 'unavailable' ? <EmptyState title={listUnavailableDetail(false)} detail="" />
      : instances.length > 0 && filters.focus && sessions.data?.total === 0 && (!group || groupsQuery.data?.total === 0) ? <SessionFocusEmpty onShowAll={() => setFilters(value => ({ ...value, ...focusModePatch(false) }))} />
      : groupUnsupported ? <EmptyState title="未提供" detail="" />
      : group && !section && !rows.length ? <EmptyState title="数据暂不可用" detail="" />
      : group && section && !rows.length ? <EmptyState title={groupEmptyText(group, section)} detail="" />
      : !rows.length ? <EmptyState {...empty} action={!instances.length ? <button className="button primary" onClick={() => navigate({ view: 'connections' })}><Icon name="plus" />添加实例</button> : undefined} /> : <div className="table-scroll"><table className="session-table"><thead><tr><th>实例</th><th className="title-column">会话标题</th><th>项目</th><th>状态</th><th>最近活动</th><th>最后同步</th><th><span className="sr-only">打开</span></th></tr></thead><tbody>{rows.map(row => {
      const instance = byId.get(row.instanceId), old = row.freshness !== 'fresh';
      return <tr key={sessionKey(row)} className={old ? 'snapshot-row' : ''} onClick={() => openSession(row)}><td><span className="instance-inline"><span className="instance-color" style={{ backgroundColor: instance?.color ?? '#71858a' }} />{instance?.alias ?? row.instanceId}</span>{old && <span className="old-label">旧快照</span>}</td>
        <td className="title-cell"><a href={intentHash({ view: 'workbench', instanceId: row.instanceId, sessionId: row.id })} onClick={event => event.stopPropagation()}>{row.title.trim() || '未命名会话'}</a><SessionKindBadge kind={row.kind} /><SessionParentLabel row={row} /></td>
        <td className="project-cell" title={row.projectId ?? undefined}>{projectLabel(row)}</td><td><SessionPill status={row.status} old={old} /></td>
        <td title={absoluteTime(row.lastMessageAt ?? row.updatedAt)}>{relativeTime(row.lastMessageAt ?? row.updatedAt)}</td><td title={absoluteTime(row.lastSuccessAt)}><span>{relativeTime(row.lastSuccessAt)}</span>{old && <small>最后成功同步</small>}</td><td><Icon name="chevron" size={16} /></td></tr>;
    })}</tbody></table></div>}
    <div className="pagination"><span title={group ? coverageText : '当前筛选范围'}>{sessions.isFetching ? '正在更新…' : sessionListCountText(sessions.data?.total, group, section, filters.focus)}</span><div><label className="page-size">每页<select aria-label="每页条数" value={filters.pageSize} onChange={event => update({ pageSize: Number(event.target.value) })}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="button secondary small" disabled={filters.page <= 1 || sessions.isFetching} onClick={() => setFilters(value => ({ ...value, page: value.page - 1 }))}>上一页</button><span>{filters.page} / {pages}</span><button className="button secondary small" disabled={filters.page >= pages || sessions.isFetching} onClick={() => setFilters(value => ({ ...value, page: value.page + 1 }))}>下一页</button></div></div>
  </>;
}

/** 卡片分区：预览条数与各分区真实总数都来自服务端，前端不渲染全量卡片。 */
function SessionGroupsView({ filters, instances, setFilters }: { filters: SessionFilters; instances: Instance[]; setFilters: (update: (value: SessionFilters) => SessionFilters) => void }) {
  const query = useSessionGroups(filters);
  // isSuccess 但 data 为 undefined 表示读视图未在当前 epoch 验证，不能当成真实空集合。
  const state = sessionGroupsState({ data: query.data, isError: query.isError, isPending: query.isPending });
  const viewAll = (group: SessionGroup) => setFilters(value => ({ ...value, ...viewAllPatch(group) }));
  const noInstances = { title: '尚无实例', detail: '' };
  return <>
    <ErrorBanner error={query.error} retry={() => { void query.refetch(); }} />
    {state.kind === 'error' ? <EmptyState title="读取失败" detail="请重试" />
      : state.kind === 'unavailable' ? (state.pending ? <div className="loading-state" role="status">{unavailableDetail(true)}</div> : <EmptyState title={unavailableDetail(false)} detail="" />)
      : !instances.length ? <EmptyState {...noInstances} action={<button className="button primary" onClick={() => navigate({ view: 'connections' })}><Icon name="plus" />添加实例</button>} />
      : filters.focus && state.groups.total === 0 ? <SessionFocusEmpty onShowAll={() => setFilters(value => ({ ...value, ...focusModePatch(false) }))} />
      : <SessionGroupSections groups={state.groups} instances={instances} onOpen={openSession} onViewAll={viewAll} focus={filters.focus} />}
  </>;
}

export function SessionsPage({ instances, instanceId = '' }: { instances: Instance[]; instanceId?: string }) {
  const [filters, setFilters] = useState<SessionFilters>({ ...initialFilters, instanceId });
  const [search, setSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [mode, setMode] = useState<SessionViewMode>(() => readSessionViewMode());
  const queryClient = useQueryClient();
  // 只刷新会话相关私有读取，不动由同一读事务种入的实例快照。
  const refreshSessions = () => { void queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === 'private' && (query.queryKey[2] === 'sessions' || query.queryKey[2] === 'sessionGroups') }); };
  const q = useDebounce(search), projectQ = useDebounce(projectSearch);
  useEffect(() => { setFilters(value => applyFilterPatch(value, { q })); }, [q]);
  useEffect(() => { setFilters(value => applyFilterPatch(value, { instanceId, projectId: '' })); setProjectSearch(''); }, [instanceId]);
  const projects = useProjects(filters.instanceId, projectQ);
  // 常规筛选变动：保留分区筛选以外的条件，重置页码；分区筛选由“查看更多”与清除按钮单独管理。
  const update = (patch: Partial<SessionFilters>) => setFilters(value => applyFilterPatch(value, patch));
  const group = groupOf(filters);
  const view = resolveSessionView(mode, group);
  const hasFilters = !!(filters.q || filters.instanceId || filters.status || filters.projectId || filters.standalone || filters.includeArchived || group);
  const chooseMode = (next: SessionViewMode) => {
    setMode(next); saveSessionViewMode(next);
    if (next === 'cards' && group) setFilters(value => ({ ...value, ...clearGroupPatch() }));
  };

  return <div className="page sessions-page"><div className="page-heading"><h1>全局会话</h1><button className="button secondary" onClick={refreshSessions}><Icon name="refresh" />刷新列表</button></div>
    <OverviewCards />
    <section className="panel sessions-panel"><div className="panel-heading"><div><h2>{filters.focus ? '需关注会话' : '已同步会话'}{group ? <span className="count-badge">{sessionGroupLabel(group, filters.focus).title}</span> : null}</h2></div><div className="panel-heading-tools"><SessionFocusToggle focus={filters.focus === true} onChange={focus => setFilters(value => ({ ...value, ...focusModePatch(focus) }))} /><div className="search-field"><Icon name="search" /><input aria-label="搜索会话标题" placeholder="搜索会话标题…" value={search} onChange={event => setSearch(event.target.value)} maxLength={256} /></div>
      <div className="session-view-toggle" role="group" aria-label="会话展示方式"><button className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => chooseMode('cards')}>卡片</button><button className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => chooseMode('list')}>列表</button></div></div></div>
      <div className="filters"><label>实例<select value={filters.instanceId} onChange={event => { update({ instanceId: event.target.value, projectId: '' }); navigate({ view: 'sessions', instanceId: event.target.value || undefined }); }}><option value="">全部实例</option>{instances.map(item => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        <label>会话状态<select value={filters.status} onChange={event => update({ status: event.target.value as SessionFilters['status'], ...(event.target.value === 'archived' ? { includeArchived: true } : {}) })}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="project-filter">项目<select disabled={!filters.instanceId || filters.standalone} value={filters.projectId} onChange={event => update({ projectId: event.target.value })}><option value="">{filters.instanceId ? '全部项目' : '请先选择实例'}</option>{projects.data?.items.map(project => <option key={JSON.stringify([project.instanceId, project.projectId])} value={project.projectId}>{project.projectName || project.projectId}</option>)}</select></label>
        <label className="check-label"><input type="checkbox" checked={filters.standalone} onChange={event => update({ standalone: event.target.checked, projectId: '' })} />仅独立会话</label>
        <label className="check-label"><input type="checkbox" checked={filters.includeArchived} onChange={event => update({ includeArchived: event.target.checked })} />包含归档</label>
        {hasFilters && <button className="text-button filter-reset" onClick={() => { setSearch(''); setProjectSearch(''); setFilters({ ...initialFilters, focus: filters.focus }); navigate({ view: 'sessions' }); }}>清除筛选</button>}
      </div>
      {filters.instanceId && !filters.standalone && <div className="project-search"><label title={projects.data && projects.data.total > 100 ? '仅显示前100项，请缩小关键词' : undefined}>查找项目<input placeholder="按名称或 ID 查找项目" value={projectSearch} maxLength={256} onChange={event => { setProjectSearch(event.target.value); update({ projectId: '' }); }} /></label><ErrorBanner error={projects.error} retry={() => { void projects.refetch(); }} /></div>}
      {view === 'cards'
        ? <SessionGroupsView filters={filters} instances={instances} setFilters={setFilters} />
        : <SessionListView filters={filters} instances={instances} setFilters={setFilters} />}
    </section>
  </div>;
}
