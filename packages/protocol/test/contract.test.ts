import { expect, test } from 'bun:test';
import { EMPTY_SCOPE, SESSION_GROUP_PREVIEW, instanceActivitySchema, overviewSchema, pairRequestSchema, scopePredicate, scopeSchema, sessionGroupsQuerySchema, sessionGroupsSchema, sessionsQuerySchema, sessionsSchema, snapshotHash, sortedSummaries, summarySchema, type InstanceActivityItem, type Summary } from '../src';
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
test('新增分组与活动投影保持旧响应形状，能力缺失时如实标记未支持',() => {
  // Legacy queries stay valid; the group selector is purely additive.
  expect(sessionsQuerySchema.parse({group:'running'}).group).toBe('running');
  expect(sessionsQuerySchema.parse({}).group).toBeUndefined();
  for (const q of [{group:''},{group:'waiting'},{group:'RUNNING'},{group:'attention',pageSize:'0'}]) expect(sessionsQuerySchema.safeParse(q).success).toBe(false);
  expect(sessionGroupsQuerySchema.parse({}).previewSize).toBe(SESSION_GROUP_PREVIEW);
  for (const q of [{previewSize:'0'},{previewSize:'101'},{page:'1'},{group:'running'},{projectId:'p'}]) expect(sessionGroupsQuerySchema.safeParse(q).success).toBe(false);
  const counts = {total:1,working:1,waiting:0,idle:0,archived:0,unknown:0};
  const item:InstanceActivityItem = {instanceId:crypto.randomUUID(),freshness:'fresh',lastSuccessAt:1,runningCount:1,counts,attention:{supported:false,count:null},background:{supported:false,count:null}};
  expect(instanceActivitySchema.parse({items:[item]}).items[0]).toEqual(item);
  // A stale instance reports null counts, and unsupported stays false rather than a fabricated zero.
  expect(instanceActivitySchema.parse({items:[{...item,freshness:'stale',counts:null}]}).items[0]!.counts).toBeNull();
  // A supported capability with a genuine zero is valid; only "unsupported yet reporting a number" is not.
  expect(instanceActivitySchema.safeParse({items:[{...item,attention:{supported:true,count:0}}]}).success).toBe(true);
  expect(instanceActivitySchema.safeParse({items:[{...item,attention:{supported:true,count:3},background:{supported:true,count:0}}]}).success).toBe(true);
  for (const bad of [{items:[{...item,attention:{supported:false,count:0}}]},{items:[{...item,background:{supported:false,count:2}}]},{items:[{...item,counts:{total:0}}]},{items:[{...item,extra:1}]}]) expect(instanceActivitySchema.safeParse(bad).success).toBe(false);
  const row = {id:'a',title:'',status:'idle' as const,projectId:null,lastMessageAt:null,updatedAt:0,instanceId:item.instanceId,freshness:'fresh' as const,lastSuccessAt:1};
  const section = {supported:true,total:1,items:[row]};
  const groups = {total:1,previewSize:SESSION_GROUP_PREVIEW,attention:{supported:false,total:null,items:[]},running:section,recent:{supported:true,total:0,items:[]}};
  expect(sessionGroupsSchema.parse(groups)).toMatchObject(groups);
  expect(sessionGroupsSchema.parse(groups).running.coverage).toBe('none');
  expect(sessionGroupsSchema.parse(groups).running.items[0]!.activity).toBeNull();
  expect(sessionGroupsSchema.safeParse({...groups,extra:1}).success).toBe(false);
  // The installed-client shapes must not grow: an additive key would break their strict parse.
  expect(sessionsSchema.parse({total:0,page:1,pageSize:50,items:[]})).toEqual({total:0,page:1,pageSize:50,items:[]});
  expect(overviewSchema.safeParse({configuredInstances:0,connectedInstances:0,freshInstances:0,staleInstances:0,lostInstances:0,staleSessions:0,freshCounts:null,activity:[]}).success).toBe(false);
});
