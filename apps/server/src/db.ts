import type { Database } from 'bun:sqlite';
import { HubDatabase } from './connection';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FailureCode } from '@nf-hub/protocol';
import { migrate } from './migrations';

export function openDatabase(path: string): Database {
  if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); closeSync(openSync(path, 'a', 0o600)); }
  const db = new HubDatabase(path, { strict: true, create: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    migrate(db); return db;
  } catch (e) { db.close(); throw e; }
}
export function readyToServe(db: Database) {
  if (db.query<{backupOnly:number},[]>('SELECT backupOnly FROM hub_meta').get()?.backupOnly !== 0) throw new Error('Backup cannot be served; use admin restore');
  if (!db.query('SELECT 1 FROM admin').get()) throw new Error('Create the administrator using the offline init command before listening');
}
export function changed(db: Database) { db.query('UPDATE hub_meta SET revision=revision+1 WHERE singleton=1').run(); }
type AuditEvent = 'admin.init'|'auth.login'|'auth.logout'|'instance.create'|'instance.update'|'instance.delete'|'connector.issue'|'connector.claim'|'connector.revoke'|'sync.failed'|'backup.export'|'backup.restore';
/** Only closed enums and server-derived IDs enter the diagnostic log. */
export function audit(db: Database, at: number, event: AuditEvent, instanceId: string | null = null, code: FailureCode | null = null) {
  db.query('INSERT INTO audit_events(at,event,instanceId,code) VALUES(?,?,?,?)').run(at,event,instanceId,code);
  db.query('DELETE FROM audit_events WHERE id <= (SELECT MAX(id)-512 FROM audit_events)').run();
}
