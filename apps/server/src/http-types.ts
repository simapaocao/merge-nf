import type { Database } from 'bun:sqlite';
import type { Context, Hono } from 'hono';
import type { WebSession } from './auth';
import type { Config } from './config';
import type { Admission } from './limits';
import { fail } from './errors';

export type HttpEnv = { Bindings:{peerAddress:string}; Variables:{session:WebSession; tokenHash:string; instanceId:string} };
export type Router = Hono<HttpEnv>;
export interface Services { db:Database; config:Config; clock:()=>number; admission:Admission }
export function noBody(c: Context<HttpEnv>) {
  const r = c.req.raw;
  if (r.headers.has('transfer-encoding') || (r.headers.has('content-length') && r.headers.get('content-length') !== '0') || (r.body && r.headers.get('content-length') !== '0')) fail(400,'INVALID_INPUT');
}
export function queryParams(c: Context<HttpEnv>) {
  const query:Record<string,string> = Object.create(null);
  for (const [k,v] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(query,k) || k.length > 32 || v.length > 1024) fail(400,'INVALID_INPUT'); query[k]=v;
  }
  return query;
}
