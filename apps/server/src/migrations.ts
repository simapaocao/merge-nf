import type { Database } from 'bun:sqlite';

// Migration position is immutable. Append future schema upgrades; never open a newer database.
const migrations = [String.raw`
CREATE TABLE hub_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, epoch TEXT NOT NULL, backupOnly INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO hub_meta(singleton,revision,epoch) VALUES(1,0,lower(hex(randomblob(16))));
CREATE TABLE admin(singleton INTEGER PRIMARY KEY CHECK(singleton=1), username TEXT NOT NULL, passwordHash TEXT NOT NULL) STRICT;
CREATE TABLE admin_sessions(tokenHash TEXT PRIMARY KEY, csrfToken TEXT NOT NULL, expiresAt INTEGER NOT NULL) STRICT;
CREATE INDEX admin_expiry ON admin_sessions(expiresAt);
CREATE TABLE instances(
  id TEXT PRIMARY KEY, alias TEXT NOT NULL, groupName TEXT NOT NULL, color TEXT NOT NULL, sortOrder INTEGER NOT NULL,
  favorite INTEGER NOT NULL CHECK(favorite IN (0,1)), browserBaseUrl TEXT NOT NULL, browserOrigin TEXT NOT NULL UNIQUE,
  embedStatus TEXT NOT NULL CHECK(embedStatus IN ('unverified','verified','blocked')),
  generation INTEGER NOT NULL DEFAULT 0, runSeq INTEGER NOT NULL DEFAULT 0,
  authState TEXT NOT NULL DEFAULT 'unpaired' CHECK(authState IN ('unpaired','active','revoked')),
  scopeJson TEXT, lastContactAt INTEGER, lastSuccessAt INTEGER, lastError TEXT, sessionCount INTEGER, snapshotHash TEXT,
  connectorVersion TEXT, nfVersion TEXT, capabilitiesJson TEXT
) STRICT;
CREATE TABLE connector_credentials(tokenHash TEXT PRIMARY KEY, instanceId TEXT NOT NULL UNIQUE REFERENCES instances(id) ON DELETE CASCADE, generation INTEGER NOT NULL) STRICT;
CREATE TABLE pairings(codeHash TEXT PRIMARY KEY, instanceId TEXT NOT NULL UNIQUE REFERENCES instances(id) ON DELETE CASCADE, generation INTEGER NOT NULL, expiresAt INTEGER NOT NULL) STRICT;
-- Keep only the latest run per instance; runSeq never goes backwards across revoke/re-pair or server restart.
CREATE TABLE sync_runs(instanceId TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE, generation INTEGER NOT NULL, runId INTEGER NOT NULL, expiresAt INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','success','failed')), hash TEXT, acceptedAt INTEGER, errorCode TEXT) STRICT;
CREATE TABLE session_summaries(
  instanceId TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, id TEXT NOT NULL, generation INTEGER NOT NULL,
  title TEXT NOT NULL, searchTitle TEXT NOT NULL, status TEXT NOT NULL, projectId TEXT, projectName TEXT,
  lastMessageAt INTEGER, updatedAt INTEGER NOT NULL, activityAt INTEGER NOT NULL, PRIMARY KEY(instanceId,id)
) STRICT, WITHOUT ROWID;
CREATE INDEX summary_activity ON session_summaries(activityAt DESC, instanceId, id);
CREATE INDEX instance_activity ON session_summaries(instanceId, activityAt DESC, id);
CREATE INDEX project_activity ON session_summaries(instanceId, projectId, activityAt DESC, id);
CREATE INDEX status_activity ON session_summaries(status, activityAt DESC, instanceId, id);
CREATE INDEX snapshot_counts ON session_summaries(instanceId,generation,status);
CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, instanceId TEXT, code TEXT) STRICT;
`, String.raw`
-- Opt-in activity side channel. It stores only closed booleans, a bounded work count, the canonical
-- hash and the center's own receive time; no title, message, event, substatus or request id is kept.
-- Validity is derived at read time (active generation + baseHash == instances.snapshotHash + receivedAt
-- within the fresh window), so a revoke, a new generation or a new base snapshot retires it automatically.
CREATE TABLE activity_snapshots(
  instanceId TEXT PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL, runId INTEGER NOT NULL,
  baseHash TEXT NOT NULL, hash TEXT, receivedAt INTEGER NOT NULL,
  available INTEGER NOT NULL CHECK(available IN (0,1)),
  CHECK((available=1 AND hash IS NOT NULL) OR (available=0 AND hash IS NULL))
) STRICT;
CREATE TABLE activity_items(
  instanceId TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, id TEXT NOT NULL, generation INTEGER NOT NULL,
  reply INTEGER NOT NULL CHECK(reply IN (0,1)), approval INTEGER NOT NULL CHECK(approval IN (0,1)),
  error INTEGER NOT NULL CHECK(error IN (0,1)), unread INTEGER NOT NULL CHECK(unread IN (0,1)),
  backgroundWorkCount INTEGER NOT NULL CHECK(backgroundWorkCount>=0),
  PRIMARY KEY(instanceId,id)
) STRICT, WITHOUT ROWID;
CREATE INDEX activity_items_generation ON activity_items(instanceId,generation);
CREATE TRIGGER retire_activity_base AFTER UPDATE OF authState,generation,snapshotHash ON instances
WHEN NEW.authState<>'active' OR NEW.generation<>OLD.generation OR NEW.snapshotHash IS NOT OLD.snapshotHash
BEGIN
  DELETE FROM activity_items WHERE instanceId=NEW.id;
  DELETE FROM activity_snapshots WHERE instanceId=NEW.id;
END;
`];
export const SCHEMA_VERSION = migrations.length;
export function migrate(db: Database) {
  db.transaction(() => {
    const { user_version: current } = db.query<{user_version:number}, []>('PRAGMA user_version').get()!;
    if (current > SCHEMA_VERSION) throw new Error('Unsupported newer database schema');
    for (let i = current; i < migrations.length; i++) {
      db.exec(migrations[i]!); db.exec(`PRAGMA user_version=${i + 1}`);
    }
  }).immediate();
}
