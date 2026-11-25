import type { Database } from 'bun:sqlite';
import { SESSION_METADATA_MAX_ITEMS, sessionMetadataHash, sessionMetadataPublicationSchema, type SessionMetadataItem, type SessionMetadataPublication } from '@nf-hub/protocol';
import { changed } from './db';
import { fail, validated } from './errors';
import { credential } from './pairing';

type Run = {generation:number;runId:number;expiresAt:number;state:'open'|'success'|'failed';hash:string|null;acceptedAt:number|null};
function sameIdSet(db:Database,instanceId:string,generation:number,items:readonly SessionMetadataItem[]) {
  const published=new Set(db.query<{id:string},[string,number]>('SELECT id FROM session_summaries WHERE instanceId=? AND generation=?').all(instanceId,generation).map(row=>row.id));
  if(items.length!==published.size) return false;
  const seen=new Set<string>();
  for(const item of items){
    if(!published.has(item.id)||seen.has(item.id)) return false;
    if(!item.parentKnown&&item.parentId!==null) return false;
    if(item.parentId!==null&&(item.parentId===item.id||!published.has(item.parentId))) return false;
    seen.add(item.id);
  }
  return seen.size===published.size;
}
/** Bind type metadata to the authenticated instance and its current committed, unexpired base lease. */
function checkBase(db:Database,tokenHash:string,packet:SessionMetadataPublication,now:number) {
  const instance=credential(db,tokenHash,packet.generation);
  const run=db.query<Run,[string]>('SELECT generation,runId,expiresAt,state,hash,acceptedAt FROM sync_runs WHERE instanceId=?').get(instance.id);
  if(!run||run.generation!==instance.generation||run.runId!==packet.runId||instance.runSeq!==packet.runId) fail(409,'STALE_RUN');
  if(now>=run.expiresAt) fail(409,'RUN_EXPIRED');
  if(run.state!=='success'||run.hash===null||run.acceptedAt===null) fail(409,'RUN_CLOSED');
  if(instance.snapshotHash===null||run.hash!==instance.snapshotHash||packet.baseHash!==instance.snapshotHash) fail(409,'HASH_MISMATCH');
  if(packet.available&&!sameIdSet(db,instance.id,instance.generation,packet.items)) fail(422,'INVALID_SCOPE');
  return instance;
}
/** Derived type/direct-parent projection; no supplied titles, activity fields or changes to base scope/hash. */
export async function receiveSessionMetadata(db:Database,tokenHash:string,raw:unknown,clock:()=>number) {
  const supplied=(raw as {items?:unknown}|null)?.items;
  if(Array.isArray(supplied)&&supplied.length>SESSION_METADATA_MAX_ITEMS) fail(413,'TOO_LARGE');
  const packet=validated(sessionMetadataPublicationSchema,raw);
  checkBase(db,tokenHash,packet,clock());
  // Async hashing cannot retain a database lock, and never makes the pre-hash checks authoritative.
  if(packet.available&&await sessionMetadataHash(packet.items)!==packet.hash) fail(400,'HASH_MISMATCH');
  db.transaction(()=>{
    const now=clock(),instance=checkBase(db,tokenHash,packet,now);
    const old=db.query<{generation:number;runId:number;baseHash:string;hash:string|null;available:number},[string]>(
      'SELECT generation,runId,baseHash,hash,available FROM session_metadata_snapshots WHERE instanceId=?').get(instance.id);
    if(old?.generation===packet.generation&&old.runId===packet.runId&&old.baseHash===packet.baseHash){
      if(packet.available){
        if(!old.available||old.hash!==packet.hash) fail(409,'RUN_CLOSED');
        return; // Identical retry does not renew receive time or advance the dashboard revision.
      }
      if(!old.available) return;
    }
    db.query('DELETE FROM session_metadata_items WHERE instanceId=?').run(instance.id);
    db.query('DELETE FROM session_metadata_snapshots WHERE instanceId=?').run(instance.id);
    if(packet.available){
      const insert=db.query('INSERT INTO session_metadata_items(instanceId,id,generation,kind,parentKnown,parentId) VALUES(?,?,?,?,?,?)');
      for(const item of packet.items) insert.run(instance.id,item.id,instance.generation,item.kind,Number(item.parentKnown),item.parentId);
    }
    // Withdrawal is terminal for this run. A newer successful base run may publish a new observation,
    // even when the base summary hash is unchanged and only the type metadata has changed.
    db.query('INSERT INTO session_metadata_snapshots(instanceId,generation,runId,baseHash,hash,receivedAt,available) VALUES(?,?,?,?,?,?,?)')
      .run(instance.id,instance.generation,packet.runId,packet.baseHash,packet.available?packet.hash:null,now,Number(packet.available));
    changed(db);
  }).immediate();
  return {accepted:true as const};
}
