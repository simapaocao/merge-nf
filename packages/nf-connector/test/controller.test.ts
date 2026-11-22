import { expect, test } from "bun:test";
import { pairRequestSchema, snapshotHash, snapshotRequestSchema } from "@nf-hub/protocol";
import { ConnectorError } from "../src/errors";
import { CREDENTIAL_KEY, PAIRING_KEY, SETTINGS_KEY } from "../src/constants";
import { nextDelay } from "../src/controller";
import { BASE, CODE, NOW, TOKEN, deferred, draft, fixture, page, row, until } from "./fixtures";

test("default is empty and stopped; paired run uses shared schema/hash, no secrets, raw rows or snapshots in ordinary storage", async()=>{
  const f=fixture(); try {
    await f.controller.activate(); expect(f.controller.view().settings).toMatchObject({scope:{mode:"none"},paused:true,intervalMs:30000,confirmed:false});
    expect(f.center.runs).toHaveLength(0);await f.pair(); await until(()=>f.controller.view().status.lastSuccessAt===NOW);
    const wire=f.center.snapshots[0]!; expect(snapshotRequestSchema.safeParse(wire).success).toBe(true);expect(wire.hash).toBe(await snapshotHash(wire.summaries));expect(wire.summaries.map(r=>r.id)).toEqual(["chosen"]);expect(wire.runId).toBe(1); expect(wire.summaries[0]?.projectName).toBeUndefined();
    expect(pairRequestSchema.safeParse(f.center.pairs[0]).success).toBe(true);expect(f.host.secrets.has(PAIRING_KEY)).toBe(false);expect(f.host.secrets.get(CREDENTIAL_KEY)).toContain(TOKEN);
    const saved=JSON.stringify([...f.host.storage]);for(const s of [TOKEN,CODE,"unpublished","标题",'"summaries"'])expect(saved).not.toContain(s);expect(JSON.stringify(f.controller.view())).not.toContain(TOKEN);
  } finally {f.controller.deactivate();}
});
test("activation restores a binding, leases a new run and captures changed source instead of replaying",async()=>{
  const f=fixture();const restarted=f.make();try{
    await f.controller.activate();await f.pair();await until(()=>f.controller.view().status.lastSuccessAt===NOW);f.controller.deactivate(); f.host.list=()=>page([row("chosen",{title:"after restart"})]);
    await restarted.activate();await until(()=>f.center.snapshots.length===2);expect(f.center.snapshots[1]!.runId).toBe(2);expect(f.center.snapshots[1]!.summaries[0]?.title).toBe("after restart");expect(f.center.pairs).toHaveLength(1);
    await restarted.pause();const r=f.make();try{await r.activate();expect(r.view().status.state).toBe("paused");expect(r.view().status.nextAttemptAt).toBe(null);}finally{r.deactivate();}
  }finally{f.controller.deactivate();restarted.deactivate();}
});
test("failed later host page reports only fixed error code, never a partial or empty success",async()=>{
  const f=fixture();try{f.host.list=(_,i)=>i.cursor ? {status:"failed",raw:"PRIVATE"} : page([row("chosen")],"next"); await f.controller.activate();await f.pair();await until(()=>f.center.failures.length===1);expect(f.center.snapshots).toHaveLength(0);expect(f.center.failures[0]).toEqual({protocolVersion:1,generation:2,runId:1,errorCode:"QUERY_FAILED"});expect(f.controller.view().status.lastSuccessAt).toBe(null);}finally{f.controller.deactivate();}
});
test("mid-collection change of base fences canceled source and never sends token or rows to replacement",async()=>{
  const gate=deferred<ReturnType<typeof page>>(), f=fixture();let entered=false;try{
    f.host.list=()=>{entered=true;return gate.promise;};await f.controller.activate();await f.pair();await until(()=>entered);
    expect(()=>f.controller.sync()).toThrow("BUSY");const next=await f.controller.configure({...draft(),baseUrl:"https://different.test"});gate.resolve(page([row("chosen")]));await Bun.sleep(20);
    expect(next.settings.requiresRevocation).toBe(true);expect(next.paired).toBe(false);expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(false);expect(f.destinations.every(url=>url===BASE)).toBe(true); expect(f.center.snapshots).toHaveLength(0);expect(f.center.failures).toHaveLength(0);
    await expect(f.controller.resume()).rejects.toMatchObject({code:"PAIRING_REQUIRED"});await expect(f.controller.pair({})).rejects.toMatchObject({code:"CENTRAL_REVOCATION_REQUIRED"});
  }finally{gate.resolve(page([]));f.controller.deactivate();}
});
test("scope change sets durable center-revoke fence; ordinary pause does not claim revocation",async()=>{
  const f=fixture();const r=f.make();try{await f.controller.activate();await f.pair();const p=await f.controller.pause();expect(p.paired).toBe(true);expect(p.settings.requiresRevocation).toBe(false);await f.controller.configure({...draft(),scope:{mode:"none",includeArchived:false},confirmed:false});f.controller.deactivate();await r.activate();expect(r.view().settings.requiresRevocation).toBe(true);expect(r.view().status.state).toBe("re-pair-required");expect(r.view().status.lastCount).toBe(null);}finally{f.controller.deactivate();r.deactivate();}
});
test("restart refuses externally mismatched persisted URL",async()=>{
  const f=fixture();const r=f.make();try{await f.controller.activate();await f.pair();f.controller.deactivate();const saved=f.host.storage.get(SETTINGS_KEY) as Record<string,unknown>;f.host.storage.set(SETTINGS_KEY,{...saved,baseUrl:"https://wrong.test"});await r.activate();expect(r.view().status).toMatchObject({state:"re-pair-required",lastErrorCode:"BASE_URL_CHANGED",nextAttemptAt:null});expect(f.destinations).not.toContain("https://wrong.test");}finally{f.controller.deactivate();r.deactivate();}
});
test("pairing envelope tied to the settings in the confirming tab; lost response is not replayed",async()=>{
  const f=fixture();try{await f.controller.activate();const old=await f.controller.configure(draft());await f.controller.configure({...draft(),baseUrl:"https://new.test"}); f.host.secrets.set(PAIRING_KEY,JSON.stringify({code:CODE,binding:old.binding}));await expect(f.controller.pair()).rejects.toMatchObject({code:"PAIRING_REQUIRED"});expect(f.center.pairs).toHaveLength(0);
    f.center.pair=async()=>{throw Error("PRIVATE server response");};await expect(f.pair()).rejects.toMatchObject({code:"PAIRING_UNCERTAIN"});expect(f.controller.view().settings.requiresRevocation).toBe(true);expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(false);expect(f.host.secrets.has(PAIRING_KEY)).toBe(false);expect(JSON.stringify([...f.host.storage])).not.toContain("PRIVATE");
  }finally{f.controller.deactivate();}
});
test("401/403 terminal behavior clears credential and persists across restart; no reporting to failed endpoint",async()=>{
  const f=fixture();const r=f.make();try{f.center.run=async()=>{throw new ConnectorError("AUTH_REJECTED",true);};await f.controller.activate();await f.pair();await until(()=>f.controller.view().status.state==="auth-rejected");expect(f.center.failures).toHaveLength(0);expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(false);await expect(f.controller.resume()).rejects.toMatchObject({code:"PAIRING_REQUIRED"});f.controller.deactivate();await r.activate();expect(r.view().status.state).toBe("auth-rejected");}finally{f.controller.deactivate();r.deactivate();}
});
test("fixed projectNames capability: initial query denied => ID-only; subsequent query failure rejects complete run",async()=>{
  const f=fixture();try{f.host.list=q=>q.endsWith("projects.list") ? {status:"failed"} : page([row("chosen")]);await f.controller.activate();await f.pair({...draft(),wantProjectNames:true});await until(()=>f.center.snapshots.length===1);expect(f.center.pairs[0]!.capabilities).toEqual(["summary.v1"]);expect(f.controller.view().includesProjectNames).toBe(false);expect(f.center.snapshots[0]!.summaries[0]?.projectName).toBeUndefined();}finally{f.controller.deactivate();}
  const g=fixture();try{g.host.list=(q,i)=>q.endsWith("projects.list") ? i.limit===1 ? page([{id:"p",name:"Has names"}]) : {status:"failed"} : page([row("chosen")]);await g.controller.activate();await g.pair({...draft(),wantProjectNames:true});await until(()=>g.center.failures.length===1);expect(g.center.pairs[0]!.capabilities).toEqual(["summary.v1","projectNames.v1"]);expect(g.center.failures[0]!.errorCode).toBe("PROJECT_QUERY_FAILED");expect(g.center.snapshots).toHaveLength(0);}finally{g.controller.deactivate();}
});
test("deactivate aborts in-flight queries without posting; temporary failures back off but do not exceed 120s",async()=>{
  const f=fixture();const gate=deferred<ReturnType<typeof page>>();let signal:AbortSignal|undefined;try{f.host.list=(_q,_i,s)=>{signal=s;return gate.promise;};await f.controller.activate();await f.pair();await until(()=>!!signal);f.controller.deactivate();expect(signal!.aborted).toBe(true);gate.resolve(page([]));await Bun.sleep(15);expect(f.center.snapshots).toHaveLength(0);expect(f.controller.view().status.nextAttemptAt).toBe(null);}finally{gate.resolve(page([]));f.controller.deactivate();}
  expect(nextDelay(30000,0,.5)).toBe(30000);expect(nextDelay(30000,1,.5)).toBe(30000);expect(nextDelay(30000,2,.5)).toBe(60000);expect(nextDelay(30000,8,1)).toBe(120000);
});
