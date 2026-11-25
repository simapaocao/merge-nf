import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ACTIVITY_SNAPSHOT_ROUTE, LIMITS, activityHash, activityReceiptSchema, instanceActivitySchema, overviewSchema, sessionGroupsQuerySchema, sessionGroupsSchema, sessionsQuerySchema, sessionsSchema, type ActivityItem, type Summary } from '@nf-hub/protocol';
import { receiveActivity } from '../src/activity';
import { changes, instanceActivity, overview, sessionGroups, sessions } from '../src/dashboard';
import { openDatabase } from '../src/db';
import { deleteInstance, instanceRecord } from '../src/instances';
import { migrate, SCHEMA_VERSION } from '../src/migrations';
import { revoke } from '../src/pairing';
import { failRun } from '../src/sync';
import { BASE, httpFixture, makeActor, publish, run, summary, type Actor } from './fixture';

let db:Database;
beforeEach(()=>{db=openDatabase(':memory:');});afterEach(()=>db.close());
const item=(id:string,delta:Partial<ActivityItem>={}):ActivityItem=>({id,reply:false,approval:false,error:false,unread:false,backgroundWorkCount:0,...delta});
const stats=(now=BASE)=>instanceActivitySchema.parse(instanceActivity(db,now));
const groups=(q:Record<string,string>={},now=BASE)=>sessionGroupsSchema.parse(sessionGroups(db,sessionGroupsQuerySchema.parse(q),now));
const list=(q:Record<string,string>={},now=BASE)=>sessionsSchema.parse(sessions(db,sessionsQuerySchema.parse(q),now));
async function publication(actor:Actor,items:ActivityItem[],database=db){
  const base=instanceRecord(database,actor.id);
  return {protocolVersion:1 as const,generation:actor.generation,runId:base.runSeq,baseHash:base.snapshotHash!,available:true as const,count:items.length,hash:await activityHash(items),items};
}
async function enhance(actor:Actor,items:ActivityItem[],now=BASE,database=db){
  const packet=await publication(actor,items,database);
  return receiveActivity(database,actor.hash,packet,()=>now);
}

test('完整安全活动去重统计，attention优先，后台/工作/自动等待并集且旧列表不扩字段',async()=>{
  const a=makeActor(db,'enhanced',BASE);
  await publish(db,a,[summary('w',{status:'working'}),summary('b'),summary('f',{status:'working'}),summary('r',{status:'waiting'}),summary('auto',{status:'waiting'}),summary('n',{status:'unknown'}),summary('arch',{status:'archived'})],BASE);
  await enhance(a,[item('w',{reply:true,backgroundWorkCount:3}),item('b',{backgroundWorkCount:2}),item('f'),item('r',{reply:true,approval:true}),item('auto'),item('n'),item('arch',{error:true,backgroundWorkCount:20})]);
  expect(stats().items[0]).toMatchObject({counts:{total:6,working:2,waiting:2,idle:1,unknown:1,archived:0},runningCount:4,attention:{supported:true,count:2},background:{supported:true,count:2}});
  const g=groups();
  expect(g).toMatchObject({total:6,attention:{supported:true,coverage:'complete',total:2},running:{coverage:'complete',total:3},recent:{coverage:'complete',total:1}});
  expect(g.attention.items.find(r=>r.id==='r')?.activity).toEqual({reply:true,approval:true,error:false,unread:false,backgroundWorkCount:0});
  expect(g.running.items.map(r=>r.id).sort()).toEqual(['auto','b','f']);
  expect(g.recent.items.map(r=>r.id)).toEqual(['n']);
  expect(groups({includeArchived:'true'}).attention.total).toBe(3);
  for(const group of ['attention','running','recent']){
    const page=list({group});
    expect(page.total).toBe(g[group as 'attention'|'running'|'recent'].total!);
    expect(page.items.every(row=>!Object.hasOwn(row,'activity'))).toBe(true);
    expect(sessionsSchema.safeParse(page).success).toBe(true);
  }
  // The old overview retains status-based counts, including authorized archived rows.
  expect(overviewSchema.parse(overview(db,BASE)).freshCounts).toMatchObject({total:7,working:2,waiting:2,archived:1});
});

test('部分增强不冒充完整覆盖；旧插件waiting仍recent，已支持真零不等于未支持',async()=>{
  const a=makeActor(db,'new',BASE),b=makeActor(db,'old',BASE);
  await publish(db,a,[summary('a',{status:'waiting'})],BASE);await publish(db,b,[summary('b',{status:'waiting'})],BASE);
  await enhance(a,[item('a')]);
  expect(stats().items.find(x=>x.instanceId===a.id)).toMatchObject({runningCount:1,attention:{supported:true,count:0},background:{supported:true,count:0}});
  expect(stats().items.find(x=>x.instanceId===b.id)).toMatchObject({runningCount:0,attention:{supported:false,count:null},background:{supported:false,count:null}});
  expect(groups()).toMatchObject({attention:{coverage:'partial',supported:true,total:0},running:{coverage:'partial',total:1},recent:{coverage:'partial',total:1}});
  expect(groups({instanceId:a.id}).attention.coverage).toBe('complete');
  expect(groups({instanceId:b.id}).attention).toMatchObject({coverage:'none',supported:false,total:null,items:[]});
  // A q/status/project filter cannot turn an unprovided instance into complete enhancement coverage.
  expect(groups({q:'not-present'}).attention).toMatchObject({coverage:'partial',supported:true,total:0});
  expect(list({group:'recent'}).items[0]).toMatchObject({id:'b'});
  await enhance(b,[item('b',{approval:true})]);
  expect(groups()).toMatchObject({attention:{coverage:'complete',total:1},running:{total:1},recent:{total:0}});
});

test('fresh空快照的增强是真正支持的0；从未同步/旧协议/陈旧均保持unknown',async()=>{
  const a=makeActor(db,'empty',BASE),b=makeActor(db,'never',BASE);
  await publish(db,a,[],BASE);await enhance(a,[]);
  expect(stats().items.find(x=>x.instanceId===a.id)).toMatchObject({runningCount:0,attention:{supported:true,count:0},background:{supported:true,count:0}});
  expect(stats().items.find(x=>x.instanceId===b.id)).toMatchObject({runningCount:null,counts:null,attention:{supported:false,count:null}});
  expect(groups({instanceId:a.id})).toMatchObject({total:0,attention:{supported:true,total:0,coverage:'complete'}});
  expect(stats(BASE+LIMITS.freshMs+1).items.find(x=>x.instanceId===a.id)).toMatchObject({freshness:'stale',counts:null,runningCount:null,attention:{supported:false,count:null}});
});

test('绑定当前已成功base lease、hash、generation及完整IDs，拒绝缺失/额外/重复/越实例',async()=>{
  const a=makeActor(db,'alpha',BASE),b=makeActor(db,'beta',BASE);
  await publish(db,a,[summary('a'),summary('b')],BASE);await publish(db,b,[summary('other')],BASE);
  const good=await publication(a,[item('a'),item('b')]);
  await expect(receiveActivity(db,a.hash,{...good,baseHash:'0'.repeat(64)},()=>BASE)).rejects.toThrow('HASH_MISMATCH');
  await expect(receiveActivity(db,a.hash,{...good,generation:a.generation+1},()=>BASE)).rejects.toThrow('FORBIDDEN');
  for(const items of [[item('a')],[item('a'),item('other')],[item('a'),item('b'),item('extra')]]){
    await expect(receiveActivity(db,a.hash,await publication(a,items),()=>BASE)).rejects.toThrow('INVALID_SCOPE');
  }
  await expect(receiveActivity(db,a.hash,{...good,items:[item('a'),item('a')]},()=>BASE)).rejects.toThrow('INVALID_INPUT');
  await expect(receiveActivity(db,a.hash,{...good,hash:'0'.repeat(64)},()=>BASE)).rejects.toThrow('HASH_MISMATCH');
  await expect(receiveActivity(db,b.hash,good,()=>BASE)).rejects.toThrow('HASH_MISMATCH');
  expect(db.query('SELECT 1 FROM activity_items').get()).toBeNull();
  await receiveActivity(db,a.hash,{...good,items:[item('b'),item('a')]},()=>BASE);
  expect(stats().items.find(x=>x.instanceId===a.id)?.attention).toEqual({supported:true,count:0});
});

test('未提交/失败/过期与迟到旧run不接受活动，摘要授权与scope不被修改',async()=>{
  const a=makeActor(db,'alpha',BASE);await publish(db,a,[summary('a')],BASE);
  const packet=await publication(a,[item('a')]);
  await expect(receiveActivity(db,a.hash,packet,()=>BASE+LIMITS.runMs)).rejects.toThrow('RUN_EXPIRED');
  const lease=run(db,a,BASE+1);
  await expect(receiveActivity(db,a.hash,packet,()=>BASE+1)).rejects.toThrow('STALE_RUN');
  await expect(receiveActivity(db,a.hash,{...packet,runId:lease.runId},()=>BASE+1)).rejects.toThrow('RUN_CLOSED');
  failRun(db,a.hash,lease.runId,{protocolVersion:1,generation:a.generation,runId:lease.runId,errorCode:'QUERY_FAILED'},BASE+2);
  await expect(receiveActivity(db,a.hash,{...packet,runId:lease.runId},()=>BASE+2)).rejects.toThrow('RUN_CLOSED');
  expect(instanceRecord(db,a.id)).toMatchObject({authState:'active',generation:a.generation,sessionCount:1});
  expect(list().total).toBe(1);
});

test('同run/hash重放幂等，新run同hash刷新中心时间，同run不同hash与撤回后迟到true明确拒绝',async()=>{
  const a=makeActor(db,'alpha',BASE),rows=[summary('a')];await publish(db,a,rows,BASE);
  const packet=await publication(a,[item('a')]);await receiveActivity(db,a.hash,packet,()=>BASE+1);
  const firstVersion=changes(db,BASE+1).version;
  await receiveActivity(db,a.hash,packet,()=>BASE+20);
  expect(changes(db,BASE+20).version).toBe(firstVersion);
  expect(db.query<{receivedAt:number},[]>('SELECT receivedAt FROM activity_snapshots').get()?.receivedAt).toBe(BASE+1);
  await expect(receiveActivity(db,a.hash,await publication(a,[item('a',{reply:true})]),()=>BASE+21)).rejects.toThrow('RUN_CLOSED');
  await publish(db,a,rows,BASE+30);await enhance(a,[item('a')],BASE+31);
  expect(db.query<{receivedAt:number},[]>('SELECT receivedAt FROM activity_snapshots').get()?.receivedAt).toBe(BASE+31);
  await expect(receiveActivity(db,a.hash,packet,()=>BASE+32)).rejects.toThrow('STALE_RUN');
  const newer=await publication(a,[item('a')]);
  const unavailable={protocolVersion:1,generation:a.generation,runId:newer.runId,baseHash:newer.baseHash,available:false};
  await receiveActivity(db,a.hash,unavailable,()=>BASE+33);
  await expect(receiveActivity(db,a.hash,newer,()=>BASE+34)).rejects.toThrow('RUN_CLOSED');
  expect(db.query('SELECT 1 FROM activity_items').get()).toBeNull();
  expect(stats(BASE+34).items[0]?.attention).toEqual({supported:false,count:null});
});

test('available:false仅清本实例增强，不删除基础摘要或影响其他实例',async()=>{
  const a=makeActor(db,'alpha',BASE),b=makeActor(db,'beta',BASE);
  await publish(db,a,[summary('a')],BASE);await publish(db,b,[summary('b')],BASE);
  await enhance(a,[item('a',{reply:true})]);await enhance(b,[item('b',{unread:true})]);
  const before=instanceRecord(db,a.id),packet=await publication(a,[item('a')]);
  await receiveActivity(db,a.hash,{protocolVersion:1,generation:a.generation,runId:packet.runId,baseHash:packet.baseHash,available:false},()=>BASE+1);
  expect(instanceRecord(db,a.id)).toEqual(before);
  expect(list().total).toBe(2);
  expect(stats().items.find(x=>x.instanceId===a.id)?.attention).toEqual({supported:false,count:null});
  expect(stats().items.find(x=>x.instanceId===b.id)?.attention).toEqual({supported:true,count:1});
  expect(groups().attention).toMatchObject({coverage:'partial',total:1});
});

test('活动独立TTL到期改变changes的opaque版本并丢弃活动，基础快照仍fresh',async()=>{
  const a=makeActor(db,'ttl',BASE),rows=[summary('s',{status:'waiting'})];
  await publish(db,a,rows,BASE);await enhance(a,[item('s',{reply:true})],BASE+1);
  // A newer, unchanged base refreshes base freshness without pretending to refresh activity.
  await publish(db,a,rows,BASE+60_000);
  const boundary=BASE+LIMITS.freshMs+1;
  const before=changes(db,boundary).version;
  expect(groups({},boundary).attention).toMatchObject({supported:true,total:1});
  expect(changes(db,boundary+1).version).not.toBe(before);
  expect(stats(boundary+1).items[0]).toMatchObject({freshness:'fresh',counts:{waiting:1},runningCount:0,attention:{supported:false,count:null}});
  expect(groups({},boundary+1)).toMatchObject({attention:{coverage:'none',total:null},running:{total:0},recent:{total:1}});
});

test('撤销/删实例/换代/换base会清理且不复活旧活动',async()=>{
  const a=makeActor(db,'retire',BASE);await publish(db,a,[summary('a')],BASE);await enhance(a,[item('a',{reply:true})]);
  const oldPacket=await publication(a,[item('a',{reply:true})]);
  await publish(db,a,[summary('new')],BASE+1);
  expect(db.query('SELECT 1 FROM activity_snapshots').get()).toBeNull();
  await publish(db,a,[summary('a')],BASE+2);
  expect(stats(BASE+2).items[0]?.attention).toEqual({supported:false,count:null});
  await expect(receiveActivity(db,a.hash,oldPacket,()=>BASE+3)).rejects.toThrow('STALE_RUN');
  await enhance(a,[item('a',{reply:true})],BASE+3);
  revoke(db,a.id,BASE+4);
  expect(db.query('SELECT 1 FROM activity_snapshots').get()).toBeNull();expect(db.query('SELECT 1 FROM activity_items').get()).toBeNull();
  expect(list().total).toBe(0);
  await expect(receiveActivity(db,a.hash,oldPacket,()=>BASE+4)).rejects.toThrow('UNAUTHENTICATED');
  const b=makeActor(db,'delete',BASE);await publish(db,b,[summary('b')],BASE);await enhance(b,[item('b')]);
  deleteInstance(db,b.id,BASE+1);
  expect(db.query('SELECT 1 FROM activity_snapshots').get()).toBeNull();expect(db.query('SELECT 1 FROM activity_items').get()).toBeNull();
});

test('hash异步阶段发生撤销/新run/过期时，写事务重新校验且不落旧包',async()=>{
  for(const race of ['revoke','newrun','expiry'] as const){
    const a=makeActor(db,race,BASE);await publish(db,a,[summary('s')],BASE);
    const packet=await publication(a,[item('s')]);let now=BASE;
    const pending=receiveActivity(db,a.hash,packet,()=>now);
    if(race==='revoke') revoke(db,a.id,BASE);
    if(race==='newrun') run(db,a,BASE+1);
    if(race==='expiry') now=BASE+LIMITS.runMs;
    await expect(pending).rejects.toThrow(race==='revoke'?'UNAUTHENTICATED':race==='newrun'?'STALE_RUN':'RUN_EXPIRED');
    expect(db.query('SELECT 1 FROM activity_items WHERE instanceId=?').get(a.id)).toBeNull();
  }
});

test('schema1原库追加迁移兼容，基础授权与摘要不动；重复迁移幂等',async()=>{
  const a=makeActor(db,'migrate',BASE);await publish(db,a,[summary('retained')],BASE);
  const before=instanceRecord(db,a.id);
  db.exec('DROP TRIGGER retire_session_metadata_base; DROP TABLE session_metadata_items; DROP TABLE session_metadata_snapshots; DROP TRIGGER retire_activity_base; DROP TABLE activity_items; DROP TABLE activity_snapshots; PRAGMA user_version=1;');
  migrate(db);migrate(db);
  expect(db.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(instanceRecord(db,a.id)).toEqual(before);expect(list().total).toBe(1);
  expect(stats().items[0]?.attention).toEqual({supported:false,count:null});
});

test('约5000条增强数据完整计数、预览/组分页稳定，所有安全过滤取交集且不串实例',async()=>{
  const actors:Actor[]=[];
  for(let i=0;i<5;i++){
    const a=makeActor(db,`bulk-${i}`,BASE);actors.push(a);
    const rows:Summary[]=Array.from({length:1000},(_,j)=>summary(String(j).padStart(4,'0'),{projectId:j%5===0?null:`p-${j%4}`,status:j%4===0?'working':'idle'}));
    await publish(db,a,rows,BASE);
    await enhance(a,rows.map((s,j)=>item(s.id,{reply:j%10===0,backgroundWorkCount:j%3===0?2:0})));
  }
  const all=groups({previewSize:'100'});
  expect(all.total).toBe(5000);expect(all.attention).toMatchObject({coverage:'complete',total:500});
  expect(all.attention.items).toHaveLength(100);expect(all.running.items).toHaveLength(100);expect(all.recent.items).toHaveLength(100);
  expect(all.attention.total!+all.running.total+all.recent.total).toBe(5000);
  const first=list({group:'attention',pageSize:'100'}),second=list({group:'attention',pageSize:'100',page:'2'});
  const keys=[...first.items,...second.items].map(r=>`${r.instanceId}:${r.id}`);
  expect(new Set(keys).size).toBe(200);expect(first.total).toBe(500);
  expect(first.items.map(r=>`${r.instanceId}:${r.id}`)).toEqual([...first.items].sort((a,b)=>a.instanceId<b.instanceId?-1:a.instanceId>b.instanceId?1:a.id<b.id?-1:a.id>b.id?1:0).map(r=>`${r.instanceId}:${r.id}`));
  const a=actors[0]!;
  const filters:Record<string,string>[]=[{instanceId:a.id,projectId:'p-1'},{instanceId:a.id,standalone:'true'},{instanceId:a.id,status:'working'},{instanceId:a.id,q:'标题 0000'}];
  for(const filter of filters){
    const grouped=groups(filter);
    for(const group of ['attention','running','recent'] as const) expect(list({...filter,group}).total).toBe(grouped[group].total!);
  }
  expect(groups({q:"' OR 1=1 --"}).total).toBe(0);
});

test('活动POST仍Bearer-only且严格字节/字段限制，新web API不接受Bearer；TTL改变ETag',async()=>{
  const h=await httpFixture();
  try{
    const a=makeActor(h.db,'http',BASE);await publish(h.db,a,[summary('s',{status:'waiting'})],BASE);
    const packet=await publication(a,[item('s',{reply:true})],h.db),bearer={authorization:`Bearer ${a.token}`};
    const forbidden:Record<string,string>[]=[{},{cookie:h.cookie},{...bearer,cookie:h.cookie},{...bearer,origin:'https://hub.example.invalid'}];
    for(const headers of forbidden){
      expect((await h.req(ACTIVITY_SNAPSHOT_ROUTE,'POST',packet,headers)).status).toBe(401);
    }
    const accepted=await h.req(ACTIVITY_SNAPSHOT_ROUTE,'POST',packet,bearer);
    expect(accepted.status).toBe(200);expect(activityReceiptSchema.parse(await accepted.json())).toEqual({accepted:true});
    for(const body of [{...packet,unexpected:'PRIVATE_MARKER'},{...packet,items:[{...item('s'),reply:'true'}]},{...packet,items:[{...item('s'),backgroundWorkCount:Number.MAX_SAFE_INTEGER+1}]},{protocolVersion:1,generation:a.generation,runId:packet.runId,baseHash:packet.baseHash,available:false,items:[]}]){
      const rejected=await h.req(ACTIVITY_SNAPSHOT_ROUTE,'POST',body,bearer);
      expect(rejected.status).toBe(400);expect(await rejected.text()).not.toContain('PRIVATE_MARKER');
    }
    expect((await h.req(ACTIVITY_SNAPSHOT_ROUTE,'POST',packet,{...bearer,'content-length':String(LIMITS.snapshotBytes+1)})).status).toBe(413);
    for(const path of ['/api/instance-activity','/api/session-groups']) expect((await h.req(path,'GET',undefined,bearer)).status).toBe(401);
    for(const q of ['?standalone=1','?includeArchived=1','?group=recent&group=attention']) expect((await h.req('/api/sessions'+q,'GET',undefined,{cookie:h.cookie})).status).toBe(400);
    await publish(h.db,a,[summary('s',{status:'waiting'})],BASE+60_000);
    const boundary=BASE+LIMITS.freshMs;h.clock.now=boundary;
    const first=await h.req('/api/changes?instances=1','GET',undefined,{cookie:h.cookie}),etag=first.headers.get('etag')!;
    h.clock.now=boundary+1;
    expect((await h.req('/api/changes?instances=1','GET',undefined,{cookie:h.cookie,'if-none-match':etag})).status).toBe(200);
  }finally{h.db.close();}
});
