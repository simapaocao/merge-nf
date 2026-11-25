import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LIMITS, SESSION_GROUP_PREVIEW, activityHash, instanceActivitySchema, overviewSchema, projectsQuerySchema, sessionGroupsQuerySchema, sessionGroupsSchema, sessionsQuerySchema, sessionsSchema, type ActivityItem } from '@nf-hub/protocol';
import { openDatabase } from '../src/db';
import { instanceActivity, overview, projects, sessionGroups, sessions } from '../src/dashboard';
import { receiveActivity } from '../src/activity';
import { instanceRecord } from '../src/instances';
import { revoke } from '../src/pairing';
import { BASE, httpFixture, makeActor, publish, summary } from './fixture';

let db: Database;
beforeEach(()=>{db=openDatabase(':memory:');}); afterEach(()=>{db.close();});
const activity=(now=BASE)=>instanceActivitySchema.parse(instanceActivity(db,now));
const groups=(query:Record<string,string>={},now=BASE)=>sessionGroupsSchema.parse(sessionGroups(db,sessionGroupsQuerySchema.parse(query),now));
const list=(query:Record<string,string>={},now=BASE)=>sessionsSchema.parse(sessions(db,sessionsQuerySchema.parse(query),now));

test('实例活动统计覆盖全部已配置实例，未配对/撤销/过期一律为 null 而不是 0',async()=>{
  const a=makeActor(db,'alpha',BASE), b=makeActor(db,'beta',BASE-LIMITS.freshMs-1), c=makeActor(db,'gamma',BASE);
  await publish(db,a,[summary('w',{status:'working'}),summary('i',{status:'idle'}),summary('a',{status:'archived'})],BASE);
  await publish(db,b,[summary('old',{status:'working'})],BASE-LIMITS.freshMs-1);
  revoke(db,c.id,BASE);
  const {items}=activity();
  expect(items).toHaveLength(3);
  const byId=new Map(items.map(x=>[x.instanceId,x]));
  // Archived rows never enter the tab counts, and an active fresh generation reports real zeros for empty buckets.
  expect(byId.get(a.id)).toEqual({instanceId:a.id,freshness:'fresh',lastSuccessAt:BASE,runningCount:1,
    counts:{total:2,working:1,waiting:0,idle:1,archived:0,unknown:0},attention:{supported:false,count:null},background:{supported:false,count:null}});
  expect(byId.get(b.id)).toMatchObject({freshness:'stale',counts:null});
  expect(byId.get(c.id)).toMatchObject({freshness:'never',lastSuccessAt:null,counts:null});
});

test('新鲜空快照是真正的全零；未配对与旧代次摘要都不计入',async()=>{
  const a=makeActor(db,'empty',BASE); await publish(db,a,[],BASE);
  expect(activity().items[0]).toMatchObject({counts:{total:0,working:0,waiting:0,idle:0,archived:0,unknown:0},freshness:'fresh'});
  // Re-issuing a code advances the generation without deleting rows: the old generation must stop counting.
  const stale=makeActor(db,'regen',BASE); await publish(db,stale,[summary('x',{status:'working'})],BASE);
  db.query("UPDATE instances SET authState='unpaired',generation=generation+1 WHERE id=?").run(stale.id);
  const item=activity().items.find(x=>x.instanceId===stale.id)!;
  expect(item.counts).toBeNull(); expect(item.freshness).toBe('fresh');
});

test('分区互斥且基于完整过滤范围计数，预览有条数上限和稳定顺序',async()=>{
  const a=makeActor(db,'alpha',BASE), b=makeActor(db,'beta',BASE);
  await publish(db,a,[summary('w1',{status:'working',updatedAt:BASE}),summary('i1',{status:'idle'}),summary('t1',{status:'waiting'})],BASE);
  await publish(db,b,[summary('w2',{status:'working'}),summary('u1',{status:'unknown'}),summary('arch',{status:'archived'})],BASE);
  const result=groups();
  expect(result.total).toBe(5);
  expect(result.previewSize).toBe(SESSION_GROUP_PREVIEW);
  expect(result.attention).toEqual({supported:false,coverage:'none',total:null,items:[]});
  expect(result.running.supported).toBe(true); expect(result.running.total).toBe(2);
  expect(result.recent.total).toBe(3);
  // Every row lands in exactly one section, and archived rows stay out unless explicitly included.
  const seen=[...result.running.items,...result.recent.items].map(r=>`${r.instanceId}:${r.id}`);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toHaveLength(5);
  const bounded=groups({previewSize:'1'});
  expect(bounded.running.items).toHaveLength(1); expect(bounded.recent.items).toHaveLength(1);
  expect(bounded.running.total).toBe(2); expect(bounded.recent.total).toBe(3);
  expect(groups({includeArchived:'true'}).total).toBe(6);
  expect(groups({instanceId:b.id}).total).toBe(2);
  expect(groups({q:'标题 w1'}).total).toBe(1);
});

test('陈旧实例的 working 只作为最近记录，不算正在运行',async()=>{
  const fresh=makeActor(db,'fresh',BASE), stale=makeActor(db,'stale',BASE-LIMITS.freshMs-1);
  await publish(db,fresh,[summary('live',{status:'working'})],BASE);
  await publish(db,stale,[summary('dead',{status:'working'})],BASE-LIMITS.freshMs-1);
  const result=groups();
  expect(result.running.total).toBe(1); expect(result.running.items[0]?.id).toBe('live');
  expect(result.recent.total).toBe(1); expect(result.recent.items[0]).toMatchObject({id:'dead',freshness:'stale'});
  expect(list({group:'running'}).items.map(r=>r.id)).toEqual(['live']);
  expect(list({group:'recent'}).items.map(r=>r.id)).toEqual(['dead']);
});

test('旧查询无行为变化；group 追加在旧查询之上，attention 不伪造数据',async()=>{
  const a=makeActor(db,'alpha',BASE,undefined,true), b=makeActor(db,'beta',BASE,undefined,true);
  await publish(db,a,[summary('same',{projectId:'p',projectName:'共同',status:'working'}),summary('arch',{status:'archived'})],BASE);
  await publish(db,b,[summary('same',{status:'idle'}),summary('later',{status:'waiting'})],BASE);
  expect(list().total).toBe(3);
  expect(list({pageSize:'2',page:'2'}).items).toHaveLength(1);
  expect(list({group:'attention'})).toMatchObject({total:0,items:[]});
  expect(list({group:'running'}).total).toBe(1);
  expect(list({group:'recent'}).total).toBe(2);
  expect(list({group:'running',includeArchived:'true'}).total).toBe(1);
  expect(list({group:'recent',status:'archived'}).total).toBe(1);
  expect(list({group:'recent',q:'标题 later'}).total).toBe(1);
  // A group never widens the authorized set.
  revoke(db,a.id,BASE);
  expect(list({group:'running'}).total).toBe(0);
  expect(groups().running.total).toBe(0);
});

test('focus先过滤再分页：保留idle待处理/后台与unknown，旧默认与分区完整总数不变',async()=>{
  const a=makeActor(db,'focus',BASE);
  const rows=[
    summary('idle-new',{updatedAt:BASE+500,projectId:'p'}),summary('idle-next',{updatedAt:BASE+400,projectId:'p'}),
    summary('pending',{updatedAt:BASE+300,projectId:'p'}),summary('background',{updatedAt:BASE+200,projectId:'p'}),
    summary('working',{status:'working',updatedAt:BASE+100}),summary('waiting',{status:'waiting',updatedAt:BASE+50}),
    summary('unknown',{status:'unknown'}),summary('archive',{status:'archived',updatedAt:BASE+25}),
  ];
  await publish(db,a,rows,BASE);
  const base=instanceRecord(db,a.id),items:ActivityItem[]=rows.map(row=>({id:row.id,reply:row.id==='pending',approval:false,error:false,unread:row.id==='archive',backgroundWorkCount:row.id==='background'?2:0}));
  await receiveActivity(db,a.hash,{protocolVersion:1,generation:a.generation,runId:base.runSeq,baseHash:base.snapshotHash,available:true,count:items.length,hash:await activityHash(items),items},()=>BASE);
  const unfiltered=list({pageSize:'1'});
  expect(unfiltered.total).toBe(7);expect(unfiltered.items[0]?.id).toBe('idle-new');
  expect(list({focus:'false'})).toEqual(list());expect(groups({focus:'false'})).toEqual(groups());
  const page1=list({focus:'true',pageSize:'1'}),page2=list({focus:'true',pageSize:'1',page:'2'});
  expect(page1.total).toBe(5);expect(page1.items[0]?.id).toBe('pending');expect(page2.items[0]?.id).toBe('background');
  expect(list({focus:'true'}).items.map(row=>row.id)).toEqual(['pending','background','working','waiting','unknown']);
  expect(list({focus:'true',status:'idle'}).total).toBe(2);
  expect(list({focus:'true',instanceId:a.id,projectId:'p'}).items.map(row=>row.id)).toEqual(['pending','background']);
  expect(list({focus:'true',standalone:'true'}).total).toBe(3);
  expect(list({focus:'true',q:'pending'}).total).toBe(1);
  expect(list({focus:'true',includeArchived:'true'}).total).toBe(6);
  expect(list({focus:'true',status:'archived'}).items[0]?.id).toBe('archive');
  const focused=groups({focus:'true',previewSize:'1'});
  expect(focused).toMatchObject({total:5,attention:{total:1},running:{total:3},recent:{total:1}});
  for(const group of ['attention','running','recent'] as const){
    const page=list({focus:'true',group,pageSize:'1'});
    expect(page.total).toBe(focused[group].total!);expect(page.items).toHaveLength(1);
    expect(focused[group].items[0]?.id).toBe(page.items[0]?.id);
  }
  // Display focus never narrows the publication or global/instance status statistics.
  expect(overview(db,BASE).freshCounts?.total).toBe(8);expect(activity().items[0]?.counts?.total).toBe(7);
});

test('focus仅使用有效活动，过期增强不保留idle；旧快照working/waiting/unknown仍是最近记录',async()=>{
  const a=makeActor(db,'focus-expiry',BASE);
  const rows=[summary('pending'),summary('background'),summary('idle'),summary('working',{status:'working'}),summary('waiting',{status:'waiting'}),summary('unknown',{status:'unknown'})];
  await publish(db,a,rows,BASE);
  expect(list({focus:'true'}).items.map(row=>row.id).sort()).toEqual(['unknown','waiting','working']);
  const base=instanceRecord(db,a.id),items:ActivityItem[]=rows.map(row=>({id:row.id,reply:row.id==='pending',approval:false,error:false,unread:false,backgroundWorkCount:row.id==='background'?1:0}));
  await receiveActivity(db,a.hash,{protocolVersion:1,generation:a.generation,runId:base.runSeq,baseHash:base.snapshotHash,available:true,count:items.length,hash:await activityHash(items),items},()=>BASE);
  await publish(db,a,rows,BASE+60_000);
  const expired=BASE+LIMITS.freshMs+1;
  expect(list({focus:'true'},expired).items.map(row=>row.id).sort()).toEqual(['unknown','waiting','working']);
  expect(groups({focus:'true'},expired)).toMatchObject({total:3,attention:{supported:false,total:null,coverage:'none'},running:{total:1},recent:{total:2}});
  const stale=expired+60_000;
  const old=groups({focus:'true'},stale);
  expect(old).toMatchObject({total:3,running:{total:0},recent:{total:3}});
  expect(old.recent.items.every(row=>row.freshness==='stale' && row.activity===null)).toBe(true);
  expect(list({focus:'true',group:'recent'},stale).total).toBe(3);
  expect(list({},stale).total).toBe(6);
});

test('focus查询沿用严格布尔编码，缺省不启用且不接受伪布尔值',()=>{
  for(const schema of [sessionsQuerySchema,sessionGroupsQuerySchema]){
    expect(schema.parse({}).focus).toBeUndefined();expect(schema.parse({focus:'false'}).focus).toBe(false);expect(schema.parse({focus:'true'}).focus).toBe(true);
    for(const focus of ['','0','1','TRUE','false OR 1=1',true,false]) expect(schema.safeParse({focus}).success).toBe(false);
  }
});

test('约 5000 条摘要下分组总数与预览上限、分页都正确',async()=>{
  for(let i=0;i<5;i++){
    const a=makeActor(db,`bulk-${i}`,BASE);
    await publish(db,a,Array.from({length:1000},(_,j)=>summary(String(j),{projectId:`p-${j%4}`,status:j%4===0?'working':j%4===1?'waiting':j%4===2?'idle':'archived'})),BASE);
  }
  const result=groups({},BASE);
  expect(result.total).toBe(3750);
  expect(result.running.total).toBe(1250);
  expect(result.recent.total).toBe(2500);
  expect(result.running.items).toHaveLength(SESSION_GROUP_PREVIEW);
  expect(result.recent.items).toHaveLength(SESSION_GROUP_PREVIEW);
  expect(groups({previewSize:'100'}).running.items).toHaveLength(100);
  expect(list({group:'running',pageSize:'100',page:'2'}).items).toHaveLength(100);
  expect(list({group:'running'}).total).toBe(1250);
  expect(overview(db,BASE).freshCounts).toMatchObject({total:5000,working:1250});
  expect(projects(db,projectsQuerySchema.parse({pageSize:'100'})).total).toBe(20);
});

test('新端点严格拒绝坏参数，旧响应 shape 不被扩张',async()=>{
  for(const q of [{group:'attention'},{group:'running'},{group:'recent'},{group:''}]) expect(sessionsQuerySchema.safeParse(q).success).toBe(q.group!=='');
  for(const q of [{group:'waiting'},{group:'bad'},{group:'RUNNING'}]) expect(sessionsQuerySchema.safeParse(q).success).toBe(false);
  expect(sessionGroupsQuerySchema.parse({}).previewSize).toBe(SESSION_GROUP_PREVIEW);
  for(const q of [{previewSize:'0'},{previewSize:'101'},{previewSize:'1.5'},{group:'running'},{page:'1'},{unexpected:'1'},{standalone:'true',projectId:'p'},{projectId:'p'}]) expect(sessionGroupsQuerySchema.safeParse(q).success).toBe(false);
  const a=makeActor(db,'alpha',BASE); await publish(db,a,[summary('s',{status:'working'})],BASE);
  const page=list(), groupsBody=groups();
  // Installed clients parse these strict objects; no additive key may leak into the legacy responses.
  expect(Object.keys(page).sort()).toEqual(['items','page','pageSize','total']);
  expect(overviewSchema.safeParse(overview(db,BASE)).success).toBe(true);
  expect(Object.keys(groupsBody).sort()).toEqual(['attention','previewSize','recent','running','total']);
  expect(Object.keys(page.items[0]!).sort()).toEqual(['freshness','id','instanceId','lastMessageAt','lastSuccessAt','projectId','status','title','updatedAt']);
});

test('两个新端点只接受网页 cookie，Bearer 与匿名一律拒绝',async()=>{
  const h=await httpFixture();
  try {
    const a=makeActor(h.db,'alpha',BASE); await publish(h.db,a,[summary('s',{status:'working'})],BASE);
    const bearer={authorization:'Bearer '+'a'.repeat(43)};
    for(const path of ['/api/instance-activity','/api/session-groups']) {
      expect((await h.req(path)).status).toBe(401);
      expect((await h.req(path,'GET',undefined,bearer)).status).toBe(401);
      expect((await h.req(path,'GET',undefined,{cookie:h.cookie,...bearer})).status).toBe(401);
      const ok=await h.req(path,'GET',undefined,{cookie:h.cookie});
      expect(ok.status).toBe(200); expect(ok.headers.get('cache-control')).toBe('no-store');
    }
    expect(instanceActivitySchema.parse(await (await h.req('/api/instance-activity','GET',undefined,{cookie:h.cookie})).json()).items[0]?.counts?.working).toBe(1);
    expect(sessionGroupsSchema.parse(await (await h.req('/api/session-groups?previewSize=2','GET',undefined,{cookie:h.cookie})).json()).running.items).toHaveLength(1);
    for(const bad of ['?group=bad','?previewSize=0','?previewSize=101','?unknown=1','?standalone=true&projectId=p']) expect((await h.req('/api/session-groups'+bad,'GET',undefined,{cookie:h.cookie})).status).toBe(400);
    for(const bad of ['?group=bad','?group=attention&group=recent']) expect((await h.req('/api/sessions'+bad,'GET',undefined,{cookie:h.cookie})).status).toBe(400);
    expect((await h.req('/api/sessions?group=running','GET',undefined,{cookie:h.cookie})).status).toBe(200);
    expect((await h.req(`/api/instances/${a.id}/revoke`,'POST',undefined,h.writeHeaders)).status).toBe(200);
    expect(instanceActivitySchema.parse(await (await h.req('/api/instance-activity','GET',undefined,{cookie:h.cookie})).json()).items[0]).toMatchObject({freshness:'never',counts:null});
  } finally { h.db.close(); }
});
