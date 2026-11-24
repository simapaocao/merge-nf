import { useEffect, useState } from 'react';
import { HTTP_FRONT_FILES, downloadHttpFrontFile } from '../lib/httpAccessTemplates';
import { Icon } from './Icon';

/**
 * HTTP 设备的可执行接入路径：原 HTTP 服务保持不变，另起独立 HTTPS 前置，
 * 再把前置的 HTTPS 地址填入访问地址。不声称前置已部署，也不接受混合内容。
 */
export function HttpAccessGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [error, setError] = useState('');
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  const download = (file: { name: string; content: string }) => {
    try { downloadHttpFrontFile(file); setError(''); }
    catch { setError('浏览器拒绝直接下载，请改用浏览器另存，或复制文件内容后手动保存。'); }
  };
  return <details className="http-guide" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="info" size={15} />设备只有 HTTP 时的 HTTPS 前置方案（含配置下载）</summary>
    <div className="http-guide-body">
      <div>
        <p><strong>先选一种可达方式</strong></p>
        <ul>
          <li>设备已有可信 HTTPS 入口：直接把该 HTTPS 地址填入访问地址。</li>
          <li>设备只提供 HTTP：保持原 HTTP 服务不改，另外启动独立 HTTPS 前置，再把前置的 HTTPS 地址填入。</li>
          <li>跨网络：先建立 VPN，或让设备具备可达的公网 HTTPS 入口。带登录凭据的 HTTP 不跨公网传输。</li>
        </ul>
      </div>
      <ol className="setup-steps">
        <li><strong>下载三份配置</strong><span>前置站点配置、容器编排与环境变量样例，内容与仓库模板一致，直接保存到空目录。</span></li>
        <li><strong>填写 IP、端口与上游</strong><span>前置监听 8443，上游指向设备固定的 HTTP 服务，例如 10.8.0.12:7778。</span></li>
        <li><strong>运行前置</strong><span>在设备本机、可信局域网或 VPN 内的网关上启动前置，并确认它能访问上面填写的 HTTP 上游。</span></li>
        <li><strong>确认设备 HTTPS 可信</strong><span>用浏览器打开前置地址，确认证书由可信来源签发且主机名匹配。证书与 CA 由你自行签发与安装。</span></li>
        <li><strong>填入前置地址并配对</strong><span>回到这里填写前置的 HTTPS 地址，例如 https://10.8.0.12:8443，再到设备插件的网页设置中完成配对。</span></li>
      </ol>
      <div>
        <p><strong>填写要求</strong>示例：设备 HTTP 为 http://10.8.0.12:7778，前置监听 8443 后在此填 https://10.8.0.12:8443。不要填 http://10.8.0.12:7778，也不要把 7778 直接写成 https。保存地址不会自动部署前置，需要先按上面步骤把前置运行起来。</p>
      </div>
      <div>
        <p><strong>安全边界</strong>HTTP 到前置这一段只走设备本机、可信局域网或 VPN；公共互联网只访问 HTTPS 入口。前置只转发原站的安全响应头，不通过删除安全头或伪造 Origin 来强行嵌入。目标 NF 仍须精确允许正式工作台 origin 与自身 HTTPS 入口 origin，不使用通配符。工作台与设备使用不同 hostname：工作台用正式域名（如 www.smpc.asia），设备用 IP 加端口。</p>
      </div>
      <div className="http-file-list" role="group" aria-label="下载 HTTPS 前置配置">
        {HTTP_FRONT_FILES.map(file => <button key={file.name} type="button" className="button secondary small" onClick={() => download(file)}><Icon name="external" size={15} />下载 {file.name}</button>)}
      </div>
      {error && <div className="notice notice-warning" role="alert">{error}</div>}
    </div>
  </details>;
}
