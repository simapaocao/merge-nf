import { isLoopbackHostname } from '@nf-hub/protocol';

/** 前置 HTTPS 的默认监听端口。填写时必须与前置实际监听一致。 */
export const FRONT_HTTPS_PORT = '8443';

/** 设备原始地址是否为 HTTP。 */
export function isHttpUrl(raw: string): boolean {
  return /^http:\/\//i.test(raw.trim());
}

export function urlHostname(raw: string): string {
  try { return new URL(raw.trim()).hostname; } catch { return ''; }
}

/** 回环 HTTP 只在开发机本机可用，不属于需要额外前置的场景。 */
export function isLoopbackHttp(raw: string): boolean {
  const host = urlHostname(raw);
  return isHttpUrl(raw) && !!host && isLoopbackHostname(host);
}

/**
 * 把 HTTP 设备地址映射为前置 HTTPS 地址：保留主机名与基路径，端口换成前置监听端口。
 * 只给出可填写的目标地址，不会把原 HTTP 端口直接写成 https。
 */
export function httpsFrontSuggestion(raw: string, port: string = FRONT_HTTPS_PORT): string | null {
  const value = raw.trim();
  if (!/^http:\/\/[^/\s]/i.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!url.hostname) return null;
  return `https://${url.hostname}:${port}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * 编辑地址时判断这次保存属于哪一种情况，用于给出对应说明。
 * 仅凭地址无法区分「同一台设备换了 IP」和「换成另一台设备」，因此主机变化时两种路径并列给出。
 */
export type AddressChange = 'add' | 'unchanged' | 'port' | 'host' | null;

function portOf(raw: string): string {
  try { const url = new URL(raw.trim()); return url.port || (url.protocol === 'https:' ? '443' : '80'); }
  catch { return ''; }
}

export function addressChange(original: string | undefined, current: string): AddressChange {
  if (!original) return 'add';
  const next = urlHostname(current);
  if (!next) return null;
  if (next !== urlHostname(original)) return 'host';
  return portOf(current) === portOf(original) ? 'unchanged' : 'port';
}
