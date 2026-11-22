import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app';
import { openDatabase } from '../src/db';
import { BASE, cfg, httpFixture, makeActor } from './fixture';

let dist: string;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'nf-hub-static-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/theme-init.js"></script>');
  writeFileSync(join(dist, 'theme-init.js'), 'globalThis.testTheme = true;');
  writeFileSync(join(dist, 'other.js'), 'not public');
  writeFileSync(join(dist, 'assets', 'index-abcdef12.js'), 'export {};');
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

function request(path: string) {
  const db = openDatabase(':memory:');
  const app = createApp(db, { ...cfg, webDist: dist }, () => BASE);
  const result = app.request(cfg.publicUrl.origin + path, { headers: { host: cfg.publicUrl.host } }, { peerAddress: '127.0.0.1' });
  return Promise.resolve(result).finally(() => db.close());
}

describe('精确的主题启动资源', () => {
  test('未登录也可获取同源 JS，非 hash 脚本必须重新验证缓存', async () => {
    const response = await request('/theme-init.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(await response.text()).toBe('globalThis.testTheme = true;');
  });
  test('hash 资源缓存策略保持不变，其余根脚本和变体继续拒绝', async () => {
    expect((await request('/assets/index-abcdef12.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const path of ['/other.js', '/theme-init.js.map', '/theme-init.json', '/Theme-init.js', '/nested/theme-init.js', '/.env']) {
      expect((await request(path)).status).toBe(404);
    }
    // Hono decodes this spelling to the same exact resource, not another root script.
    const encoded = await request('/theme%2dinit.js');
    expect(encoded.status).toBe(200);
    expect(encoded.headers.get('cache-control')).toBe('no-cache');
    expect(encoded.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await encoded.text()).toBe('globalThis.testTheme = true;');
    // API routes keep their existing authentication boundary rather than falling back to HTML.
    const api = await request('/api/missing');
    expect(api.status).toBe(401);
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('content-type')).toContain('application/json');
  });
  test('HTML CSP 保持原有 script-src 和 frame-src 授权语义', async () => {
    const anonymous = await request('/index.html');
    expect(anonymous.headers.get('content-security-policy')).toBe("default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; frame-src 'none'");
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    expect(anonymous.headers.get('vary')).toBe('Cookie');
    const fixture = await httpFixture();
    try {
      makeActor(fixture.db, 'nf-static', BASE);
      const app = createApp(fixture.db, { ...cfg, webDist: dist }, () => BASE);
      const response = await app.request(cfg.publicUrl.origin + '/', { headers: { host: cfg.publicUrl.host, cookie: fixture.cookie } }, { peerAddress: '127.0.0.1' });
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; frame-src https://nf-static.example.invalid");
    } finally { fixture.db.close(); }
  });
});
