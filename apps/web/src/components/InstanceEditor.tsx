import { useState, type FormEvent } from 'react';
import { createInstanceSchema, normalizeBrowserBaseUrl, updateInstanceSchema, type CreateInstance, type Instance, type UpdateInstance } from '@nf-hub/protocol';
import { ErrorBanner, Modal } from './Common';

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
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null); setValidation('');
    let normalized: string;
    try { normalized = normalizeBrowserBaseUrl(browserBaseUrl.trim(), window.location.origin); }
    catch { setValidation('访问地址必须是无账号、查询参数或片段的独立 HTTPS 地址；NF 主机名不能与中心相同。回环开发可使用不同主机名的 HTTP 地址。'); return; }
    const value = { alias: alias.trim(), group: group.trim(), color, order: Number(order), favorite, browserBaseUrl: normalized };
    const result = (instance ? updateInstanceSchema : createInstanceSchema).safeParse(value);
    if (!result.success) { setValidation('请检查别名、分组、颜色和排序：别名不能为空，名称最多 80 字，排序须为 -1000000 到 1000000 的整数。'); return; }
    setBusy(true);
    try { await onSave(result.data); } catch (reason) { setError(reason); } finally { setBusy(false); }
  };
  return <Modal title={instance ? '编辑实例' : '添加实例'} onClose={onClose} wide><form className="form-stack" onSubmit={submit}>
    <div className="form-columns"><label>实例别名<input autoComplete="off" placeholder="如：办公电脑" required maxLength={80} value={alias} onChange={event => setAlias(event.target.value)} /></label><label>分组<span className="optional">选填</span><input placeholder="如：开发环境" maxLength={80} value={group} onChange={event => setGroup(event.target.value)} /></label></div>
    <label>浏览器访问地址<input type="url" placeholder="https://nf.your-domain.net/" required maxLength={2048} value={browserBaseUrl} onChange={event => setBrowserBaseUrl(event.target.value)} autoComplete="url" spellCheck={false} /><small>每台 NF 使用独立 origin，中心与 NF 必须使用不同 hostname，不可仅换端口。支持已有基路径。</small></label>
    <div className="form-columns"><label>标识颜色<div className="color-field"><input type="color" value={color} onChange={event => setColor(event.target.value)} /><span>{color.toUpperCase()}</span></div></label><label>排序<input type="number" min={-1000000} max={1000000} step={1} required value={order} onChange={event => setOrder(event.target.value)} /><small>数字越小越靠前，收藏优先。</small></label></div>
    <label className="check-label"><input type="checkbox" checked={favorite} onChange={event => setFavorite(event.target.checked)} />收藏此实例</label>
    {!instance && <div className="notice">新实例默认不发布任何摘要。添加后，在 NF 插件中明确选择范围并完成配对。</div>}
    {validation && <div className="notice notice-error" role="alert">{validation}</div>}<ErrorBanner error={error} />
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : instance ? '保存更改' : '添加实例'}</button></div>
  </form></Modal>;
}
