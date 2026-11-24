import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Instance } from '@nf-hub/protocol';
import { ConnectionPathGuide } from '../src/components/ConnectionPathGuide';
import { HttpAccessGuide } from '../src/components/HttpAccessGuide';
import { InstanceEditor } from '../src/components/InstanceEditor';
import { addressChange, httpsFrontSuggestion, isHttpUrl, isLoopbackHttp } from '../src/components/httpFrontAddress';
import { HTTP_FRONT_FILES } from '../src/lib/httpAccessTemplates';

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: '6380d660-028d-4444-967b-ec88df692aed', alias: '办公电脑', group: '', color: '#396B78', order: 0, favorite: false,
    browserBaseUrl: 'https://10.8.0.12:8443', embedStatus: 'unverified', generation: 1,
    scope: { mode: 'none', includeArchived: false }, connection: 'unpaired', freshness: 'never',
    lastContactAt: null, lastSuccessAt: null, lastError: null, sessionCount: null, connectorVersion: null, nfVersion: null,
    capabilities: null, ...overrides,
  };
}
const editor = (item: Instance) => renderToStaticMarkup(<InstanceEditor instance={item} onClose={() => {}} onSave={async () => {}} />);
/** details 的 open 属性在静态标记里可能是 `open` 或 `open=""`，两者都算展开。 */
const frontGuideOpen = (html: string) => /<details class="http-guide"[^>]*\sopen[\s=>]/.test(html);

describe('连接管理：新增设备与只改地址', () => {
  test('新增设备与仅改地址分开说明，不把改地址说成要重新配对', () => {
    const html = renderToStaticMarkup(<ConnectionPathGuide />);
    expect(html).toContain('新增设备');
    expect(html).toContain('同一台设备只改 IP 或端口');
    expect(html).toContain('不需要重新配对');
    expect(html).toContain('换成另一台实际设备');
    expect(html).toContain('先撤销原授权，再重新配对');
    expect(html).toContain('不修改原站会话');
  });

  test('地址变化区分新增、仅改端口、主机变化', () => {
    expect(addressChange(undefined, 'https://10.8.0.12:8443')).toBe('add');
    expect(addressChange('https://10.8.0.12:8443', 'https://10.8.0.12:8443')).toBe('unchanged');
    expect(addressChange('https://10.8.0.12:8443', 'https://10.8.0.12:9443')).toBe('port');
    expect(addressChange('https://10.8.0.12:8443', 'https://10.8.0.13:8443')).toBe('host');
    expect(addressChange('https://10.8.0.12:8443', '')).toBeNull();
  });

  test('工作台与设备不同 hostname 的示例保持设备用 IP 加端口', () => {
    const html = renderToStaticMarkup(<ConnectionPathGuide />);
    expect(html).toContain('www.smpc.asia');
    expect(html).toContain('https://10.8.0.12:8443');
    expect(html).not.toContain('NF1');
    expect(html).not.toContain('NF12');
  });
});

describe('连接管理：HTTP 设备的可执行 HTTPS 前置方案', () => {
  test('HTTP 地址给出前置 HTTPS 地址，不把原端口写成 https', () => {
    expect(isHttpUrl('http://10.8.0.12:7778')).toBe(true);
    expect(httpsFrontSuggestion('http://10.8.0.12:7778')).toBe('https://10.8.0.12:8443');
    expect(httpsFrontSuggestion('http://10.8.0.12:7778/nf/')).toBe('https://10.8.0.12:8443/nf');
    expect(httpsFrontSuggestion('http://10.8.0.12:7778')).not.toContain('7778');
    expect(httpsFrontSuggestion('https://10.8.0.12:8443')).toBeNull();
  });

  test('回环 HTTP 与需要前置的 HTTP 分开判定', () => {
    expect(isLoopbackHttp('http://127.0.0.1:7778')).toBe(true);
    expect(isLoopbackHttp('http://localhost:7778')).toBe(true);
    expect(isLoopbackHttp('http://10.8.0.12:7778')).toBe(false);
    expect(isLoopbackHttp('https://10.8.0.12:8443')).toBe(false);
  });

  test('前置方案给出可下载配置与短步骤，且不声称已自动部署', () => {
    const html = renderToStaticMarkup(<HttpAccessGuide defaultOpen />);
    for (const file of HTTP_FRONT_FILES) expect(html).toContain(`下载 ${file.name}`);
    expect(HTTP_FRONT_FILES.map(file => file.name)).toEqual(['Caddyfile', 'compose.yaml', 'settings.env.example']);
    for (const file of HTTP_FRONT_FILES) expect(file.content.length).toBeGreaterThan(0);
    expect(html).toContain('保存地址不会自动部署前置');
    expect(html).toContain('下载三份配置');
    expect(html).toContain('填写 IP、端口与上游');
    expect(html).toContain('确认设备 HTTPS 可信');
    expect(html).toContain('https://10.8.0.12:8443');
  });

  test('HTTP 前置方案限定可信路径并保留嵌入允许列表要求', () => {
    const html = renderToStaticMarkup(<HttpAccessGuide />);
    expect(html).toContain('可信局域网或 VPN');
    expect(html).toContain('公共互联网只访问 HTTPS 入口');
    expect(html).toContain('不通过删除安全头或伪造 Origin 来强行嵌入');
    expect(html).toContain('不使用通配符');
    expect(html).toContain('自身 HTTPS 入口 origin');
  });
});

describe('编辑实例：HTTP 原始输入的解决路径', () => {
  test('HTTP 地址在编辑框内给出前置路径、建议地址与填入按钮', () => {
    const html = editor(instance({ browserBaseUrl: 'http://10.8.0.12:7778' }));
    expect(html).toContain('HTTP 地址需要独立 HTTPS 前置');
    expect(html).toContain('填入前置 HTTPS 地址');
    expect(html).toContain('https://10.8.0.12:8443');
    expect(html).not.toContain('https://10.8.0.12:7778');
    expect(html).toContain('保存地址不会部署前置');
  });

  test('HTTP 原始输入时前置面板默认展开', () => {
    expect(frontGuideOpen(editor(instance({ browserBaseUrl: 'http://10.8.0.12:7778' })))).toBe(true);
  });

  test('HTTPS 地址不出现前置提示，面板保持收起', () => {
    const html = editor(instance({ browserBaseUrl: 'https://10.8.0.12:8443' }));
    expect(html).not.toContain('HTTP 地址需要独立 HTTPS 前置');
    expect(html).not.toContain('填入前置 HTTPS 地址');
    expect(frontGuideOpen(html)).toBe(false);
    expect(html).toContain('设备只有 HTTP 时的 HTTPS 前置方案');
  });

  test('新增实例给出一次性配对说明，而不是改地址说明', () => {
    const html = renderToStaticMarkup(<InstanceEditor onClose={() => {}} onSave={async () => {}} />);
    expect(html).toContain('新增设备');
    expect(html).toContain('完成一次配对');
    expect(html).not.toContain('同一台设备，只修改 IP 或端口');
    expect(html).not.toContain('地址的主机名已改变');
  });
});
