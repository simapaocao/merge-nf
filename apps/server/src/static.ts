import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { webSession } from './auth';
import { Fault, fail } from './errors';
import type { Router, Services } from './http-types';

const mime: Record<string,string> = {'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.webp':'image/webp','.jpg':'image/jpeg','.html':'text/html; charset=utf-8'};
function staticPath(root: string, file: string) {
  try {
    const base = realpathSync(root), candidate = realpathSync(resolve(base,file));
    const rel = relative(base,candidate);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(candidate).isFile()) return null;
    return candidate;
  } catch { return null; }
}
export function staticRoutes(app: Router, {db,config,clock}: Services) {
  app.get('*',c => {
    const path = c.req.path;
    if (path === '/api' || path.startsWith('/api/') || !/^\/[a-zA-Z0-9_./-]*$/.test(path) || path.split('/').some(s => s.startsWith('.'))) fail(404,'NOT_FOUND');
    const asset = path.startsWith('/assets/') || path === '/favicon.ico' || path === '/favicon.svg' || path === '/theme-init.js';
    if (!asset && extname(path) && path !== '/index.html') fail(404,'NOT_FOUND');
    const file = staticPath(config.webDist,asset ? path.slice(1) : 'index.html'), type = file && mime[extname(file).toLowerCase()];
    if (!file || !type) fail(404,'NOT_FOUND');
    if (!asset) {
      let loggedIn = false;
      try { webSession(db,config,c.req.raw,clock()); loggedIn=true; } catch (e) { if (!(e instanceof Fault) || e.status !== 401) throw e; }
      const origins = loggedIn ? db.query<{browserOrigin:string},[]>('SELECT browserOrigin FROM instances ORDER BY id').all().map(r=>r.browserOrigin) : [];
      c.header('Content-Security-Policy',`default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; frame-src ${origins.join(' ') || "'none'"}`);
      c.header('Vary','Cookie');
    } else if (path.startsWith('/assets/')) c.header('Cache-Control','public, max-age=31536000, immutable');
    else if (path === '/theme-init.js') c.header('Cache-Control','no-cache');
    c.header('Content-Type',type); return c.body(Bun.file(file).stream());
  });
}
