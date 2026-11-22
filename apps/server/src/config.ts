import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { isLoopbackHostname, normalizeBrowserBaseUrl, parseHttpBase } from '@nf-hub/protocol';
import { fail } from './errors';

type Env = Record<string, string | undefined>;
const loopback = (host: string) => ['127.0.0.1','::1','[::1]'].includes(host);
export function databasePath(env: Env = process.env): string { return resolve(env.DATABASE_PATH || '.data/hub.sqlite'); }
export function readConfig(env: Env = process.env) {
  if (!env.PUBLIC_URL) throw new Error('Set PUBLIC_URL to the canonical HTTPS origin');
  const url = parseHttpBase(env.PUBLIC_URL);
  const bindHost = env.BIND_HOST || '127.0.0.1';
  const port = Number(env.PORT || 17900);
  if (url.pathname !== '/' || !Number.isInteger(port) || port < 1 || port > 65535 || isIP(bindHost) === 0) throw new Error('Invalid public origin or listen address');
  if (env.DEV_HTTP !== undefined && !['0','1'].includes(env.DEV_HTTP)) throw new Error('DEV_HTTP must be 0 or 1');
  const devHttp = env.DEV_HTTP === '1';
  if (devHttp && (env.NODE_ENV === 'production' || url.protocol !== 'http:' || !isLoopbackHostname(url.hostname) || !loopback(bindHost))) throw new Error('DEV_HTTP requires a loopback development origin and bind address');
  if (!devHttp && url.protocol !== 'https:') throw new Error('Production PUBLIC_URL must be HTTPS');
  const certFile = env.TLS_CERT_FILE, keyFile = env.TLS_KEY_FILE, proxyIp = env.TRUSTED_PROXY_IP;
  if (!!certFile !== !!keyFile || (devHttp && (certFile || proxyIp)) || (certFile && proxyIp)) throw new Error('Choose direct TLS, trusted TLS proxy or loopback development');
  if (proxyIp && (!isIP(proxyIp) || ['0.0.0.0','::'].includes(proxyIp))) throw new Error('TRUSTED_PROXY_IP must be one immediate proxy peer address');
  if (!certFile && !devHttp && !loopback(bindHost) && !proxyIp) throw new Error('Non-loopback production listener requires direct TLS or a pinned TLS proxy peer');
  return { publicUrl: url, bindHost, port, devHttp, certFile, keyFile, proxyIp, databasePath: databasePath(env), webDist: resolve(env.WEB_DIST || 'apps/web/dist') };
}
export type Config = ReturnType<typeof readConfig>;
export function allowedPeer(config: Config, rawPeer: string | undefined): boolean {
  const ip = rawPeer?.replace(/^::ffff:/i, '') || '';
  if (config.devHttp) return loopback(ip);
  if (config.certFile) return !!ip;
  return config.proxyIp ? ip === config.proxyIp.replace(/^::ffff:/i, '') : loopback(ip);
}
export function browserBase(raw: string, config: Config) {
  try {
    const base = normalizeBrowserBaseUrl(raw,config.publicUrl.origin);
    return {base,origin:new URL(base).origin};
  } catch { return fail(400,'INVALID_INPUT'); }
}
