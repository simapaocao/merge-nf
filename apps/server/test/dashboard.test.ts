import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LIMITS, overviewSchema, projectsQuerySchema, projectsSchema, sessionsQuerySchema, sessionsSchema } from '@nf-hub/protocol';
import { openDatabase } from '../src/db';
import { changes, overview, projects, sessions } from '../src/dashboard';
import { listInstances } from '../src/instances';
import { revoke } from '../src/pairing';
import { BASE, makeActor, publish, run, sampleDashboard, summary } from './fixture';

let db: Database;
beforeEach(()=>{db=openDatabase(':memory:');}); afterEach(()=>{db.close();});
test('三台合成实例同时展示有效、失联旧数据和首次同步状态',async()=>{
  const ids=await sampleDashboard(db,BASE), rows=listInstances(db,BASE).items;
  expect(overview(db,BASE)).toMatchObject({configuredInstances:3,connectedInstances:2,freshInstances:1,staleInstances:1,lostInstances:1,staleSessions:1,freshCounts:{total:2,working:1}});
  expect(rows.find(x=>x.id===ids.cloud)?.sessionCount).toBeNull();
});
test('同名项目、会话复合键、稳定排序分页、字面搜索与归档筛选', async()=>{
  const a=makeActor(db,'alpha',BASE,undefined,true), b=makeActor(db,'beta',BASE,undefined,true);
  await publish(db,a,[summary('same',{projectId:'p',projectName:'共同',title:'Alpha_%',status:'working'}),summary('arch',{status:'archived'})],BASE);
  await publish(db,b,[summary('same',{projectId:'p',projectName:'共同',title:'ALPHA 2'}),summary('later',{updatedAt:BASE+50,lastMessageAt:BASE+150,status:'waiting'})],BASE);
  const read=(query:Record<string,string>={})=>sessionsSchema.parse(sessions(db,sessionsQuerySchema.parse(query),BASE));
  const page1=read({pageSize:'2'}), page2=read({pageSize:'2',page:'2'});
  expect(page1.total).toBe(3); expect(page1.items[0]!.id).toBe('later');
  expect([page1.items[1]!.instanceId,page2.items[0]!.instanceId]).toEqual([a.id,b.id].sort());
  expect(read({q:'alpha'}).total).toBe(2); expect(read({q:'_%'}).items[0]?.instanceId).toBe(a.id);
  expect(read({instanceId:b.id,projectId:'p'}).total).toBe(1); expect(read({standalone:'true'}).total).toBe(1);
  expect(read({status:'archived'}).total).toBe(1); expect(read({includeArchived:'true'}).total).toBe(4);
  expect(projectsSchema.parse(projects(db,projectsQuerySchema.parse({}))).items).toHaveLength(2);
  revoke(db,a.id,BASE); expect(read({q:'_%'}).total).toBe(0); expect(read({includeArchived:'true'}).total).toBe(2);
});
test('时钟跨过120/180秒时即使没有写入也更新版本；失联不同于过期',async()=>{
  const a=makeActor(db,'alpha',BASE); await publish(db,a,[summary('work',{status:'working'})],BASE);
  const initial=changes(db,BASE).version;
  expect(overviewSchema.parse(overview(db,BASE+LIMITS.freshMs)).freshCounts?.working).toBe(1);
  expect(changes(db,BASE+LIMITS.freshMs).version).toBe(initial);
  const stale=BASE+LIMITS.freshMs+1; expect(changes(db,stale).version).not.toBe(initial);
  expect(overview(db,stale)).toMatchObject({staleInstances:1,connectedInstances:1,freshCounts:null,staleSessions:1});
  expect(listInstances(db,BASE+LIMITS.lostMs).items[0]!.connection).toBe('connected');
  expect(listInstances(db,BASE+LIMITS.lostMs+1).items[0]!.connection).toBe('lost');
  expect(changes(db,BASE+LIMITS.lostMs+1).version).not.toBe(changes(db,stale).version);
  run(db,a,BASE+LIMITS.lostMs+2);
  expect(listInstances(db,BASE+LIMITS.lostMs+2).items[0]).toMatchObject({freshness:'stale',connection:'connected',sessionCount:1,lastSuccessAt:BASE});
});
test('在10实例/10000摘要上分页、搜索和分组保持完整且跨实例不串行',async()=>{
  for(let i=0;i<10;i++){
    const a=makeActor(db,`fixture-${i}`,BASE);
    await publish(db,a,Array.from({length:1000},(_,j)=>summary(String(j),{projectId:`p-${j%8}`,status:j%3===0?'working':j%3===1?'waiting':'idle'})),BASE);
  }
  const stats=overview(db,BASE); expect(stats).toMatchObject({configuredInstances:10,freshCounts:{total:10000,working:3340,waiting:3330,idle:3330}});
  expect(sessions(db,sessionsQuerySchema.parse({page:'100',pageSize:'100'}),BASE).items).toHaveLength(100);
  expect(sessions(db,sessionsQuerySchema.parse({q:'标题 999'}),BASE).total).toBe(10);
  expect(projects(db,projectsQuerySchema.parse({})).total).toBe(80);
});
