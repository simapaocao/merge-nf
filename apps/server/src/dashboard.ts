import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { z } from 'zod';
import { LIMITS, type ActivityCoverage, type GroupSessionRow, type InstanceActivity, type InstanceActivityItem, type Overview, type Project, type ProjectsPage, type projectsQuerySchema, type SessionGroup, type SessionGroups, type sessionGroupsQuerySchema, type SessionRow, type SessionsPage, type sessionsQuerySchema, type SessionStatus } from '@nf-hub/protocol';

// Every read independently checks active generation, not just foreign-key cleanup on revoke/delete.
const join = `FROM session_summaries s JOIN instances i ON i.id=s.instanceId AND i.generation=s.generation AND i.authState='active'`;
// The two bindings are always the same server-derived freshness cutoff. Host observation time is not used.
const activityJoin = `${join}
  LEFT JOIN activity_snapshots a ON a.instanceId=i.id AND a.generation=i.generation AND a.baseHash=i.snapshotHash AND a.available=1 AND i.lastSuccessAt>=? AND a.receivedAt>=?
  LEFT JOIN activity_items ai ON ai.instanceId=s.instanceId AND ai.id=s.id AND ai.generation=s.generation AND a.instanceId IS NOT NULL`;
const attention = '(coalesce(ai.reply,0)=1 OR coalesce(ai.approval,0)=1 OR coalesce(ai.error,0)=1 OR coalesce(ai.unread,0)=1)';
const automaticWait = `(s.status='waiting' AND ai.id IS NOT NULL AND NOT ${attention})`;
const running = `(i.lastSuccessAt>=? AND (s.status='working' OR coalesce(ai.backgroundWorkCount,0)>0 OR ${automaticWait}))`;
const groupPredicate = (group:SessionGroup) => group==='attention' ? attention : group==='running' ? `(NOT ${attention} AND ${running})` : `(NOT ${attention} AND NOT coalesce(${running},0))`;
const UNSUPPORTED = Object.freeze({supported:false,count:null});
type Row = Omit<SessionRow,'projectName'> & {projectName:string|null};
type GroupRow = Row & {activityId:string|null;reply:number|null;approval:number|null;error:number|null;unread:number|null;backgroundWorkCount:number|null};
const columns = 's.id,s.instanceId,s.title,s.status,s.projectId,s.projectName,s.updatedAt,s.lastMessageAt,i.lastSuccessAt';
const groupColumns = `${columns},ai.id AS activityId,ai.reply,ai.approval,ai.error,ai.unread,ai.backgroundWorkCount`;
const freshColumn = "CASE WHEN i.lastSuccessAt>=? THEN 'fresh' ELSE 'stale' END AS freshness";
const order = 'ORDER BY s.activityAt DESC,s.instanceId,s.id';
function baseRow({projectName,...row}:Row):SessionRow {return projectName===null ? row : {...row,projectName};}
function groupRow({activityId,reply,approval,error,unread,backgroundWorkCount,...row}:GroupRow):GroupSessionRow {
  return {...baseRow(row),activity:activityId===null ? null : {reply:!!reply,approval:!!approval,error:!!error,unread:!!unread,backgroundWorkCount:backgroundWorkCount!}};
}
function listFilters(q:{instanceId?:string;standalone?:boolean;projectId?:string;status?:SessionStatus;includeArchived?:boolean;q?:string}) {
  const where:string[] = [], args:SQLQueryBindings[] = [];
  if(q.instanceId){where.push('s.instanceId=?');args.push(q.instanceId);}
  if(q.standalone) where.push('s.projectId IS NULL');
  if(q.projectId){where.push('s.projectId=?');args.push(q.projectId);}
  if(q.status){where.push('s.status=?');args.push(q.status);}
  if(!q.includeArchived && q.status!=='archived') where.push("s.status<>'archived'");
  if(q.q){where.push('instr(s.searchTitle,?)>0');args.push(q.q.normalize('NFKC').toLowerCase());}
  return {where,args};
}
/** Coverage is conservative over the selected active instance scope; a search cannot upgrade it. */
function coverage(db:Database,instanceId:string|undefined,cutoff:number):ActivityCoverage {
  const args:SQLQueryBindings[]=[cutoff,cutoff];
  if(instanceId) args.push(instanceId);
  const row=db.query<{total:number;known:number},SQLQueryBindings[]>(`SELECT count(*) AS total,
    count(*) FILTER(WHERE i.lastSuccessAt>=? AND a.receivedAt>=?) AS known
    FROM instances i LEFT JOIN activity_snapshots a ON a.instanceId=i.id AND a.generation=i.generation AND a.baseHash=i.snapshotHash AND a.available=1
    WHERE i.authState='active'${instanceId?' AND i.id=?':''}`).get(...args)!;
  return !row.known ? 'none' : row.known===row.total ? 'complete' : 'partial';
}
export function overview(db:Database,now:number):Overview {
  return db.transaction(()=>{
    const cutoff=now-LIMITS.freshMs;
    const stats=db.query<Omit<Overview,'freshCounts'>,[number,number,number,number,number]>(`
      SELECT count(*) AS configuredInstances,
        count(*) FILTER(WHERE authState='active' AND lastContactAt>=?) AS connectedInstances,
        count(*) FILTER(WHERE authState='active' AND lastSuccessAt>=?) AS freshInstances,
        count(*) FILTER(WHERE authState='active' AND lastSuccessAt<?) AS staleInstances,
        count(*) FILTER(WHERE authState='active' AND lastContactAt<?) AS lostInstances,
        coalesce(sum(sessionCount) FILTER(WHERE authState='active' AND lastSuccessAt<?),0) AS staleSessions FROM instances`
    ).get(now-LIMITS.lostMs,cutoff,cutoff,now-LIMITS.lostMs,cutoff)!;
    if(!stats.freshInstances) return {...stats,freshCounts:null};
    const freshCounts={total:0,working:0,waiting:0,idle:0,archived:0,unknown:0};
    for(const row of db.query<{status:SessionStatus;n:number},[number]>(`SELECT s.status,count(*) AS n ${join} WHERE i.lastSuccessAt>=? GROUP BY s.status`).all(cutoff)){
      freshCounts[row.status]=row.n;freshCounts.total+=row.n;
    }
    return {...stats,freshCounts};
  })();
}
export function changes(db:Database,now:number){
  const cutoff=now-LIMITS.freshMs;
  const r=db.query<{epoch:string;revision:number;fresh:number;connected:number;activity:number},[number,number,number,number]>(`
    SELECT epoch,revision,(SELECT count(*) FROM instances WHERE authState='active' AND lastSuccessAt>=?) AS fresh,
      (SELECT count(*) FROM instances WHERE authState='active' AND lastContactAt>=?) AS connected,
      (SELECT count(*) FROM activity_snapshots a JOIN instances i ON i.id=a.instanceId AND i.generation=a.generation AND i.authState='active' AND i.snapshotHash=a.baseHash AND a.available=1
        WHERE i.lastSuccessAt>=? AND a.receivedAt>=?) AS activity FROM hub_meta WHERE singleton=1`
  ).get(cutoff,now-LIMITS.lostMs,cutoff,cutoff)!;
  // Version is opaque to both installed schemas and ChangesBaseline: activity-only expiry fences reads.
  return {version:`${r.epoch}.${r.revision}.${r.fresh}.${r.connected}.${r.activity}`};
}
export function sessions(db:Database,q:z.output<typeof sessionsQuerySchema>,now:number):SessionsPage {
  const cutoff=now-LIMITS.freshMs,{where,args}=listFilters(q);
  const bindings:SQLQueryBindings[]=q.group ? [cutoff,cutoff,...args] : args;
  if(q.group){where.push(groupPredicate(q.group));if(q.group!=='attention') bindings.push(cutoff);}
  const clause=`${q.group?activityJoin:join}${where.length?' WHERE '+where.join(' AND '):''}`;
  return db.transaction(()=>{
    const {total}=db.query<{total:number},SQLQueryBindings[]>(`SELECT count(*) AS total ${clause}`).get(...bindings)!;
    const items=db.query<Row,SQLQueryBindings[]>(`SELECT ${columns},${freshColumn} ${clause} ${order} LIMIT ? OFFSET ?`)
      .all(cutoff,...bindings,q.pageSize,(q.page-1)*q.pageSize).map(baseRow);
    // Do not attach activity here: strict installed /api/sessions clients still receive SessionRow.
    return {total,items,page:q.page,pageSize:q.pageSize};
  })();
}
export function projects(db:Database,q:z.output<typeof projectsQuerySchema>):ProjectsPage {
  const args:SQLQueryBindings[]=[],where=['s.projectId IS NOT NULL'];
  if(q.instanceId){where.push('s.instanceId=?');args.push(q.instanceId);}
  if(q.q){where.push('(instr(lower(s.projectId),lower(?))>0 OR instr(lower(s.projectName),lower(?))>0)');args.push(q.q,q.q);}
  const sql=`SELECT s.instanceId,s.projectId,max(s.projectName) AS projectName ${join} WHERE ${where.join(' AND ')} GROUP BY s.instanceId,s.projectId`;
  return db.transaction(()=>{
    const {total}=db.query<{total:number},SQLQueryBindings[]>(`SELECT count(*) AS total FROM (${sql})`).get(...args)!;
    const items=db.query<Project,SQLQueryBindings[]>(`SELECT * FROM (${sql}) ORDER BY instanceId,projectId LIMIT ? OFFSET ?`).all(...args,q.pageSize,(q.page-1)*q.pageSize);
    return {total,items,page:q.page,pageSize:q.pageSize};
  })();
}
/** Tab counts cover all authorized, fresh, non-archived rows, independently of list filters. */
export function instanceActivity(db:Database,now:number):InstanceActivity {
  return db.transaction(()=>{
    const cutoff=now-LIMITS.freshMs;
    const instances=db.query<{id:string;authState:string;lastSuccessAt:number|null;activityAvailable:number},[number,number]>(`SELECT i.id,i.authState,i.lastSuccessAt,
      CASE WHEN i.authState='active' AND i.lastSuccessAt>=? AND a.receivedAt>=? THEN 1 ELSE 0 END AS activityAvailable
      FROM instances i LEFT JOIN activity_snapshots a ON a.instanceId=i.id AND a.generation=i.generation AND a.baseHash=i.snapshotHash AND a.available=1
      ORDER BY i.favorite DESC,i.sortOrder,i.alias COLLATE NOCASE,i.id`).all(cutoff,cutoff);
    type Stats={instanceId:string;total:number;working:number;waiting:number;idle:number;archived:number;unknown:number;attention:number;background:number;runningCount:number};
    const stats=db.query<Stats,[number,number,number]>(`SELECT s.instanceId,count(*) AS total,
      count(*) FILTER(WHERE s.status='working') AS working,count(*) FILTER(WHERE s.status='waiting') AS waiting,
      count(*) FILTER(WHERE s.status='idle') AS idle,0 AS archived,count(*) FILTER(WHERE s.status='unknown') AS unknown,
      count(*) FILTER(WHERE ${attention}) AS attention,count(*) FILTER(WHERE ai.backgroundWorkCount>0) AS background,
      count(*) FILTER(WHERE s.status='working' OR ai.backgroundWorkCount>0 OR ${automaticWait}) AS runningCount
      ${activityJoin} WHERE i.lastSuccessAt>=? AND s.status<>'archived' GROUP BY s.instanceId`).all(cutoff,cutoff,cutoff);
    const byId=new Map(stats.map(s=>[s.instanceId,s]));
    const items=instances.map((i):InstanceActivityItem=>{
      const freshness=i.lastSuccessAt===null?'never':i.lastSuccessAt>=cutoff?'fresh':'stale';
      const current=i.authState==='active' && freshness==='fresh',row=byId.get(i.id);
      const counts=!current?null:row?{total:row.total,working:row.working,waiting:row.waiting,idle:row.idle,archived:0,unknown:row.unknown}:{total:0,working:0,waiting:0,idle:0,archived:0,unknown:0};
      return {instanceId:i.id,freshness,lastSuccessAt:i.lastSuccessAt,counts,runningCount:current?row?.runningCount??0:null,
        attention:i.activityAvailable?{supported:true,count:row?.attention??0}:{...UNSUPPORTED},
        background:i.activityAvailable?{supported:true,count:row?.background??0}:{...UNSUPPORTED}};
    });
    return {items};
  })();
}
/** Complete filtered totals and mutually exclusive previews, never grouping just a currently loaded page. */
export function sessionGroups(db:Database,q:z.output<typeof sessionGroupsQuerySchema>,now:number):SessionGroups {
  const cutoff=now-LIMITS.freshMs,{where,args}=listFilters(q);
  const clause=(predicate?:string)=>`${activityJoin} WHERE ${[...where,predicate??'1'].join(' AND ')}`;
  const bindings:SQLQueryBindings[]=[cutoff,cutoff,...args];
  return db.transaction(()=>{
    const totals=db.query<{total:number;attention:number;running:number},SQLQueryBindings[]>(`SELECT count(*) AS total,
      count(*) FILTER(WHERE ${attention}) AS attention,count(*) FILTER(WHERE ${groupPredicate('running')}) AS running ${clause()}`)
      .get(cutoff,...bindings)!;
    const preview=(group:SessionGroup)=>db.query<GroupRow,SQLQueryBindings[]>(`SELECT ${groupColumns},${freshColumn} ${clause(groupPredicate(group))} ${order} LIMIT ?`)
      .all(cutoff,...bindings,...(group==='attention'?[]:[cutoff]),q.previewSize).map(groupRow);
    const activityCoverage=coverage(db,q.instanceId,cutoff),supported=activityCoverage!=='none';
    return {total:totals.total,previewSize:q.previewSize,
      attention:{supported,coverage:activityCoverage,total:supported?totals.attention:null,items:supported?preview('attention'):[]},
      running:{supported:true,coverage:activityCoverage,total:totals.running,items:preview('running')},
      recent:{supported:true,coverage:activityCoverage,total:totals.total-totals.attention-totals.running,items:preview('recent')}};
  })();
}
