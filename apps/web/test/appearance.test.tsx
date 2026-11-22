import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Instance } from '@nf-hub/protocol';
import { PageNavigation, Sidebar } from '../src/App';
import { AppearanceMenu } from '../src/components/AppearanceMenu';
import type { AppearanceRuntime } from '../src/hooks/useAppearance';

const source = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
const key = 'nf-hub:appearance:v1';
function fixture(raw: string | null = null, dark = false, denial: 'read' | 'write' | 'getter' | null = null) {
  const values = new Map<string, string>([['unrelated', 'keep'], ['narrafork_token', 'synthetic-untouched']]);
  if (raw !== null) values.set(key, raw);
  const attributes = new Map<string, string>();
  const meta = new Map<string, string>();
  const changes = new Set<() => void>();
  const storageEvents = new Set<(event: { key: string; newValue: string | null }) => void>();
  const query = { matches: dark, addEventListener: (_: string, listener: () => void) => changes.add(listener), removeEventListener: (_: string, listener: () => void) => changes.delete(listener) };
  const host = {
    localStorage: {
      getItem: (name: string) => { if (denial === 'read') throw new Error('denied'); return values.get(name) ?? null; },
      setItem: (name: string, value: string) => { if (denial === 'write') throw new Error('denied'); values.set(name, value); },
    },
    matchMedia: () => query,
    document: { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) }, querySelector: (selector: string) => ({ setAttribute: (_: string, value: string) => meta.set(selector, value) }) },
    addEventListener: (_: string, listener: (event: { key: string; newValue: string | null }) => void) => storageEvents.add(listener),
    removeEventListener: (_: string, listener: (event: { key: string; newValue: string | null }) => void) => storageEvents.delete(listener),
    __NF_HUB_APPEARANCE__: undefined as AppearanceRuntime | undefined,
  };
  if (denial === 'getter') Object.defineProperty(host, 'localStorage', { get() { throw new Error('denied'); } });
  const context = createContext(host);
  new Script(source).runInContext(context);
  return { runtime: host.__NF_HUB_APPEARANCE__!, values, attributes, meta, changes, storageEvents, context,
    system: (value: boolean) => { query.matches = value; changes.forEach(listener => listener()); },
    storage: (name: string, value: string | null) => storageEvents.forEach(listener => listener({ key: name, newValue: value })),
  };
}

describe('共享的首屏和交互外观偏好', () => {
  test('非法 JSON、非对象及非 primitive 值安全回退，默认收起侧栏', () => {
    for (const raw of [null, '{', 'null', '[]', '"dark"', '{"scheme":1,"oled":"true","sidebar":1}', '{"scheme":"invalid","token":"discard"}']) {
      const { runtime } = fixture(raw);
      expect(runtime.store.getSnapshot()).toEqual({ scheme: 'auto', oled: false, sidebar: false, theme: 'light', dark: false });
    }
    const { runtime } = fixture();
    expect(runtime.normalize({ scheme: 'dark', oled: true, sidebar: true, extra: { private: 'discard' } })).toEqual({ scheme: 'dark', oled: true, sidebar: true });
    expect(runtime.parse(' '.repeat(1025))).toEqual(runtime.defaults);
  });
  test('存储读取、getter 或写入拒绝不会阻止首屏和内存设置', () => {
    for (const denial of ['read', 'write', 'getter'] as const) {
      const { runtime, attributes } = fixture(null, false, denial);
      const detach = runtime.store.subscribe(() => {});
      runtime.store.setPreferences({ scheme: 'dark', oled: true, sidebar: true });
      expect(attributes.get('data-theme')).toBe('oled');
      expect(runtime.store.getSnapshot()).toEqual({ scheme: 'dark', oled: true, sidebar: true, theme: 'oled', dark: true });
      detach();
    }
  });
  test('首屏恢复与运行期共用一个 resolver，OLED 在浅色下无效', () => {
    for (const scheme of ['auto', 'light', 'dark'] as const) for (const oled of [false, true]) for (const system of [false, true]) {
      const preferences = { scheme, oled, sidebar: true };
      const { runtime, attributes, meta } = fixture(JSON.stringify(preferences), system);
      const resolved = runtime.resolve(preferences, system);
      expect(runtime.store.getSnapshot().theme).toBe(resolved);
      expect(attributes.get('data-theme')).toBe(resolved);
      expect(meta.get('meta[name="color-scheme"]')).toBe(resolved === 'light' ? 'light' : 'dark');
      expect(meta.get('meta[name="theme-color"]')).toBe(resolved === 'oled' ? '#000000' : resolved === 'dark' ? '#242424' : '#f4f7f8');
      if (scheme === 'light') expect(resolved).toBe('light');
    }
  });
  test('系统变化只在 auto 监听，多个订阅和重复初始化均可清理', () => {
    const f = fixture('{"scheme":"auto","oled":true,"sidebar":false}');
    const store = f.runtime.store;
    let calls = 0;
    const first = store.subscribe(() => { calls++; });
    const second = store.subscribe(() => {});
    expect(f.changes.size).toBe(1); expect(f.storageEvents.size).toBe(1);
    f.system(true); expect(store.getSnapshot().theme).toBe('oled'); expect(calls).toBe(1);
    store.setPreferences({ scheme: 'light' });
    expect(f.changes.size).toBe(0);
    f.system(false); f.system(true); expect(store.getSnapshot().theme).toBe('light');
    store.setPreferences({ scheme: 'dark', oled: false }); f.system(false);
    expect(store.getSnapshot().theme).toBe('dark'); expect(f.changes.size).toBe(0);
    store.setPreferences({ scheme: 'auto' }); expect(f.changes.size).toBe(1); expect(store.getSnapshot().theme).toBe('light');
    new Script(source).runInContext(f.context);
    expect(f.runtime.store).toBe(store); expect(f.changes.size).toBe(1);
    first(); expect(f.changes.size).toBe(1);
    second(); expect(f.changes.size).toBe(0); expect(f.storageEvents.size).toBe(0);
  });
  test('只持久化自己的三个 primitive，不改其他存储；刷新后恢复', () => {
    const f = fixture();
    f.runtime.store.setPreferences({ scheme: 'dark', oled: true, sidebar: true });
    const raw = f.values.get(key)!;
    expect(JSON.parse(raw)).toEqual({ scheme: 'dark', oled: true, sidebar: true });
    expect(f.values.get('unrelated')).toBe('keep');
    expect(f.values.get('narrafork_token')).toBe('synthetic-untouched');
    expect(f.values.size).toBe(3);
    expect(fixture(raw).runtime.store.getSnapshot()).toEqual(f.runtime.store.getSnapshot());
  });
  test('跨标签页只接收独立偏好键，损坏数据回退', () => {
    const f = fixture();
    const detach = f.runtime.store.subscribe(() => {});
    f.storage('unrelated', '{"scheme":"dark"}'); expect(f.runtime.store.getSnapshot().theme).toBe('light');
    f.storage(key, '{"scheme":"dark","oled":true,"sidebar":true}'); expect(f.runtime.store.getSnapshot().theme).toBe('oled');
    f.storage(key, '{'); expect(f.runtime.store.getSnapshot()).toMatchObject({ scheme: 'auto', sidebar: false, oled: false });
    detach();
  });
  test('HTML 在主 bundle 前加载外部经典脚本，不添加内联脚本', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/main.tsx'));
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});

describe('紧凑组件语义', () => {
  test('iframe 独立选择系统配色，不继承外壳强制浅色或深色', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const iframeRule = css.match(/\.iframe-area iframe\{([^}]+)\}/)?.[1];
    expect(iframeRule).toBeDefined();
    expect(iframeRule).toMatch(/(?:^|;)color-scheme:light dark(?:;|$)/);
    expect(iframeRule).not.toContain('filter:');
  });
  test('桌面和移动导航保留三个页面与当前页语义', () => {
    const html = renderToStaticMarkup(<PageNavigation view="workbench" onChange={() => {}} />);
    for (const label of ['全局会话', '实例工作台', '连接管理', '主导航', '页面导航']) expect(html).toContain(label);
    expect(html).toContain('aria-label="实例工作台"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
  });
  test('收起完全隐藏，移动展开使用对话框语义且保留退出入口', () => {
    const instances = [{ id: 'one', alias: '<NF 原站>', color: '#287b80', group: '', connection: 'connected', freshness: 'fresh' }] as Instance[];
    const closed = renderToStaticMarkup(<Sidebar instances={instances} view="workbench" selectedId="one" open={false} mobile={false} close={() => {}} count="1" />);
    expect(closed).toContain('id="instance-sidebar"'); expect(closed).toContain('hidden=""');
    const drawer = renderToStaticMarkup(<Sidebar instances={instances} view="workbench" selectedId="one" open mobile close={() => {}} count="1" />);
    expect(drawer).toContain('role="dialog"'); expect(drawer).toContain('aria-modal="true"'); expect(drawer).toContain('关闭实例列表');
    expect(drawer).toContain('&lt;NF 原站&gt;'); expect(drawer).not.toContain('<NF 原站>');
    expect(drawer).toContain('管理实例连接');
  });
  test('外观菜单提供三模式和仅深色可用的 OLED 开关', () => {
    const html = renderToStaticMarkup(<AppearanceMenu />);
    expect(html).toContain('aria-label="外观设置"'); expect(html).toContain('配色模式');
    for (const label of ['跟随系统', '浅色', '深色', 'OLED 纯黑', '仅在深色外观下生效']) expect(html).toContain(label);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
  });
});

test('归档索引解析只放行精确的启动脚本，assets 目录仅统计 hash 引用', () => {
  const path = fileURLToPath(new URL('../../../deploy/package-release.py', import.meta.url));
  const result = spawnSync('python', ['-B', '-c', `import runpy, sys
m = runpy.run_path(sys.argv[1])
p = m['AssetReferences']()
p.feed('<script src="/theme-init.js"></script><script src="/assets/index-abcdef12.js"></script><link href="/assets/index-abcdef12.css" rel="stylesheet">')
assert p.paths == {'apps/web/dist/theme-init.js', 'apps/web/dist/assets/index-abcdef12.js', 'apps/web/dist/assets/index-abcdef12.css'}
for ref in ['/other.js', '/theme-init.js?x', '/theme-init.js.map', '//example.invalid/theme-init.js', '/assets/theme-init.js', '/../theme-init.js', 'theme-init.js']:
    try:
        m['AssetReferences']().feed('<script src="' + ref + '"></script>')
    except ValueError:
        pass
    else:
        raise AssertionError(ref)
try:
    m['AssetReferences']().feed('<link href="/theme-init.js" rel="stylesheet">')
except ValueError:
    pass
else:
    raise AssertionError('root script accepted as link')
assert m['TEXT_GROUPS']['apps/web/public'] == ('theme-init.js',)
import tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='nf-assets-') as temp:
    root = Path(temp)
    dist = root / 'apps/web/dist'
    assets = dist / 'assets'
    public = root / 'apps/web/public'
    assets.mkdir(parents=True)
    public.mkdir(parents=True)
    (dist / 'index.html').write_text('<script src="/theme-init.js"></script><script src="/assets/index-abcdef12.js"></script><link href="/assets/index-abcdef12.css">', encoding='utf-8')
    (dist / 'theme-init.js').write_text('/* init */', encoding='utf-8')
    (public / 'theme-init.js').write_text('/* init */', encoding='utf-8')
    (assets / 'index-abcdef12.js').write_text('/* app */', encoding='utf-8')
    (assets / 'index-abcdef12.css').write_text('/* style */', encoding='utf-8')
    m['web_assets'].__globals__['ROOT'] = root
    assert len(m['web_assets']()) == 4
    for unexpected in [dist / 'private.js', assets / 'theme-init.js']:
        unexpected.write_text('not public', encoding='utf-8')
        try:
            m['web_assets']()
        except ValueError:
            pass
        else:
            raise AssertionError(str(unexpected))
        unexpected.unlink()
    (dist / 'theme-init.js').write_text('/* stale */', encoding='utf-8')
    try:
        m['web_assets']()
    except ValueError:
        pass
    else:
        raise AssertionError('stale bootstrap accepted')
print('ok')`, path], { encoding: 'utf8' });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout.trim()).toBe('ok');
});
