import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Instance } from '@nf-hub/protocol';
import { HeaderMenu } from './Common';
import { Icon } from './Icon';
import { connectionLabel } from '../lib/format';
import { keyboardTarget, nextActiveOnClose, type TabsState } from '../lib/tabs';
import { countBadge, tabCountsTitle, tabUnavailableStatus, COUNT_SCOPE_HINT, SCOPE_HINT, type TabActivityView } from '../lib/tabActivity';

export const INSTANCE_DRAG_MIME = 'application/x-nf-instance-id';
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
export function InstanceTabBar({ state, instances, selectedId, mountedIds, activityFor, lastSuccessFor, onActivate, onClose, onCloseAll, collapsed, onToggleCollapsed, onReorder, splitIds, onDragTabChange }: {
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
  onReorder?: (fromId: string, toId: string, position: 'before' | 'after') => void;
  splitIds?: ReadonlySet<string>;
  onDragTabChange?: (instanceId: string | null) => void;
}) {
  const byId = useMemo(() => new Map(instances.map(item => [item.id, item])), [instances]);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const dragSource = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const canDrag = !!(onReorder || onDragTabChange);
  // Tabs for instances the current snapshot no longer lists are kept in state but not drawn,
  // so a fenced or unverified read never turns into a fake "closed" tab.
  const rows = state.openIds.flatMap(instanceId => {
    const instance = byId.get(instanceId);
    if (!instance) return [];
    const activity = activityFor(instanceId);
    const synced = lastSuccessFor(instanceId);
    const active = instanceId === selectedId;
    const inSplit = !active && !!splitIds?.has(instanceId);
    const revoked = instance.connection === 'revoked';
    // The active tab is loading or live; only an inactive tab outside the kept frames is asleep.
    const dormant = !revoked && !active && !inSplit && mountedIds !== null && !mountedIds.has(instanceId);
    return [{
      instanceId, alias: instance.alias, active, inSplit, revoked, dormant, activity,
      connection: connectionLabel(instance), online: instance.connection === 'connected' && instance.freshness === 'fresh',
      attention: activity.attention.supported && activity.attention.count === 0 ? null
        : activity.attention.supported && activity.attention.count !== null && activity.attention.count > 0 ? countBadge(activity.attention.count)
          : { text: '?', muted: true },
      running: countBadge(activity.running),
      unavailable: tabUnavailableStatus(instance),
      title: [
        `${instance.alias} · ${instance.browserBaseUrl}`,
        revoked ? '授权已撤销' : inSplit ? '分屏显示中' : dormant ? '休眠后重载，未发输入不保留' : '',
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
  // Arrow keys move along the visible tabs; Alt+Arrow reorders; Ctrl+W stays the browser's own shortcut.
  const keyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!count) return;
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && onReorder && selectedId) {
      const index = rows.findIndex(row => row.instanceId === selectedId);
      if (index < 0) return;
      const neighbor = event.key === 'ArrowLeft' ? rows[index - 1] : rows[index + 1];
      if (!neighbor) return;
      event.preventDefault();
      onReorder(selectedId, neighbor.instanceId, event.key === 'ArrowLeft' ? 'before' : 'after');
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = keyboardTarget(rows.map(row => row.instanceId), selectedId, event.key as 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End');
    if (!target) return;
    activate(target);
    tabs.current.get(target)?.focus();
  };

  const clearDrag = () => {
    dragSource.current = null;
    setDraggingId(null);
    setDragOver(null);
    onDragTabChange?.(null);
  };

  const menu = count > 0 && <HeaderMenu label="已打开实例" icon={<><span className="tabs-menu-label">已打开</span><Icon name="chevron" size={12} /></>} className="tabs-menu">
    <div className="menu-heading">{summary}</div>
    {rows.map((row, index) => {
      const itemButton = <button key={onReorder ? undefined : row.instanceId} data-close-menu className={`menu-item ${row.active ? 'selected' : ''}`} onClick={() => activate(row.instanceId)}><Icon name="screen" size={16} /><span className="tabs-menu-copy"><strong>{row.alias}</strong><small>{row.revoked ? '授权已撤销' : row.inSplit ? '分屏中' : row.dormant ? '休眠' : '保活中'}</small></span></button>;
      if (!onReorder || rows.length <= 1) return itemButton;
      return <div key={row.instanceId} className="tabs-menu-row">
        {itemButton}
        <div className="tabs-menu-reorder">
          <button type="button" className="icon-button" aria-label={`将 ${row.alias} 往前移`} title="前移标签" disabled={index === 0} onClick={event => { event.stopPropagation(); const prev = rows[index - 1]; if (prev) onReorder(row.instanceId, prev.instanceId, 'before'); }}>↑</button>
          <button type="button" className="icon-button" aria-label={`将 ${row.alias} 往后移`} title="后移标签" disabled={index === rows.length - 1} onClick={event => { event.stopPropagation(); const next = rows[index + 1]; if (next) onReorder(row.instanceId, next.instanceId, 'after'); }}>↓</button>
        </div>
      </div>;
    })}
    <div className="menu-divider" /><button className="menu-item" data-close-menu onClick={onCloseAll}><Icon name="close" size={16} />关闭全部标签</button>
  </HeaderMenu>;

  return <section className={`instance-tabs${collapsed ? ' collapsed' : ''}${count === 0 ? ' tabs-empty-state' : ''}`} aria-label="已打开的实例标签">
    <button ref={toggle} className="icon-button tabs-toggle" aria-expanded={!collapsed} aria-controls="instance-tablist" aria-label={collapsed ? '展开实例标签栏' : '收起实例标签栏'} title={collapsed ? '展开实例标签栏' : '收起实例标签栏'} onClick={onToggleCollapsed}><Icon name="chevron" size={13} /></button>
    {collapsed
      ? <div className="tabs-collapsed"><span className="tabs-collapsed-text">{summary}</span>{menu}</div>
      : <div className="tabs-row">
        <div ref={scroller} id="instance-tablist" className="instance-tablist" role="tablist" aria-label="已打开的实例" aria-orientation="horizontal" onKeyDown={keyboard} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null); }}>
          {rows.map(row => {
            const wrapClass = [
              'instance-tab-wrap',
              row.active ? 'active' : '',
              row.inSplit ? 'in-split' : '',
              canDrag ? 'draggable' : '',
              draggingId === row.instanceId ? 'dragging' : '',
              dragOver?.id === row.instanceId ? `drag-over-${dragOver.side}` : '',
            ].filter(Boolean).join(' ');
            return <div
              key={row.instanceId}
              className={wrapClass}
              role="presentation"
              draggable={canDrag || undefined}
              onDragStart={canDrag ? event => {
                if ((event.target as HTMLElement | null)?.closest('.instance-tab-close')) { event.preventDefault(); return; }
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(INSTANCE_DRAG_MIME, row.instanceId);
                event.dataTransfer.setData('text/plain', row.instanceId);
                dragSource.current = row.instanceId;
                setDraggingId(row.instanceId);
                onDragTabChange?.(row.instanceId);
              } : undefined}
              onDragOver={onReorder ? event => {
                const fromId = dragSource.current;
                if (!fromId && !event.dataTransfer.types.includes(INSTANCE_DRAG_MIME)) return;
                if (fromId === row.instanceId) { if (dragOver) setDragOver(null); return; }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                const side: 'before' | 'after' = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                if (dragOver?.id !== row.instanceId || dragOver.side !== side) setDragOver({ id: row.instanceId, side });
              } : undefined}
              onDrop={onReorder ? event => {
                const fromId = dragSource.current || event.dataTransfer.getData(INSTANCE_DRAG_MIME) || event.dataTransfer.getData('text/plain');
                const rect = event.currentTarget.getBoundingClientRect();
                const side: 'before' | 'after' = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                event.preventDefault();
                clearDrag();
                if (fromId && fromId !== row.instanceId) onReorder(fromId, row.instanceId, side);
              } : undefined}
              onDragEnd={canDrag ? clearDrag : undefined}
            >
              <button ref={element => { if (element) tabs.current.set(row.instanceId, element); else tabs.current.delete(row.instanceId); }} role="tab" id={domId('instance-tab', row.instanceId)} className={`instance-tab ${row.active ? 'active' : ''} ${row.dormant ? 'dormant' : ''}`} aria-selected={row.active} aria-controls="workbench-panel" tabIndex={row.active || (!selectedId && rows[0]?.instanceId === row.instanceId) ? 0 : -1} title={row.title} onClick={() => activate(row.instanceId)}>
                <span className={`tiny-dot ${row.online ? 'online' : ''}`} title={`连接状态：${row.connection}`} aria-label={`连接状态：${row.connection}`} />
                <span className="instance-tab-name">{row.alias}</span>
                {row.attention && <span className={`tab-badge ${row.attention.muted ? 'muted' : 'attention'}`} aria-label={row.attention.muted ? '待处理状态未同步' : `待处理 ${row.attention.text} 个会话`} title={row.attention.muted ? '待处理状态未同步' : `${COUNT_SCOPE_HINT} · ${SCOPE_HINT}`}><span className="tab-badge-label">待处理</span>{row.attention.text}</span>}
                {row.running ? <span className="tab-badge running" aria-label={`运行 ${row.running.text} 个会话`} title={COUNT_SCOPE_HINT}><span className="tab-badge-label">运行</span>{row.running.text}</span> : <span className="tab-status" title={row.unavailable}>{row.unavailable}</span>}
                {row.dormant && <span className="tab-dormant">休眠</span>}
              </button>
              <button className="instance-tab-close" aria-label={`关闭 ${row.alias} 标签`} title="仅关闭标签，不停止 NF" onClick={() => requestClose(row.instanceId)}><Icon name="close" size={12} /></button>
            </div>;
          })}
          {!count && <span className="tabs-empty">选择实例</span>}
          {count > 0 && !rows.length && <span className="tabs-empty">加载实例…</span>}
        </div>
        {menu}
      </div>}
  </section>;
}
