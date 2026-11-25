import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { LIMITS, SESSION_METADATA_ROUTE, sessionMetadataHash, sessionMetadataReceiptSchema, sessionRowSchema, sessionGroupsQuerySchema, sessionsQuerySchema, type SessionMetadataItem } from '@nf-hub/protocol';
import { changes, sessionGroups, sessions } from '../src/dashboard';
import { openDatabase } from '../src/db';
import { deleteInstance, instanceRecord } from '../src/instances';
import { migrate, SCHEMA_VERSION } from '../src/migrations';
import { revoke } from '../src/pairing';
import { receiveSessionMetadata } from '../src/session-metadata';
import { BASE, httpFixture, makeActor, publish, run, summary, type Actor } from './fixture';

let db:Database;
beforeEach(()=>{db=openDatabase(':memory:');});afterEach(()=>db.close());
type MetadataInput=Pick<SessionMetadataItem,'id'|'kind'> & Partial<Pick<SessionMetadataItem,'parentKnown'|'parentId'>>;
async function packet(actor:Actor,input:MetadataInput[],database=db){
  const base=instanceRecord(database,actor.id);
  const items:SessionMetadataItem[]=input.map(item=>({...item,parentKnown:item.parentKnown??false,parentId:item.parentId??null}));
  return {protocolVersion:1 as const,generation:actor.generation,runId:base.runSeq,baseHash:base.snapshotHash!,available:true as const,count:items.length,hash:await sessionMetadataHash(items),items};
}
const rows=(query:Record<string,string>={},now=BASE)=>sessions(db,sessionsQuerySchema.parse(query),now);
const groups=(query:Record<string,string>={},now=BASE)=>sessionGroups(db,sessionGroupsQuerySchema.parse(query),now);

test('旧数据kind未知；主会话/子代理/显式null在列表和分区真实投影且同ID跨实例不串数据',async()=>{
  const a=makeActor(db,'types',BASE),b=makeActor(db,'legacy',BASE);
  await publish(db,a,[summary('primary',{status:'working'}),summary('child'),summary('unknown')],BASE);
  await publish(db,b,[summary('child')],BASE);
  const legacy=rows({instanceId:a.id}).items[0]!;
  expect(Object.hasOwn(legacy,'kind')).toBe(false);
  expect(sessionRowSchema.safeParse(legacy).success).toBe(true);
  expect(sessionRowSchema.safeParse({...legacy,kind:null}).success).toBe(true);
  expect(sessionRowSchema.safeParse({...legacy,kind:'other'}).success).toBe(false);
  expect(sessionRowSchema.safeParse({...legacy,parentKnown:false,parentId:null}).success).toBe(true);
  expect(sessionRowSchema.safeParse({...legacy,rootId:'not-published'}).success).toBe(false);
  await receiveSessionMetadata(db,a.hash,await packet(a,[{id:'unknown',kind:null},{id:'child',kind:'subagent'},{id:'primary',kind:'primary'}]),()=>BASE);
  const indexed=new Map(rows({instanceId:a.id}).items.map(row=>[row.id,row.kind??null]));
  expect(indexed).toEqual(new Map([['primary','primary'],['child','subagent'],['unknown',null]]));
  expect(rows({instanceId:b.id}).items[0]?.kind).toBeUndefined();
  const g=groups({instanceId:a.id});
  expect(g.running.items[0]).toMatchObject({id:'primary',kind:'primary'});
  expect(g.recent.items.find(row=>row.id==='child')).toMatchObject({kind:'subagent',projectId:null});
  expect(g.recent.items.find(row=>row.id==='unknown')?.kind).toBeUndefined();
  expect(rows({group:'running',instanceId:a.id,pageSize:'1'}).items[0]?.kind).toBe('primary');
  expect(rows({group:'recent',instanceId:a.id,pageSize:'1'}).total).toBe(2);
  // Type metadata stays attached to the same historical base; only activity has an independent TTL.
  expect(rows({instanceId:a.id},BASE+LIMITS.freshMs+1).items.find(row=>row.id==='child')).toMatchObject({freshness:'stale',kind:'subagent'});
});

test('直接父标题只来自本实例已发布摘要，未知/明确无父/有父不同且不按父关系改kind',async()=>{
  const a=makeActor(db,'parents',BASE),b=makeActor(db,'other-parent',BASE);
  await publish(db,a,[summary('p',{title:'可信父标题'}),summary('child',{title:'筛选中的子代理'}),summary('detached'),summary('unknown'),summary('fork')],BASE);
  await publish(db,b,[summary('p',{title:'另一实例同名ID'}),summary('outside')],BASE);
  const good=await packet(a,[{id:'p',kind:'primary',parentKnown:true,parentId:null},{id:'child',kind:'subagent',parentKnown:true,parentId:'p'},
    {id:'detached',kind:'subagent',parentKnown:true,parentId:null},{id:'unknown',kind:'subagent'},
    {id:'fork',kind:'primary',parentKnown:true,parentId:'p'}]);
  const outside=good.items.map(item=>item.id==='child'?{...item,parentId:'outside'}:item);
  await expect(receiveSessionMetadata(db,a.hash,{...good,items:outside,hash:await sessionMetadataHash(outside)},()=>BASE)).rejects.toThrow('INVALID_SCOPE');
  for(const delta of [{parentKnown:false,parentId:'p'},{parentKnown:true,parentId:'child'}]){
    const malformed=good.items.map(item=>item.id==='child'?{...item,...delta}:item);
    await expect(receiveSessionMetadata(db,a.hash,{...good,items:malformed},()=>BASE)).rejects.toThrow('INVALID_INPUT');
  }
  await receiveSessionMetadata(db,a.hash,good,()=>BASE);
  const filtered=rows({instanceId:a.id,q:'筛选中的',pageSize:'1'}).items[0]!;
  expect(filtered).toMatchObject({kind:'subagent',parentKnown:true,parentId:'p',parentTitle:'可信父标题'});
  expect(rows({instanceId:a.id}).items.find(row=>row.id==='detached')).toMatchObject({kind:'subagent',parentKnown:true,parentId:null});
  expect(rows({instanceId:a.id}).items.find(row=>row.id==='unknown')).toMatchObject({kind:'subagent',parentKnown:false,parentId:null});
  expect(rows({instanceId:a.id}).items.find(row=>row.id==='fork')).toMatchObject({kind:'primary',parentKnown:true,parentId:'p'});
  expect(groups({instanceId:a.id}).recent.items.find(row=>row.id==='child')).toMatchObject({parentTitle:'可信父标题'});
  expect(rows({instanceId:b.id}).items.find(row=>row.id==='p')?.parentTitle).toBeUndefined();
  // Defensively hide a parent ID/title if it is no longer in this instance's current published set.
  db.query('DELETE FROM session_summaries WHERE instanceId=? AND id=?').run(a.id,'p');
  const hidden=rows({instanceId:a.id}).items.find(row=>row.id==='child')!;
  expect(hidden).toMatchObject({kind:'subagent',parentKnown:false,parentId:null});expect(hidden.parentTitle).toBeUndefined();
});

test('metadata严格绑定当前base/代次/完整ID集合，拒绝缺漏越界重复与非白名单字段',async()=>{
  const a=makeActor(db,'scope-a',BASE),b=makeActor(db,'scope-b',BASE);
  await publish(db,a,[summary('a'),summary('b')],BASE);await publish(db,b,[summary('foreign')],BASE);
  const good=await packet(a,[{id:'a',kind:'primary'},{id:'b',kind:'subagent'}]);
  await expect(receiveSessionMetadata(db,a.hash,{...good,generation:a.generation+1},()=>BASE)).rejects.toThrow('FORBIDDEN');
  await expect(receiveSessionMetadata(db,a.hash,{...good,baseHash:'0'.repeat(64)},()=>BASE)).rejects.toThrow('HASH_MISMATCH');
  await expect(receiveSessionMetadata(db,a.hash,{...good,hash:'0'.repeat(64)},()=>BASE)).rejects.toThrow('HASH_MISMATCH');
  for(const items of [[{id:'a',kind:null}],[{id:'a',kind:null},{id:'foreign',kind:null}]]){
    await expect(receiveSessionMetadata(db,a.hash,await packet(a,items),()=>BASE)).rejects.toThrow('INVALID_SCOPE');
  }
  for(const bad of [{...good,count:1},{...good,items:[good.items[0],good.items[0]]},{...good,items:[{...good.items[0],parentTitle:'untrusted-parent'},good.items[1]]}]){
    await expect(receiveSessionMetadata(db,a.hash,bad,()=>BASE)).rejects.toThrow('INVALID_INPUT');
  }
  await expect(receiveSessionMetadata(db,b.hash,good,()=>BASE)).rejects.toThrow('HASH_MISMATCH');
  expect(db.query('SELECT 1 FROM session_metadata_items').get()).toBeNull();
  expect(instanceRecord(db,a.id)).toMatchObject({authState:'active',sessionCount:2});
});

test('同轮同hash幂等不续期；新轮同baseHash允许kind变动，冲突和撤回迟到包不能覆盖',async()=>{
  const a=makeActor(db,'replay',BASE),base=[summary('same')];await publish(db,a,base,BASE);
  const first=await packet(a,[{id:'same',kind:'primary'}]);
  await receiveSessionMetadata(db,a.hash,first,()=>BASE+1);
  const version=changes(db,BASE+1).version;
  await receiveSessionMetadata(db,a.hash,first,()=>BASE+2);
  expect(changes(db,BASE+2).version).toBe(version);
  expect(db.query<{receivedAt:number},[]>('SELECT receivedAt FROM session_metadata_snapshots').get()?.receivedAt).toBe(BASE+1);
  await expect(receiveSessionMetadata(db,a.hash,await packet(a,[{id:'same',kind:'subagent'}]),()=>BASE+2)).rejects.toThrow('RUN_CLOSED');
  await publish(db,a,base,BASE+3);
  const next=await packet(a,[{id:'same',kind:'subagent'}]);
  expect(next.baseHash).toBe(first.baseHash);
  await receiveSessionMetadata(db,a.hash,next,()=>BASE+4);
  expect(rows().items[0]?.kind).toBe('subagent');expect(changes(db,BASE+4).version).not.toBe(version);
  await expect(receiveSessionMetadata(db,a.hash,first,()=>BASE+4)).rejects.toThrow('STALE_RUN');
  const unavailable={protocolVersion:1,generation:a.generation,runId:next.runId,baseHash:next.baseHash,available:false};
  await receiveSessionMetadata(db,a.hash,unavailable,()=>BASE+5);
  const withdrawn=changes(db,BASE+5).version;
  await receiveSessionMetadata(db,a.hash,unavailable,()=>BASE+6);
  expect(changes(db,BASE+6).version).toBe(withdrawn);
  await expect(receiveSessionMetadata(db,a.hash,next,()=>BASE+6)).rejects.toThrow('RUN_CLOSED');
  expect(rows().items[0]?.kind).toBeUndefined();expect(rows().total).toBe(1);
  expect(db.query('SELECT 1 FROM session_metadata_items').get()).toBeNull();
});

test('未提交/过期base与hash期间的撤销/新轮/过期均拒绝，metadata不会迟到落库',async()=>{
  for(const mode of ['open','expired','revoke-race','run-race','expiry-race'] as const){
    const a=makeActor(db,mode,BASE);await publish(db,a,[summary('s')],BASE);
    const good=await packet(a,[{id:'s',kind:'subagent'}]);
    if(mode==='open'){
      const lease=run(db,a,BASE+1);
      await expect(receiveSessionMetadata(db,a.hash,{...good,runId:lease.runId},()=>BASE+1)).rejects.toThrow('RUN_CLOSED');
    }else if(mode==='expired'){
      await expect(receiveSessionMetadata(db,a.hash,good,()=>BASE+LIMITS.runMs)).rejects.toThrow('RUN_EXPIRED');
    }else{
      let now=BASE;const pending=receiveSessionMetadata(db,a.hash,good,()=>now);
      if(mode==='revoke-race') revoke(db,a.id,BASE);
      if(mode==='run-race') run(db,a,BASE+1);
      if(mode==='expiry-race') now=BASE+LIMITS.runMs;
      await expect(pending).rejects.toThrow(mode==='revoke-race'?'UNAUTHENTICATED':mode==='run-race'?'STALE_RUN':'RUN_EXPIRED');
    }
    expect(db.query('SELECT 1 FROM session_metadata_items WHERE instanceId=?').get(a.id)).toBeNull();
  }
});

test('schema2追加迁移保留旧状态；换base/换代/撤权/删除退役且哈希恢复不复活旧类型',async()=>{
  const a=makeActor(db,'migration',BASE);await publish(db,a,[summary('old')],BASE);
  const before=instanceRecord(db,a.id);
  db.exec('DROP TRIGGER retire_session_metadata_base; DROP TABLE session_metadata_items; DROP TABLE session_metadata_snapshots; PRAGMA user_version=2;');
  migrate(db);migrate(db);
  expect(db.query<{user_version:number},[]>('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  expect(instanceRecord(db,a.id)).toEqual(before);expect(rows().items[0]?.kind).toBeUndefined();
  await receiveSessionMetadata(db,a.hash,await packet(a,[{id:'old',kind:'subagent'}]),()=>BASE);
  await publish(db,a,[summary('new')],BASE+1);await publish(db,a,[summary('old')],BASE+2);
  expect(rows().items[0]?.kind).toBeUndefined();expect(db.query('SELECT 1 FROM session_metadata_snapshots').get()).toBeNull();
  await receiveSessionMetadata(db,a.hash,await packet(a,[{id:'old',kind:'primary'}]),()=>BASE+3);
  db.query('UPDATE instances SET generation=generation+1 WHERE id=?').run(a.id);
  expect(db.query('SELECT 1 FROM session_metadata_items').get()).toBeNull();expect(rows().total).toBe(0);
  for(const action of ['revoke','delete'] as const){
    const b=makeActor(db,action,BASE);await publish(db,b,[summary('b')],BASE);
    await receiveSessionMetadata(db,b.hash,await packet(b,[{id:'b',kind:'primary'}]),()=>BASE);
    if(action==='revoke') revoke(db,b.id,BASE);else deleteInstance(db,b.id,BASE);
    expect(db.query('SELECT 1 FROM session_metadata_items WHERE instanceId=?').get(b.id)).toBeNull();
    expect(db.query('SELECT 1 FROM session_metadata_snapshots WHERE instanceId=?').get(b.id)).toBeNull();
  }
});

test('metadata端点复用Bearer-only且严格限制body，新web查询返回实际kind',async()=>{
  const h=await httpFixture();
  try{
    const a=makeActor(h.db,'http-types',BASE);await publish(h.db,a,[summary('s')],BASE);
    const good=await packet(a,[{id:'s',kind:'subagent'}],h.db),bearer={authorization:`Bearer ${a.token}`};
    const forbidden:Record<string,string>[]=[{},{cookie:h.cookie},{...bearer,cookie:h.cookie},{...bearer,origin:'https://hub.example.invalid'}];
    for(const headers of forbidden) expect((await h.req(SESSION_METADATA_ROUTE,'POST',good,headers)).status).toBe(401);
    const accepted=await h.req(SESSION_METADATA_ROUTE,'POST',good,bearer);
    expect(accepted.status).toBe(200);expect(sessionMetadataReceiptSchema.parse(await accepted.json())).toEqual({accepted:true});
    expect((await h.req(SESSION_METADATA_ROUTE,'POST',{...good,parentId:'PRIVATE_PARENT'},bearer)).status).toBe(400);
    expect((await h.req(SESSION_METADATA_ROUTE,'POST',good,{...bearer,'content-length':String(LIMITS.snapshotBytes+1)})).status).toBe(413);
    const response=await h.req('/api/sessions','GET',undefined,{cookie:h.cookie});
    const result=await response.json() as {items:{kind?:string}[]};
    expect(result.items[0]?.kind).toBe('subagent');
    expect((await h.req('/api/sessions','GET',undefined,bearer)).status).toBe(401);
  }finally{h.db.close();}
});
