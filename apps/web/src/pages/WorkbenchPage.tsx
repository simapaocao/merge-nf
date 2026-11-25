import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { buildNarratorUrl, instanceSchema, normalizeBrowserBaseUrl, routes, type Instance } from '@nf-hub/protocol';
import { EmptyState, ErrorBanner, HeaderMenu, Modal } from '../components/Common';
import { Icon } from '../components/Icon';
import { INSTANCE_DRAG_MIME } from '../components/InstanceTabs';
import { useAppState } from '../hooks/useAppState';
import { api } from '../lib/api';
import { embedLabels } from '../lib/format';
import { authorizedFrames, frameKey, identityKey, keepOpenedFrames, pruneFrames, refreshFrame, sortFramesForRender, touchFrame, type FrameEntry, type FrameIdentity } from '../lib/frames';
import { isMixedContent, navigate, type LocationIntent } from '../lib/navigation';
import {
  assignPane, closeSplitPane, computeDividers, computePaneRects, defaultRatios, defaultSplitState,
  resizeSplit, SPLIT_MODE_LABELS, swapPanes, type DividerSpec, type SplitMode, type SplitState,
} from '../lib/splitLayout';

export function resolveWorkbenchTarget({ base, sessionId, authorized, changedIdentity, retained, remembered }: { base: string; sessionId?: string; authorized: boolean; changedIdentity: boolean; retained?: string; remembered?: string }) {
  // Without the current identity grant, an old hash or remembered session must never reach another origin.
  if (!authorized) return { explicit: undefined, target: base };
  const explicit = sessionId && !changedIdentity ? buildNarratorUrl(base, sessionId) : undefined;
  return { explicit, target: explicit ?? retained ?? remembered ?? base };
}

export function WorkbenchPage({
  instances, loaded, intent, visible, toolbarTarget, openIds, onMountedChange,
  split = defaultSplitState, onSplitChange, onSelectSplitMode, onFocusPane, draggingTabId = null, onDragTabChange,
}: {
  instances: Instance[]; loaded: boolean; intent: LocationIntent; visible: boolean; toolbarTarget?: HTMLElement | null;
  /** Opened tabs. A closed tab is unmounted here even when it would still fit the LRU capacity. */
  openIds?: readonly string[];
  onMountedChange?: (instanceIds: readonly string[]) => void;
  split?: SplitState;
  onSplitChange?: (next: SplitState) => void;
  onSelectSplitMode?: (mode: SplitMode) => void;
  onFocusPane?: (paneIndex: number) => void;
  draggingTabId?: string | null;
  onDragTabChange?: (instanceId: string | null) => void;
}) {
  const { revision, removedInstance } = useAppState();
  const client = useQueryClient();
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [resizingDivider, setResizingDivider] = useState<DividerSpec['id'] | null>(null);
  const [hoverDrop, setHoverDrop] = useState<string | null>(null);
  const iframeAreaRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef(split);
  splitRef.current = split;
  const closeDetails = useCallback(() => setShowDetails(false), []);
  useEffect(() => { setShowDetails(false); }, [intent.instanceId, visible]);
  useEffect(() => { if (!draggingTabId) setHoverDrop(null); }, [draggingTabId]);
  const selected = instances.find(item => item.id === intent.instanceId);
  const byId = useMemo(() => new Map(instances.map(item => [item.id, item])), [instances]);
  const grants = useMemo(() => authorizedFrames(loaded ? instances : [], window.location.origin), [instances, loaded]);
  // LRU order is for eviction only. Moving a surviving iframe in the DOM can reload its document.
  const rendered = useMemo(() => sortFramesForRender(keepOpenedFrames(pruneFrames(frames, grants), openIds)), [frames, grants, openIds]);
  const grant = selected ? grants.get(selected.id) : undefined, key = grant ? identityKey(grant) : '';
  const remembered = useRef(new Map<string, string>());
  const lastIntent = useRef<{ id: string; session: string | undefined; key: string } | null>(null);
  const changedIdentity = !!(grant && intent.sessionId && lastIntent.current?.id === grant.instanceId && lastIntent.current.session === intent.sessionId && lastIntent.current.key !== key);
  let base = '', target = '', explicit: string | undefined, urlValid = true;
  if (selected) {
    try {
      base = normalizeBrowserBaseUrl(selected.browserBaseUrl, window.location.origin);
      ({ explicit, target } = resolveWorkbenchTarget({ base, sessionId: intent.sessionId, authorized: !!grant, changedIdentity, retained: rendered.find(f => f.instanceId === selected.id)?.target, remembered: remembered.current.get(key) }));
    } catch { urlValid = false; }
  }
  const isSplit = split.mode !== 'single';
  const rects = useMemo(() => computePaneRects(split), [split]);
  const dividers = useMemo(() => computeDividers(split), [split]);
  const visiblePaneIds = useMemo(() => {
    if (!isSplit) return selected ? [selected.id] : [];
    const ids = split.paneIds.filter((id): id is string => !!id);
    if (selected && ids.includes(selected.id)) return [...ids.filter(id => id !== selected.id), selected.id];
    return ids;
  }, [isSplit, split.paneIds, selected]);
  // Restored tabs win: only an empty tab list falls back to the first instance.
  useEffect(() => {
    if (visible && loaded && !intent.instanceId && !openIds?.length && instances[0]) navigate({ view: 'workbench', instanceId: instances[0].id });
  }, [visible, loaded, intent.instanceId, instances, openIds]);
  useEffect(() => {
    setFrames(value => { const next = pruneFrames(value, grants); return next.length === value.length ? value : next; });
    const activeKeys = new Set([...grants.values()].map(identityKey));
    for (const id of remembered.current.keys()) if (!activeKeys.has(id)) remembered.current.delete(id);
  }, [grants]);
  useEffect(() => {
    if (removedInstance) setFrames(value => value.filter(frame => frame.instanceId !== removedInstance.id));
  }, [removedInstance]);
  // A closed tab frees its frame immediately so a later reopen starts from a fresh document.
  useEffect(() => {
    setFrames(value => { const next = keepOpenedFrames(value, openIds); return next.length === value.length ? value : next; });
  }, [openIds]);
  useEffect(() => {
    if (!visible) return;
    if (grant && urlValid && changedIdentity) { navigate({ view: 'workbench', instanceId: grant.instanceId }); return; }
    const activeGrants = visiblePaneIds.map(id => grants.get(id)).filter((item): item is FrameIdentity => !!item);
    if (!activeGrants.length) return;
    setFrames(value => {
      let next = value;
      for (const paneGrant of activeGrants) {
        const paneKey = identityKey(paneGrant);
        const isSelected = paneGrant.instanceId === grant?.instanceId;
        const desired = (isSelected ? explicit : undefined) ?? remembered.current.get(paneKey) ?? paneGrant.browserBaseUrl;
        remembered.current.set(paneKey, desired);
        if (isSelected) lastIntent.current = { id: paneGrant.instanceId, session: intent.sessionId, key: paneKey };
        next = touchFrame(next, paneGrant, desired);
      }
      const unchanged = next.length === value.length && next.every((item, i) => frameKey(item) === frameKey(value[i]!) && item.target === value[i]!.target);
      return unchanged ? value : next;
    });
    if (grant && urlValid) setError(null);
  }, [visible, visiblePaneIds, grants, grant, explicit, intent.sessionId, urlValid, changedIdentity]);
  const mountedIds = useMemo(() => rendered.map(frame => frame.instanceId), [rendered]);
  useEffect(() => { onMountedChange?.(mountedIds); }, [mountedIds, onMountedChange]);

  const setEmbedStatus = async (embedStatus: 'verified' | 'blocked' | 'unverified') => {
    if (!selected) return;
    setSaving(true); setError(null);
    try {
      await api.request(routes.instance(selected.id), instanceSchema, { method: 'PATCH', body: { embedStatus } });
      await client.invalidateQueries({ queryKey: ['private', revision, 'instances'] });
    } catch (reason) { setError(reason); } finally { setSaving(false); }
  };
  const home = () => {
    if (!selected || !grant) return;
    remembered.current.set(key, base);
    setFrames(value => refreshFrame(touchFrame(value, grant, base), grant));
    navigate({ view: 'workbench', instanceId: selected.id });
  };
  const startResize = (divider: DividerSpec, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onSplitChange) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizingDivider(divider.id);
    const update = (clientX: number, clientY: number) => {
      const box = iframeAreaRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return;
      const pct = divider.orientation === 'vertical'
        ? ((clientX - box.left) / box.width) * 100
        : ((clientY - box.top) / box.height) * 100;
      onSplitChange(resizeSplit(splitRef.current, divider.id, pct));
    };
    const move = (e: PointerEvent) => update(e.clientX, e.clientY);
    const end = () => {
      setResizingDivider(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const keyboardResize = (divider: DividerSpec, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!onSplitChange) return;
    const step = divider.orientation === 'vertical'
      ? (event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0)
      : (event.key === 'ArrowUp' ? -5 : event.key === 'ArrowDown' ? 5 : 0);
    if (!step) return;
    event.preventDefault();
    const currentPos = divider.orientation === 'vertical' ? divider.left : divider.top;
    onSplitChange(resizeSplit(split, divider.id, currentPos + step));
  };
  const readDraggedInstance = (event: ReactDragEvent) =>
    draggingTabId || event.dataTransfer.getData(INSTANCE_DRAG_MIME) || event.dataTransfer.getData('text/plain');
  const allowDrop = (zoneId: string) => (event: ReactDragEvent) => {
    if (!draggingTabId && !event.dataTransfer.types.includes(INSTANCE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (hoverDrop !== zoneId) setHoverDrop(zoneId);
  };
  const handleSingleDrop = (zone: 'left' | 'replace' | 'right' | 'bottom') => (event: ReactDragEvent) => {
    event.preventDefault();
    const fromId = readDraggedInstance(event);
    setHoverDrop(null);
    onDragTabChange?.(null);
    if (!fromId || !byId.has(fromId) || !selected || !onSplitChange) return;
    if (zone === 'replace') {
      navigate({ view: 'workbench', instanceId: fromId });
    } else if (zone === 'left') {
      onSplitChange({ mode: 'split-h', paneIds: [fromId, selected.id], focusedPane: 0, ratios: defaultRatios('split-h') });
    } else if (zone === 'right') {
      onSplitChange({ mode: 'split-h', paneIds: [selected.id, fromId], focusedPane: 1, ratios: defaultRatios('split-h') });
    } else {
      onSplitChange({ mode: 'split-v', paneIds: [selected.id, fromId], focusedPane: 1, ratios: defaultRatios('split-v') });
    }
  };
  const handlePaneDrop = (paneIndex: number) => (event: ReactDragEvent) => {
    event.preventDefault();
    const fromId = readDraggedInstance(event);
    setHoverDrop(null);
    onDragTabChange?.(null);
    if (!fromId || !byId.has(fromId) || !onSplitChange) return;
    onSplitChange(assignPane(split, paneIndex, fromId));
  };

  const splitIconName = split.mode === 'split-v' ? 'splitV' : split.mode === 'split-3' ? 'split3' : split.mode === 'split-grid' ? 'splitGrid' : 'split';
  const interacting = resizingDivider !== null || draggingTabId !== null;
  const activeDividerOrientation = resizingDivider ? dividers.find(d => d.id === resizingDivider)?.orientation : undefined;

  return <section className="workbench-page" id="workbench-panel" role="tabpanel" hidden={!visible} aria-label="实例工作台">
    {visible && (selected || isSplit) && toolbarTarget && createPortal(<div className="workbench-controls">
      {selected && <button className={`icon-button embed-status ${selected.embedStatus === 'verified' ? 'verified' : selected.embedStatus === 'blocked' ? 'blocked' : ''}`} aria-label={`${selected.alias}：${embedLabels[selected.embedStatus]}，查看来源与嵌入详情`} title={`${selected.alias} · ${embedLabels[selected.embedStatus]}`} onClick={() => setShowDetails(true)}><span className="status-dot" /></button>}
      {onSelectSplitMode && <HeaderMenu label={`分屏布局（${SPLIT_MODE_LABELS[split.mode]}）`} icon={<Icon name={splitIconName} size={17} />} className={`split-menu ${isSplit ? 'active' : ''}`}>
        <div className="menu-heading">窗口分屏 · {SPLIT_MODE_LABELS[split.mode]}</div>
        <button className={`menu-item ${split.mode === 'single' ? 'selected' : ''}`} data-close-menu onClick={() => onSelectSplitMode('single')}><Icon name="screen" size={16} />单屏</button>
        <button className={`menu-item ${split.mode === 'split-h' ? 'selected' : ''}`} data-close-menu disabled={instances.length < 2} title={instances.length < 2 ? '需至少 2 个实例' : undefined} onClick={() => onSelectSplitMode('split-h')}><Icon name="split" size={16} />左右双屏</button>
        <button className={`menu-item ${split.mode === 'split-v' ? 'selected' : ''}`} data-close-menu disabled={instances.length < 2} title={instances.length < 2 ? '需至少 2 个实例' : undefined} onClick={() => onSelectSplitMode('split-v')}><Icon name="splitV" size={16} />上下双屏</button>
        <button className={`menu-item ${split.mode === 'split-3' ? 'selected' : ''}`} data-close-menu disabled={instances.length < 3} title={instances.length < 3 ? '需至少 3 个实例' : undefined} onClick={() => onSelectSplitMode('split-3')}><Icon name="split3" size={16} />三屏并排</button>
        <button className={`menu-item ${split.mode === 'split-grid' ? 'selected' : ''}`} data-close-menu disabled={instances.length < 3} title={instances.length < 3 ? '需至少 3 个实例' : undefined} onClick={() => onSelectSplitMode('split-grid')}><Icon name="splitGrid" size={16} />左主右双</button>
        {isSplit && onSplitChange && <>
          <div className="menu-divider" />
          <button className="menu-item" data-close-menu onClick={() => onSplitChange(swapPanes(split, 0, 1))}><Icon name="swap" size={16} />对调分屏位置</button>
          <button className="menu-item" data-close-menu onClick={() => onSplitChange({ ...split, ratios: defaultRatios(split.mode) })}><Icon name="refresh" size={16} />重置分屏比例</button>
        </>}
        <p className="menu-note">拖动标签可调整顺序，拖入窗口或拖动分隔线可分屏与调宽。</p>
      </HeaderMenu>}
      {selected && <button className="icon-button" aria-label={`刷新 ${selected.alias} 原站`} title="刷新原站" disabled={!urlValid || !grant} onClick={() => { if (grant) setFrames(value => refreshFrame(value, grant)); }}><Icon name="refresh" size={17} /></button>}
      {selected && <HeaderMenu label="更多原站操作" icon={<Icon name="more" size={20} />}>
        <div className="menu-heading">{selected.alias}</div>
        <button className="menu-item" data-close-menu disabled={!urlValid || !grant} onClick={home}><Icon name="home" size={17} />返回原站首页</button>
        {urlValid && <a className="menu-item" data-close-menu href={target} target="_blank" rel="noopener noreferrer"><Icon name="external" size={17} />在新窗口打开</a>}
        <button className="menu-item" data-close-menu onClick={() => setShowDetails(true)}><Icon name="info" size={17} />来源与嵌入详情</button>
        <div className="menu-divider" /><div className="menu-heading">人工验证 · {embedLabels[selected.embedStatus]}</div>
        <button className="menu-item" data-close-menu disabled={saving} onClick={() => { void setEmbedStatus('verified'); }}><Icon name="check" size={17} />我已验证可用</button>
        <button className="menu-item" data-close-menu disabled={saving} onClick={() => { void setEmbedStatus('blocked'); }}><Icon name="close" size={17} />我已确认受阻</button>
        {selected.embedStatus !== 'unverified' && <button className="menu-item muted" data-close-menu disabled={saving} onClick={() => { void setEmbedStatus('unverified'); }}><Icon name="refresh" size={17} />重置验证状态</button>}
        <p className="menu-note">原站独立登录，加载页面不代表验证成功。</p>
      </HeaderMenu>}
    </div>, toolbarTarget)}
    {!selected && !isSplit ? <div className="page"><EmptyState title={loaded ? '选择一个实例开始工作' : '正在读取实例…'} detail="各实例保留独立登录状态，最多保活三个已打开的页面。" action={loaded && !instances.length ? <button className="button primary" onClick={() => navigate({ view: 'connections' })}><Icon name="plus" />添加实例</button> : undefined} /></div> : selected && <>
      {selected.embedStatus === 'blocked' && <div className="notice notice-warning" role="alert">嵌入已被人工标记受阻，请在「更多」核对来源与嵌入信任；也可在新窗口打开。</div>}
      {urlValid && isMixedContent(window.location.href, base) && <div className="notice notice-warning" role="alert">HTTPS 工作台内的 HTTP 原站会被浏览器按混合内容阻止。请先为原站配置可信 HTTPS 入口。</div>}
      {!urlValid && <div className="notice notice-error" role="alert">实例地址不符合安全要求，请在连接管理中检查协议、独立主机名与基路径。</div>}
      <ErrorBanner error={error} />
      {selected.connection === 'revoked' && <div className="notice notice-warning" role="alert">中心授权已撤销，旧摘要及此实例的保活页面已清除。重新配对后可在此继续使用；原 NF 会话没有被删除。</div>}
    </>}
    {visible && selected && showDetails && <Modal title={`${selected.alias} · 来源与嵌入`} onClose={closeDetails}>
      <dl className="source-details"><div><dt>原站入口</dt><dd>{base || selected.browserBaseUrl}</dd></div><div><dt>当前工作区入口</dt><dd>{target || '地址无效'}</dd></div><div><dt>嵌入状态</dt><dd>{embedLabels[selected.embedStatus]}</dd></div><div><dt>保活页面</dt><dd>{rendered.length} / 3</dd></div></dl>
      <div className="notice"><div><strong>原站身份独立</strong>在 NF / 反向代理中，将中心 origin <code>{window.location.origin}</code> 加入明确的嵌入允许列表。allowedOrigins 同时影响 CSP 与部分 CORS；各 NF 使用独立 origin，且主机名与中心不同。工作台不读取跨域页面，页面加载不代表登录或验证成功。</div></div>
    </Modal>}
    <div ref={iframeAreaRef} className={`iframe-area${isSplit ? ' is-split' : ''}${interacting ? ' dragging-active' : ''}${activeDividerOrientation ? ` resizing-${activeDividerOrientation}` : ''}`} hidden={!isSplit && (!selected || !urlValid || selected.connection === 'revoked')}>
      {rendered.map(frame => {
        const paneIndex = isSplit ? split.paneIds.indexOf(frame.instanceId) : -1;
        const paneRect = isSplit && paneIndex >= 0 ? rects[paneIndex] : undefined;
        const frameHidden = isSplit ? paneIndex < 0 : frame.instanceId !== selected?.id;
        const frameStyle = paneRect
          ? { left: `${paneRect.left}%`, top: `calc(${paneRect.top}% + var(--pane-header-h))`, right: 'auto', bottom: 'auto', width: `${paneRect.width}%`, height: `calc(${paneRect.height}% - var(--pane-header-h))` }
          : undefined;
        return <iframe
          key={frameKey(frame)}
          title={`${byId.get(frame.instanceId)?.alias ?? 'NF'} 原站工作区`}
          src={frame.target}
          hidden={frameHidden}
          style={frameStyle}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-write"
        />;
      })}
      {isSplit && rects.map((rect, index) => {
        const paneId = split.paneIds[index] ?? null;
        const paneInstance = paneId ? byId.get(paneId) : undefined;
        const paneGrant = paneId ? grants.get(paneId) : undefined;
        const focused = index === split.focusedPane;
        const online = paneInstance?.connection === 'connected' && paneInstance?.freshness === 'fresh';
        return <div key={`pane-${index}`} className="split-pane-chrome">
          <div
            className={`split-pane-header${focused ? ' focused' : ''}${paneId ? ' draggable' : ''}`}
            style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%` }}
            draggable={!!paneId && !!onSplitChange}
            onClick={() => onFocusPane?.(index)}
            onDragStart={event => {
              if (!paneId || (event.target as HTMLElement | null)?.closest('button, select')) { event.preventDefault(); return; }
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(INSTANCE_DRAG_MIME, paneId);
              event.dataTransfer.setData('text/plain', paneId);
              onDragTabChange?.(paneId);
            }}
            onDragEnd={() => { setHoverDrop(null); onDragTabChange?.(null); }}
          >
            <span className={`tiny-dot ${online ? 'online' : ''}`} />
            <select
              className="split-pane-select"
              aria-label={`分屏 ${index + 1} 实例`}
              value={paneId ?? ''}
              onClick={event => event.stopPropagation()}
              onChange={event => { onSplitChange?.(assignPane(split, index, event.target.value || null)); }}
            >
              {!paneId && <option value="">选择实例…</option>}
              {instances.map(item => {
                const otherIndex = split.paneIds.indexOf(item.id);
                return <option key={item.id} value={item.id}>{item.alias}{otherIndex >= 0 && otherIndex !== index ? ' (对调)' : ''}</option>;
              })}
            </select>
            <div className="split-pane-actions" onClick={event => event.stopPropagation()}>
              <button type="button" className="icon-button" aria-label={`刷新分屏 ${index + 1}`} title="刷新此分屏" disabled={!paneGrant} onClick={() => { if (paneGrant) setFrames(value => refreshFrame(value, paneGrant)); }}><Icon name="refresh" size={14} /></button>
              <button type="button" className="icon-button" aria-label={`对调分屏 ${index + 1}`} title="与下一分屏对调" onClick={() => onSplitChange?.(swapPanes(split, index, (index + 1) % split.paneIds.length))}><Icon name="swap" size={14} /></button>
              <button type="button" className="icon-button" aria-label={`全屏显示分屏 ${index + 1}`} title="切换为单屏" onClick={() => onSplitChange?.({ mode: 'single', paneIds: [paneId], focusedPane: 0, ratios: defaultRatios('single') })}><Icon name="maximize" size={14} /></button>
              <button type="button" className="icon-button" aria-label={`关闭分屏 ${index + 1}`} title="关闭此分屏" onClick={() => onSplitChange?.(closeSplitPane(split, index))}><Icon name="close" size={14} /></button>
            </div>
          </div>
          {(!paneInstance || !paneGrant) && <div
            className="split-pane-empty"
            style={{ left: `${rect.left}%`, top: `calc(${rect.top}% + var(--pane-header-h))`, width: `${rect.width}%`, height: `calc(${rect.height}% - var(--pane-header-h))` }}
            onClick={() => onFocusPane?.(index)}
          >
            <span>{!paneInstance ? '在上方选择要显示的实例' : paneInstance.connection === 'revoked' ? `${paneInstance.alias} 授权已撤销` : `${paneInstance.alias} 地址不符合安全要求`}</span>
          </div>}
          {draggingTabId && <div
            className={`split-pane-drop${hoverDrop === `pane-${index}` ? ' over' : ''}`}
            style={{ left: `${rect.left}%`, top: `calc(${rect.top}% + var(--pane-header-h))`, width: `${rect.width}%`, height: `calc(${rect.height}% - var(--pane-header-h))` }}
            onDragOver={allowDrop(`pane-${index}`)}
            onDragLeave={() => { if (hoverDrop === `pane-${index}`) setHoverDrop(null); }}
            onDrop={handlePaneDrop(index)}
          >
            <span>{paneId === draggingTabId ? '当前窗口' : split.paneIds.includes(draggingTabId) ? '松开与此窗口对调' : '松开在此窗口显示'}</span>
          </div>}
        </div>;
      })}
      {isSplit && dividers.map(divider => <div
        key={divider.id}
        role="separator"
        tabIndex={0}
        aria-orientation={divider.orientation}
        aria-label="拖动调整分屏大小，双击均分"
        title="拖动调整大小 · 双击均分"
        className={`split-divider ${divider.orientation}${resizingDivider === divider.id ? ' active' : ''}`}
        style={divider.orientation === 'vertical'
          ? { left: `${divider.left}%`, top: `${divider.top}%`, height: `${divider.length}%` }
          : { left: `${divider.left}%`, top: `${divider.top}%`, width: `${divider.length}%` }}
        onPointerDown={event => startResize(divider, event)}
        onDoubleClick={() => onSplitChange?.({ ...split, ratios: defaultRatios(split.mode) })}
        onKeyDown={event => keyboardResize(divider, event)}
      />)}
      {resizingDivider !== null && <div className="split-drag-shield" />}
      {!isSplit && draggingTabId && selected && draggingTabId !== selected.id && instances.length >= 2 && onSplitChange && <div className="split-drop-zones" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverDrop(null); }}>
        <div className="split-drop-row">
          <div className={`split-drop-zone${hoverDrop === 'left' ? ' over' : ''}`} onDragOver={allowDrop('left')} onDrop={handleSingleDrop('left')}><Icon name="split" size={18} /><span>左侧分屏</span></div>
          <div className={`split-drop-zone${hoverDrop === 'replace' ? ' over' : ''}`} onDragOver={allowDrop('replace')} onDrop={handleSingleDrop('replace')}><Icon name="screen" size={18} /><span>主屏显示</span></div>
          <div className={`split-drop-zone${hoverDrop === 'right' ? ' over' : ''}`} onDragOver={allowDrop('right')} onDrop={handleSingleDrop('right')}><Icon name="split" size={18} /><span>右侧分屏</span></div>
        </div>
        <div className={`split-drop-zone split-drop-bottom${hoverDrop === 'bottom' ? ' over' : ''}`} onDragOver={allowDrop('bottom')} onDrop={handleSingleDrop('bottom')}><Icon name="splitV" size={18} /><span>下侧分屏</span></div>
      </div>}
    </div>
  </section>;
}
