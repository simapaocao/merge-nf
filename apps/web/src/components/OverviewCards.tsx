import { useOverview } from '../hooks/useData';
import { countLabel } from '../lib/format';
import { ErrorBanner } from './Common';

export function OverviewCards() {
  const query = useOverview();
  const overview = query.data;
  return <><ErrorBanner error={query.error} retry={() => { void query.refetch(); }} />
    <section className="overview-grid" aria-label="已同步范围统计">
      <div className="metric-card"><span>已配置实例</span><strong>{countLabel(overview?.configuredInstances)}</strong><div>已连接 <b>{countLabel(overview?.connectedInstances)}</b><i />有效 <b>{countLabel(overview?.freshInstances)}</b></div></div>
      <div className="metric-card"><span title="仅含已授权的新鲜摘要">有效会话</span><strong title="未提供或已过期时显示 —">{countLabel(overview?.freshCounts?.total)}</strong></div>
      <div className="metric-card accent"><span title="仅统计基础主状态"><span className="status-dot" />运行中</span><strong>{countLabel(overview?.freshCounts?.working)}</strong><div title="等待中不表示需人工处理">等待中 <b>{countLabel(overview?.freshCounts?.waiting)}</b><i />空闲 <b>{countLabel(overview?.freshCounts?.idle)}</b></div></div>
      <div className="metric-card"><span title="分别统计过期和失联实例">过期 / 失联</span><strong>{countLabel(overview?.staleInstances)}<small> / </small>{countLabel(overview?.lostInstances)}</strong><div title="不计入当前运行">旧快照 <b>{countLabel(overview?.staleSessions)}</b></div></div>
    </section>
  </>;
}
