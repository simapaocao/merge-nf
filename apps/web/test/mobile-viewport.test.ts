import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installMobileZoomGuard } from '../src/lib/mobileViewport';

describe('移动端缩放防护与 SE3 适配基础', () => {
  test('viewport 禁止页面缩放并启用安全区，关闭电话号码自动识别', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1] ?? '';
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('initial-scale=1.0');
    expect(viewport).toContain('maximum-scale=1.0');
    expect(viewport).toContain('user-scalable=no');
    expect(viewport).toContain('viewport-fit=cover');
    expect(html).toContain('<meta name="format-detection" content="telephone=no" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="多 NF 工作台" />');
  });

  test('双指捏合与 Safari 手势事件被阻止，单指滚动与点击不受影响，卸载后清理监听', () => {
    const listeners = new Map<string, Set<EventListener>>();
    const optionsSeen: Array<boolean | AddEventListenerOptions | undefined> = [];
    const target = {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
        optionsSeen.push(options);
        const set = listeners.get(type) ?? new Set();
        set.add(listener as EventListener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        listeners.get(type)?.delete(listener as EventListener);
      },
    };
    const emit = (type: string, extra: Record<string, unknown> = {}) => {
      let prevented = false;
      const event = { cancelable: true, preventDefault: () => { prevented = true; }, ...extra } as unknown as Event;
      listeners.get(type)?.forEach(fn => fn(event));
      return prevented;
    };

    const cleanup = installMobileZoomGuard(target);
    expect(optionsSeen.every(opt => typeof opt === 'object' && opt?.passive === false)).toBe(true);

    // iOS Safari gesture events must be prevented.
    expect(emit('gesturestart')).toBe(true);
    expect(emit('gesturechange')).toBe(true);
    expect(emit('gestureend')).toBe(true);

    // Two-finger touch and scaled touchmove must be prevented.
    expect(emit('touchstart', { touches: { length: 2 } })).toBe(true);
    expect(emit('touchmove', { touches: { length: 2 } })).toBe(true);
    expect(emit('touchmove', { touches: { length: 1 }, scale: 1.2 })).toBe(true);

    // Single-finger scroll/tap must pass through untouched.
    expect(emit('touchstart', { touches: { length: 1 } })).toBe(false);
    expect(emit('touchmove', { touches: { length: 1 }, scale: 1 })).toBe(false);
    expect(emit('touchmove', { touches: { length: 1 } })).toBe(false);

    // Non-cancelable events do not throw or call preventDefault.
    expect(emit('gesturestart', { cancelable: false })).toBe(false);

    cleanup();
    expect(emit('gesturestart')).toBe(false);
    expect(emit('touchstart', { touches: { length: 2 } })).toBe(false);
  });

  test('移动端输入与选择控件保持 16px 字号避免 iOS Safari 自动放大，并修复窄屏连接指引多列挤压', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('touch-action:pan-x pan-y');
    expect(css).toContain('touch-action:manipulation');
    expect(css).toContain('.connection-paths>div{grid-template-columns:1fr;gap:14px}');
    expect(css).toContain('.search-field input{font-size:16px');
    expect(css).toContain('.filters select{width:100%;height:40px;font-size:16px');
    expect(css).toContain('.form-stack input:not([type=checkbox]):not([type=color]){font-size:16px');
    expect(css).toContain('.page-size select{height:38px;font-size:16px');
    expect(css).toContain('.instance-tabs.tabs-empty-state,.instance-tabs.collapsed{display:none}');
  });
});
