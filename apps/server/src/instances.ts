import type { Database } from 'bun:sqlite';
import { EMPTY_SCOPE, LIMITS, createInstanceSchema, type CreateInstance, type Instance, type UpdateInstance } from '@nf-hub/protocol';
import { browserBase, type Config } from './config';
import { audit, changed } from './db';
import { fail, validated } from './errors';

export type InstanceRecord = Pick<Instance,'id'|'alias'|'color'|'browserBaseUrl'|'embedStatus'|'generation'|'lastContactAt'|'lastSuccessAt'|'lastError'|'sessionCount'|'connectorVersion'|'nfVersion'> & {
  groupName: string; sortOrder: number; favorite: number; browserOrigin: string; runSeq: number; authState:'unpaired'|'active'|'revoked';
  scopeJson:string|null; capabilitiesJson:string|null; snapshotHash:string|null;
};
export function instanceRecord(db: Database, id: string): InstanceRecord {
  return db.query<InstanceRecord,[string]>('SELECT * FROM instances WHERE id=?').get(id) ?? fail(404, 'NOT_FOUND');
}
export function instanceDto(r: InstanceRecord, now: number): Instance {
  return { id:r.id, alias:r.alias, group:r.groupName, color:r.color, order:r.sortOrder, favorite:!!r.favorite,
    browserBaseUrl:r.browserBaseUrl, embedStatus:r.embedStatus, generation:r.generation,
    scope:r.scopeJson ? JSON.parse(r.scopeJson) : EMPTY_SCOPE,
    connection:r.authState === 'active' ? (r.lastContactAt !== null && now - r.lastContactAt <= LIMITS.lostMs ? 'connected' : 'lost') : r.authState,
    freshness:r.lastSuccessAt === null ? 'never' : now - r.lastSuccessAt <= LIMITS.freshMs ? 'fresh' : 'stale',
    lastContactAt:r.lastContactAt, lastSuccessAt:r.lastSuccessAt, lastError:r.lastError, sessionCount:r.sessionCount,
    connectorVersion:r.connectorVersion, nfVersion:r.nfVersion, capabilities:r.capabilitiesJson ? JSON.parse(r.capabilitiesJson) : null,
  };
}
export function listInstances(db: Database, now: number) {
  return { items:db.query<InstanceRecord,[]>('SELECT * FROM instances ORDER BY favorite DESC,sortOrder,alias COLLATE NOCASE,id').all().map(r => instanceDto(r,now)) };
}
function uniqueOrigin(db: Database, origin: string, id: string) {
  if (db.query('SELECT 1 FROM instances WHERE browserOrigin=? AND id<>?').get(origin,id)) fail(409,'CONFLICT');
  // Bound the authenticated document's frame-src header below typical proxy header limits.
  const { bytes } = db.query<{bytes:number},[string]>('SELECT coalesce(sum(length(browserOrigin)+1),0) AS bytes FROM instances WHERE id<>?').get(id)!;
  if (bytes + origin.length + 1 > 6000) fail(409,'CONFLICT');
}
export function createInstance(db: Database, cfg: Config, raw: CreateInstance, now: number) {
  const data = validated(createInstanceSchema, raw), {base,origin} = browserBase(data.browserBaseUrl,cfg), id = crypto.randomUUID();
  return db.transaction(() => {
    uniqueOrigin(db,origin,id);
    db.query('INSERT INTO instances(id,alias,groupName,color,sortOrder,favorite,browserBaseUrl,browserOrigin,embedStatus) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,data.alias,data.group,data.color,data.order,Number(data.favorite),base,origin,data.embedStatus);
    changed(db); audit(db,now,'instance.create',id); return instanceDto(instanceRecord(db,id),now);
  }).immediate();
}
export function updateInstance(db: Database, cfg: Config, id: string, data: UpdateInstance, now: number) {
  return db.transaction(() => {
    const old = instanceRecord(db,id), {base,origin} = browserBase(data.browserBaseUrl ?? old.browserBaseUrl,cfg);
    // Connector authorization is bound to tokenHash, generation and authState; the browser entry point is
    // only metadata. Editing it must not revoke credentials or pending codes, so no credential row, pairing
    // row or generation is touched here and a revoked instance stays revoked.
    uniqueOrigin(db,origin,id);
    db.query('UPDATE instances SET alias=?,groupName=?,color=?,sortOrder=?,favorite=?,browserBaseUrl=?,browserOrigin=?,embedStatus=? WHERE id=?')
      .run(data.alias ?? old.alias,data.group ?? old.groupName,data.color ?? old.color,data.order ?? old.sortOrder,Number(data.favorite ?? !!old.favorite),base,origin,base === old.browserBaseUrl ? data.embedStatus ?? old.embedStatus : 'unverified',id);
    changed(db); audit(db,now,'instance.update',id); return instanceDto(instanceRecord(db,id),now);
  }).immediate();
}
export function deleteInstance(db: Database, id: string, now: number) {
  db.transaction(() => {
    if (!db.query('DELETE FROM instances WHERE id=?').run(id).changes) fail(404,'NOT_FOUND');
    changed(db); audit(db,now,'instance.delete',id);
  }).immediate();
}
