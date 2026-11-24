import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SESSION_GROUP_PREVIEW, changesWithInstancesSchema, instanceActivitySchema, instancesSchema, overviewSchema, projectsSchema, routes, sessionGroupsSchema, sessionsSchema, type ChangesWithInstances, type SessionGroup, type SessionStatus } from '@nf-hub/protocol';
import { api } from '../lib/api';
import { ApiError } from '../lib/errors';
import { privateKey, useAppState } from './useAppState';

export type SessionFilters = { q:string; instanceId:string; status:SessionStatus|''; projectId:string; standalone:boolean; includeArchived:boolean; page:number; pageSize:number; group?:SessionGroup|'' };
export const initialFilters:SessionFilters={q:'',instanceId:'',status:'',projectId:'',standalone:false,includeArchived:false,page:1,pageSize:50,group:''};
/** Filters shared by the paged list and the card preview. Paging and the group selector are not included. */
function filterParams(filters:SessionFilters):URLSearchParams {
  const params=new URLSearchParams();
  if(filters.q.trim()) params.set('q',filters.q.trim()); if(filters.instanceId) params.set('instanceId',filters.instanceId);
  if(filters.status) params.set('status',filters.status); if(filters.projectId && filters.instanceId && !filters.standalone) params.set('projectId',filters.projectId);
  if(filters.standalone) params.set('standalone','true'); if(filters.includeArchived) params.set('includeArchived','true');
  return params;
}
export function sessionsPath(filters:SessionFilters):string {
  const params=filterParams(filters);
  params.set('page',String(Math.max(1,filters.page))); params.set('pageSize',String(Math.min(100,Math.max(1,filters.pageSize))));
  if(filters.group) params.set('group',filters.group);
  return `${routes.sessions}?${params}`;
}
/** Card preview path: one bounded page per section, so page/group never leak into it. */
export function sessionGroupsPath(filters:SessionFilters,previewSize=SESSION_GROUP_PREVIEW):string {
  const params=filterParams(filters);
  params.set('previewSize',String(Math.min(100,Math.max(1,previewSize))));
  return `${routes.sessionGroups}?${params}`;
}
type Schema<T>={safeParse:(v:unknown)=>{success:true;data:T}|{success:false}};
function usePrivateQuery<T>(kind:string,path:string,schema:Schema<T>,enabled=true) {
  const {revision,view}=useAppState();
  // Instance list gets seeded at this *exact* key from the same read transaction as /changes.
  const base=privateKey(revision,kind,view.epoch), key=kind==='instances'?base:[...base,path];
  const query=useQuery({queryKey:key,enabled:enabled && view.verified,queryFn:({signal})=>api.read(path,schema,signal,view.epoch)});
  return {...query,data:view.verified && view.epoch===api.readEpoch && query.isSuccess ? query.data : undefined};
}
export function useInstances() {return usePrivateQuery('instances',routes.instances,instancesSchema);}
export function useOverview() {return usePrivateQuery('overview',routes.overview,overviewSchema);}
export function useSessions(filters:SessionFilters) {return usePrivateQuery('sessions',sessionsPath(filters),sessionsSchema);}
/** Tab-bar statistics: per instance, independent of the current list filters. */
export function useInstanceActivity() {return usePrivateQuery('instanceActivity',routes.instanceActivity,instanceActivitySchema);}
/** Card sections. Counts cover the whole filtered set; each section carries at most `previewSize` rows. */
export function useSessionGroups(filters:SessionFilters,previewSize=SESSION_GROUP_PREVIEW) {
  return usePrivateQuery('sessionGroups',sessionGroupsPath(filters,previewSize),sessionGroupsSchema);
}
export function useProjects(instanceId:string,q:string) {
  const params=new URLSearchParams({instanceId,page:'1',pageSize:'100'}); if(q.trim()) params.set('q',q.trim());
  return usePrivateQuery('projects',`${routes.projects}?${params}`,projectsSchema,!!instanceId);
}
export function useDebounce<T>(value:T,delay=300):T {
  const [debounced,setDebounced]=useState(value);
  useEffect(()=>{const timer=window.setTimeout(()=>setDebounced(value),delay);return ()=>window.clearTimeout(timer);},[value,delay]); return debounced;
}
/** A 304 is valid only for the installed instance-bearing representation. Errors discard the baseline. */
export class ChangesBaseline {
  etag:string|null=null; version:string|null=null;
  clear(){this.etag=null;this.version=null;}
  consume(result:{data:ChangesWithInstances|null;etag:string|null}, current:string|null, install:(data:ChangesWithInstances)=>boolean) {
    if (!result.data) {
      if (!this.etag || !this.version || this.version!==current || result.etag!==this.etag) throw new ApiError('INVALID_RESPONSE');
      return;
    }
    const {version}=result.data;
    if (result.etag!==`"instances:${version}"`) throw new ApiError('INVALID_RESPONSE');
    if (this.version!==version || current!==version) { if (!install(result.data)) return; }
    this.version=version; this.etag=result.etag;
  }
}
export function useChanges() {
  const {revision,installView}=useAppState(), [error,setError]=useState<unknown>(null);
  useEffect(()=>{
    const baseline=new ChangesBaseline(), controller=new AbortController(); let active=true,running=false,timer:number|undefined;
    const poll=async()=>{
      if(!active || running) return; running=true;
      try {
        const result=await api.request(routes.changesWithInstances,changesWithInstancesSchema,{allow304:true,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12_000)]),headers:baseline.etag?{'If-None-Match':baseline.etag}:undefined});
        if(!active) return;
        baseline.consume(result,api.readVersion,snapshot=>installView(revision,snapshot)); setError(null);
      } catch(reason) {
        if(active){ baseline.clear(); installView(revision,null); setError(reason); }
      } finally { running=false; if(active) timer=window.setTimeout(poll,document.hidden?30_000:5_000); }
    };
    const visibility=()=>{window.clearTimeout(timer);if(!running) void poll();};
    document.addEventListener('visibilitychange',visibility); void poll();
    return ()=>{active=false;controller.abort();window.clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
  },[revision,installView]);
  return error;
}
