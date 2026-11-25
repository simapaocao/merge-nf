import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Instance } from '@nf-hub/protocol';
import { moveTab, type TabsState } from '../src/lib/tabs';
import {
  assignPane, clearSplitLayout, closeSplitPane, computeDividers, computePaneRects, defaultRatios,
  defaultSplitState, focusOrAssignInstance, readSplitLayout, reconcileSplit, resizeSplit, setSplitMode,
  SPLIT_STORAGE_PREFIX, splitStorageKey, swapPanes, writeSplitLayout, type SplitState,
} from '../src/lib/splitLayout';
import { InstanceTabBar } from '../src/components/InstanceTabs';
import { unknownActivity } from '../src/lib/tabActivity';

const serverEpoch = 'c'.repeat(32);
const instance = (id: string) => ({
  id, alias: id.toUpperCase(), group: '', color: '#287b80', order: 0, favorite: false,
  browserBaseUrl: `https://${id}.example.net`, embedStatus: 'verified', generation: 1,
  scope: { mode: 'all', includeArchived: false, sessionIds: [], projectIds: [], includeStandalone: true },
  connection: 'connected', freshness: 'fresh', lastContactAt: null, lastSuccessAt: 1_700_000_000_000,
  lastError: null, sessionCount: 0, connectorVersion: null, nfVersion: null, capabilities: null,
} as unknown as Instance);

describe('标签拖拽排序', () => {
  test('支持向前/向后拖拽并保持 activeId 不变', () => {
    const base: TabsState = { openIds: ['a', 'b', 'c', 'd'], activeId: 'b' };
    expect(moveTab(base, 'c', 'a', 'before')).toEqual({ openIds: ['c', 'a', 'b', 'd'], activeId: 'b' });
    expect(moveTab(base, 'a', 'c', 'after')).toEqual({ openIds: ['b', 'c', 'a', 'd'], activeId: 'b' });
    expect(moveTab(base, 'a', 'd', 'before')).toEqual({ openIds: ['b', 'c', 'a', 'd'], activeId: 'b' });
    expect(moveTab(base, 'd', 'b', 'after')).toEqual({ openIds: ['a', 'b', 'd', 'c'], activeId: 'b' });
  });

  test('拖到原位或无效 ID 返回同一引用', () => {
    const base: TabsState = { openIds: ['a', 'b', 'c'], activeId: 'a' };
    expect(moveTab(base, 'a', 'a', 'before')).toBe(base);
    expect(moveTab(base, 'a', 'b', 'before')).toBe(base);
    expect(moveTab(base, 'b', 'a', 'after')).toBe(base);
    expect(moveTab(base, 'missing', 'a', 'before')).toBe(base);
    expect(moveTab(base, 'a', 'missing', 'after')).toBe(base);
  });
});

describe('多 NF 分屏状态转换', () => {
  test('从单屏切分屏时保留当前实例并按候选顺序填充其余窗口', () => {
    const split2 = setSplitMode(defaultSplitState, 'split-h', 'a', ['a', 'b', 'c']);
    expect(split2).toEqual({ mode: 'split-h', paneIds: ['a', 'b'], focusedPane: 0, ratios: [50, 50] });

    const split3 = setSplitMode(split2, 'split-3', 'b', ['a', 'b', 'c']);
    expect(split3).toEqual({ mode: 'split-3', paneIds: ['a', 'b', 'c'], focusedPane: 1, ratios: [33.33, 33.33] });

    const single = setSplitMode(split3, 'single', 'b', ['a', 'b', 'c']);
    expect(single).toEqual({ mode: 'single', paneIds: ['b'], focusedPane: 0, ratios: [50, 50] });
  });

  test('assignPane 分配已在另一分屏的实例时自动对调，不出现重复窗口', () => {
    const state: SplitState = { mode: 'split-h', paneIds: ['a', 'b'], focusedPane: 0, ratios: [50, 50] };
    expect(assignPane(state, 0, 'b')).toEqual({ mode: 'split-h', paneIds: ['b', 'a'], focusedPane: 0, ratios: [50, 50] });
    expect(assignPane(state, 1, 'c')).toEqual({ mode: 'split-h', paneIds: ['a', 'c'], focusedPane: 1, ratios: [50, 50] });
  });

  test('focusOrAssignInstance 优先聚焦已有窗口，不在屏上时替换当前聚焦窗口', () => {
    const state: SplitState = { mode: 'split-h', paneIds: ['a', 'b'], focusedPane: 0, ratios: [50, 50] };
    expect(focusOrAssignInstance(state, 'b')).toEqual({ mode: 'split-h', paneIds: ['a', 'b'], focusedPane: 1, ratios: [50, 50] });
    expect(focusOrAssignInstance(state, 'c')).toEqual({ mode: 'split-h', paneIds: ['c', 'b'], focusedPane: 0, ratios: [50, 50] });
  });

  test('swapPanes 与 closeSplitPane 保持其余存活窗口不丢失', () => {
    const split3: SplitState = { mode: 'split-grid', paneIds: ['a', 'b', 'c'], focusedPane: 2, ratios: [50, 50] };
    expect(swapPanes(split3, 0, 2)).toEqual({ mode: 'split-grid', paneIds: ['c', 'b', 'a'], focusedPane: 0, ratios: [50, 50] });
    const down2 = closeSplitPane(split3, 1);
    expect(down2).toEqual({ mode: 'split-h', paneIds: ['a', 'c'], focusedPane: 1, ratios: [50, 50] });
    const down1 = closeSplitPane(down2, 0);
    expect(down1).toEqual({ mode: 'single', paneIds: ['c'], focusedPane: 0, ratios: [50, 50] });
  });

  test('reconcileSplit 在关闭标签后自动补位或平滑退回单屏', () => {
    const state: SplitState = { mode: 'split-h', paneIds: ['a', 'b'], focusedPane: 1, ratios: [55, 50] };
    expect(reconcileSplit(state, ['a', 'c'], 'a')).toEqual({ mode: 'split-h', paneIds: ['a', 'c'], focusedPane: 1, ratios: [55, 50] });
    expect(reconcileSplit(state, ['a'], 'a')).toEqual({ mode: 'single', paneIds: ['a'], focusedPane: 0, ratios: [50, 50] });
  });
});

describe('分屏比例裁剪与几何布局', () => {
  test('双屏与网格分隔线限制在安全比例范围内', () => {
    const h: SplitState = { mode: 'split-h', paneIds: ['a', 'b'], focusedPane: 0, ratios: defaultRatios('split-h') };
    expect(resizeSplit(h, 'primary', 5).ratios[0]).toBe(18);
    expect(resizeSplit(h, 'primary', 95).ratios[0]).toBe(82);
    const resized = resizeSplit(h, 'primary', 62.5);
    expect(computePaneRects(resized)).toEqual([
      { left: 0, top: 0, width: 62.5, height: 100 },
      { left: 62.5, top: 0, width: 37.5, height: 100 },
    ]);
    expect(computeDividers(resized)).toEqual([
      { id: 'primary', orientation: 'vertical', left: 62.5, top: 0, length: 100 },
    ]);
  });

  test('三屏并排与左主右双几何覆盖完整 100% 区域', () => {
    const s3 = resizeSplit({ mode: 'split-3', paneIds: ['a', 'b', 'c'], focusedPane: 0, ratios: [33.33, 33.33] }, 'primary', 25);
    const rects3 = computePaneRects(s3);
    expect(rects3).toHaveLength(3);
    expect(Number(rects3.reduce((sum, r) => sum + r.width, 0).toFixed(2))).toBe(100);
    expect(computeDividers(s3)).toHaveLength(2);

    const grid = resizeSplit(resizeSplit({ mode: 'split-grid', paneIds: ['a', 'b', 'c'], focusedPane: 0, ratios: [50, 50] }, 'primary', 60), 'secondary', 40);
    expect(computePaneRects(grid)).toEqual([
      { left: 0, top: 0, width: 60, height: 100 },
      { left: 60, top: 0, width: 40, height: 40 },
      { left: 60, top: 40, width: 40, height: 60 },
    ]);
    expect(computeDividers(grid)).toEqual([
      { id: 'primary', orientation: 'vertical', left: 60, top: 0, length: 100 },
      { id: 'secondary', orientation: 'horizontal', left: 60, top: 40, length: 40 },
    ]);
  });
});

describe('分屏持久化与登出清理', () => {
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

  test('读写恢复与账号隔离，且登出只清理分屏键', () => {
    const { values, storage } = memory({ unrelated: 'keep', narrafork_token: 'synthetic-untouched' });
    const key = splitStorageKey('alice', 'https://hub.example.net', serverEpoch);
    const state: SplitState = { mode: 'split-v', paneIds: ['a', 'b'], focusedPane: 1, ratios: [42, 50] };
    writeSplitLayout(storage, key, state);
    expect(readSplitLayout(storage, key)).toEqual(state);
    expect(readSplitLayout(storage, splitStorageKey('bob', 'https://hub.example.net', serverEpoch))).toBeNull();
    expect(readSplitLayout(memory({ [key]: '{"v":1,"mode":"split-h","paneIds":["a","a"]}' }).storage, key)).toBeNull();
    clearSplitLayout(storage);
    expect([...values.keys()].some(k => k.startsWith(SPLIT_STORAGE_PREFIX))).toBe(false);
    expect(values.get('unrelated')).toBe('keep');
    expect(values.get('narrafork_token')).toBe('synthetic-untouched');
  });
});

describe('标签栏拖拽与分屏高亮语义', () => {
  test('开启拖拽排序与分屏集合时渲染 draggable、排序按钮与分屏标识', () => {
    const html = renderToStaticMarkup(<InstanceTabBar
      state={{ openIds: ['a', 'b'], activeId: 'a' }}
      instances={[instance('a'), instance('b')]}
      selectedId="a"
      mountedIds={new Set(['a', 'b'])}
      splitIds={new Set(['a', 'b'])}
      activityFor={() => unknownActivity}
      lastSuccessFor={() => null}
      onActivate={() => {}}
      onClose={() => {}}
      onCloseAll={() => {}}
      onReorder={() => {}}
      collapsed={false}
      onToggleCollapsed={() => {}}
    />);
    expect(html).toContain('draggable="true"');
    expect(html).toContain('in-split');
    expect(html).toContain('分屏中');
    expect(html).toContain('将 A 往前移');
    expect(html).toContain('将 B 往后移');
  });
});
