import { useEffect, useState } from 'react';
import type { Instance, SessionRow } from '@nf-hub/protocol';
import { EmptyState, ErrorBanner, PageHeading, SessionPill } from '../components/Common';
import { OverviewCards } from '../components/OverviewCards';
import { Icon } from '../components/Icon';
import { initialFilters, useDebounce, useProjects, useSessions, type SessionFilters } from '../hooks/useData';
import { absoluteTime, countLabel, emptySessionMessage, projectLabel, relativeTime, sessionKey, statusLabels } from '../lib/format';
import { intentHash, navigate } from '../lib/navigation';

export function SessionsPage({ instances, instanceId = '' }: { instances: Instance[]; instanceId?: string }) {
  const [filters, setFilters] = useState<SessionFilters>({ ...initialFilters, instanceId });
  const [search, setSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const q = useDebounce(search), projectQ = useDebounce(projectSearch);
  useEffect(() => { setFilters(value => ({ ...value, q, page: 1 })); }, [q]);
  useEffect(() => { setFilters(value => ({ ...value, instanceId, projectId: '', page: 1 })); setProjectSearch(''); }, [instanceId]);
  const projects = useProjects(filters.instanceId, projectQ);
  const sessions = useSessions(filters);
  const update = (patch: Partial<SessionFilters>) => setFilters(value => ({ ...value, ...patch, page: 1 }));
  const byId = new Map(instances.map(item => [item.id, item]));
  const hasFilters = !!(filters.q || filters.instanceId || filters.status || filters.projectId || filters.standalone || filters.includeArchived);
  const empty = emptySessionMessage(instances.length > 0, hasFilters);
  const total = sessions.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / filters.pageSize));
  useEffect(() => {
    if (sessions.data && filters.page > pages) setFilters(value => ({ ...value, page: pages }));
  }, [sessions.data, filters.page, pages]);
  const open = (row: SessionRow) => navigate({ view: 'workbench', instanceId: row.instanceId, sessionId: row.id });

  return <div className="page sessions-page"><PageHeading eyebrow="会话总览" title="全局会话" description="把分散的工作放在一处查看，操作仍在原 NF 中进行。" action={<button className="button secondary" disabled={sessions.isFetching} onClick={() => { void sessions.refetch(); }}><Icon name="refresh" />刷新列表</button>} />
    <OverviewCards />
    <section className="panel sessions-panel"><div className="panel-heading"><div><h2>已同步会话 <span className="count-badge">{countLabel(sessions.data?.total)}</span></h2><p>按最近活动排列 · 默认不含归档</p></div><div className="search-field"><Icon name="search" /><input aria-label="搜索会话标题" placeholder="搜索会话标题…" value={search} onChange={event => setSearch(event.target.value)} maxLength={256} /></div></div>
      <div className="filters"><label>实例<select value={filters.instanceId} onChange={event => { update({ instanceId: event.target.value, projectId: '' }); navigate({ view: 'sessions', instanceId: event.target.value || undefined }); }}><option value="">全部实例</option>{instances.map(item => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        <label>会话状态<select value={filters.status} onChange={event => update({ status: event.target.value as SessionFilters['status'], ...(event.target.value === 'archived' ? { includeArchived: true } : {}) })}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="project-filter">项目<select disabled={!filters.instanceId || filters.standalone} value={filters.projectId} onChange={event => update({ projectId: event.target.value })}><option value="">{filters.instanceId ? '全部项目' : '请先选择实例'}</option>{projects.data?.items.map(project => <option key={JSON.stringify([project.instanceId, project.projectId])} value={project.projectId}>{project.projectName || project.projectId}</option>)}</select></label>
        <label className="check-label"><input type="checkbox" checked={filters.standalone} onChange={event => update({ standalone: event.target.checked, projectId: '' })} />仅独立会话</label>
        <label className="check-label"><input type="checkbox" checked={filters.includeArchived} onChange={event => update({ includeArchived: event.target.checked })} />包含归档</label>
        {hasFilters && <button className="text-button filter-reset" onClick={() => { setSearch(''); setProjectSearch(''); setFilters(initialFilters); navigate({ view: 'sessions' }); }}>清除筛选</button>}
      </div>
      {filters.instanceId && !filters.standalone && <div className="project-search"><label>查找项目<input placeholder="按名称或 ID 查找项目" value={projectSearch} maxLength={256} onChange={event => { setProjectSearch(event.target.value); update({ projectId: '' }); }} /></label>{projects.data && projects.data.total > 100 && <small>展示前 100 个匹配项目，请输入更具体的关键词。</small>}<ErrorBanner error={projects.error} retry={() => { void projects.refetch(); }} /></div>}
      <ErrorBanner error={sessions.error} retry={() => { void sessions.refetch(); }} />
      {sessions.isPending ? <div className="loading-state" role="status">正在读取会话摘要…</div> : sessions.isError && !sessions.data ? <EmptyState title="暂时无法读取会话" detail="请通过上方错误提示重试。请求失败不代表已授权范围内没有会话。" /> : !sessions.data?.items.length ? <EmptyState {...empty} action={!instances.length ? <button className="button primary" onClick={() => navigate({ view: 'connections' })}><Icon name="plus" />添加实例</button> : undefined} /> : <div className="table-scroll"><table className="session-table"><thead><tr><th>实例</th><th className="title-column">会话标题</th><th>项目</th><th>状态</th><th>最近活动</th><th>最后同步</th><th><span className="sr-only">打开</span></th></tr></thead><tbody>{sessions.data.items.map(row => {
        const instance = byId.get(row.instanceId), old = row.freshness !== 'fresh';
        return <tr key={sessionKey(row)} className={old ? 'snapshot-row' : ''} onClick={() => open(row)}><td><span className="instance-inline"><span className="instance-color" style={{ backgroundColor: instance?.color ?? '#71858a' }} />{instance?.alias ?? row.instanceId}</span>{old && <span className="old-label">旧快照</span>}</td>
          <td className="title-cell"><a href={intentHash({ view: 'workbench', instanceId: row.instanceId, sessionId: row.id })} onClick={event => event.stopPropagation()}>{row.title.trim() || '未命名会话'}</a></td>
          <td className="project-cell" title={row.projectId ?? undefined}>{projectLabel(row)}</td><td><SessionPill status={row.status} old={old} /></td>
          <td title={absoluteTime(row.lastMessageAt ?? row.updatedAt)}>{relativeTime(row.lastMessageAt ?? row.updatedAt)}</td><td title={absoluteTime(row.lastSuccessAt)}><span>{relativeTime(row.lastSuccessAt)}</span>{old && <small>最后成功同步</small>}</td><td><Icon name="chevron" size={16} /></td></tr>;
      })}</tbody></table></div>}
      <div className="pagination"><span>{sessions.isFetching ? '正在更新…' : `共 ${countLabel(sessions.data?.total)} 条`}</span><div><label className="page-size">每页<select aria-label="每页条数" value={filters.pageSize} onChange={event => update({ pageSize: Number(event.target.value) })}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><button className="button secondary small" disabled={filters.page <= 1 || sessions.isFetching} onClick={() => setFilters(value => ({ ...value, page: value.page - 1 }))}>上一页</button><span>{filters.page} / {pages}</span><button className="button secondary small" disabled={filters.page >= pages || sessions.isFetching} onClick={() => setFilters(value => ({ ...value, page: value.page + 1 }))}>下一页</button></div></div>
    </section>
  </div>;
}
