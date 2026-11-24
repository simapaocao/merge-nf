import type { Database } from 'bun:sqlite';
import { ACTIVITY_MAX_ITEMS, activityHash, activityPublicationSchema, type ActivityItem, type ActivityPublication } from '@nf-hub/protocol';
import { changed } from './db';
import { fail, validated } from './errors';
import { credential } from './pairing';

type Run = {generation:number;runId:number;expiresAt:number;state:'open'|'success'|'failed';hash:string|null;acceptedAt:number|null};
function sameIdSet(db:Database,instanceId:string,generation:number,items:readonly ActivityItem[]) {
  const published=new Set(db.query<{id:string},[string,number]>('SELECT id FROM session_summaries WHERE instanceId=? AND generation=?').all(instanceId,generation).map(r=>r.id));
  if(items.length!==published.size) return false;
  const seen=new Set<string>();
  for(const item of items){if(!published.has(item.id)||seen.has(item.id)) return false;seen.add(item.id);}
  return seen.size===published.size;
}
/** Reusable both before hashing and inside the final write lock; no base lease or authorization is widened. */
function checkBase(db:Database,tokenHash:string,packet:ActivityPublication,now:number) {
  const instance=credential(db,tokenHash,packet.generation);
  const run=db.query<Run,[string]>('SELECT generation,runId,expiresAt,state,hash,acceptedAt FROM sync_runs WHERE instanceId=?').get(instance.id);
  if(!run||run.generation!==instance.generation||run.runId!==packet.runId||instance.runSeq!==packet.runId) fail(409,'STALE_RUN');
  if(now>=run.expiresAt) fail(409,'RUN_EXPIRED');
  if(run.state!=='success'||run.hash===null||run.acceptedAt===null) fail(409,'RUN_CLOSED');
  if(instance.snapshotHash===null||run.hash!==instance.snapshotHash||packet.baseHash!==instance.snapshotHash) fail(409,'HASH_MISMATCH');
  if(packet.available&&!sameIdSet(db,instance.id,instance.generation,packet.items)) fail(422,'INVALID_SCOPE');
  return instance;
}
/**
 * Optional metadata for an already committed base snapshot, authenticated by the original connector
 * bearer. The packet cannot add an ID, change scope, extend a lease or revive an old generation/run.
 * Only validated booleans/counts/hash/center receive time are stored; no host timestamps or free text.
 */
export async function receiveActivity(db:Database,tokenHash:string,raw:unknown,clock:()=>number) {
  const supplied=(raw as {items?:unknown}|null)?.items;
  if(Array.isArray(supplied)&&supplied.length>ACTIVITY_MAX_ITEMS) fail(413,'TOO_LARGE');
  const packet=validated(activityPublicationSchema,raw);
  checkBase(db,tokenHash,packet,clock());
  // SHA-256 is async. Never hold a database lock across it or trust the pre-hash authorization check.
  if(packet.available&&await activityHash(packet.items)!==packet.hash) fail(400,'HASH_MISMATCH');
  db.transaction(()=>{
    const now=clock(),instance=checkBase(db,tokenHash,packet,now);
    const old=db.query<{generation:number;runId:number;baseHash:string;hash:string|null;available:number},[string]>('SELECT generation,runId,baseHash,hash,available FROM activity_snapshots WHERE instanceId=?').get(instance.id);
    if(old?.generation===packet.generation&&old.runId===packet.runId&&old.baseHash===packet.baseHash){
      if(packet.available){
        // One observation per run: a different hash, or a late packet after withdrawal, is not newer.
        if(!old.available||old.hash!==packet.hash) fail(409,'RUN_CLOSED');
        return; // Same run/hash retry must not extend receivedAt or invalidate readers again.
      }
      if(!old.available) return;
    }
    db.query('DELETE FROM activity_items WHERE instanceId=?').run(instance.id);
    db.query('DELETE FROM activity_snapshots WHERE instanceId=?').run(instance.id);
    if(packet.available){
      const insert=db.query('INSERT INTO activity_items(instanceId,id,generation,reply,approval,error,unread,backgroundWorkCount) VALUES(?,?,?,?,?,?,?,?)');
      for(const item of packet.items) insert.run(instance.id,item.id,instance.generation,Number(item.reply),Number(item.approval),Number(item.error),Number(item.unread),item.backgroundWorkCount);
    }
    // Keep an unavailable tombstone so a late available packet cannot revive this withdrawn run.
    db.query('INSERT INTO activity_snapshots(instanceId,generation,runId,baseHash,hash,receivedAt,available) VALUES(?,?,?,?,?,?,?)')
      .run(instance.id,instance.generation,packet.runId,packet.baseHash,packet.available?packet.hash:null,now,Number(packet.available));
    // available:false only clears this instance's enhancement; base scope/auth/summaries stay untouched.
    changed(db);
  }).immediate();
  return {accepted:true as const};
}
