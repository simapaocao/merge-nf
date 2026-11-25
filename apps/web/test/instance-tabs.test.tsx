import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Instance } from '@nf-hub/protocol';
import {
  activateTab, closeAllTabs, closeTab, emptyTabs, keyboardTarget, nextActiveOnClose, openTab, pruneTabs, pruneWhenKnown,
  readTabs, tabsStorageKey, tabsServerEpoch, writeTabs, clearTabs, TABS_STORAGE_PREFIX, type TabsState,
} from '../src/lib/tabs';
import { countBadge, tabCountsTitle, toActivityView, unknownActivity } from '../src/lib/tabActivity';
import { authorizedFrames, frameKey, keepOpenedFrames, pruneFrames, sortFramesForRender, touchFrame } from '../src/lib/frames';
import { InstanceTabBar, revealHorizontalTab } from '../src/components/InstanceTabs';

const open = (...ids: string[]): TabsState => ids.reduce<TabsState>((state, id) => openTab(state, id), emptyTabs);
const serverEpoch = 'a'.repeat(32);

describe('已打开标签的打开与去重', () => {
  test('首次打开按顺序追加并激活，重复打开只激活不重复', () => {
    const first = open('a', 'b', 'c');
    expect(first.openIds).toEqual(['a', 'b', 'c']);
    expect(first.activeId).toBe('c');
    const again = openTab(first, 'a');
    expect(again.openIds).toEqual(['a', 'b', 'c']);
    expect(again.activeId).toBe('a');
    expect(openTab(again, 'a')).toBe(again);
  });
  test('空 id 不会创建标签，激活未打开的实例不生效', () => {
    expect(openTab(emptyTabs, '')).toBe(emptyTabs);
    expect(activateTab(open('a'), 'zzz').activeId).toBe('a');
  });
});

describe('关闭只关视图并选择相邻标签', () => {
  test('关闭当前标签优先右邻，其次左邻', () => {
    const state = open('a', 'b', 'c');
    expect(closeTab({ ...state, activeId: 'b' }, 'b').activeId).toBe('c');
    expect(closeTab({ ...state, activeId: 'c' }, 'c').activeId).toBe('b');
    expect(nextActiveOnClose({ ...state, activeId: 'a' }, 'a')).toBe('b');
  });
  test('关闭非当前标签不改变当前标签', () => {
    const state: TabsState = { openIds: ['a', 'b', 'c'], activeId: 'c' };
    expect(closeTab(state, 'a')).toEqual({ openIds: ['b', 'c'], activeId: 'c' });
  });
  test('全部关闭后没有当前标签，界面回到全局会话', () => {
    const state = open('a');
    expect(closeTab(state, 'a')).toEqual({ openIds: [], activeId: null });
    expect(nextActiveOnClose(state, 'a')).toBeNull();
    expect(closeAllTabs(open('a', 'b'))).toEqual(emptyTabs);
    expect(closeAllTabs(emptyTabs)).toBe(emptyTabs);
  });
  test('关闭不存在的标签不改状态', () => {
    const state = open('a');
    expect(closeTab(state, 'zzz')).toBe(state);
  });
});

describe('键盘导航', () => {
  test('左右键循环，Home/End 到两端', () => {
    expect(keyboardTarget(['a', 'b', 'c'], 'a', 'ArrowRight')).toBe('b');
    expect(keyboardTarget(['a', 'b', 'c'], 'c', 'ArrowRight')).toBe('a');
    expect(keyboardTarget(['a', 'b', 'c'], 'a', 'ArrowLeft')).toBe('c');
    expect(keyboardTarget(['a', 'b', 'c'], 'b', 'Home')).toBe('a');
    expect(keyboardTarget(['a', 'b', 'c'], 'b', 'End')).toBe('c');
    expect(keyboardTarget(['a', 'b'], null, 'ArrowRight')).toBe('a');
    expect(keyboardTarget(['a', 'b'], null, 'ArrowLeft')).toBe('b');
    expect(keyboardTarget([], null, 'ArrowRight')).toBeNull();
  });
});

describe('激活标签仅横向露出', () => {
  const rect = (left: number, right: number): DOMRect => ({ left, right, top: 20, bottom: 50, x: left, y: 20, width: right - left, height: 30, toJSON: () => ({}) });
  function viewport() {
    return { clientWidth: 100, clientLeft: 2, scrollWidth: 600, scrollLeft: 100, scrollTop: 75, getBoundingClientRect: () => rect(10, 114) };
  }
  const tab = (left: number, right: number) => ({ getBoundingClientRect: () => rect(left, right), focus: () => { throw new Error('must not take focus'); } });

  test('标签完整可见时不改手动滚动位置', () => {
    const view = viewport();
    revealHorizontalTab(view, tab(20, 100));
    expect(view.scrollLeft).toBe(100);
    expect(view.scrollTop).toBe(75);
  });
  test('右侧被裁切时刚好露出整个标签包裹层，纵向不动', () => {
    const view = viewport();
    revealHorizontalTab(view, tab(100, 160));
    expect(view.scrollLeft).toBe(148);
    expect(view.scrollTop).toBe(75);
  });
  test('左侧被裁切时仅向左滚动，考虑容器边框', () => {
    const view = viewport();
    revealHorizontalTab(view, tab(-10, 30));
    expect(view.scrollLeft).toBe(78);
    expect(view.scrollTop).toBe(75);
  });
  test('标签比窄屏视口宽时对齐起始端，不横向往返', () => {
    const view = viewport();
    revealHorizontalTab(view, tab(200, 360));
    expect(view.scrollLeft).toBe(288);
    revealHorizontalTab(view, tab(12, 172));
    expect(view.scrollLeft).toBe(288);
  });
  test('滚动范围限制在当前容器内，隐藏时不滚动', () => {
    const view = viewport();
    revealHorizontalTab(view, tab(800, 850));
    expect(view.scrollLeft).toBe(500);
    revealHorizontalTab(view, tab(-800, -750));
    expect(view.scrollLeft).toBe(0);
    view.clientWidth = 0;
    revealHorizontalTab(view, tab(800, 850));
    expect(view.scrollLeft).toBe(0);
    expect(view.scrollTop).toBe(75);
  });
  test('重复选同一激活标签仍可露出，已露出后再次调用无位移', () => {
    const view = viewport();
    const active = { getBoundingClientRect: () => rect(350 - view.scrollLeft, 410 - view.scrollLeft) };
    revealHorizontalTab(view, active);
    expect(view.scrollLeft).toBe(298);
    revealHorizontalTab(view, active);
    expect(view.scrollLeft).toBe(298);
  });
});

describe('恢复持久化标签', () => {
  function memory(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
      },
    };
  }
  const key = tabsStorageKey('alice', 'https://hub.example.net', serverEpoch);
  test('存储隔离只取稳定服务端epoch，频繁revision与增强计数不重置标签', () => {
    expect(tabsServerEpoch(`${serverEpoch}.1.2.3`)).toBe(serverEpoch);
    expect(tabsServerEpoch(`${serverEpoch}.999.0.7.3`)).toBe(serverEpoch);
    expect(tabsServerEpoch(null)).toBeNull();
    expect(tabsServerEpoch('unknown')).toBeNull();
  });

  test('只写实例 ID、顺序和当前项，key 与 value 都不含令牌、标题或正文', () => {
    const { values, storage } = memory();
    writeTabs(storage, key, { openIds: ['one', 'two'], activeId: 'two' });
    expect(key).toBe(`${TABS_STORAGE_PREFIX}${JSON.stringify(['https://hub.example.net', 'alice', serverEpoch])}`);
    expect(key).not.toContain('token');
    const raw = values.get(key)!;
    expect(JSON.parse(raw)).toEqual({ v: 1, ids: ['one', 'two'], active: 'two' });
    for (const leak of ['csrf', 'Bearer', 'title', 'content', 'password']) expect(raw).not.toContain(leak);
  });
  test('非法或过期的存储内容被丢弃，不恢复半个列表', () => {
    const cases = ['', 'null', '[]', '{"v":2,"ids":["a"],"active":"a"}', '{"v":1,"ids":["a","a"],"active":"a"}',
      '{"v":1,"ids":[1],"active":null}', '{"v":1,"ids":["a"],"active":"missing"}', '{"v":1,"ids":"a"}',
      '{"v":1,"ids":["a"],"extra":true}', '{"v":1,"ids":["a"],"active":null,"token":"leak"}'];
    for (const raw of cases) expect(readTabs(memory({ [key]: raw }).storage, key)).toBeNull();
    expect(readTabs(undefined, key)).toBeNull();
  });
  test('有效内容按原顺序恢复，active 可缺省', () => {
    expect(readTabs(memory({ [key]: '{"v":1,"ids":["a","b"],"active":"a"}' }).storage, key)).toEqual({ openIds: ['a', 'b'], activeId: 'a' });
    expect(readTabs(memory({ [key]: '{"v":1,"ids":["a"]}' }).storage, key)).toEqual({ openIds: ['a'], activeId: null });
  });
  test('存储不可用时静默降级', () => {
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); }, key: () => { throw new Error('denied'); }, length: 0 };
    expect(readTabs(denied, key)).toBeNull();
    expect(() => writeTabs(denied, key, emptyTabs)).not.toThrow();
    expect(() => clearTabs(denied)).not.toThrow();
  });
  test('登出清理所有账号的标签，其他键保持不动', () => {
    const { values, storage } = memory({
      [tabsStorageKey('alice', 'https://hub.example.net', serverEpoch)]: '{"v":1,"ids":["a"],"active":"a"}',
      [tabsStorageKey('bob', 'https://hub.example.net', serverEpoch)]: '{"v":1,"ids":["b"],"active":"b"}',
      unrelated: 'keep',
      narrafork_token: 'synthetic-untouched',
    });
    clearTabs(storage);
    expect(values.get('unrelated')).toBe('keep');
    expect(values.get('narrafork_token')).toBe('synthetic-untouched');
    expect([...values.keys()].some(name => name.startsWith(TABS_STORAGE_PREFIX))).toBe(false);
  });
  test('不同账号与不同中心互不串用', () => {
    const { values, storage } = memory();
    writeTabs(storage, tabsStorageKey('alice', 'https://hub.example.net', serverEpoch), { openIds: ['a'], activeId: 'a' });
    expect(readTabs(storage, tabsStorageKey('bob', 'https://hub.example.net', serverEpoch))).toBeNull();
    expect(readTabs(storage, tabsStorageKey('alice', 'https://other.example.net', serverEpoch))).toBeNull();
    expect(readTabs(storage, tabsStorageKey('alice', 'https://hub.example.net', 'b'.repeat(32)))).toBeNull();
    expect(values.size).toBe(1);
  });
});

describe('无效 ID 的剪裁', () => {
  test('只在有效集合已知时剪裁，未知列表不当作空列表', () => {
    const state = open('a', 'b');
    expect(pruneTabs(state, new Set(['a', 'b']))).toBe(state);
    expect(pruneTabs(state, new Set(['a']))).toEqual({ openIds: ['a'], activeId: null });
    expect(pruneTabs(state, new Set())).toEqual(emptyTabs);
  });
  test('未验证/失败读取时保留已开标签，恢复后仍可用', () => {
    const state = open('a', 'b');
    expect(pruneWhenKnown(state, null)).toBe(state);
    expect(pruneWhenKnown(state, new Set(['a', 'b']))).toBe(state);
    expect(pruneWhenKnown(state, new Set(['b']))).toEqual({ openIds: ['b'], activeId: 'b' });
  });
  test('当前标签仍有效时保持选中', () => {
    expect(pruneTabs({ openIds: ['a', 'b'], activeId: 'b' }, new Set(['a', 'b', 'c']))).toEqual({ openIds: ['a', 'b'], activeId: 'b' });
  });
});

describe('标签计数不把未知当 0', () => {
  const facts = { runningCount: 3, attention: { supported: false, count: null }, background: { supported: false, count: null } };
  test('新鲜连接才使用计数，陈旧/失联/撤销/未验证一律未知', () => {
    expect(toActivityView(facts, true)).toEqual({ running: 3, attention: { supported: false, count: null }, background: { supported: false, count: null } });
    expect(toActivityView(facts, false)).toEqual(unknownActivity);
    expect(toActivityView(undefined, true)).toEqual(unknownActivity);
  });
  test('服务端运行数为空时显示未知而不是 0', () => {
    const view = toActivityView({ runningCount: null, attention: { supported: false, count: null }, background: { supported: false, count: null } }, true);
    expect(view.running).toBeNull();
    expect(countBadge(view.running)).toBeNull();
  });
  test('运行徽标保留可信真零，未知不显示数字', () => {
    expect(countBadge(0)).toEqual({ text: '0', muted: false });
    expect(countBadge(4)).toEqual({ text: '4', muted: false });
    expect(countBadge(null)).toBeNull();
  });
  test('计数浮层只保留同步信息，未支持的数据仍未知', () => {
    const view = toActivityView({ runningCount: 0, attention: { supported: false, count: null }, background: { supported: false, count: null } }, true);
    expect(view.attention).toEqual({ supported: false, count: null });
    const title = tabCountsTitle(view, 1_700_000_000_000);
    expect(title).toContain('最后同步');
    expect(title).not.toContain('运行会话');
    expect(title).not.toContain('需要处理');
    expect(tabCountsTitle(view, null)).toBe('未同步');
    expect(tabCountsTitle(unknownActivity, null)).toBe('暂无新鲜数据 · 未同步');
  });
  test('运行数精确消费服务端去重值，不与后台数再相加', () => {
    const view = toActivityView({ runningCount: 6, attention: { supported: true, count: 2 }, background: { supported: true, count: 5 } }, true);
    expect(view.running).toBe(6);
    expect(view.background).toEqual({ supported: true, count: 5 });
    expect(countBadge(view.running)).toEqual({ text: '6', muted: false });
  });
});

const instance = (id: string, patch: Partial<Instance> = {}) => ({
  id, alias: id.toUpperCase(), group: '', color: '#287b80', order: 0, favorite: false,
  browserBaseUrl: `https://${id}.example.net`, embedStatus: 'unverified', generation: 1,
  scope: { mode: 'all', includeArchived: false, sessionIds: [], projectIds: [], includeStandalone: true },
  connection: 'connected', freshness: 'fresh', lastContactAt: null, lastSuccessAt: 1_700_000_000_000,
  lastError: null, sessionCount: 0, connectorVersion: null, nfVersion: null, capabilities: null, ...patch,
} as unknown as Instance);

describe('多标签与 3 个 iframe 的 LRU 分离', () => {
  const grants = authorizedFrames([instance('a'), instance('b'), instance('c'), instance('d')], 'https://hub.example.net');
  const openAll = ['a', 'b', 'c', 'd'];
  test('打开 4 个标签只保活 3 个页面，最久未用的先休眠', () => {
    let frames = touchFrame([], grants.get('a')!);
    frames = touchFrame(frames, grants.get('b')!);
    frames = touchFrame(frames, grants.get('c')!);
    frames = touchFrame(frames, grants.get('d')!);
    expect(frames.map(frame => frame.instanceId)).toEqual(['b', 'c', 'd']);
    expect(openAll).toHaveLength(4);
    const rendered = sortFramesForRender(keepOpenedFrames(frames, openAll));
    expect(rendered.map(frame => frame.instanceId)).toEqual(['b', 'c', 'd']);
  });
  test('重新激活保活中的标签不改变 iframe key、不重排 DOM', () => {
    const frames = ['a', 'b', 'c'].reduce((list, id) => touchFrame(list, grants.get(id)!), [] as ReturnType<typeof touchFrame>);
    const keys = sortFramesForRender(frames).map(frameKey);
    const reactivated = touchFrame(frames, grants.get('a')!);
    // LRU order changed, but the rendered order and every document identity stayed identical.
    expect(reactivated.map(frame => frame.instanceId)).toEqual(['b', 'c', 'a']);
    expect(sortFramesForRender(reactivated).map(frameKey)).toEqual(keys);
    expect(sortFramesForRender(reactivated).map(frame => frame.instanceId)).toEqual(['a', 'b', 'c']);
  });
  test('关闭标签即使容量还有空位也会真正卸载对应 frame', () => {
    const frames = ['a', 'b'].reduce((list, id) => touchFrame(list, grants.get(id)!), [] as ReturnType<typeof touchFrame>);
    expect(keepOpenedFrames(frames, ['a', 'b'])).toHaveLength(2);
    expect(keepOpenedFrames(frames, ['a']).map(frame => frame.instanceId)).toEqual(['a']);
    expect(keepOpenedFrames(frames, undefined)).toHaveLength(2);
  });
  test('撤权与换代的 frame 仍被剪除，标签存在也不复活页面', () => {
    const revoked = authorizedFrames([instance('a', { connection: 'revoked' }), instance('b')], 'https://hub.example.net');
    const frames = touchFrame([], grants.get('a')!);
    expect(pruneFrames(frames, revoked)).toHaveLength(0);
    expect(sortFramesForRender(keepOpenedFrames(pruneFrames(frames, revoked), ['a']))).toHaveLength(0);
    const renewed = authorizedFrames([instance('a', { generation: 2 })], 'https://hub.example.net');
    expect(pruneFrames(frames, renewed)).toHaveLength(0);
  });
});

describe('标签栏语义与未知数据', () => {
  const instances = [instance('a'), instance('b', { connection: 'lost', freshness: 'stale' })];
  const state: TabsState = { openIds: ['a', 'b'], activeId: 'a' };
  const render = (patch: Partial<Parameters<typeof InstanceTabBar>[0]> = {}) => renderToStaticMarkup(<InstanceTabBar
    state={state} instances={instances} selectedId="a" mountedIds={new Set(['a'])}
    activityFor={id => (id === 'a'
      ? { running: 2, attention: { supported: false, count: null }, background: { supported: false, count: null } }
      : unknownActivity)}
    lastSuccessFor={() => null}
    onActivate={() => {}} onClose={() => {}} onCloseAll={() => {}} collapsed={false} onToggleCollapsed={() => {}} {...patch} />);

  test('使用 tablist/tab 语义与 aria-selected，只给当前标签可聚焦', () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('aria-controls="workbench-panel"');
  });
  test('运行数按新鲜摘要显示，失联实例显示短状态，未知待处理显示低强调问号', () => {
    const html = render();
    expect(html).toContain('运行 2 个会话');
    expect(html).toContain('class="tab-status" title="离线">离线');
    expect(html).toContain('class="tab-badge muted" aria-label="待处理状态未同步" title="待处理状态未同步"');
    expect(html).toContain('待处理</span>?');
    expect(html).not.toContain('运行会话数未知');
    expect(html).not.toContain('—');
  });
  test('待处理已知零仍隐藏，可信运行零保留', () => {
    const html = render({ activityFor: () => ({ running: 0, attention: { supported: true, count: 0 }, background: { supported: false, count: null } }) });
    expect(html).not.toContain('待处理');
    expect(html).toContain('运行 0 个会话');
  });
  test('未支持或supported但count未知都不冒充确定零', () => {
    for (const attention of [{ supported: false, count: 0 }, { supported: false, count: null }, { supported: true, count: null }]) {
      const html = render({ activityFor: () => ({ running: 7, attention, background: { supported: false, count: null } }) });
      expect(html).toContain('待处理</span>?');
      expect(html).toContain('待处理状态未同步');
      expect(html).not.toContain('待处理 0');
      expect(html).toContain('运行 7 个会话');
    }
  });
  test('无可信运行数时按真实实例字段显示短状态，不伪造零', () => {
    const cases: Array<[Partial<Instance>, string]> = [
      [{ connection: 'unpaired', freshness: 'never' }, '未配对'],
      [{ connection: 'revoked', freshness: 'stale' }, '已撤销'],
      [{ connection: 'lost', freshness: 'stale' }, '离线'],
      [{ freshness: 'stale' }, '数据过期'],
      [{ freshness: 'never' }, '未同步'],
      [{ freshness: 'fresh' }, '暂无数据'],
    ];
    for (const [patch, label] of cases) {
      const html = render({ instances: [instance('a', patch)], state: { openIds: ['a'], activeId: 'a' }, activityFor: () => unknownActivity });
      expect(html).toContain(`class="tab-status" title="${label}">${label}`);
      expect(html).toContain('待处理状态未同步');
      expect(html).toContain('待处理</span>?');
      expect(html).not.toContain('运行 0');
      expect(html).not.toContain('运行—');
    }
  });
  test('已支持计数的悬停仅保留简短范围与权限提示', () => {
    const html = render({ activityFor: () => ({ running: 3, attention: { supported: true, count: 2 }, background: { supported: false, count: null } }) });
    expect(html).toContain('待处理 2 个会话');
    expect(html).not.toContain('待处理状态未同步');
    expect(html).toContain('运行 3 个会话');
    expect(html).toContain('仅同步范围，未归档会话 · 处理权限以原站账号为准');
    expect(html).not.toContain('该实例全部已授权');
    expect(html).not.toContain('不受页面筛选影响');
  });
  test('休眠标签显示休眠提示，关闭按钮不停止 NF', () => {
    const html = render({ mountedIds: new Set(['a']) });
    expect(html).toContain('休眠');
    expect(html).toContain('仅关闭标签，不停止 NF');
    expect(html).toContain('未发输入不保留');
  });
  test('未验证快照时不猜休眠状态', () => {
    expect(render({ mountedIds: null })).not.toContain('休眠</span>');
  });
  test('收起时保留已打开下拉，标签行隐藏', () => {
    const html = render({ collapsed: true });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('已打开');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('关闭全部标签');
  });
  test('空标签列表给出打开提示，不渲染关闭全部', () => {
    const html = render({ state: emptyTabs });
    expect(html).toContain('选择实例');
    expect(html).not.toContain('在左侧选择');
    expect(html).not.toContain('关闭全部标签');
  });
  test('标签名按纯文本转义', () => {
    const html = render({ instances: [instance('a', { alias: '<script>alert(1)</script>' })], state: { openIds: ['a'], activeId: 'a' } });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
