import { expect, test } from 'bun:test';
import { EMPTY_SCOPE, pairRequestSchema, scopePredicate, scopeSchema, sessionsQuerySchema, snapshotHash, sortedSummaries, summarySchema, type Summary } from '../src';
const row: Summary = {id:'a',title:'',status:'idle',projectId:null,lastMessageAt:null,updatedAt:0};

test('摘要严格拒绝额外字段、子状态、非整数时间与空项目名称',() => {
  expect(summarySchema.parse(row).title).toBe('');
  for (const delta of [{message:'not accepted'},{subStatus:'something'},{updatedAt:'2024-01-01'},{updatedAt:-1},{projectName:'unexpected'},{projectId:'p',projectName:''},{title:'a\u0000b'},{id:'..'}]) expect(summarySchema.safeParse({...row,...delta}).success).toBe(false);
});
test('范围默认空，整台/归档/独立/指定会话彼此独立，拒绝重复白名单',() => {
  expect(scopePredicate(EMPTY_SCOPE)(row)).toBe(false);
  expect(scopeSchema.safeParse({mode:'all',includeArchived:false}).success).toBe(false);
  const allowed = scopePredicate({mode:'projects',projectIds:['p'],includeStandalone:false,includeArchived:false});
  expect(allowed(row)).toBe(false); expect(allowed({...row,projectId:'p'})).toBe(true);
  expect(allowed({...row,projectId:'p',status:'archived'})).toBe(false);
  expect(scopePredicate({mode:'sessions',sessionIds:['a'],includeArchived:true})({...row,status:'archived'})).toBe(true);
  expect(scopeSchema.safeParse({mode:'sessions',sessionIds:['a','a'],includeArchived:false}).success).toBe(false);
  expect(pairRequestSchema.safeParse({protocolVersion:1,code:'a'.repeat(22),scope:EMPTY_SCOPE,confirmed:true,connectorVersion:'0.1.0',capabilities:['summary.v1']}).success).toBe(false);
});
test('哈希跨键顺序/行顺序稳定，空快照有独立标准向量',async () => {
  expect(await snapshotHash([])).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  const other = {...row,id:'é',title:'中文'}, ordered = [other,row];
  expect(sortedSummaries(ordered).map(s=>s.id)).toEqual(['a','é']);
  expect(ordered[0]!.id).toBe('é');
  expect(await snapshotHash(ordered)).toBe(await snapshotHash([row,{updatedAt:other.updatedAt,lastMessageAt:null,projectId:null,status:'idle',title:'中文',id:'é'}]));
  expect(await snapshotHash(ordered)).not.toBe(await snapshotHash([row,{...other,status:'working'}]));
});
test('分页和复合项目过滤是有界线协议',() => {
  expect(sessionsQuerySchema.parse({page:'2',pageSize:'100',includeArchived:'false'}).includeArchived).toBe(false);
  for (const q of [{pageSize:'101'},{page:'0'},{projectId:'p'},{includeArchived:'0'},{unexpected:'1'}]) expect(sessionsQuerySchema.safeParse(q).success).toBe(false);
});
