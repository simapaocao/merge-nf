import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { z } from 'zod';
import { LIMITS, type Overview, type Project, type ProjectsPage, type projectsQuerySchema, type SessionRow, type SessionsPage, type sessionsQuerySchema, type SessionStatus } from '@nf-hub/protocol';

// Each read also checks active generation, independent of foreign-key cleanup on revoke/delete.
const join = `FROM session_summaries s JOIN instances i ON i.id=s.instanceId AND i.generation=s.generation AND i.authState='active'`;
export function overview(db: Database, now: number): Overview {
  return db.transaction(() => {
    const cutoff = now - LIMITS.freshMs;
    const stats = db.query<Omit<Overview,'freshCounts'>, [number,number,number,number,number]>(`
      SELECT count(*) AS configuredInstances,
        count(*) FILTER(WHERE authState='active' AND lastContactAt>=?) AS connectedInstances,
        count(*) FILTER(WHERE authState='active' AND lastSuccessAt>=?) AS freshInstances,
        count(*) FILTER(WHERE authState='active' AND lastSuccessAt<?) AS staleInstances,
        count(*) FILTER(WHERE authState='active' AND lastContactAt<?) AS lostInstances,
        coalesce(sum(sessionCount) FILTER(WHERE authState='active' AND lastSuccessAt<?),0) AS staleSessions FROM instances`
    ).get(now-LIMITS.lostMs,cutoff,cutoff,now-LIMITS.lostMs,cutoff)!;
    if (!stats.freshInstances) return {...stats,freshCounts:null};
    const freshCounts = {total:0,working:0,waiting:0,idle:0,archived:0,unknown:0};
    for (const row of db.query<{status:SessionStatus;n:number},[number]>(`SELECT s.status,count(*) AS n ${join} WHERE i.lastSuccessAt>=? GROUP BY s.status`).all(cutoff)) {
      freshCounts[row.status] = row.n; freshCounts.total += row.n;
    }
    return {...stats,freshCounts};
  })();
}
export function changes(db: Database, now: number) {
  const r = db.query<{epoch:string;revision:number;fresh:number;connected:number}, [number,number]>(`
    SELECT epoch,revision,(SELECT count(*) FROM instances WHERE authState='active' AND lastSuccessAt>=?) AS fresh,
    (SELECT count(*) FROM instances WHERE authState='active' AND lastContactAt>=?) AS connected FROM hub_meta WHERE singleton=1`
  ).get(now - LIMITS.freshMs,now - LIMITS.lostMs)!;
  return {version:`${r.epoch}.${r.revision}.${r.fresh}.${r.connected}`};
}
export function sessions(db: Database, q: z.output<typeof sessionsQuerySchema>, now: number): SessionsPage {
  const where:string[] = [], args: SQLQueryBindings[] = [];
  if (q.instanceId) { where.push('s.instanceId=?'); args.push(q.instanceId); }
  if (q.standalone) where.push('s.projectId IS NULL');
  if (q.projectId) { where.push('s.projectId=?'); args.push(q.projectId); }
  if (q.status) { where.push('s.status=?'); args.push(q.status); }
  if (!q.includeArchived && q.status !== 'archived') where.push("s.status<>'archived'");
  if (q.q) { where.push('instr(s.searchTitle,?)>0'); args.push(q.q.normalize('NFKC').toLowerCase()); }
  const clause = `${join}${where.length ? ' WHERE '+where.join(' AND ') : ''}`;
  type Row = Omit<SessionRow,'projectName'> & {projectName:string|null};
  return db.transaction(() => {
    const {total} = db.query<{total:number},SQLQueryBindings[]>(`SELECT count(*) AS total ${clause}`).get(...args)!;
    const rows = db.query<Row,SQLQueryBindings[]>(`SELECT s.id,s.instanceId,s.title,s.status,s.projectId,s.projectName,s.updatedAt,s.lastMessageAt,i.lastSuccessAt,
      CASE WHEN i.lastSuccessAt>=? THEN 'fresh' ELSE 'stale' END AS freshness ${clause} ORDER BY s.activityAt DESC,s.instanceId,s.id LIMIT ? OFFSET ?`).all(now-LIMITS.freshMs,...args,q.pageSize,(q.page-1)*q.pageSize);
    const items = rows.map(({projectName,...row}) => projectName === null ? row : {...row,projectName});
    return {total,items,page:q.page,pageSize:q.pageSize};
  })();
}
export function projects(db: Database, q: z.output<typeof projectsQuerySchema>): ProjectsPage {
  const args: SQLQueryBindings[] = [], where = ['s.projectId IS NOT NULL'];
  if (q.instanceId) { where.push('s.instanceId=?'); args.push(q.instanceId); }
  if (q.q) { where.push('(instr(lower(s.projectId),lower(?))>0 OR instr(lower(s.projectName),lower(?))>0)'); args.push(q.q,q.q); }
  const sql = `SELECT s.instanceId,s.projectId,max(s.projectName) AS projectName ${join} WHERE ${where.join(' AND ')} GROUP BY s.instanceId,s.projectId`;
  return db.transaction(() => {
    const {total} = db.query<{total:number},SQLQueryBindings[]>(`SELECT count(*) AS total FROM (${sql})`).get(...args)!;
    const items = db.query<Project,SQLQueryBindings[]>(`SELECT * FROM (${sql}) ORDER BY instanceId,projectId LIMIT ? OFFSET ?`).all(...args,q.pageSize,(q.page-1)*q.pageSize);
    return {total,items,page:q.page,pageSize:q.pageSize};
  })();
}
