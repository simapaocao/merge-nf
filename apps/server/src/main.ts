import { readFileSync } from 'node:fs';
import { LIMITS } from '@nf-hub/protocol';
import { createApp } from './app';
import { browserBase, readConfig } from './config';
import { openDatabase, readyToServe } from './db';

export function startServer() {
  if (process.platform !== 'win32') process.umask(0o077);
  const cfg = readConfig(), db = openDatabase(cfg.databasePath);
  try {
    readyToServe(db);
    // Revalidate persisted origins after restore or a PUBLIC_URL/transport change, before listening.
    for (const r of db.query<{browserBaseUrl:string;browserOrigin:string},[]>('SELECT browserBaseUrl,browserOrigin FROM instances').all()) {
      if (browserBase(r.browserBaseUrl,cfg).origin !== r.browserOrigin) throw new Error('Review stored instance origins before startup');
    }
    const app = createApp(db,cfg);
    const server = Bun.serve({ hostname:cfg.bindHost, port:cfg.port, development:false, idleTimeout:30,
      maxRequestBodySize:LIMITS.snapshotBytes, tls:cfg.certFile && cfg.keyFile ? {cert:readFileSync(cfg.certFile),key:readFileSync(cfg.keyFile)} : undefined,
      fetch(req,srv) { return app.fetch(req,{peerAddress:srv.requestIP(req)?.address || ''}); },
      error() { return Response.json({error:{code:'INTERNAL'}},{status:500,headers:{'Cache-Control':'no-store'}}); },
    });
    console.info(`NF workbench listening on ${cfg.bindHost}:${server.port} (${cfg.devHttp ? 'loopback development' : cfg.certFile ? 'TLS' : 'pinned proxy peer'})`);
    return {server,db,async stop() { await server.stop(true); db.close(); }};
  } catch(e) { db.close(); throw e; }
}
if (import.meta.main) {
  try {
    const runtime = startServer(); let stopping=false;
    const shutdown = async () => { if (!stopping) { stopping=true; await runtime.stop(); } };
    process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
  } catch(e) { console.error(e instanceof Error ? e.message : 'Startup failed'); process.exitCode=1; }
}
