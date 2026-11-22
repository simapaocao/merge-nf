import { fail } from './errors';

/** Synchronous accounting per server process; does not trust client IP headers. */
export class Admission {
  private buckets = new Map<string,{used:number;until:number}>();
  private active = new Map<string,number>();
  constructor(private clock: () => number) {}
  rate(key: string, max: number, interval: number) {
    const now = this.clock(); let entry = this.buckets.get(key);
    if (!entry || now >= entry.until) {
      if (this.buckets.size >= 4096) {
        for (const [k,v] of this.buckets) if (now >= v.until) this.buckets.delete(k);
        if (!entry && this.buckets.size >= 4096) fail(429,'RATE_LIMITED');
      }
      entry = {used:0,until:now + interval}; this.buckets.set(key,entry);
    }
    if (entry.used >= max) fail(429,'RATE_LIMITED'); entry.used++;
  }
  async withSlot<T>(key: string, max: number, fn: () => Promise<T>): Promise<T> {
    const n = this.active.get(key) ?? 0;
    if (n >= max) fail(429,'BUSY'); this.active.set(key,n+1);
    try { return await fn(); } finally {
      const left = this.active.get(key)! - 1;
      if (left) this.active.set(key,left); else this.active.delete(key);
    }
  }
}
export async function readJson(req: Request, limit = 32 * 1024): Promise<unknown> {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const encoding = req.headers.get('content-encoding')?.trim().toLowerCase();
  if (type !== 'application/json' || (encoding && encoding !== 'identity')) fail(415,'UNSUPPORTED_MEDIA');
  const size = req.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > limit)) fail(413,'TOO_LARGE');
  if (!req.body) fail(400,'INVALID_INPUT');
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0, expired = false;
  const deadline = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 25_000);
  try {
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { void reader.cancel().catch(() => {}); fail(413,'TOO_LARGE'); }
      if (value.byteLength) chunks.push(value);
    }
  } finally { clearTimeout(deadline); reader.releaseLock(); }
  if (expired) fail(408,'INVALID_INPUT');
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks,bytes))); }
  catch { return fail(400,'INVALID_INPUT'); }
}
