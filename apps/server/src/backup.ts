import type { Database } from 'bun:sqlite';
import { HubDatabase } from './connection';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { audit, openDatabase } from './db';
import type { InstanceRecord } from './instances';
import { SCHEMA_VERSION } from './migrations';

type Mode = 'backup'|'restore';
const columns = 'id,alias,groupName,color,sortOrder,favorite,browserBaseUrl,browserOrigin,embedStatus,generation,runSeq';
// Schemas 2/3 only add derived activity/type tables; the configuration columns are unchanged.
// Explicit versions, not a broad <= check; a future schema must be reviewed before joining this set.
const CONFIG_SCHEMAS:ReadonlySet<number> = new Set([1,2,3]);
function copyConfig(source: Database, target: Database, mode: Mode) {
  // Read a consistent snapshot. Explicit column allowlist: no summaries, scope, codes, sessions,
  // connector credentials, audit history or in-flight packets are ever copied, in EITHER direction.
  source.transaction(() => {
    const schema = source.query<{user_version:number},[]>('PRAGMA user_version').get();
    const meta = source.query<{backupOnly:number},[]>('SELECT backupOnly FROM hub_meta WHERE singleton=1').get();
    if (!schema || !CONFIG_SCHEMAS.has(schema.user_version) || schema.user_version > SCHEMA_VERSION || meta?.backupOnly !== (mode === 'backup' ? 0 : 1)) throw new Error('Wrong input database type/version; restore only a dedicated hub backup');
    const admin = source.query<{username:string;passwordHash:string},[]>('SELECT username,passwordHash FROM admin WHERE singleton=1').get();
    if (!admin) throw new Error('Input database has no administrator');
    target.transaction(() => {
      target.query('INSERT INTO admin VALUES(1,?,?)').run(admin.username,admin.passwordHash);
      const insert = target.query(`INSERT INTO instances(${columns},authState) VALUES(?,?,?,?,?,?,?,?,?,?,?,'revoked')`);
      for (const r of source.query<InstanceRecord,[]>(`SELECT ${columns} FROM instances ORDER BY id`).iterate()) {
        insert.run(r.id,r.alias,r.groupName,r.color,r.sortOrder,r.favorite,r.browserBaseUrl,r.browserOrigin,r.embedStatus,r.generation+(mode === 'restore' ? 1 : 0),r.runSeq);
      }
      target.query('UPDATE hub_meta SET backupOnly=?,revision=1 WHERE singleton=1').run(mode === 'backup' ? 1 : 0);
      audit(target,Date.now(),mode === 'backup' ? 'backup.export' : 'backup.restore');
    }).immediate();
  })();
}
/** Publish one closed SQLite file atomically and without replacing a live database. Same-volume hard link required. */
export function transferConfig(mode: Mode, input: string, output: string) {
  const dest = resolve(output), dir = dirname(dest);
  if (['','-wal','-shm','-journal'].some(suffix => existsSync(dest+suffix))) throw new Error('Destination must be a new path (no database or sidecars)');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const temp = mkdtempSync(join(dir,`.${basename(dest)}-`)), file = join(temp,'data.sqlite');
  try {
    const source = new HubDatabase(resolve(input),{readonly:true,strict:true});
    try {
      source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
      const target = openDatabase(file);
      try { copyConfig(source,target,mode); target.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;'); }
      finally { target.close(); }
    } finally { source.close(); }
    linkSync(file,dest);
  } finally { rmSync(temp,{recursive:true,force:true}); }
}
