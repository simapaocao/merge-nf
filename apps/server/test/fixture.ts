import type { Database } from 'bun:sqlite';
import { LIMITS, snapshotHash, type PairRequest, type PublishScope, type Summary } from '@nf-hub/protocol';
import { createApp } from '../src/app';
import { digest, initializeAdmin, secret } from '../src/auth';
import { readConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { createInstance } from '../src/instances';
import { claim, issueCode } from '../src/pairing';
import { acceptSnapshot, startRun } from '../src/sync';

export const cfg = readConfig({PUBLIC_URL:'https://hub.example.invalid'});
export const all = {mode:'all',includeArchived:true,acknowledgeHidden:true} as const satisfies PublishScope;
export const BASE = 1_750_000_000_000;
export function summary(id: string, overrides: Partial<Summary> = {}): Summary {
  return {id,title:`标题 ${id}`,status:'idle',projectId:null,lastMessageAt:null,updatedAt:BASE,...overrides};
}
export function makeActor(db: Database, host: string, now: number, scope: PairRequest['scope'] = all, names = false) {
  const i = createInstance(db,cfg,{alias:host,browserBaseUrl:`https://${host}.example.invalid/base`},now);
  const p = issueCode(db,i.id,now);
  const body: PairRequest = {protocolVersion:1,code:p.code,scope,confirmed:true,connectorVersion:'0.1.0',capabilities:names ? ['summary.v1','projectNames.v1'] : ['summary.v1']};
  const bound = claim(db,body,now);
  return {id:i.id,hash:digest(bound.token),...bound,request:body,issued:p};
}
export type Actor = ReturnType<typeof makeActor>;
export const run = (db: Database, actor: Actor, now: number) => startRun(db,actor.hash,{protocolVersion:1,generation:actor.generation},now);
export async function packet(actor: Actor, runId: number, summaries: Summary[]) { return {protocolVersion:1,generation:actor.generation,runId,count:summaries.length,hash:await snapshotHash(summaries),summaries}; }
export async function publish(db: Database, actor: Actor, items: Summary[], now: number) {
  const r = run(db,actor,now); return acceptSnapshot(db,actor.hash,r.runId,await packet(actor,r.runId,items),()=>now);
}
/** Reusable synthetic three-instance dashboard. No defaults installed by the server and no network calls. */
export async function sampleDashboard(db: Database, now: number) {
  const office=makeActor(db,'office',now,undefined,true), home=makeActor(db,'home',now-LIMITS.lostMs-1), cloud=makeActor(db,'cloud',now);
  await publish(db,office,[summary('shared',{title:'接口开发',status:'working',projectId:'dev',projectName:'应用开发',updatedAt:now}),summary('readme',{title:'',status:'idle',updatedAt:now-60_000})],now);
  await publish(db,home,[summary('shared',{title:'测试修复',status:'working',updatedAt:now-LIMITS.lostMs-1})],now-LIMITS.lostMs-1);
  return {office:office.id,home:home.id,cloud:cloud.id};
}
export async function httpFixture() {
  const db = openDatabase(':memory:'), password = secret(32), clock = {now:BASE};
  await initializeAdmin(db,'owner',password,clock.now);
  const app = createApp(db,cfg,()=>clock.now);
  function req(path:string,method='GET',body?:unknown,extra:Record<string,string>={},peer='127.0.0.1') {
    const headers = {host:cfg.publicUrl.host,...(body === undefined ? {} : {'content-type':'application/json'}),...extra};
    return app.request(cfg.publicUrl.origin+path,{method,headers,body:body === undefined ? undefined : JSON.stringify(body)},{peerAddress:peer});
  }
  const auth = await req('/api/auth/login','POST',{username:'owner',password},{origin:cfg.publicUrl.origin});
  if (auth.status !== 200) throw new Error('Fixture could not log in');
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!, {csrfToken} = await auth.json() as {csrfToken:string};
  return {db,req,clock,password,cookie,authHeaders:auth.headers,writeHeaders:{cookie,origin:cfg.publicUrl.origin,'x-csrf-token':csrfToken},freshMs:LIMITS.freshMs};
}
