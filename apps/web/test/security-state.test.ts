import { expect,test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { changesSchema, type ChangesWithInstances, type Instance } from '@nf-hub/protocol';
import { ApiClient } from '../src/lib/api';
import { privateKey,replacePrivateView } from '../src/hooks/useAppState';
import { ChangesBaseline } from '../src/hooks/useData';
import { authorizedFrames,frameKey,pruneFrames,touchFrame } from '../src/lib/frames';
import { resolveWorkbenchTarget } from '../src/pages/WorkbenchPage';

const host='https://hub.example.invalid', instanceId='6380d660-028d-4444-967b-ec88df692aed';
function instance(overrides:Partial<Instance>={}):Instance {return {id:instanceId,alias:'项',group:'',color:'#123456',order:0,favorite:false,browserBaseUrl:'https://one.example.invalid/nf',embedStatus:'verified',generation:1,scope:{mode:'all',includeArchived:false,acknowledgeHidden:true},connection:'connected',freshness:'fresh',lastContactAt:1,lastSuccessAt:1,lastError:null,sessionCount:1,connectorVersion:'0.1.1',nfVersion:null,capabilities:['summary.v1'],...overrides};}
const response=(version:string,instances:Instance[])=>({data:{version,instances},etag:`"instances:${version}"`});
const queryClient=()=>new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
test('首次权威版本淘汰提交在先的私有数据；无广播，后续304也不能恢复',async()=>{
  const q=queryClient(), client=new ApiClient(), old=privateKey(0,'sessions',client.readEpoch), baseline=new ChangesBaseline();
  q.setQueryData(old,[{title:'旧授权'}]);
  await expect(client.read('/api/sessions',changesSchema,undefined,0)).rejects.toMatchObject({code:'SESSION_CHANGED'});
  const install=(data:ChangesWithInstances)=>{replacePrivateView(q,client,0,data);return true;};
  const res=response('after-revoke',[instance({connection:'revoked',generation:2,sessionCount:null})]);
  baseline.consume(res,client.readVersion,install);
  expect(q.getQueryData(old)).toBeUndefined();
  const epoch=client.readEpoch;
  expect(q.getQueryData<{items:Instance[]}>(privateKey(0,'instances',epoch))).toEqual({items:res.data.instances});
  baseline.consume({data:null,etag:res.etag},client.readVersion,install);
  expect(client.readEpoch).toBe(epoch);expect(q.getQueryData(old)).toBeUndefined();
  expect(()=>new ChangesBaseline().consume({data:null,etag:res.etag},client.readVersion,install)).toThrow('INVALID_RESPONSE');
  expect(()=>baseline.consume({data:null,etag:'"other-representation"'},client.readVersion,install)).toThrow('INVALID_RESPONSE');
  baseline.clear();replacePrivateView(q,client,0,null);
  expect(q.getQueryCache().findAll({queryKey:['private']})).toHaveLength(0);
});
test('即使传输忽略取消，旧读也不能交付；同时进行的写不受普通版本变更影响',async()=>{
  const pending=new Map<string,{resolve:(r:Response)=>void;signal:AbortSignal}>();
  const client=new ApiClient((path,init)=>new Promise<Response>(resolve=>pending.set(path,{resolve,signal:init.signal!}))), q=queryClient();
  const old=replacePrivateView(q,client,0,{version:'v1',instances:[instance()]});
  const read=client.read('/api/sessions',changesSchema,undefined,old.epoch);
  const write=client.request('/api/instances',changesSchema,{method:'PATCH',body:{favorite:true}});
  replacePrivateView(q,client,0,{version:'v2',instances:[]});
  expect(pending.get('/api/sessions')!.signal.aborted).toBe(true);expect(pending.get('/api/instances')!.signal.aborted).toBe(false);
  pending.get('/api/sessions')!.resolve(Response.json({version:'stale'}));pending.get('/api/instances')!.resolve(Response.json({version:'saved'}));
  await expect(read).rejects.toMatchObject({code:'SESSION_CHANGED'});expect((await write).data).toEqual({version:'saved'});
});
test('连接失联/摘要过期不重挂；撤销/删除不在渲染集合；同 ID 换代或基址生成独立 iframe key',()=>{
  const grants=(...xs:Instance[])=>authorizedFrames(xs,host), a=instance(), grant=grants(a).get(a.id)!;
  const target=grant.browserBaseUrl+'/narrators/old', frames=touchFrame([],grant,target), original=frameKey(frames[0]!);
  for(const meta of [instance({sessionCount:20}),instance({connection:'lost',freshness:'stale'})]) expect(frameKey(pruneFrames(frames,grants(meta))[0]!)).toBe(original);
  expect(touchFrame(frames,grant)[0]!.target).toBe(target);expect(pruneFrames(frames,grants())).toHaveLength(0);
  expect(pruneFrames(frames,grants(instance({connection:'revoked'})))).toHaveLength(0);
  for(const newer of [instance({generation:3}),instance({browserBaseUrl:'https://other.example.invalid/updated'})]) {
    const allowed=grants(newer); expect(pruneFrames(frames,allowed)).toHaveLength(0);
    const next=touchFrame(frames,allowed.get(a.id)!);expect(frameKey(next[0]!)).not.toBe(original);expect(next[0]!.target).toBe(newer.browserBaseUrl);
  }
});
test('已撤销且更换基址时，旧 hash 和保活记忆不会拼入新原站外链',()=>{
  const newer=instance({connection:'revoked',generation:2,browserBaseUrl:'https://new.example.invalid/next'});
  const grant=authorizedFrames([newer],host).get(newer.id);
  expect(grant).toBeUndefined();
  const result=resolveWorkbenchTarget({base:newer.browserBaseUrl,sessionId:'old-private-session',authorized:!!grant,changedIdentity:false,retained:'https://one.example.invalid/nf/narrators/old-private-session',remembered:'https://one.example.invalid/nf/narrators/remembered'});
  expect(result).toEqual({explicit:undefined,target:newer.browserBaseUrl});
  expect(result.target).not.toContain('old-private-session');
  const changed=resolveWorkbenchTarget({base:newer.browserBaseUrl,sessionId:'old-private-session',authorized:true,changedIdentity:true});
  expect(changed).toEqual({explicit:undefined,target:newer.browserBaseUrl});
  const current=resolveWorkbenchTarget({base:newer.browserBaseUrl,sessionId:'current',authorized:true,changedIdentity:false});
  expect(current).toEqual({explicit:newer.browserBaseUrl+'/narrators/current',target:newer.browserBaseUrl+'/narrators/current'});
});
