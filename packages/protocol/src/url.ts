import { idSchema } from './summary';

export function parseHttpBase(raw: string): URL {
  if (raw.length > 2048 || !/^https?:\/\/[^/]/i.test(raw) || /[\s\\?#\p{Cc}\p{Cs}]/u.test(raw) || raw.split('/')[2]?.includes('@')) throw new Error('Expected a plain HTTP(S) base URL');
  const url = new URL(raw);
  // This origin is also written to CSP frame-src. Wildcards and directive syntax are not hostnames.
  if (url.username || url.password || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(url.hostname) || url.hostname.startsWith('.') || url.hostname.endsWith('.')) throw new Error('Invalid authority');
  return url;
}
export const isLoopbackHostname = (host: string) => ['127.0.0.1','::1','[::1]','localhost'].includes(host);
/** Pass the hub's configured public origin (in the browser: location.origin). */
export function normalizeBrowserBaseUrl(raw: string, hubUrl: string): string {
  const url = parseHttpBase(raw), hub = parseHttpBase(hubUrl);
  const development = hub.protocol === 'http:' && isLoopbackHostname(hub.hostname);
  if (hub.pathname !== '/' || (hub.protocol !== 'https:' && !development)) throw new Error('Invalid hub origin');
  // A host-only cookie is still shared across ports: the hub hostname must be dedicated.
  if (url.hostname === hub.hostname || (url.protocol !== 'https:' && !(development && isLoopbackHostname(url.hostname)))) throw new Error('Invalid instance origin');
  return url.href.replace(/\/+$/, '');
}
/** Use an instance's validated fixed browser base. No ID may change the origin, prefix or number of path segments. */
export function buildNarratorUrl(base: string, id: string): string {
  const url = parseHttpBase(base);
  if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) throw new Error('Invalid instance origin');
  if (!idSchema.safeParse(id).success) throw new Error('Invalid narrator ID');
  return `${url.href.replace(/\/+$/, '')}/narrators/${encodeURIComponent(id)}`;
}
