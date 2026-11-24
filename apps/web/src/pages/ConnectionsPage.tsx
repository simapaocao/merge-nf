import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { instanceSchema, pairingSchema, routes, type CreateInstance, type Instance, type Pairing, type UpdateInstance } from '@nf-hub/protocol';
import { ConnectionPathGuide } from '../components/ConnectionPathGuide';
import { ConnectionPill, EmptyState, ErrorBanner, Modal, PageHeading } from '../components/Common';
import { isHttpUrl, isLoopbackHttp } from '../components/httpFrontAddress';
import { Icon } from '../components/Icon';
import { InstanceEditor } from '../components/InstanceEditor';
import { PairingDialog } from '../components/PairingDialog';
import { useAppState } from '../hooks/useAppState';
import { api } from '../lib/api';
import { ApiError } from '../lib/errors';
import { absoluteTime, countLabel, embedLabels, relativeTime, scopeLabel } from '../lib/format';
import { navigate, reloadDocument } from '../lib/navigation';

type PairState = { instanceId: string; alias: string; generation: number; pairing: Pairing };
type Confirmation = { kind: 'revoke' | 'delete'; instance: Instance };
export function ConnectionsPage({ instances, loading, unavailable = false }: { instances: Instance[]; loading: boolean; unavailable?: boolean }) {
  const { revision, removedInstance, resetInstance } = useAppState();
  const client = useQueryClient();
  const [editor, setEditor] = useState<Instance | 'new' | null>(null);
  const [pair, setPair] = useState<PairState | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<unknown>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const closeEditor = useCallback(() => setEditor(null), []);
  const closePair = useCallback(() => setPair(null), []);
  const closeConfirm = useCallback(() => { if (!confirmBusy) setConfirmation(null); }, [confirmBusy]);
  useEffect(() => {
    if (!pair) return;
    const item = instances.find(instance => instance.id === pair.instanceId);
    if (item && item.generation >= pair.generation && (item.generation > pair.generation || item.connection === 'connected' || item.connection === 'lost' || item.connection === 'revoked')) setPair(null);
  }, [instances, pair]);
  useEffect(() => { if (removedInstance) setPair(value => value?.instanceId === removedInstance.id ? null : value); }, [removedInstance]);

  const save = async (value: CreateInstance | UpdateInstance) => {
    const original = editor && editor !== 'new' ? editor : null;
    const result = await api.request(original ? routes.instance(original.id) : routes.instances, instanceSchema, { method: original ? 'PATCH' : 'POST', body: value });
    if (!result.data) throw new ApiError('INVALID_RESPONSE');
    if (!original || original.browserBaseUrl !== result.data.browserBaseUrl) {
      reloadDocument({ view: 'connections', instanceId: result.data.id });
      return;
    }
    await client.invalidateQueries({ queryKey: ['private', revision, 'instances'] });
    setEditor(null);
  };
  const generatePair = async (instance: Instance) => {
    setError(null); setBusyId(instance.id);
    try {
      const result = await api.request(routes.pairing(instance.id), pairingSchema, { method: 'POST' });
      if (!result.data) throw new ApiError('INVALID_RESPONSE');
      setPair({ instanceId: instance.id, alias: instance.alias, generation: instance.generation + 1, pairing: result.data });
      await client.invalidateQueries({ queryKey: ['private', revision] });
    } catch (reason) { setError(reason); } finally { setBusyId(null); }
  };
  const confirm = async () => {
    if (!confirmation) return;
    setConfirmError(null); setConfirmBusy(true);
    const { instance, kind } = confirmation;
    try {
      await api.request(kind === 'delete' ? routes.instance(instance.id) : routes.revoke(instance.id), instanceSchema, { method: kind === 'delete' ? 'DELETE' : 'POST' });
      setPair(null);
      resetInstance(instance.id);
      setConfirmation(null);
    } catch (reason) { setConfirmError(reason); } finally { setConfirmBusy(false); }
  };
  const ask = (kind: Confirmation['kind'], instance: Instance) => { setConfirmError(null); setConfirmation({ kind, instance }); };

  return <div className="page connections-page"><PageHeading eyebrow="连接与授权" title="连接管理" description="管理实例入口与只读摘要授权，两项状态独立验证。" action={<button className="button primary" onClick={() => setEditor('new')}><Icon name="plus" />添加实例</button>} />
    <div className="connection-intro"><div className="intro-icon"><Icon name="link" size={22} /></div><div><strong>新接入从空范围开始</strong><p>添加实例 → 在 NF 启用 / 激活插件 → 填入中心地址与一次性码 → 选择发布范围 → 等待摘要 → 配置嵌入信任。</p></div><span className="pill neutral">只读摘要</span></div>
    <ConnectionPathGuide />
    <ErrorBanner error={error} />
    {loading ? <div className="loading-state" role="status">正在读取连接配置…</div> : unavailable ? <section className="panel"><EmptyState title="暂时无法读取实例" detail="请确认中心服务可访问，并通过上方错误提示重试。未读取到数据不代表没有配置实例。" /></section> : !instances.length ? <section className="panel"><EmptyState title="还没有配置实例" detail="先填写你在浏览器使用的 NF 地址，再到 NF 插件中完成配对。中心与 NF 使用不同主机名。" action={<button className="button primary" onClick={() => setEditor('new')}><Icon name="plus" />添加第一台实例</button>} /></section> : <div className="connection-grid">{instances.map(instance => <article className="panel connection-card" key={instance.id}>
      <div className="connection-card-heading"><span className="instance-avatar" style={{ backgroundColor: instance.color }}>{instance.alias.slice(0, 1)}</span><div><h2>{instance.alias}{instance.favorite && <span className="favorite-label">收藏</span>}</h2><span>{instance.group || '未分组'}</span></div><ConnectionPill instance={instance} /></div>
      <div className="connection-url" title={instance.browserBaseUrl}>{instance.browserBaseUrl}</div>
      <dl className="connection-details"><div><dt>已同步会话</dt><dd>{countLabel(instance.sessionCount)}</dd></div><div><dt>最近完整同步</dt><dd title={absoluteTime(instance.lastSuccessAt)}>{relativeTime(instance.lastSuccessAt)}</dd></div><div><dt>最近认证联络</dt><dd title={absoluteTime(instance.lastContactAt)}>{relativeTime(instance.lastContactAt)}</dd></div><div><dt>原站嵌入</dt><dd>{embedLabels[instance.embedStatus]}</dd></div></dl>
      <div className="scope-box"><div><span>发布范围</span><small>只读 · 在 NF 插件中选择</small></div><strong>{scopeLabel(instance.scope)}</strong>{instance.scope.mode === 'projects' && <details><summary>查看已选项目 ID</summary><p>{instance.scope.projectIds.join('、') || '仅独立会话'}</p></details>}{instance.scope.mode === 'sessions' && <details><summary>查看已选会话 ID</summary><p>{instance.scope.sessionIds.join('、')}</p></details>}</div>
      {instance.lastError && <div className="notice notice-warning">摘要同步失败 · {instance.lastError}。旧快照仅供参考，请在 NF 插件中检查并重试。</div>}
      {isHttpUrl(instance.browserBaseUrl) && <div className="notice notice-warning">{isLoopbackHttp(instance.browserBaseUrl) ? '此地址是回环 HTTP，仅本机可访问；其他电脑或手机需改为 HTTPS 入口。' : '此地址是 HTTP，浏览器会按混合内容阻止。请为设备部署独立 HTTPS 前置后改为填写前置的 HTTPS 地址。'}</div>}
      <div className="connection-meta"><span>授权代次 {instance.generation}</span><span>插件 {instance.connectorVersion || '—'} · NF {instance.nfVersion || '—'}</span></div>
      <div className="connection-card-actions"><button className="button secondary small" onClick={() => navigate({ view: 'workbench', instanceId: instance.id })}><Icon name="screen" size={16} />进入工作台</button><button className="text-button" onClick={() => setEditor(instance)}>编辑</button><span className="action-spacer" /><button className="text-button" disabled={busyId === instance.id || instance.connection === 'connected' || instance.connection === 'lost'} title={instance.connection === 'connected' || instance.connection === 'lost' ? '已配对，须先撤销旧授权' : undefined} onClick={() => { void generatePair(instance); }}>{busyId === instance.id ? '正在生成…' : '生成配对码'}</button><button className="text-button danger-text" onClick={() => ask('revoke', instance)}>撤销</button><button className="text-button danger-text" onClick={() => ask('delete', instance)}>删除</button></div>
    </article>)}</div>}
    <section className="connection-help"><h2>连接状态说明</h2><div><p><strong>上报与嵌入分开验证</strong>插件能上报不代表浏览器可以嵌入。NF 的 allowedOrigins 是 CSP 和部分 CORS 的明确允许列表，不自动授予摘要发布权限；应精确允许正式工作台 origin（嵌入）与设备自身 HTTPS 入口 origin（登录与页面会话），不使用通配符。</p><p><strong>暂停不等于撤销</strong>停用、卸载或暂停 NF 插件只停止发送，不会撤销中心的旧授权。缩小范围、更换配对时，请先在此撤销，再回到插件重新配对。</p><p><strong>撤销不删除原 NF 会话</strong>撤销会废止旧令牌并清除中心摘要；删除还会移除中心的实例配置。两者都不修改原站会话。</p></div></section>
    {editor && <InstanceEditor instance={editor === 'new' ? undefined : editor} onClose={closeEditor} onSave={save} />}
    {pair && <PairingDialog alias={pair.alias} pairing={pair.pairing} onClose={closePair} />}
    {confirmation && <Modal title={confirmation.kind === 'delete' ? '删除实例？' : '撤销中心授权？'} onClose={closeConfirm}><div className="form-stack"><p>实例：<strong>{confirmation.instance.alias}</strong></p><div className="notice notice-warning">{confirmation.kind === 'delete' ? '将删除中心的实例配置、配对授权及会话摘要。' : '将立即废止旧令牌和配对码，移除中心旧摘要；重新接入需要新配对码。'}<strong>不会删除或修改原 NF 会话。</strong></div><p className="muted">已展示、截图或外部备份的内容无法追回。停用插件与中心撤销是不同操作。</p><ErrorBanner error={confirmError} /><div className="modal-actions"><button className="button secondary" disabled={confirmBusy} onClick={closeConfirm}>取消</button><button className="button danger" disabled={confirmBusy} onClick={() => { void confirm(); }}>{confirmBusy ? '正在处理…' : confirmation.kind === 'delete' ? '确认删除实例' : '确认撤销授权'}</button></div></div></Modal>}
  </div>;
}
