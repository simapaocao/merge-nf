import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION, scopePredicate, scopeSchema, snapshotHash, snapshotRequestSchema, summarySchema,
  type FailedRequest, type RunRequest, type RunResponse, type SnapshotResponse, type Summary } from '@nf-hub/protocol';
import { changed, audit } from './db';
import { fail, validated } from './errors';
import { credential } from './pairing';
import type { InstanceRecord } from './instances';

type Run = {generation:number;runId:number;expiresAt:number;state:'open'|'success'|'failed';hash:string|null;acceptedAt:number|null;errorCode:string|null};
function latest(db: Database, instance: InstanceRecord, runId: number, now: number): Run {
  const row = db.query<Run,[string]>('SELECT generation,runId,expiresAt,state,hash,acceptedAt,errorCode FROM sync_runs WHERE instanceId=?').get(instance.id);
  if (!row || row.generation !== instance.generation || row.runId !== runId || instance.runSeq !== runId) fail(409,'STALE_RUN');
  if (now >= row.expiresAt) fail(409,'RUN_EXPIRED');
  return row;
}
export function startRun(db: Database, hash: string, input: RunRequest, now: number): RunResponse {
  return db.transaction(() => {
    const i = credential(db,hash,input.generation), runId = i.runSeq + 1, expiresAt = now + LIMITS.runMs;
    db.query('UPDATE instances SET runSeq=?,lastContactAt=? WHERE id=?').run(runId,now,i.id);
    db.query("INSERT OR REPLACE INTO sync_runs(instanceId,generation,runId,expiresAt,state) VALUES(?,?,?,?,'open')").run(i.id,i.generation,runId,expiresAt);
    changed(db); return {protocolVersion:PROTOCOL_VERSION,generation:i.generation,runId,expiresAt};
  }).immediate();
}
export function failRun(db: Database, hash: string, runId: number, input: FailedRequest, now: number) {
  if (input.runId !== runId) fail(400,'INVALID_INPUT');
  db.transaction(() => {
    const i = credential(db,hash,input.generation), r = latest(db,i,runId,now);
    if (r.state === 'failed' && r.errorCode === input.errorCode) {
      db.query('UPDATE instances SET lastContactAt=? WHERE id=?').run(now,i.id); changed(db); return;
    }
    if (r.state !== 'open') fail(409,'RUN_CLOSED');
    db.query("UPDATE sync_runs SET state='failed',errorCode=? WHERE instanceId=?").run(input.errorCode,i.id);
    db.query('UPDATE instances SET lastContactAt=?,lastError=? WHERE id=?').run(now,input.errorCode,i.id);
    changed(db); audit(db,now,'sync.failed',i.id,input.errorCode);
  }).immediate();
}
// Reuse the shared strict envelope and validate each row individually. A hostile input of many bad rows
// must not build a huge tree of Zod errors. Unchecked fields never reach the DB or diagnostics.
const envelopeSchema = snapshotRequestSchema.extend({ summaries:z.custom<unknown[]>(Array.isArray) });
export async function acceptSnapshot(db: Database, hash: string, runId: number, raw: unknown, clock: () => number): Promise<SnapshotResponse> {
  const suppliedRows = (raw as {summaries?:unknown} | null)?.summaries;
  if (Array.isArray(suppliedRows) && suppliedRows.length > LIMITS.summaries) fail(413,'TOO_LARGE');
  const packet = validated(envelopeSchema,raw);
  if (runId !== packet.runId) fail(400,'INVALID_INPUT');
  const before = credential(db,hash,packet.generation), initial = latest(db,before,runId,clock());
  if (initial.state === 'failed') fail(409,'RUN_CLOSED');
  if (packet.summaries.length > LIMITS.summaries) fail(413,'TOO_LARGE');
  if (packet.summaries.length !== packet.count) fail(400,'COUNT_MISMATCH');
  const allowed = scopePredicate(scopeSchema.parse(JSON.parse(before.scopeJson!)));
  const canName = (JSON.parse(before.capabilitiesJson!) as string[]).includes('projectNames.v1');
  const ids = new Set<string>(), summaries: Summary[] = [];
  for (const item of packet.summaries) {
    const s = validated(summarySchema,item);
    if (ids.has(s.id)) fail(400,'DUPLICATE_ID');
    if (!allowed(s) || (s.projectName !== undefined && !canName)) fail(422,'INVALID_SCOPE');
    ids.add(s.id); summaries.push(s);
  }
  const computed = await snapshotHash(summaries);
  if (computed !== packet.hash) fail(400,'HASH_MISMATCH');
  return db.transaction(() => {
    // Hashing/IO can overlap revocation, delete/re-pair, another run or expiry. Re-check inside the write lock.
    const now = clock(), i = credential(db,hash,packet.generation), run = latest(db,i,runId,now);
    if (run.state === 'success' && run.hash === computed && run.acceptedAt !== null) {
      db.query('UPDATE instances SET lastContactAt=? WHERE id=?').run(now,i.id); changed(db);
      return {runId,acceptedAt:run.acceptedAt,duplicate:true};
    }
    if (run.state !== 'open') fail(409,'RUN_CLOSED');
    if (computed !== i.snapshotHash) {
      db.query('DELETE FROM session_summaries WHERE instanceId=?').run(i.id);
      const insert = db.query('INSERT INTO session_summaries(instanceId,id,generation,title,searchTitle,status,projectId,projectName,lastMessageAt,updatedAt,activityAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const s of summaries) insert.run(i.id,s.id,i.generation,s.title,s.title.normalize('NFKC').toLowerCase(),s.status,s.projectId,s.projectName ?? null,s.lastMessageAt,s.updatedAt,s.lastMessageAt ?? s.updatedAt);
    }
    db.query("UPDATE sync_runs SET state='success',hash=?,acceptedAt=? WHERE instanceId=?").run(computed,now,i.id);
    db.query('UPDATE instances SET lastContactAt=?,lastSuccessAt=?,lastError=NULL,sessionCount=?,snapshotHash=? WHERE id=?').run(now,now,summaries.length,computed,i.id);
    changed(db); return {runId,acceptedAt:now,duplicate:false};
  }).immediate();
}
