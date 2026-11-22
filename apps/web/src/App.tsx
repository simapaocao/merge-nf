import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Instance } from '@nf-hub/protocol';
import { AppearanceMenu } from './components/AppearanceMenu';
import { ErrorBanner, HeaderMenu } from './components/Common';
import { Icon } from './components/Icon';
import { useAppearance } from './hooks/useAppearance';
import { useAppState } from './hooks/useAppState';
import { useChanges, useInstances } from './hooks/useData';
import { connectionLabel, countLabel, sortedInstances } from './lib/format';
import { intentHash, navigate, parseIntent, type View } from './lib/navigation';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { LoginPage } from './pages/LoginPage';
import { SessionsPage } from './pages/SessionsPage';
import { WorkbenchPage } from './pages/WorkbenchPage';

const navigation = [
  { view: 'sessions', label: '全局会话', short: '会话', icon: 'grid' },
  { view: 'workbench', label: '实例工作台', short: '工作台', icon: 'screen' },
  { view: 'connections', label: '连接管理', short: '连接', icon: 'link' },
] as const;

export function PageNavigation({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return <><nav className="top-navigation" aria-label="主导航">{navigation.map(item => <button key={item.view} className={view === item.view ? 'active' : ''} aria-current={view === item.view ? 'page' : undefined} aria-label={item.label} onClick={() => onChange(item.view)}><Icon name={item.icon} size={16} /><span className="navigation-full">{item.label}</span><span className="navigation-short" aria-hidden="true">{item.short}</span></button>)}</nav>
    <HeaderMenu label="页面导航" icon={<Icon name="menu" size={18} />} className="mobile-navigation"><div className="menu-heading">页面导航</div>{navigation.map(item => <button data-close-menu key={item.view} className={`menu-item ${view === item.view ? 'selected' : ''}`} aria-current={view === item.view ? 'page' : undefined} onClick={() => onChange(item.view)}><Icon name={item.icon} size={17} />{item.label}</button>)}</HeaderMenu></>;
}

export function Sidebar({ instances, selectedId, view, open, mobile, panelRef, close, count }: { instances: Instance[]; selectedId?: string; view: View; open: boolean; mobile: boolean; panelRef?: RefObject<HTMLElement | null>; close: () => void; count: string }) {
  const choose = (target: View, instanceId?: string) => { navigate({ view: target, instanceId }); if (mobile) close(); };
  return <aside id="instance-sidebar" ref={panelRef} className="sidebar" hidden={!open} aria-label="实例列表" role={mobile ? 'dialog' : undefined} aria-modal={mobile ? true : undefined} tabIndex={-1}>
    <div className="sidebar-heading"><span>工作空间 <b>{count}</b></span>{mobile && <button className="icon-button" aria-label="关闭实例列表" onClick={close}><Icon name="close" size={17} /></button>}</div>
    <button className={`sidebar-all ${view === 'sessions' && !selectedId ? 'selected' : ''}`} onClick={() => choose('sessions')}><Icon name="grid" size={17} /><span>全部实例</span></button>
    <div className="sidebar-section-label">我的实例</div>
    <div className="sidebar-instances">{instances.map(item => <button key={item.id} className={`sidebar-instance ${item.id === selectedId ? 'selected' : ''}`} onClick={() => choose(view === 'sessions' ? 'sessions' : 'workbench', item.id)} title={`${item.alias} · ${item.group || '未分组'} · ${connectionLabel(item)}`}><span className="sidebar-avatar" style={{ color: item.color, backgroundColor: `${item.color}16` }}>{item.alias.slice(0, 1)}</span><span className="sidebar-instance-copy"><strong>{item.alias}</strong><small>{item.group || connectionLabel(item)}</small></span><span className={`tiny-dot ${item.connection === 'connected' && item.freshness === 'fresh' ? 'online' : ''}`} />{item.favorite && <span className="sr-only">已收藏</span>}</button>)}</div>
    <button className="sidebar-add" onClick={() => choose('connections')}><Icon name="plus" size={16} />管理实例连接</button>
  </aside>;
}

function Dashboard() {
  const { auth, signOut, revision } = useAppState();
  const { sidebar, setPreferences } = useAppearance();
  const [intent, setIntent] = useState(() => parseIntent(window.location.hash));
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [workbenchSlot, setWorkbenchSlot] = useState<HTMLDivElement | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [drawer, setDrawer] = useState(false);
  const sidebarButton = useRef<HTMLButtonElement>(null);
  const sidebarPanel = useRef<HTMLElement>(null);
  const instancesQuery = useInstances();
  const instances = useMemo(() => sortedInstances(instancesQuery.data?.items ?? []), [instancesQuery.data]);
  const changesError = useChanges();
  const open = mobile ? drawer : sidebar;
  const closeDrawer = useCallback(() => setDrawer(false), []);
  useEffect(() => { const change = () => setIntent(parseIntent(window.location.hash)); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => { if (instancesQuery.isSuccess && !instances.length && !window.location.hash) navigate({ view: 'connections' }); }, [instances.length, instancesQuery.isSuccess]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const change = () => { setMobile(query.matches); setDrawer(false); };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => { setDrawer(false); }, [intent.view, intent.instanceId]);
  useEffect(() => {
    if (!mobile || !drawer) return;
    const panel = sidebarPanel.current;
    const previous = document.activeElement;
    // The overlay never reparents, hides, or navigates the underlying workbench.
    const regions = [document.getElementById('main-content'), document.querySelector<HTMLElement>('.app-header')].filter((element): element is HTMLElement => !!element);
    regions.forEach(element => { element.inert = true; });
    panel?.querySelector<HTMLElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      regions.forEach(element => { element.inert = false; });
      document.removeEventListener('keydown', keyboard);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); else sidebarButton.current?.focus();
    };
  }, [mobile, drawer, closeDrawer]);
  const logout = async () => {
    setLogoutError(null); setSigningOut(true);
    try { await signOut(); } catch (error) { setLogoutError(error); setSigningOut(false); }
  };
  const updateView = (view: View) => navigate({ view, instanceId: view === 'workbench' && intent.view === 'workbench' ? intent.instanceId : undefined });
  const active = instances.find(item => item.id === intent.instanceId);

  return <div className="app-shell"><a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳转到主内容</a>
    <header className="app-header">
      <button ref={sidebarButton} className="icon-button sidebar-toggle" aria-label={open ? '收起实例列表' : '展开实例列表'} title={open ? '收起实例列表' : '展开实例列表'} aria-expanded={open} aria-controls="instance-sidebar" onClick={() => { if (mobile) setDrawer(value => !value); else setPreferences({ sidebar: !sidebar }); }}><Icon name="sidebar" size={18} /></button>
      <a href={intentHash({ view: 'sessions' })} className="brand" title="多 NF 工作台"><span className="brand-mark">NF</span><span className="brand-copy">多 NF 工作台</span></a>
      <PageNavigation view={intent.view} onChange={updateView} />
      <label className="site-selector" title={active ? `${active.alias} · ${active.browserBaseUrl}` : '选择 NF 实例'}><span className="sr-only">当前 NF</span><select aria-label="当前 NF" value={active?.id ?? ''} onChange={event => { if (event.target.value) navigate({ view: intent.view === 'sessions' ? 'sessions' : 'workbench', instanceId: event.target.value }); }}><option value="" disabled>选择 NF</option>{instances.map(item => <option key={item.id} value={item.id}>{item.alias}</option>)}</select><Icon name="chevron" size={13} /></label>
      <div className="header-workbench-slot" ref={setWorkbenchSlot} hidden={intent.view !== 'workbench'} />
      <div className="header-end"><AppearanceMenu /><HeaderMenu label="账户菜单" icon={<Icon name="user" size={17} />} className="account-menu"><div className="menu-heading">{auth?.username}</div><button className="menu-item" data-close-menu disabled={signingOut} onClick={() => { void logout(); }}><Icon name="logout" size={17} />{signingOut ? '正在退出…' : '退出登录'}</button></HeaderMenu></div>
    </header>
    <div className="app-body">
      {mobile && drawer && <button className="sidebar-backdrop" aria-label="关闭实例列表遮罩" tabIndex={-1} onClick={closeDrawer} />}
      <Sidebar instances={instances} selectedId={intent.instanceId} view={intent.view} open={open} mobile={mobile} panelRef={sidebarPanel} close={closeDrawer} count={countLabel(instancesQuery.data ? instances.length : null)} />
      <main id="main-content" className={`main-content ${intent.view === 'workbench' ? 'workbench-active' : ''}`} tabIndex={-1}>
        <div className="global-notices"><ErrorBanner error={instancesQuery.error} retry={() => { void instancesQuery.refetch(); }} /><ErrorBanner error={changesError} /><ErrorBanner error={logoutError} /></div>
        {intent.view === 'sessions' && <SessionsPage key={revision} instances={instances} instanceId={intent.instanceId} />}
        {intent.view === 'connections' && <ConnectionsPage instances={instances} loading={instancesQuery.isPending} unavailable={instancesQuery.isError && !instancesQuery.data} />}
        <WorkbenchPage instances={instances} loaded={instancesQuery.isSuccess} intent={intent} visible={intent.view === 'workbench'} toolbarTarget={workbenchSlot} />
      </main>
    </div>
  </div>;
}
export function App() {
  const { auth, ready } = useAppState();
  if (!ready) return <main className="initial-loading"><div className="standalone-appearance"><AppearanceMenu /></div><span className="brand-mark">NF</span><p role="status">正在验证工作台登录状态…</p></main>;
  return auth ? <Dashboard /> : <LoginPage />;
}
