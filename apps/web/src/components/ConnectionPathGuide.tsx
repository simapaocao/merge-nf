/**
 * 连接管理的操作方法说明：新增设备、只改地址、更换设备三种路径，以及 HTTP 设备的 HTTPS 前置路径。
 * 只写操作步骤与安全边界，不含实例数据。
 */
export function ConnectionPathGuide() {
  return <section className="connection-paths">
    <h2>三种操作怎么选</h2>
    <div>
      <p><strong>新增设备</strong>添加实例 → 保存 → 生成一次性配对码 → 在设备插件的网页设置中填写中心地址与该码，完成一次配对。</p>
      <p><strong>同一台设备只改 IP 或端口</strong>编辑并保存，原授权与发布范围不变，不需要重新配对；浏览器会按新地址加载页面，请在原站重新确认嵌入信任。</p>
      <p><strong>换成另一台实际设备、调整发布范围或更换中心地址</strong>先撤销原授权，再重新配对。撤销只废止令牌与中心摘要，不修改原站会话。</p>
    </div>
    <details>
      <summary>设备只有 HTTP 时怎么接入</summary>
      <div>
        <p>浏览器可访问的三种方式：设备已有可信 HTTPS 入口就直接填该地址；设备只提供 HTTP 时保持原服务不变，另起独立 HTTPS 前置后填前置地址；跨网络先建立 VPN，或让设备具备可达的公网 HTTPS 入口。</p>
        <p>前置示例：设备 HTTP 为 http://10.8.0.12:7778，前置监听 8443 后填写 https://10.8.0.12:8443。不要填原 HTTP 地址，也不要把 7778 直接写成 https。填写地址不会部署前置；在「添加实例」或「编辑」中可下载前置配置并查看完整步骤。</p>
        <p>工作台与设备必须使用不同 hostname：工作台用正式域名（如 www.smpc.asia），设备用 IP 加端口。HTTP 到前置这一段只走设备本机、可信局域网或 VPN，公网只访问 HTTPS 入口。目标 NF 仍须精确允许正式工作台 origin 与自身 HTTPS 入口 origin，不使用通配符。</p>
      </div>
    </details>
  </section>;
}
