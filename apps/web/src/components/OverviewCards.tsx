import { useOverview } from '../hooks/useData';
import { countLabel } from '../lib/format';
import { ErrorBanner } from './Common';

export function OverviewCards() {
  const query = useOverview();
  const overview = query.data;
  return <><ErrorBanner error={query.error} retry={() => { void query.refetch(); }} />
    <section className="overview-grid" aria-label="已同步范围统计">
      <div className="metric-card"><span>已配置实例</span><strong>{countLabel(overview?.configuredInstances)}</strong><div>已连接 <b>{countLabel(overview?.connectedInstances)}</b><i />有效 <b>{countLabel(overview?.freshInstances)}</b></div></div>
      <div className="metric-card"><span>新鲜范围内会话</span><strong>{countLabel(overview?.freshCounts?.total)}</strong><div>明确空快照显示 0，首次同步前显示 —</div></div>
      <div className="metric-card accent"><span><span className="status-dot" />当前运行中</span><strong>{countLabel(overview?.freshCounts?.working)}</strong><div>等待中 <b>{countLabel(overview?.freshCounts?.waiting)}</b><i />空闲 <b>{countLabel(overview?.freshCounts?.idle)}</b></div></div>
      <div className="metric-card"><span>数据过期 / 上报失联</span><strong>{countLabel(overview?.staleInstances)}<small> / </small>{countLabel(overview?.lostInstances)}</strong><div>分别统计实例；失联不表示主机停机</div></div>
    </section>
    <div className="summary-caption"><span>计数仅限已授权同步的范围；等待中不表示需要人工处理。</span><span>旧快照 {countLabel(overview?.staleSessions)} 条 · 不计入当前运行</span></div>
  </>;
}
