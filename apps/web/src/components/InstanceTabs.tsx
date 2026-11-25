import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Instance } from '@nf-hub/protocol';
import { HeaderMenu } from './Common';
import { Icon } from './Icon';
import { connectionLabel } from '../lib/format';
import { keyboardTarget, nextActiveOnClose, type TabsState } from '../lib/tabs';
import { countBadge, tabCountsTitle, tabUnavailableStatus, COUNT_SCOPE_HINT, SCOPE_HINT, type TabActivityView } from '../lib/tabActivity';

const domId = (prefix: string, instanceId: string) => `${prefix}-${instanceId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** Reveal only inside this horizontal viewport; never scroll ancestors or move focus. */
export function revealHorizontalTab(
  viewport: Pick<HTMLElement, 'clientWidth' | 'clientLeft' | 'scrollWidth' | 'scrollLeft' | 'getBoundingClientRect'>,
  tab: Pick<HTMLElement, 'getBoundingClientRect'>,
): void {
  if (viewport.clientWidth <= 0) return;
  const left = viewport.getBoundingClientRect().left + viewport.clientLeft;
  const right = left + viewport.clientWidth;
  const bounds = tab.getBoundingClientRect();
  const delta = bounds.right - bounds.left > viewport.clientWidth || bounds.left < left
    ? bounds.left - left : bounds.right > right ? bounds.right - right : 0;
  if (!delta) return;
  viewport.scrollLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft + delta));
}

/**
 * Opened instance tabs. A tab is a view of one NF: closing it never stops an NF, deletes an
 * instance or revokes a pairing. Tabs beyond the frame capacity stay listed but dormant.
 */
export function InstanceTabBar({ state, instances, selectedId, mountedIds, activityFor, lastSuccessFor, onActivate, onClose, onCloseAll, collapsed, onToggleCollapsed }: {
  state: TabsState;
  instances: readonly Instance[];
  selectedId: string | null;
  /** Mounted frame ids, or null while the private snapshot is unverified and the set is unknown. */
  mountedIds: ReadonlySet<string> | null;
  activityFor: (instanceId: string) => TabActivityView;
  lastSuccessFor: (instanceId: string) => number | null;
  onActivate: (instanceId: string) => void;
  onClose: (instanceId: string) => void;
  onCloseAll: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const byId = useMemo(() => new Map(instances.map(item => [item.id, item])), [instances]);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  // Tabs for instances the current snapshot no longer lists are kept in state but not drawn,
  // so a fenced or unverified read never turns into a fake "closed" tab.
  const rows = state.openIds.flatMap(instanceId => {
    const instance = byId.get(instanceId);
    if (!instance) return [];
    const activity = activityFor(instanceId);
    const synced = lastSuccessFor(instanceId);
    const active = instanceId === selectedId;
    const revoked = instance.connection === 'revoked';
    // The active tab is loading or live; only an inactive tab outside the kept frames is asleep.
    const dormant = !revoked && !active && mountedIds !== null && !mountedIds.has(instanceId);
    return [{
      instanceId, alias: instance.alias, active, revoked, dormant, activity,
      connection: connectionLabel(instance), online: instance.connection === 'connected' && instance.freshness === 'fresh',
      attention: activity.attention.supported && activity.attention.count === 0 ? null
        : activity.attention.supported && activity.attention.count !== null && activity.attention.count > 0 ? countBadge(activity.attention.count)
          : { text: '?', muted: true },
      running: countBadge(activity.running),
      unavailable: tabUnavailableStatus(instance),
      title: [
        `${instance.alias} · ${instance.browserBaseUrl}`,
        revoked ? '授权已撤销' : dormant ? '休眠后重载，未发输入不保留' : '',
        tabCountsTitle(activity, synced),
      ].filter(Boolean).join('\n'),
    }];
  });
  // Opened ids drive the summary and the bulk close, so an unverified snapshot cannot make
  // existing tabs look closed while their labels are temporarily unavailable.
  const count = state.openIds.length;
  const summary = count ? `已打开 ${count} 个实例` : '尚未打开实例';
  const selectedRendered = rows.some(row => row.active);
  const reveal = useCallback((instanceId: string | null) => {
    if (!instanceId) return;
    const viewport = scroller.current;
    const wrap = tabs.current.get(instanceId)?.parentElement;
    if (viewport && wrap && viewport.contains(wrap)) revealHorizontalTab(viewport, wrap);
  }, []);
  // Selection, restore and expansion reveal the active tab without taking focus from the page.
  // Activity badges are deliberately not dependencies: manual horizontal scrolling stays put.
  useEffect(() => { if (!collapsed && selectedRendered) reveal(selectedId); }, [selectedId, collapsed, selectedRendered, reveal]);
  useEffect(() => {
    const viewport = scroller.current;
    if (collapsed || !viewport) return;
    let width = viewport.clientWidth;
    const resize = () => {
      if (viewport.clientWidth === width) return;
      width = viewport.clientWidth;
      reveal(selectedId);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(viewport);
    if (!observer) window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); if (!observer) window.removeEventListener('resize', resize); };
  }, [selectedId, collapsed, reveal]);
  const activate = (instanceId: string) => {
    onActivate(instanceId);
    // Reselecting the same active tab in the opened menu does not change selectedId.
    reveal(instanceId);
  };

  // Focus follows the neighbour after a close instead of falling back to the document body.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const element = target ? tabs.current.get(target) : undefined;
    (element ?? tabs.current.values().next().value ?? toggle.current)?.focus();
  }, [state.openIds, selectedId]);

  const requestClose = (instanceId: string) => {
    pendingFocus.current = nextActiveOnClose(state, instanceId) ?? '';
    onClose(instanceId);
  };
  // Arrow keys move along the visible tabs; Ctrl+W stays the browser's own shortcut.
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key) || !count) return;
    event.preventDefault();
    const target = keyboardTarget(rows.map(row => row.instanceId), selectedId, event.key as 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End');
    if (!target) return;
    activate(target);
    tabs.current.get(target)?.focus();
  };

  const menu = count > 0 && <HeaderMenu label="已打开实例" icon={<><span className="tabs-menu-label">已打开</span><Icon name="chevron" size={12} /></>} className="tabs-menu">
    <div className="menu-heading">{summary}</div>
    {rows.map(row => <button key={row.instanceId} data-close-menu className={`menu-item ${row.active ? 'selected' : ''}`} onClick={() => activate(row.instanceId)}><Icon name="screen" size={16} /><span className="tabs-menu-copy"><strong>{row.alias}</strong><small>{row.revoked ? '授权已撤销' : row.dormant ? '休眠' : '保活中'}</small></span></button>)}
    <div className="menu-divider" /><button className="menu-item" data-close-menu onClick={onCloseAll}><Icon name="close" size={16} />关闭全部标签</button>
  </HeaderMenu>;

  return <section className={`instance-tabs ${collapsed ? 'collapsed' : ''}`} aria-label="已打开的实例标签">
    <button ref={toggle} className="icon-button tabs-toggle" aria-expanded={!collapsed} aria-controls="instance-tablist" aria-label={collapsed ? '展开实例标签栏' : '收起实例标签栏'} title={collapsed ? '展开实例标签栏' : '收起实例标签栏'} onClick={onToggleCollapsed}><Icon name="chevron" size={13} /></button>
    {collapsed
      ? <div className="tabs-collapsed"><span className="tabs-collapsed-text">{summary}</span>{menu}</div>
      : <div className="tabs-row">
        <div ref={scroller} id="instance-tablist" className="instance-tablist" role="tablist" aria-label="已打开的实例" aria-orientation="horizontal" onKeyDown={keyboard}>
          {rows.map(row => <div key={row.instanceId} className={`instance-tab-wrap ${row.active ? 'active' : ''}`} role="presentation">
            <button ref={element => { if (element) tabs.current.set(row.instanceId, element); else tabs.current.delete(row.instanceId); }} role="tab" id={domId('instance-tab', row.instanceId)} className={`instance-tab ${row.active ? 'active' : ''} ${row.dormant ? 'dormant' : ''}`} aria-selected={row.active} aria-controls="workbench-panel" tabIndex={row.active || (!selectedId && rows[0]?.instanceId === row.instanceId) ? 0 : -1} title={row.title} onClick={() => activate(row.instanceId)}>
              <span className={`tiny-dot ${row.online ? 'online' : ''}`} title={`连接状态：${row.connection}`} aria-label={`连接状态：${row.connection}`} />
              <span className="instance-tab-name">{row.alias}</span>
              {row.attention && <span className={`tab-badge ${row.attention.muted ? 'muted' : 'attention'}`} aria-label={row.attention.muted ? '待处理状态未同步' : `待处理 ${row.attention.text} 个会话`} title={row.attention.muted ? '待处理状态未同步' : `${COUNT_SCOPE_HINT} · ${SCOPE_HINT}`}><span className="tab-badge-label">待处理</span>{row.attention.text}</span>}
              {row.running ? <span className="tab-badge running" aria-label={`运行 ${row.running.text} 个会话`} title={COUNT_SCOPE_HINT}><span className="tab-badge-label">运行</span>{row.running.text}</span> : <span className="tab-status" title={row.unavailable}>{row.unavailable}</span>}
              {row.dormant && <span className="tab-dormant">休眠</span>}
            </button>
            <button className="instance-tab-close" aria-label={`关闭 ${row.alias} 标签`} title="仅关闭标签，不停止 NF" onClick={() => requestClose(row.instanceId)}><Icon name="close" size={12} /></button>
          </div>)}
          {!count && <span className="tabs-empty">选择实例</span>}
          {count > 0 && !rows.length && <span className="tabs-empty">加载实例…</span>}
        </div>
        {menu}
      </div>}
  </section>;
}
