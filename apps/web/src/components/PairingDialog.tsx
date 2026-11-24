import { useEffect, useState } from 'react';
import type { Pairing } from '@nf-hub/protocol';
import { absoluteTime } from '../lib/format';
import { Modal } from './Common';
import { Icon } from './Icon';

export function PairingDialog({ alias, pairing, onClose }: { alias: string; pairing: Pairing; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopyState('done'); } catch { setCopyState('failed'); }
  };
  return <Modal title={`连接 ${alias}`} onClose={onClose} wide><div className="form-stack">
    <div className="notice notice-warning">配对码只在此窗口显示，请勿发给其他人。关闭后不会保存；如未完成配对，先撤销再生成新码。</div>
    <div className="notice"><div><strong>这是一次新增设备或重新配对</strong>同一台设备只修改 IP 或端口不需要配对码，编辑保存即可，原授权不变。更换实际设备、调整发布范围或更换中心地址时，才需要撤销后重新配对。</div></div>
    <label>中心地址<div className="copy-field"><code>{window.location.origin}</code><button className="icon-button" title="复制中心地址" aria-label="复制中心地址" onClick={() => { void copy(window.location.origin); }}><Icon name="copy" /></button></div></label>
    <label>一次性配对码{seconds > 0 ? <div className="pairing-code"><code>{pairing.code}</code><button className="button secondary small" onClick={() => { void copy(pairing.code); }}><Icon name="copy" size={16} />复制配对码</button></div> : <div className="notice">配对码已过期，明文已隐藏。请先撤销旧授权，再重新生成。</div>}<small>有效期至 {absoluteTime(pairing.expiresAt)} · 剩余 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒</small></label>
    {copyState === 'done' && <div className="copy-feedback" role="status">已复制。粘贴完成后请自行清理剪贴板。</div>}{copyState === 'failed' && <div className="notice notice-warning" role="alert">浏览器拒绝剪贴板操作，请手动选中并复制上方内容。</div>}
    <ol className="setup-steps"><li><strong>安装并启用 / 激活插件</strong><span>在目标 NF 中安装连接插件，并确认所需出站设置。</span></li><li><strong>填写中心地址和配对码</strong><span>聚合地址使用此处显示的固定地址，不复制任何 NF 登录令牌。浏览器访问 NF 的地址与中心必须使用不同 hostname：工作台用正式域名，设备用 IP 加端口。</span></li><li><strong>设备只有 HTTP 时先加 HTTPS 前置</strong><span>保持设备原 HTTP 服务不变，在设备本机、可信局域网或 VPN 内的网关上另起 HTTPS 前置；浏览器与插件都用前置的 HTTPS 地址，不填原 HTTP 地址。配置可在「连接管理 → 编辑 / 添加实例」中下载。</span></li><li><strong>明确选择发布范围</strong><span>默认范围为空。仅上传所选摘要，不上传正文；实际选择在 NF 插件中完成。</span></li><li><strong>等待首次完整摘要</strong><span>成功空快照显示 0；首次同步前显示 —。</span></li><li><strong>配置嵌入信任并人工验证</strong><span>在 NF 明确的 allowedOrigins 中精确加入中心 origin 用于嵌入，并精确加入设备自身 HTTPS 入口 origin 用于登录与页面会话；不使用通配符。它同时影响 CSP 与部分 CORS。</span></li></ol>
    <div className="modal-actions"><button className="button primary" onClick={onClose}>完成并隐藏配对码</button></div>
  </div></Modal>;
}
