import { expect, test } from 'bun:test';
import { LIMITS, type Summary } from '@nf-hub/protocol';
import { openDatabase } from '../src/db';
import { instanceRecord } from '../src/instances';
import { Admission, readJson } from '../src/limits';
import { acceptSnapshot } from '../src/sync';
import { BASE, makeActor, packet, run, summary } from './fixture';

test('按实际解码前字节限制；不信 content-length，不接收压缩请求或非法 UTF-8', async()=>{
  const req=(body:BodyInit,headers:Record<string,string>={})=>new Request('https://hub.example.invalid/',{method:'POST',body,headers:{'content-type':'application/json',...headers}});
  await expect(readJson(req('{}',{'content-encoding':'gzip'}))).rejects.toMatchObject({code:'UNSUPPORTED_MEDIA'});
  await expect(readJson(req(new Uint8Array([0xff])))).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(readJson(req('{}',{'content-length':String(LIMITS.snapshotBytes+1)}),LIMITS.snapshotBytes)).rejects.toMatchObject({status:413});
  await expect(readJson(req('"多字节"',{'content-length':'1'}),8)).rejects.toMatchObject({status:413});
});
test('并发槽和速率额有界，失败释放槽，时间窗口过后可重试',async()=>{
  let now=BASE; const a=new Admission(()=>now); let done!:()=>void;
  const held=a.withSlot('snapshot',1,()=>new Promise<void>(resolve=>{done=resolve;}));
  await expect(a.withSlot('snapshot',1,async()=>{})).rejects.toMatchObject({code:'BUSY'});
  done(); await held;
  await expect(a.withSlot('snapshot',1,async()=>{throw new Error('failure');})).rejects.toThrow('failure');
  expect(await a.withSlot('snapshot',1,async()=>1)).toBe(1);
  a.rate('key',1,100); expect(()=>a.rate('key',1,100)).toThrow('RATE_LIMITED'); now+=100;
  expect(()=>a.rate('key',1,100)).not.toThrow();
});
test('单实例明确支持10000行，第10001项拒绝而不是截断',async()=>{
  const db=openDatabase(':memory:');
  try {
    const a=makeActor(db,'alpha',BASE), r=run(db,a,BASE);
    const items:Summary[]=Array.from({length:LIMITS.summaries},(_,n)=>summary(String(n)));
    const data=await packet(a,r.runId,items);
    await acceptSnapshot(db,a.hash,r.runId,data,()=>BASE);
    const next=run(db,a,BASE+1);
    await expect(acceptSnapshot(db,a.hash,next.runId,{...data,runId:next.runId,summaries:[...items,summary('extra')]},()=>BASE+1)).rejects.toMatchObject({code:'TOO_LARGE'});
    expect(instanceRecord(db,a.id).sessionCount).toBe(LIMITS.summaries);
  } finally { db.close(); }
});
