import { afterEach, beforeEach, expect, test } from 'bun:test';
import { LIMITS, changesWithInstancesSchema, instanceSchema, instancesSchema, pairingSchema, pairResponseSchema, routes, runResponseSchema, snapshotHash } from '@nf-hub/protocol';
import { browserBase, readConfig } from '../src/config';
import { BASE, all, cfg, httpFixture, makeActor, publish, summary } from './fixture';

let h: Awaited<ReturnType<typeof httpFixture>>;
beforeEach(async()=>{h=await httpFixture();}); afterEach(()=>{h.db.close();});
test('登录用独立的 HttpOnly host-only Secure cookie；限速、来源、CSRF、失效检查',async()=>{
  const cookie = h.authHeaders.get('set-cookie')!;
  expect(cookie).toContain('__Host-'); expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly'); expect(cookie).not.toContain('Domain=');
  for(const path of [routes.me,routes.sessions,routes.projects,routes.overview,routes.instances,routes.changes]) expect((await h.req(path)).status).toBe(401);
  expect((await h.req(routes.instances,'GET',undefined,{cookie:h.cookie,host:'elsewhere.example.invalid','x-forwarded-host':cfg.publicUrl.host})).status).toBe(403);
  expect((await h.req(routes.instances,'GET',undefined,{cookie:h.cookie,'x-forwarded-for':'127.0.0.1'},'192.0.2.4')).status).toBe(403);
  const body={alias:'demo',browserBaseUrl:'https://demo.example.invalid'};
  expect((await h.req(routes.instances,'POST',body,{...h.writeHeaders,origin:'https://elsewhere.example.invalid'})).status).toBe(403);
  expect((await h.req(routes.instances,'POST',body,{cookie:h.cookie,origin:cfg.publicUrl.origin})).status).toBe(403);
  expect((await h.req(routes.logout,'POST',undefined,h.writeHeaders)).status).toBe(204);
  expect((await h.req(routes.me,'GET',undefined,{cookie:h.cookie})).status).toBe(401);
  // Invalid short bodies count toward the peer limiter before expensive password verification.
  for(let i=0;i<7;i++) expect((await h.req(routes.login,'POST',{}, {origin:cfg.publicUrl.origin})).status).toBe(400);
  expect((await h.req(routes.login,'POST',{}, {origin:cfg.publicUrl.origin})).status).toBe(429);
});
test('仅网页可以创建实例和签码，配对单用，Bearer不能读看板，cookie不能同步',async()=>{
  const created=await h.req(routes.instances,'POST',{alias:'demo',browserBaseUrl:'https://demo.example.invalid/base/'},h.writeHeaders);
  expect(created.status).toBe(201); const {id}=await created.json() as {id:string};
  const web={cookie:h.cookie}, issued=pairingSchema.parse(await (await h.req(routes.pairing(id),'POST',undefined,h.writeHeaders)).json());
  const req={protocolVersion:1,code:issued.code,scope:all,confirmed:true,connectorVersion:'0.1.0',capabilities:['summary.v1']};
  const pair=await h.req(routes.pair,'POST',req); expect(pair.status).toBe(201);
  const bound=pairResponseSchema.parse(await pair.json()), bearer={authorization:`Bearer ${bound.token}`};
  expect((await h.req(routes.pair,'POST',req)).status).toBe(401);
  expect((await h.req(routes.instances,'GET',undefined,bearer)).status).toBe(401);
  expect((await h.req(routes.instances,'GET',undefined,{...web,...bearer})).status).toBe(401);
  const runBody={protocolVersion:1,generation:bound.generation};
  expect((await h.req(routes.runs,'POST',runBody,web)).status).toBe(401);
  expect((await h.req(routes.runs,'POST',{...runBody,instanceId:id},bearer)).status).toBe(400);
  const lease=runResponseSchema.parse(await (await h.req(routes.runs,'POST',runBody,bearer)).json());
  const data={...runBody,runId:lease.runId,count:0,hash:await snapshotHash([]),summaries:[]};
  expect((await h.req(routes.snapshot(lease.runId),'POST',data,bearer)).status).toBe(200);
  expect(instancesSchema.parse(await (await h.req(routes.instances,'GET',undefined,web)).json()).items[0]?.sessionCount).toBe(0);
  expect((await h.req(routes.pairing(id),'POST',undefined,h.writeHeaders)).status).toBe(409);
  expect((await h.req(routes.revoke(id),'POST',undefined,h.writeHeaders)).status).toBe(200);
  expect((await h.req(routes.snapshot(lease.runId),'POST',data,bearer)).status).toBe(401);
});
test('管理员网页改浏览器地址后旧令牌继续同步；来源与CSRF校验不变',async()=>{
  const created=await h.req(routes.instances,'POST',{alias:'demo',browserBaseUrl:'https://demo.example.invalid'},h.writeHeaders);
  expect(created.status).toBe(201); const {id}=await created.json() as {id:string};
  const issued=pairingSchema.parse(await (await h.req(routes.pairing(id),'POST',undefined,h.writeHeaders)).json());
  const req={protocolVersion:1,code:issued.code,scope:all,confirmed:true,connectorVersion:'0.1.0',capabilities:['summary.v1']};
  const bound=pairResponseSchema.parse(await (await h.req(routes.pair,'POST',req)).json()), bearer={authorization:`Bearer ${bound.token}`};
  const url={browserBaseUrl:'https://10.8.0.2:7778',embedStatus:'verified'};
  expect((await h.req(routes.instance(id),'PATCH',url,{cookie:h.cookie,origin:cfg.publicUrl.origin})).status).toBe(403);
  expect((await h.req(routes.instance(id),'PATCH',url,{...h.writeHeaders,origin:'https://elsewhere.example.invalid'})).status).toBe(403);
  expect((await h.req(routes.instance(id),'PATCH',url,bearer)).status).toBe(401);
  const patched=await h.req(routes.instance(id),'PATCH',url,h.writeHeaders);
  expect(patched.status).toBe(200);
  expect(instanceSchema.parse(await patched.json())).toMatchObject({browserBaseUrl:'https://10.8.0.2:7778',embedStatus:'unverified',generation:bound.generation,connection:'connected'});
  const runBody={protocolVersion:1,generation:bound.generation};
  const lease=runResponseSchema.parse(await (await h.req(routes.runs,'POST',runBody,bearer)).json());
  const data={...runBody,runId:lease.runId,count:0,hash:await snapshotHash([]),summaries:[]};
  expect((await h.req(routes.snapshot(lease.runId),'POST',data,bearer)).status).toBe(200);
  expect((await h.req(routes.pairing(id),'POST',undefined,h.writeHeaders)).status).toBe(409);
});
test('ETag 不缓存跨时间的过期结果；变更端点也必须认证',async()=>{
  const a=makeActor(h.db,'alpha',BASE); await publish(h.db,a,[summary('a')],BASE);
  const initial=await h.req(routes.changes,'GET',undefined,{cookie:h.cookie}), etag=initial.headers.get('etag')!;
  expect(etag).toBeTruthy(); const headers={cookie:h.cookie,'if-none-match':etag};
  expect((await h.req(routes.changes,'GET',undefined,headers)).status).toBe(304);
  h.clock.now+=LIMITS.freshMs+1; expect((await h.req(routes.changes,'GET',undefined,headers)).status).toBe(200);
  expect((await h.req(routes.changes,'GET',undefined,{'if-none-match':etag})).status).toBe(401);
});
test('changes 实例表示与普通 ETag 不串用；撤销、失联边界和严格查询一致',async()=>{
  const a=makeActor(h.db,'bound',BASE); await publish(h.db,a,[summary('sample')],BASE);
  const headers={cookie:h.cookie};
  const plain=await h.req(routes.changes,'GET',undefined,headers), plainTag=plain.headers.get('etag')!;
  const full=await h.req(routes.changesWithInstances,'GET',undefined,{...headers,'if-none-match':plainTag});
  expect(full.status).toBe(200); const fullTag=full.headers.get('etag')!; expect(fullTag).not.toBe(plainTag);
  expect(changesWithInstancesSchema.parse(await full.json()).instances[0]?.sessionCount).toBe(1);
  expect((await h.req(routes.changes,'GET',undefined,{...headers,'if-none-match':fullTag})).status).toBe(200);
  expect((await h.req(routes.changesWithInstances,'GET',undefined,{...headers,'if-none-match':fullTag})).status).toBe(304);
  for(const q of ['?instances=0','?other=1','?instances=1&instances=1']) expect((await h.req(routes.changes+q,'GET',undefined,headers)).status).toBe(400);
  expect((await h.req(routes.changesWithInstances)).status).toBe(401);
  h.clock.now+=LIMITS.lostMs+1;
  const stale=await h.req(routes.changesWithInstances,'GET',undefined,{...headers,'if-none-match':fullTag});
  expect(changesWithInstancesSchema.parse(await stale.json()).instances[0]).toMatchObject({connection:'lost',freshness:'stale'});
  await h.req(routes.revoke(a.id),'POST',undefined,h.writeHeaders);
  const revoked=await h.req(routes.changesWithInstances,'GET',undefined,{...headers,'if-none-match':stale.headers.get('etag')!});
  expect(changesWithInstancesSchema.parse(await revoked.json()).instances[0]).toMatchObject({connection:'revoked',sessionCount:null});
});
test('仅明确回环开发可用 HTTP，生产地址和不受信反代不能放行',()=>{
  for (const env of [{PUBLIC_URL:'http://localhost'},{PUBLIC_URL:'http://example.invalid',DEV_HTTP:'1'},{PUBLIC_URL:'http://localhost',DEV_HTTP:'1',BIND_HOST:'0.0.0.0'}, {PUBLIC_URL:'https://user@example.invalid'}, {PUBLIC_URL:'https://*.example.invalid'},{PUBLIC_URL:'https://example.invalid',BIND_HOST:'0.0.0.0'},{PUBLIC_URL:'http://localhost',DEV_HTTP:'1',NODE_ENV:'production'}]) expect(()=>readConfig(env)).toThrow();
  expect(readConfig({PUBLIC_URL:'http://localhost:17900',DEV_HTTP:'1'}).devHttp).toBe(true);
  expect(()=>browserBase('https://hub.example.invalid:9443/nf',cfg)).toThrow('INVALID_INPUT'); // host-only cookies ignore port.
});
