import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { buildNarratorUrl, instanceSchema, normalizeBrowserBaseUrl, routes, type Instance } from '@nf-hub/protocol';
import { EmptyState, ErrorBanner, HeaderMenu, Modal } from '../components/Common';
import { Icon } from '../components/Icon';
import { useAppState } from '../hooks/useAppState';
import { api } from '../lib/api';
import { embedLabels } from '../lib/format';
import { authorizedFrames, frameKey, identityKey, pruneFrames, refreshFrame, touchFrame, type FrameEntry } from '../lib/frames';
import { isMixedContent, navigate, type LocationIntent } from '../lib/navigation';

export function resolveWorkbenchTarget({ base, sessionId, authorized, changedIdentity, retained, remembered }: { base: string; sessionId?: string; authorized: boolean; changedIdentity: boolean; retained?: string; remembered?: string }) {
  // Without the current identity grant, an old hash or remembered session must never reach another origin.
  if (!authorized) return { explicit: undefined, target: base };
  const explicit = sessionId && !changedIdentity ? buildNarratorUrl(base, sessionId) : undefined;
  return { explicit, target: explicit ?? retained ?? remembered ?? base };
}

export function WorkbenchPage({ instances, loaded, intent, visible, toolbarTarget }: { instances: Instance[]; loaded: boolean; intent: LocationIntent; visible: boolean; toolbarTarget?: HTMLElement | null }) {
  const { revision, removedInstance } = useAppState();
  const client = useQueryClient();
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const closeDetails = useCallback(() => setShowDetails(false), []);
  useEffect(() => { setShowDetails(false); }, [intent.instanceId, visible]);
  const selected = instances.find(item => item.id === intent.instanceId);
  const grants=useMemo(()=>authorizedFrames(loaded?instances:[],window.location.origin),[instances,loaded]);
  // LRU order is for eviction only. Moving a surviving iframe in the DOM can reload its document.
  const rendered=useMemo(()=>pruneFrames(frames,grants).sort((a,b)=>a.instanceId<b.instanceId?-1:a.instanceId>b.instanceId?1:0),[frames,grants]);
  const grant=selected ? grants.get(selected.id) : undefined, key=grant ? identityKey(grant) : '';
  const remembered=useRef(new Map<string,string>());
  const lastIntent=useRef<{id:string;session:string|undefined;key:string}|null>(null);
  const changedIdentity=!!(grant && intent.sessionId && lastIntent.current?.id===grant.instanceId && lastIntent.current.session===intent.sessionId && lastIntent.current.key!==key);
  let base='', target='', explicit:string|undefined, urlValid=true;
  if (selected) {
    try {
      base=normalizeBrowserBaseUrl(selected.browserBaseUrl,window.location.origin);
      ({ explicit, target } = resolveWorkbenchTarget({ base, sessionId: intent.sessionId, authorized: !!grant, changedIdentity, retained: rendered.find(f=>f.instanceId===selected.id)?.target, remembered: remembered.current.get(key) }));
    } catch { urlValid=false; }
  }
  useEffect(() => {
    if (visible && loaded && !intent.instanceId && instances[0]) navigate({ view: 'workbench', instanceId: instances[0].id });
  }, [visible, loaded, intent.instanceId, instances]);
  useEffect(() => {
    setFrames(value => {const next=pruneFrames(value,grants);return next.length===value.length?value:next;});
    const activeKeys=new Set([...grants.values()].map(identityKey));
    for(const id of remembered.current.keys()) if(!activeKeys.has(id)) remembered.current.delete(id);
  },[grants]);
  useEffect(() => {
    if(removedInstance) setFrames(value=>value.filter(frame=>frame.instanceId!==removedInstance.id));
  },[removedInstance]);
  useEffect(() => {
    if(!visible || !grant || !urlValid) return;
    if(changedIdentity){navigate({view:'workbench',instanceId:grant.instanceId});return;}
    const desired=explicit??remembered.current.get(key)??grant.browserBaseUrl;
    remembered.current.set(key,desired);lastIntent.current={id:grant.instanceId,session:intent.sessionId,key};
    setFrames(value=>touchFrame(value,grant,desired));setError(null);
  },[visible,key,explicit,intent.sessionId,urlValid,changedIdentity]);

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
    remembered.current.set(key,base);
    setFrames(value => refreshFrame(touchFrame(value, grant, base), grant));
    navigate({ view: 'workbench', instanceId: selected.id });
  };

  return <section className="workbench-page" hidden={!visible} aria-label="实例工作台">
    {visible && selected && toolbarTarget && createPortal(<div className="workbench-controls">
      <button className={`icon-button embed-status ${selected.embedStatus === 'verified' ? 'verified' : selected.embedStatus === 'blocked' ? 'blocked' : ''}`} aria-label={`${selected.alias}：${embedLabels[selected.embedStatus]}，查看来源与嵌入详情`} title={`${selected.alias} · ${embedLabels[selected.embedStatus]}`} onClick={() => setShowDetails(true)}><span className="status-dot" /></button>
      <button className="icon-button" aria-label={`刷新 ${selected.alias} 原站`} title="刷新原站" disabled={!urlValid || !grant} onClick={() => { if (grant) setFrames(value => refreshFrame(value, grant)); }}><Icon name="refresh" size={17} /></button>
      <HeaderMenu label="更多原站操作" icon={<Icon name="more" size={20} />}>
        <div className="menu-heading">{selected.alias}</div>
        <button className="menu-item" data-close-menu disabled={!urlValid || !grant} onClick={home}><Icon name="home" size={17} />返回原站首页</button>
        {urlValid && <a className="menu-item" data-close-menu href={target} target="_blank" rel="noopener noreferrer"><Icon name="external" size={17} />在新窗口打开</a>}
        <button className="menu-item" data-close-menu onClick={() => setShowDetails(true)}><Icon name="info" size={17} />来源与嵌入详情</button>
        <div className="menu-divider" /><div className="menu-heading">人工验证 · {embedLabels[selected.embedStatus]}</div>
        <button className="menu-item" data-close-menu disabled={saving} onClick={() => { void setEmbedStatus('verified'); }}><Icon name="check" size={17} />我已验证可用</button>
        <button className="menu-item" data-close-menu disabled={saving} onClick={() => { void setEmbedStatus('blocked'); }}><Icon name="close" size={17} />我已确认受阻</button>
        {selected.embedStatus !== 'unverified' && <button className="menu-item muted" data-close-menu disabled={saving} onClick={() => { void setEmbedStatus('unverified'); }}><Icon name="refresh" size={17} />重置验证状态</button>}
        <p className="menu-note">原站独立登录，加载页面不代表验证成功。</p>
      </HeaderMenu>
    </div>, toolbarTarget)}
    {!selected ? <div className="page"><EmptyState title={loaded ? '选择一个实例开始工作' : '正在读取实例…'} detail="各实例保留独立登录状态，最多保活三个已打开的页面。" action={loaded && !instances.length ? <button className="button primary" onClick={() => navigate({ view: 'connections' })}><Icon name="plus" />添加实例</button> : undefined} /></div> : <>
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
    <div className="iframe-area" hidden={!selected || !urlValid || selected.connection === 'revoked'}>{rendered.map(frame => <iframe key={frameKey(frame)} title={`${instances.find(item => item.id === frame.instanceId)?.alias ?? 'NF'} 原站工作区`} src={frame.target} hidden={frame.instanceId !== selected?.id} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox" allow="clipboard-write" />)}</div>
  </section>;
}
