import { normalizeBrowserBaseUrl, type Instance } from '@nf-hub/protocol';

export type FrameIdentity = {instanceId:string; generation:number; browserBaseUrl:string};
export type FrameEntry = FrameIdentity & {target:string;revision:number};
export const identityKey = (entry:FrameIdentity) => JSON.stringify([entry.instanceId,entry.generation,entry.browserBaseUrl]);
export const frameKey = (entry:FrameEntry) => JSON.stringify([entry.instanceId,entry.generation,entry.browserBaseUrl,entry.revision]);
export function authorizedFrames(instances: readonly Pick<Instance,'id'|'generation'|'browserBaseUrl'|'connection'>[],hubOrigin:string) {
  const map=new Map<string,FrameIdentity>();
  for(const instance of instances) {
    if(instance.connection==='revoked') continue;
    try { map.set(instance.id,{instanceId:instance.id,generation:instance.generation,browserBaseUrl:normalizeBrowserBaseUrl(instance.browserBaseUrl,hubOrigin)}); } catch { /* Invalid origins are not frame hosts. */ }
  }
  return map;
}
/** Render through this filter (not an after-paint cleanup). Absence, revocation or changed identity dismounts the iframe. */
export function pruneFrames(entries:readonly FrameEntry[],allowed:ReadonlyMap<string,FrameIdentity>):FrameEntry[] {
  return entries.filter(entry=>{const grant=allowed.get(entry.instanceId); return grant && identityKey(grant)===identityKey(entry);});
}
/** LRU -> MRU. Omitting an explicit target preserves a live document's last hub-directed target. */
export function touchFrame(entries:readonly FrameEntry[],grant:FrameIdentity,target?:string,capacity=3):FrameEntry[] {
  if(capacity<1) return [];
  const existing=entries.find(entry=>identityKey(entry)===identityKey(grant));
  const next={...grant,target:target??existing?.target??grant.browserBaseUrl,revision:existing?.revision??0};
  return [...entries.filter(entry=>entry.instanceId!==grant.instanceId),next].slice(-capacity);
}
export function refreshFrame(entries:readonly FrameEntry[],grant:FrameIdentity):FrameEntry[] {
  return entries.map(entry=>identityKey(entry)===identityKey(grant)?{...entry,revision:entry.revision+1}:entry);
}
