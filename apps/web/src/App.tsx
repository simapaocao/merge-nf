import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Instance } from '@nf-hub/protocol';
import { AppearanceMenu } from './components/AppearanceMenu';
import { ErrorBanner, HeaderMenu } from './components/Common';
import { Icon } from './components/Icon';
import { InstanceTabBar } from './components/InstanceTabs';
import { useAppearance } from './hooks/useAppearance';
import { useAppState } from './hooks/useAppState';
import { useChanges, useInstanceActivity, useInstances } from './hooks/useData';
import { useTabActivity } from './hooks/useTabActivity';
import { connectionLabel, countLabel, sortedInstances } from './lib/format';
import { intentHash, navigate, parseIntent, type View } from './lib/navigation';
import {
  clearSplitLayout, defaultSplitState, focusOrAssignInstance, readSplitLayout, reconcileSplit,
  setSplitMode, splitStorageKey, writeSplitLayout, type SplitMode, type SplitState,
} from './lib/splitLayout';
import { nextActiveOnClose } from './lib/tabs';
import { forgetStoredTabs, useInstanceTabs } from './lib/useInstanceTabs';

function safeSessionStorage() {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
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
  // Choosing an instance always means "open this NF in the workbench", never a silent filter change.
  const choose = (target: View, instanceId?: string) => { navigate({ view: target, instanceId }); if (mobile) close(); };
  return <aside id="instance-sidebar" ref={panelRef} className="sidebar" hidden={!open} aria-label="实例列表" role={mobile ? 'dialog' : undefined} aria-modal={mobile ? true : undefined} tabIndex={-1}>
    <div className="sidebar-heading"><span>工作空间 <b>{count}</b></span>{mobile && <button className="icon-button" aria-label="关闭实例列表" onClick={close}><Icon name="close" size={17} /></button>}</div>
    <button className={`sidebar-all ${view === 'sessions' && !selectedId ? 'selected' : ''}`} onClick={() => choose('sessions')}><Icon name="grid" size={17} /><span>全部实例</span></button>
    <div className="sidebar-section-label">我的实例</div>
    <div className="sidebar-instances">{instances.map(item => <button key={item.id} className={`sidebar-instance ${item.id === selectedId ? 'selected' : ''}`} onClick={() => choose('workbench', item.id)} title={`${item.alias} · ${item.group || '未分组'} · ${connectionLabel(item)}`}><span className="sidebar-avatar" style={{ color: item.color, backgroundColor: `${item.color}16` }}>{item.alias.slice(0, 1)}</span><span className="sidebar-instance-copy"><strong>{item.alias}</strong><small>{item.group || connectionLabel(item)}</small></span><span className={`tiny-dot ${item.connection === 'connected' && item.freshness === 'fresh' ? 'online' : ''}`} />{item.favorite && <span className="sr-only">已收藏</span>}</button>)}</div>
    <button className="sidebar-add" onClick={() => choose('connections')}><Icon name="plus" size={16} />管理实例连接</button>
  </aside>;
}

function Dashboard() {
  const { auth, signOut, revision, serverEpoch } = useAppState();
  const { sidebar, setPreferences } = useAppearance();
  const [intent, setIntent] = useState(() => parseIntent(window.location.hash));
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [workbenchSlot, setWorkbenchSlot] = useState<HTMLDivElement | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [drawer, setDrawer] = useState(false);
  const [tabsCollapsed, setTabsCollapsed] = useState(false);
  const [mountedIds, setMountedIds] = useState<readonly string[]>([]);
  const [split, setSplit] = useState<SplitState>(defaultSplitState);
  const [splitHydratedKey, setSplitHydratedKey] = useState<string | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const sidebarButton = useRef<HTMLButtonElement>(null);
  const sidebarPanel = useRef<HTMLElement>(null);
  const instancesQuery = useInstances();
  const instances = useMemo(() => sortedInstances(instancesQuery.data?.items ?? []), [instancesQuery.data]);
  const activityQuery = useInstanceActivity();
  const changesError = useChanges();
  // isSuccess alone is not proof of a verified snapshot: a fenced read leaves data undefined.
  const verified = instancesQuery.isSuccess && !!instancesQuery.data;
  const validIds = useMemo(() => (verified ? new Set(instances.map(item => item.id)) : null), [verified, instances]);
  const tabs = useInstanceTabs({ username: auth?.username ?? null, serverEpoch, validIds });
  const splitContextKey = auth?.username && serverEpoch ? splitStorageKey(auth.username, window.location.origin, serverEpoch) : null;
  const splitHydrated = splitContextKey !== null && splitHydratedKey === splitContextKey;
  useEffect(() => {
    if (!splitContextKey) { setSplit(defaultSplitState); setSplitHydratedKey(null); return; }
    if (splitHydratedKey === splitContextKey) return;
    setSplit(readSplitLayout(safeSessionStorage(), splitContextKey) ?? defaultSplitState);
    setSplitHydratedKey(splitContextKey);
  }, [splitContextKey, splitHydratedKey]);
  useEffect(() => {
    if (!splitHydrated || !splitContextKey) return;
    writeSplitLayout(safeSessionStorage(), splitContextKey, split);
  }, [split, splitHydrated, splitContextKey]);
  useEffect(() => {
    if (!verified || !tabs.hydrated || !splitHydrated) return;
    setSplit(value => reconcileSplit(value, tabs.state.openIds, tabs.state.activeId));
  }, [verified, tabs.hydrated, splitHydrated, tabs.state.openIds, tabs.state.activeId]);
  // Keep only logical ids across unverified reads; no old private labels or counts are rendered.
  const activity = useTabActivity(instances, verified ? activityQuery.data?.items : undefined, verified);
  const open = mobile ? drawer : sidebar;
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const selectedId = intent.view === 'workbench' ? intent.instanceId ?? null : null;
  const splitIds = useMemo(() => (
    split.mode !== 'single' && intent.view === 'workbench'
      ? new Set(split.paneIds.filter((id): id is string => !!id))
      : undefined
  ), [split.mode, split.paneIds, intent.view]);
  // Mounted frames are only meaningful for a verified list; otherwise "asleep" would be a guess.
  const mountedSet = useMemo(() => (verified ? new Set(mountedIds) : null), [verified, mountedIds]);
  useEffect(() => { const change = () => setIntent(parseIntent(window.location.hash)); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  // Only an authoritative empty list may redirect; an unverified read is not "no instances".
  useEffect(() => { if (verified && !instances.length && !window.location.hash) navigate({ view: 'connections' }); }, [verified, instances.length]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const change = () => { setMobile(query.matches); setDrawer(false); };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => { setDrawer(false); }, [intent.view, intent.instanceId]);
  // An opened tab and the workbench view stay in sync in both directions. Waiting for
  // hydration keeps a restored list from being replaced by the single hash target.
  useEffect(() => {
    if (!tabs.hydrated || intent.view !== 'workbench' || !intent.instanceId) return;
    if (validIds && !validIds.has(intent.instanceId)) { navigate({ view: 'sessions' }); return; }
    tabs.open(intent.instanceId);
    if (splitHydrated) setSplit(value => focusOrAssignInstance(value, intent.instanceId!));
  }, [tabs.hydrated, splitHydrated, intent.view, intent.instanceId, tabs.open, validIds]);
  // A refresh inside the workbench without an instance re-selects the restored tab only.
  // Restoring never hijacks a deliberate visit to the global session page.
  useEffect(() => {
    if (!tabs.hydrated || intent.view !== 'workbench' || intent.instanceId) return;
    const restored = tabs.state.activeId;
    if (restored) navigate({ view: 'workbench', instanceId: restored });
  }, [tabs.hydrated, intent.view, intent.instanceId, tabs.state.activeId]);
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
  // Switching to the workbench reuses the active tab before falling back to the hash instance.
  const updateView = (view: View) => {
    const instanceId = view !== 'workbench' ? undefined
      : intent.view === 'workbench' && intent.instanceId ? intent.instanceId
        : tabs.state.activeId ?? undefined;
    navigate({ view, instanceId });
  };
  const applySplit = useCallback((next: SplitState) => {
    let openedAny = false;
    for (const id of next.paneIds) {
      if (id && !tabs.state.openIds.includes(id)) { tabs.open(id); openedAny = true; }
    }
    const focusId = next.paneIds[next.focusedPane] ?? next.paneIds.find(Boolean) ?? null;
    if (focusId && (openedAny || focusId !== tabs.state.activeId)) tabs.activate(focusId);
    setSplit(next);
    if (focusId && (intent.view !== 'workbench' || intent.instanceId !== focusId)) {
      navigate({ view: 'workbench', instanceId: focusId });
    }
  }, [tabs.state.openIds, tabs.state.activeId, tabs.open, tabs.activate, intent.view, intent.instanceId]);
  const selectSplitMode = useCallback((mode: SplitMode) => {
    const candidates = [...tabs.state.openIds, ...instances.map(item => item.id)];
    applySplit(setSplitMode(split, mode, selectedId ?? tabs.state.activeId, candidates));
  }, [split, selectedId, tabs.state.openIds, tabs.state.activeId, instances, applySplit]);
  const focusPane = useCallback((paneIndex: number) => {
    if (paneIndex < 0 || paneIndex >= split.paneIds.length) return;
    applySplit(split.focusedPane === paneIndex ? split : { ...split, focusedPane: paneIndex });
  }, [split, applySplit]);
  const activateTab = (instanceId: string) => {
    tabs.activate(instanceId);
    setSplit(value => focusOrAssignInstance(value, instanceId));
    navigate({ view: 'workbench', instanceId });
  };
  // A tab close only changes the current page when that tab was the one on screen.
  const closeTab = (instanceId: string) => {
    const wasActive = tabs.state.activeId === instanceId;
    const next = nextActiveOnClose(tabs.state, instanceId);
    tabs.close(instanceId);
    if (wasActive && intent.view === 'workbench') navigate(next ? { view: 'workbench', instanceId: next } : { view: 'sessions' });
  };
  // Closing every tab returns to the global session page only when the workbench was showing;
  // the connection manager keeps its own view.
  const closeAllTabs = () => {
    tabs.closeAll();
    setSplit(defaultSplitState);
    if (intent.view === 'workbench') navigate({ view: 'sessions' });
  };

  return <div className="app-shell"><a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳转到主内容</a>
    <header className="app-header">
      <button ref={sidebarButton} className="icon-button sidebar-toggle" aria-label={open ? '收起实例列表' : '展开实例列表'} title={open ? '收起实例列表' : '展开实例列表'} aria-expanded={open} aria-controls="instance-sidebar" onClick={() => { if (mobile) setDrawer(value => !value); else setPreferences({ sidebar: !sidebar }); }}><Icon name="sidebar" size={18} /></button>
      <a href={intentHash({ view: 'sessions' })} className="brand" title="多 NF 工作台"><span className="brand-mark">NF</span><span className="brand-copy">多 NF 工作台</span></a>
      <PageNavigation view={intent.view} onChange={updateView} />
      <InstanceTabBar state={tabs.state} instances={instances} selectedId={selectedId} mountedIds={mountedSet} activityFor={activity.activityFor} lastSuccessFor={activity.lastSuccessFor} onActivate={activateTab} onClose={closeTab} onCloseAll={closeAllTabs} onReorder={tabs.reorder} splitIds={splitIds} onDragTabChange={setDraggingTabId} collapsed={tabsCollapsed} onToggleCollapsed={() => setTabsCollapsed(value => !value)} />
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
        <WorkbenchPage key={serverEpoch ?? 'pending'} instances={instances} loaded={verified && tabs.hydrated} intent={intent} visible={intent.view === 'workbench'} toolbarTarget={workbenchSlot} openIds={tabs.state.openIds} onMountedChange={setMountedIds} split={split} onSplitChange={applySplit} onSelectSplitMode={selectSplitMode} onFocusPane={focusPane} draggingTabId={draggingTabId} onDragTabChange={setDraggingTabId} />
      </main>
    </div>
  </div>;
}
export function App() {
  const { auth, ready } = useAppState();
  // Signing out or losing the session also drops every account's restored tab list.
  useEffect(() => { if (ready && !auth) { forgetStoredTabs(); clearSplitLayout(safeSessionStorage()); } }, [ready, auth]);
  if (!ready) return <main className="initial-loading"><div className="standalone-appearance"><AppearanceMenu /></div><span className="brand-mark">NF</span><p role="status">验证登录中…</p></main>;
  return auth ? <Dashboard /> : <LoginPage />;
}
