import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LIMITS, sessionsQuerySchema } from '@nf-hub/protocol';
import { openDatabase } from '../src/db';
import { overview, sessions } from '../src/dashboard';
import { deleteInstance, instanceRecord } from '../src/instances';
import { claim, issueCode, revoke } from '../src/pairing';
import { acceptSnapshot, failRun } from '../src/sync';
import { BASE, makeActor, packet, publish, run, summary } from './fixture';

let db: Database;
beforeEach(()=>{db=openDatabase(':memory:');}); afterEach(()=>{db.close();});
const readIds = () => sessions(db,sessionsQuerySchema.parse({}),BASE).items.map(s=>s.id);
test('同轮幂等、同内容新轮更新成功时间，明确空数组才归零',async () => {
  const a = makeActor(db,'alpha',BASE), r = run(db,a,BASE);
  expect(instanceRecord(db,a.id).sessionCount).toBeNull(); expect(overview(db,BASE).freshCounts).toBeNull();
  const data = await packet(a,r.runId,[summary('old')]);
  expect(await acceptSnapshot(db,a.hash,r.runId,data,()=>BASE)).toEqual({runId:r.runId,acceptedAt:BASE,duplicate:false});
  expect(await acceptSnapshot(db,a.hash,r.runId,data,()=>BASE+500)).toEqual({runId:r.runId,acceptedAt:BASE,duplicate:true});
  expect(instanceRecord(db,a.id).lastSuccessAt).toBe(BASE); expect(instanceRecord(db,a.id).lastContactAt).toBe(BASE+500);
  await publish(db,a,data.summaries,BASE+1000); expect(instanceRecord(db,a.id).lastSuccessAt).toBe(BASE+1000);
  await publish(db,a,[],BASE+2000); expect(instanceRecord(db,a.id).sessionCount).toBe(0); expect(readIds()).toEqual([]);
  expect(overview(db,BASE+2000).freshCounts?.total).toBe(0);
});
test('字段、范围、重复、数量、摘要哈希和轮号全量校验；任何坏行保留旧快照',async () => {
  const a=makeActor(db,'alpha',BASE,{mode:'projects',projectIds:['p'],includeStandalone:false,includeArchived:false});
  await publish(db,a,[summary('old',{projectId:'p'})],BASE);
  const {runId}=run(db,a,BASE+1), valid=summary('new',{projectId:'p'}), base=await packet(a,runId,[valid]);
  const refused: [unknown,string][] = [
    [{...base,summaries:[{...valid,message:'not collected'}]},'INVALID_INPUT'],[{...base,instanceId:a.id},'INVALID_INPUT'],
    [{...base,count:2},'COUNT_MISMATCH'],[{...base,hash:'0'.repeat(64)},'HASH_MISMATCH'],[{...base,runId:runId+1},'INVALID_INPUT'],
    [{...base,generation:a.generation+1},'FORBIDDEN'],[{...base,summaries:[{...valid,projectName:'unadvertised'}]},'INVALID_SCOPE'],
    [await packet(a,runId,[valid,valid]),'DUPLICATE_ID'],[await packet(a,runId,[valid,summary('wrong')]),'INVALID_SCOPE'],
    [await packet(a,runId,[{...valid,status:'archived'}]),'INVALID_SCOPE'],
  ];
  for (const [data,code] of refused) {
    await expect(acceptSnapshot(db,a.hash,runId,data,()=>BASE+1)).rejects.toMatchObject({code});
    expect(readIds()).toEqual(['old']); expect(instanceRecord(db,a.id).lastSuccessAt).toBe(BASE);
  }
  await acceptSnapshot(db,a.hash,runId,base,()=>BASE+1); expect(readIds()).toEqual(['new']);
});
test('本轮失败不清空；失败与成功不能互相翻转；到期边界拒绝包',async () => {
  const a=makeActor(db,'alpha',BASE,undefined,true);
  await publish(db,a,[summary('known',{projectId:'p',projectName:'项目'})],BASE);
  const r=run(db,a,BASE+1), failed = {protocolVersion:1 as const,generation:a.generation,runId:r.runId,errorCode:'PROJECT_QUERY_FAILED' as const};
  failRun(db,a.hash,r.runId,failed,BASE+2);
  expect(instanceRecord(db,a.id)).toMatchObject({lastSuccessAt:BASE,lastContactAt:BASE+2,lastError:'PROJECT_QUERY_FAILED'});
  await expect(acceptSnapshot(db,a.hash,r.runId,await packet(a,r.runId,[]),()=>BASE+3)).rejects.toMatchObject({code:'RUN_CLOSED'});
  failRun(db,a.hash,r.runId,failed,BASE+90_000);
  expect(instanceRecord(db,a.id)).toMatchObject({lastContactAt:BASE+90_000,lastSuccessAt:BASE});
  expect(overview(db,BASE+181_000)).toMatchObject({connectedInstances:1,staleSessions:1});
  const r2=run(db,a,BASE+181_001);
  await expect(acceptSnapshot(db,a.hash,r2.runId,await packet(a,r2.runId,[]),()=>BASE+181_001+LIMITS.runMs)).rejects.toMatchObject({code:'RUN_EXPIRED'});
  expect(readIds()).toEqual(['known']);
});
test('摘要异步验证期间撤销并重新配对，旧包不能恢复任何行',async () => {
  const a=makeActor(db,'alpha',BASE); await publish(db,a,[summary('old')],BASE);
  const r=run(db,a,BASE), data=await packet(a,r.runId,[summary('late')]);
  const pending=acceptSnapshot(db,a.hash,r.runId,data,()=>BASE);
  revoke(db,a.id,BASE); const p=issueCode(db,a.id,BASE);
  const newer=claim(db,{...a.request,code:p.code,scope:{mode:'sessions',sessionIds:['new'],includeArchived:false}},BASE);
  await expect(pending).rejects.toMatchObject({code:'UNAUTHENTICATED'});
  expect(newer.generation).toBeGreaterThan(a.generation); expect(instanceRecord(db,a.id).sessionCount).toBeNull(); expect(readIds()).toEqual([]);
});
test('新轮和删除操作均阻止迟到包，另一实例同轮不受影响',async () => {
  const a=makeActor(db,'alpha',BASE), b=makeActor(db,'beta',BASE); await publish(db,b,[summary('other')],BASE);
  const r=run(db,a,BASE), pending=acceptSnapshot(db,a.hash,r.runId,await packet(a,r.runId,[summary('late')]),()=>BASE);
  const latest=run(db,a,BASE); await expect(pending).rejects.toMatchObject({code:'STALE_RUN'});
  const packet2=await packet(a,latest.runId,[]); deleteInstance(db,a.id,BASE);
  await expect(acceptSnapshot(db,a.hash,latest.runId,packet2,()=>BASE)).rejects.toMatchObject({code:'UNAUTHENTICATED'});
  expect(readIds()).toEqual(['other']);
});
