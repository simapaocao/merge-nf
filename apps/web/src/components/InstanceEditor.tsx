import { useState, type FormEvent } from 'react';
import { createInstanceSchema, normalizeBrowserBaseUrl, updateInstanceSchema, type CreateInstance, type Instance, type UpdateInstance } from '@nf-hub/protocol';
import { ErrorBanner, Modal } from './Common';
import { HttpAccessGuide } from './HttpAccessGuide';
import { addressChange, httpsFrontSuggestion, isHttpUrl, isLoopbackHttp, urlHostname } from './httpFrontAddress';

const GENERIC_ADDRESS_ERROR = '访问地址必须是无账号、查询参数或片段的独立 HTTPS 地址；NF 主机名不能与中心相同。回环开发可使用不同主机名的 HTTP 地址。';

export function InstanceEditor({ instance, onClose, onSave }: { instance?: Instance; onClose: () => void; onSave: (value: CreateInstance | UpdateInstance) => Promise<void> }) {
  const [alias, setAlias] = useState(instance?.alias ?? '');
  const [group, setGroup] = useState(instance?.group ?? '');
  const [browserBaseUrl, setBrowserBaseUrl] = useState(instance?.browserBaseUrl ?? '');
  const [color, setColor] = useState(instance?.color ?? '#396B78');
  const [order, setOrder] = useState(String(instance?.order ?? 0));
  const [favorite, setFavorite] = useState(instance?.favorite ?? false);
  const [error, setError] = useState<unknown>(null);
  const [validation, setValidation] = useState('');
  const [busy, setBusy] = useState(false);

  const change = addressChange(instance?.browserBaseUrl, browserBaseUrl);
  const httpInput = isHttpUrl(browserBaseUrl);
  const loopbackHttp = isLoopbackHttp(browserBaseUrl);
  const needsFront = httpInput && !loopbackHttp;
  const suggestion = needsFront ? httpsFrontSuggestion(browserBaseUrl) : null;
  const originalHost = instance ? urlHostname(instance.browserBaseUrl) : '';
  const urlDirty = !!instance && browserBaseUrl.trim() !== instance.browserBaseUrl;

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setValidation('');
    let normalized: string;
    try { normalized = normalizeBrowserBaseUrl(browserBaseUrl.trim(), window.location.origin); }
    catch { setValidation(needsFront ? '当前地址是 HTTP，浏览器会按混合内容阻止，也不满足这里的 HTTPS 要求。请按下方路径为设备加独立 HTTPS 前置，再填写前置的 HTTPS 地址。' : GENERIC_ADDRESS_ERROR); return; }
    const value = { alias: alias.trim(), group: group.trim(), color, order: Number(order), favorite, browserBaseUrl: normalized };
    const result = (instance ? updateInstanceSchema : createInstanceSchema).safeParse(value);
    if (!result.success) { setValidation('请检查别名、分组、颜色和排序：别名不能为空，名称最多 80 字，排序须为 -1000000 到 1000000 的整数。'); return; }
    setBusy(true);
    try { await onSave(result.data); } catch (reason) { setError(reason); } finally { setBusy(false); }
  };

  return <Modal title={instance ? '编辑实例' : '添加实例'} onClose={onClose} wide><form className="form-stack" onSubmit={submit}>
    {change === 'add' && <div className="notice"><div><strong>新增设备</strong>保存后为这台设备生成一次性配对码，在设备插件的网页设置中填写中心地址与该码，完成一次配对。默认不发布任何摘要。</div></div>}
    {change === 'port' && <div className="notice"><div><strong>同一台设备，只修改 IP 或端口</strong>保存后原授权、配对码与发布范围保持不变，不需要重新配对。浏览器会按新地址加载页面，请在原站重新确认嵌入信任。</div></div>}
    {change === 'unchanged' && urlDirty && <div className="notice"><div><strong>同一台设备，只修改基路径</strong>保存后原授权、配对码与发布范围保持不变，不需要重新配对。浏览器会按新地址加载页面，请在原站重新确认嵌入信任。</div></div>}
    {change === 'host' && <div className="notice notice-warning"><div><strong>地址的主机名已改变{originalHost ? `（原为 ${originalHost}）` : ''}</strong>若仍是同一台设备、只换了 IP 或端口：直接保存，原授权与发布范围保持不变，不需要重新配对，保存后在原站重新确认嵌入信任。若换成另一台实际设备：先在连接管理中撤销原授权，再保存并生成新的配对码。调整发布范围或更换中心地址，同样先撤销再重新配对；撤销不会删除原站会话。</div></div>}
    <div className="form-columns"><label>实例别名<input autoComplete="off" placeholder="如：办公电脑" required maxLength={80} value={alias} onChange={event => setAlias(event.target.value)} /></label><label>分组<span className="optional">选填</span><input placeholder="如：开发环境" maxLength={80} value={group} onChange={event => setGroup(event.target.value)} /></label></div>
    <label>浏览器访问地址<input type="url" placeholder="https://10.8.0.12:8443" required maxLength={2048} value={browserBaseUrl} onChange={event => setBrowserBaseUrl(event.target.value)} autoComplete="url" spellCheck={false} /><small>每台 NF 使用独立 origin，中心与 NF 必须使用不同 hostname，不可仅换端口。工作台使用正式域名（如 www.smpc.asia），设备使用 IP 加端口。支持已有基路径。</small></label>
    {needsFront && <div className="notice notice-warning" role="alert"><div><strong>HTTP 地址需要独立 HTTPS 前置</strong>原 HTTP 服务保持不变，在设备本机、可信局域网或 VPN 内的网关上另起 HTTPS 前置，然后把前置的 HTTPS 地址填到这里。当前设备 HTTP 为 <code>{browserBaseUrl.trim()}</code>，前置监听 8443 后应填 <code>{suggestion}</code>。不要填原 HTTP 地址，也不要把原端口直接写成 https。<div className="http-suggestion"><button type="button" className="button secondary small" onClick={() => { if (suggestion) setBrowserBaseUrl(suggestion); }}>填入前置 HTTPS 地址</button><span>保存地址不会部署前置，需先按下方步骤运行前置并确认证书可信。</span></div></div></div>}
    {httpInput && loopbackHttp && <div className="notice"><div><strong>回环 HTTP 仅用于本机开发</strong>其他电脑或手机访问时浏览器会阻止该地址。请改为 HTTPS 入口，或使用下方的 HTTPS 前置方案。</div></div>}
    <HttpAccessGuide defaultOpen={needsFront} />
    <div className="form-columns"><label>标识颜色<div className="color-field"><input type="color" value={color} onChange={event => setColor(event.target.value)} /><span>{color.toUpperCase()}</span></div></label><label>排序<input type="number" min={-1000000} max={1000000} step={1} required value={order} onChange={event => setOrder(event.target.value)} /><small>数字越小越靠前，收藏优先。</small></label></div>
    <label className="check-label"><input type="checkbox" checked={favorite} onChange={event => setFavorite(event.target.checked)} />收藏此实例</label>
    {validation && <div className="notice notice-error" role="alert">{validation}</div>}<ErrorBanner error={error} />
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : instance ? '保存更改' : '添加实例'}</button></div>
  </form></Modal>;
}
