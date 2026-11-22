import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { allowedPeer, type Config } from './config';
import { connectorRoutes } from './connector-routes';
import { Fault, fail } from './errors';
import type { HttpEnv } from './http-types';
import { Admission } from './limits';
import { staticRoutes } from './static';
import { webRoutes } from './web-routes';

export function createApp(db: Database, config: Config, clock: ()=>number = Date.now) {
  const app = new Hono<HttpEnv>(), deps = {db,config,clock,admission:new Admission(clock)};
  app.use('*', async (c,next) => {
    c.header('Cache-Control','no-store'); c.header('X-Content-Type-Options','nosniff');
    c.header('Referrer-Policy','no-referrer'); c.header('X-Frame-Options','DENY');
    c.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!config.devHttp) c.header('Strict-Transport-Security','max-age=31536000');
    const host = (c.req.header('Host') || '').toLowerCase();
    const publicUrl = config.publicUrl, defaultPort = publicUrl.protocol === 'https:' ? 443 : 80;
    const expectedHost = host === publicUrl.host || (!publicUrl.port && host === `${publicUrl.hostname}:${defaultPort}`);
    if (!allowedPeer(config,c.env?.peerAddress) || !expectedHost) fail(403,'BAD_ORIGIN');
    await next();
  });
  app.onError((err,c) => {
    const fault = err instanceof Fault ? err : new Fault(500,'INTERNAL');
    // No URL, request body, rejected field, token, query or stack enters logs.
    if (!(err instanceof Fault)) console.error('hub.request.internal');
    if (fault.status === 429) c.header('Retry-After',fault.code === 'BUSY' ? '2' : '60');
    c.header('Cache-Control','no-store'); return c.json({error:{code:fault.code}},fault.status);
  });
  app.notFound(c => c.json({error:{code:'NOT_FOUND'}},404));
  connectorRoutes(app,deps); webRoutes(app,deps); staticRoutes(app,deps);
  return app;
}
