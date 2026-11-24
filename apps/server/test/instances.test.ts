import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { digest } from '../src/auth';
import { openDatabase } from '../src/db';
import { createInstance, instanceRecord, updateInstance } from '../src/instances';
import { claim, credential, issueCode, revoke } from '../src/pairing';
import { startRun } from '../src/sync';
import { BASE, cfg, makeActor, publish, summary } from './fixture';

let db: Database;
beforeEach(()=>{db=openDatabase(':memory:');}); afterEach(()=>{db.close();});
const revision = () => db.query<{revision:number},[]>('SELECT revision FROM hub_meta').get()!.revision;
test('改地址不撤销已授权连接：旧令牌继续上报，范围能力代次与摘要不变',async()=>{
  const a=makeActor(db,'alpha',BASE,undefined,true); await publish(db,a,[summary('kept')],BASE);
  const before=instanceRecord(db,a.id), revisionBefore=revision();
  const dto=updateInstance(db,cfg,a.id,{browserBaseUrl:'https://10.8.0.2:7778'},BASE+1);
  expect(dto).toMatchObject({browserBaseUrl:'https://10.8.0.2:7778',embedStatus:'unverified',generation:before.generation,connection:'connected',sessionCount:1,capabilities:['summary.v1','projectNames.v1']});
  expect(instanceRecord(db,a.id)).toMatchObject({browserOrigin:'https://10.8.0.2:7778',authState:'active',generation:before.generation,
    scopeJson:before.scopeJson,capabilitiesJson:before.capabilitiesJson,sessionCount:before.sessionCount,snapshotHash:before.snapshotHash,
    runSeq:before.runSeq,lastContactAt:before.lastContactAt,lastSuccessAt:before.lastSuccessAt});
  expect(credential(db,a.hash).browserBaseUrl).toBe('https://10.8.0.2:7778');
  expect(revision()).toBe(revisionBefore+1);
  expect(db.query('SELECT event,instanceId FROM audit_events ORDER BY id DESC LIMIT 1').get()).toEqual({event:'instance.update',instanceId:a.id});
  expect(await publish(db,a,[summary('kept'),summary('added')],BASE+2)).toMatchObject({duplicate:false});
  expect(instanceRecord(db,a.id)).toMatchObject({lastSuccessAt:BASE+2,sessionCount:2,generation:before.generation});
  // Editing metadata never weakens the pairing rule: an active instance still refuses a new code.
  expect(()=>issueCode(db,a.id,BASE+3)).toThrow('REVOKE_FIRST');
});
test('地址变化无条件把嵌入状态重置为未验证，客户端同时提交已验证也不能绕过',()=>{
  const i=createInstance(db,cfg,{alias:'demo',browserBaseUrl:'https://demo.example.invalid',embedStatus:'verified'},BASE);
  expect(updateInstance(db,cfg,i.id,{embedStatus:'verified'},BASE+1).embedStatus).toBe('verified');
  expect(updateInstance(db,cfg,i.id,{browserBaseUrl:'https://10.8.0.3:7778',embedStatus:'verified'},BASE+2)).toMatchObject({browserBaseUrl:'https://10.8.0.3:7778',embedStatus:'unverified'});
  expect(updateInstance(db,cfg,i.id,{alias:'重命名'},BASE+3)).toMatchObject({alias:'重命名',browserBaseUrl:'https://10.8.0.3:7778',embedStatus:'unverified'});
});
test('待配对的有效代码在改地址后仍可兑换一次，代次不变',()=>{
  const i=createInstance(db,cfg,{alias:'beta',browserBaseUrl:'https://beta.example.invalid'},BASE), p=issueCode(db,i.id,BASE), pending=instanceRecord(db,i.id);
  expect(updateInstance(db,cfg,i.id,{browserBaseUrl:'https://10.8.0.12:8443'},BASE+1)).toMatchObject({browserBaseUrl:'https://10.8.0.12:8443',connection:'unpaired',generation:pending.generation});
  expect(instanceRecord(db,i.id)).toMatchObject({authState:'unpaired',generation:pending.generation});
  expect(db.query('SELECT generation,expiresAt FROM pairings WHERE instanceId=?').get(i.id)).toEqual({generation:pending.generation,expiresAt:p.expiresAt});
  const body={protocolVersion:1 as const,code:p.code,scope:{mode:'all',includeArchived:false,acknowledgeHidden:true} as const,confirmed:true as const,connectorVersion:'0.1.0',capabilities:['summary.v1'] as ('summary.v1')[]};
  const bound=claim(db,body,BASE+2);
  expect(bound).toMatchObject({instanceId:i.id,generation:pending.generation});
  expect(credential(db,digest(bound.token)).browserBaseUrl).toBe('https://10.8.0.12:8443');
  expect(()=>claim(db,body,BASE+3)).toThrow('INVALID_PAIRING');
});
test('撤销后编辑地址不复活授权，旧令牌仍被拒绝',()=>{
  const a=makeActor(db,'alpha',BASE); revoke(db,a.id,BASE);
  const before=instanceRecord(db,a.id);
  expect(updateInstance(db,cfg,a.id,{browserBaseUrl:'https://10.8.0.4:7778',alias:'renamed'},BASE+1)).toMatchObject({alias:'renamed',browserBaseUrl:'https://10.8.0.4:7778',embedStatus:'unverified',connection:'revoked',sessionCount:null});
  expect(instanceRecord(db,a.id)).toMatchObject({authState:'revoked',generation:before.generation,scopeJson:null,capabilitiesJson:null,snapshotHash:null,lastContactAt:null,lastSuccessAt:null});
  expect(db.query('SELECT 1 FROM connector_credentials WHERE instanceId=?').get(a.id)).toBeNull();
  expect(()=>credential(db,a.hash)).toThrow('UNAUTHENTICATED');
});
test('无效地址、同中心hostname与重复origin仍拒绝且不改动记录',()=>{
  const one=createInstance(db,cfg,{alias:'one',browserBaseUrl:'https://one.example.invalid'},BASE);
  const two=createInstance(db,cfg,{alias:'two',browserBaseUrl:'https://two.example.invalid',embedStatus:'verified'},BASE), before=instanceRecord(db,two.id);
  for(const bad of ['http://10.8.0.5:7778','https://hub.example.invalid','https://hub.example.invalid:9443','https://user@10.8.0.6','https://*.example.invalid','ftp://10.8.0.7'])
    expect(()=>updateInstance(db,cfg,two.id,{browserBaseUrl:bad},BASE+1)).toThrow('INVALID_INPUT');
  expect(()=>updateInstance(db,cfg,two.id,{browserBaseUrl:one.browserBaseUrl},BASE+1)).toThrow('CONFLICT');
  expect(instanceRecord(db,two.id)).toEqual(before);
});
test('改地址不改变代次：旧代次租约照旧被拒，当前代次照常发放',()=>{
  const a=makeActor(db,'alpha',BASE), {generation}=instanceRecord(db,a.id);
  updateInstance(db,cfg,a.id,{browserBaseUrl:'https://10.8.0.8:7778'},BASE+1);
  expect(()=>startRun(db,a.hash,{protocolVersion:1,generation:generation+1},BASE+2)).toThrow('FORBIDDEN');
  expect(startRun(db,a.hash,{protocolVersion:1,generation},BASE+2)).toMatchObject({generation});
});
test('frame-src 汇总长度上限仍约束编辑后的地址',()=>{
  const ids=Array.from({length:200},(_,i)=>createInstance(db,cfg,{alias:`h${i}`,browserBaseUrl:`https://h${i}.example.invalid`},BASE).id);
  const last=ids[199]!, before=instanceRecord(db,last), longHost=('a'.repeat(60)+'.').repeat(11)+'invalid';
  expect(updateInstance(db,cfg,last,{browserBaseUrl:'https://10.8.0.9:7778'},BASE+1).browserBaseUrl).toBe('https://10.8.0.9:7778');
  expect(()=>updateInstance(db,cfg,last,{browserBaseUrl:`https://${longHost}`},BASE+2)).toThrow('CONFLICT');
  expect(instanceRecord(db,last)).toMatchObject({browserBaseUrl:'https://10.8.0.9:7778',browserOrigin:'https://10.8.0.9:7778',generation:before.generation});
});
