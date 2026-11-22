import type { Database } from 'bun:sqlite';
import { LIMITS, PROTOCOL_VERSION, pairCodeSchema, pairRequestSchema, type PairResponse } from '@nf-hub/protocol';
import { digest, secret } from './auth';
import { audit, changed } from './db';
import { fail } from './errors';
import { instanceDto, instanceRecord, type InstanceRecord } from './instances';

export function issueCode(db: Database, id: string, now: number) {
  return db.transaction(() => {
    const instance = instanceRecord(db,id);
    if (instance.authState === 'active' || db.query('SELECT 1 FROM pairings WHERE instanceId=? AND expiresAt>?').get(id,now)) fail(409,'REVOKE_FIRST');
    const code = secret(16), expiresAt = now + LIMITS.pairingMs, generation = instance.generation + 1;
    db.query('DELETE FROM pairings WHERE instanceId=?').run(id);
    db.query("UPDATE instances SET authState='unpaired',generation=? WHERE id=?").run(generation,id);
    db.query('INSERT INTO pairings VALUES(?,?,?,?)').run(digest(code),id,generation,expiresAt);
    changed(db); audit(db,now,'connector.issue',id); return {code, expiresAt};
  }).immediate();
}
export function claim(db: Database, raw: unknown, now: number): PairResponse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400,'INVALID_INPUT');
  const obj = raw as Record<string,unknown>, parsedCode = pairCodeSchema.safeParse(obj.code);
  if (!parsedCode.success) fail(401,'INVALID_PAIRING');
  const codeHash = digest(parsedCode.data);
  return db.transaction(() => {
    const pairing = db.query<{instanceId:string;generation:number},[string,number]>(`SELECT p.instanceId,p.generation FROM pairings p JOIN instances i ON i.id=p.instanceId AND i.generation=p.generation WHERE p.codeHash=? AND p.expiresAt>? AND i.authState='unpaired'`).get(codeHash,now);
    if (!pairing) fail(401,'INVALID_PAIRING');
    // Do not walk arbitrary scope arrays before the high-entropy code has been authenticated.
    const scope = obj.scope as Record<string,unknown> | null;
    for (const list of [scope?.projectIds,scope?.sessionIds]) if (Array.isArray(list) && list.length > LIMITS.summaries) fail(413,'TOO_LARGE');
    if (Array.isArray(obj.capabilities) && obj.capabilities.length > 2) fail(400,'INVALID_INPUT');
    const parsed = pairRequestSchema.safeParse(raw);
    if (!parsed.success) fail(400,'INVALID_INPUT');
    const request = parsed.data;
    const {instanceId,generation} = pairing, token = secret(32);
    db.query('DELETE FROM pairings WHERE codeHash=?').run(codeHash);
    db.query('INSERT INTO connector_credentials VALUES(?,?,?)').run(digest(token),instanceId,generation);
    db.query("UPDATE instances SET authState='active',scopeJson=?,lastContactAt=?,connectorVersion=?,nfVersion=?,capabilitiesJson=? WHERE id=?")
      .run(JSON.stringify(request.scope),now,request.connectorVersion,request.nfVersion ?? null,JSON.stringify(request.capabilities),instanceId);
    changed(db); audit(db,now,'connector.claim',instanceId); return {protocolVersion:PROTOCOL_VERSION,instanceId,generation,token};
  }).immediate();
}
export function revoke(db: Database, id: string, now: number) {
  return db.transaction(() => {
    const instance = instanceRecord(db,id);
    if (instance.authState !== 'revoked') {
      db.query('DELETE FROM connector_credentials WHERE instanceId=?').run(id);
      db.query('DELETE FROM pairings WHERE instanceId=?').run(id);
      db.query('DELETE FROM sync_runs WHERE instanceId=?').run(id);
      db.query('DELETE FROM session_summaries WHERE instanceId=?').run(id);
      db.query(`UPDATE instances SET authState='revoked',generation=generation+1,scopeJson=NULL,lastContactAt=NULL,lastSuccessAt=NULL,lastError=NULL,sessionCount=NULL,snapshotHash=NULL,connectorVersion=NULL,nfVersion=NULL,capabilitiesJson=NULL WHERE id=?`).run(id);
      changed(db); audit(db,now,'connector.revoke',id);
    }
    return instanceDto(instanceRecord(db,id),now);
  }).immediate();
}
export function bearerHash(req: Request): string {
  if (req.headers.has('cookie') || req.headers.has('origin')) fail(401,'UNAUTHENTICATED');
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.get('authorization') || '');
  return match ? digest(match[1]!) : fail(401,'UNAUTHENTICATED');
}
export function credential(db: Database, tokenHash: string, generation?: number): InstanceRecord {
  const r = db.query<InstanceRecord,[string]>(`SELECT i.* FROM connector_credentials c JOIN instances i ON i.id=c.instanceId AND c.generation=i.generation WHERE c.tokenHash=? AND i.authState='active'`).get(tokenHash);
  if (!r) fail(401,'UNAUTHENTICATED');
  if (generation !== undefined && generation !== r.generation) fail(403,'FORBIDDEN');
  return r;
}
