import { describe, expect, test } from "bun:test";
import { EMPTY_SCOPE, LIMITS, snapshotHash, type PublishScope } from "@nf-hub/protocol";
import { collectSummaries, redactSummary } from "../src/collection";
import { FakeHost, page, row } from "./fixtures";
const all: PublishScope = {mode:"all",includeArchived:false,acknowledgeHidden:true};
const only: PublishScope = {mode:"sessions",sessionIds:["yes"],includeArchived:false};

describe("host summary collection", () => {
  test("empty scope makes no host query", async () => {
    const host = new FakeHost(); expect((await collectSummaries(host,EMPTY_SCOPE)).summaries).toEqual([]); expect(host.ids).toEqual([]);
  });
  test("strict projection, valid Unicode boundary, enum only, no free-text substatus or extra fields", () => {
    const result = redactSummary(row("yes",{status:"custom-text",title:"x".repeat(511)+"😀"+"\n",modelKey:"PRIVATE",body:"PRIVATE",substatus:["PRIVATE"],systemPrompt:"PRIVATE",cwd:"PRIVATE"}));
    expect(Object.keys(result).sort()).toEqual(["id","lastMessageAt","projectId","status","title","updatedAt"]); expect(result.status).toBe("unknown"); expect(result.title).toBe("x".repeat(511)); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(() => redactSummary(row("yes",{projectId:undefined}))).toThrow("INVALID_RECORD"); expect(() => redactSummary(row("yes",{updatedAt:"not-a-date"}))).toThrow("INVALID_RECORD");
  });
  test("later pages are required even after all selected IDs were found", async () => {
    const host = new FakeHost(); const seen: Record<string,unknown>[]=[]; host.list = (_,input) => { seen.push(input); return input.cursor ? {status:"failed"} : page([row("yes")],"next"); };
    await expect(collectSummaries(host,only)).rejects.toMatchObject({code:"QUERY_FAILED"}); expect(seen).toHaveLength(2); expect(seen[0]?.limit).toBe(100); expect(new Set(host.ids)).toEqual(new Set(["narrafork.narrators.list"]));
  });
  test("filters selected projects upstream, rechecks locally and does not send unselected rows", async () => {
    const h = new FakeHost(), inputs: Record<string,unknown>[]=[];
    h.list = (_,input) => { inputs.push(input); const p=String(input.projectId); return page([row(p,{projectId:p}),row(`other-${p}`,{projectId:"outside",title:"SECRET"})]); };
    const r = await collectSummaries(h,{mode:"projects",includeArchived:false,includeStandalone:false,projectIds:["b","a"]});
    expect(inputs.map(i=>i.projectId)).toEqual(["b","a"]); expect(inputs[0]?.status).toEqual(["idle","working","waiting"]); expect(r.summaries.map(s=>s.id)).toEqual(["a","b"]); expect(JSON.stringify(r)).not.toContain("SECRET");
  });
  test("standalone, archived and project name allowlists are independent", async () => {
    const h=new FakeHost(); h.list = id => id==="narrafork.projects.list" ? page([{id:"p",name:"Project",cwd:"NO_SEND"},{id:"q",name:"NO_SEND"}]) : page([row("a"),row("b",{projectId:null}),row("c",{status:"archived"}),row("d",{projectId:"q"})]);
    const r=await collectSummaries(h,{mode:"projects",projectIds:["p"],includeStandalone:true,includeArchived:false},{projectNames:true}); expect(r.summaries.map(s=>[s.id,s.projectName])).toEqual([["a","Project"],["b",undefined]]); expect(r.projectNames).toBe("available"); expect(JSON.stringify(r)).not.toContain("NO_SEND");
    const full=await collectSummaries(h,{...all,includeArchived:true},{projectNames:false});expect(full.summaries.map(s=>s.id)).toEqual(["a","b","c","d"]);expect(full.summaries.every(s=>s.projectName===undefined)).toBe(true);
  });
  test("project-name failure rejects instead of partial completion",async()=>{ const h=new FakeHost(); h.list=(q,i)=>q.endsWith("projects.list") ? i.cursor ? {status:"failed"} : page([{id:"p",name:"Partial"}],"n") : page([row("yes")]); await expect(collectSummaries(h,all,{projectNames:true})).rejects.toMatchObject({code:"PROJECT_QUERY_FAILED"}); });
  for(const [name, fixture] of [
    ["missing-page", {status:"succeeded",data:{items:[]}}], ["missing-has-more",{status:"succeeded",data:{items:[]},page:{}}], ["missing-cursor",{status:"succeeded",data:{items:[row("a")]},page:{hasMore:true}}], ["empty-followup",page([],"next")], ["contradictory-end",{status:"succeeded",data:{items:[]},page:{hasMore:false,nextCursor:"next"}}],
  ] as const) test(`rejects malformed page ${name}`, async()=>{const h=new FakeHost();h.list=()=>fixture; await expect(collectSummaries(h,all)).rejects.toBeDefined();});
  test("detects nonconsecutive cursor reuse and duplicate unselected IDs", async()=>{
    const h=new FakeHost();let n=0; h.list=()=>page([row(`outside-${n}`)], ["a","b","a"][n++]); await expect(collectSummaries(h,only)).rejects.toMatchObject({code:"CURSOR_INVALID"});
    h.list=(_,i)=>page([row("outside")],i.cursor ? undefined : "a"); await expect(collectSummaries(h,only)).rejects.toMatchObject({code:"DUPLICATE_ID"});
  });
  test("500 raw page and 90s cumulative budgets fail closed", async()=>{
    const h=new FakeHost(); let n=0; h.list=()=>page([row(`outside-${++n}`)],`c${n}`); await expect(collectSummaries(h,only)).rejects.toMatchObject({code:"LIMIT_EXCEEDED"});expect(n).toBe(LIMITS.hostPages);
    let now=0;h.list=()=>{now=90_001;return page([]);}; await expect(collectSummaries(h,all,{now:()=>now})).rejects.toMatchObject({code:"COLLECTION_TIMEOUT"});
  });
  test("10,000 summaries succeed; 10,001 does not return a truncated snapshot", async()=>{
    const h = new FakeHost(); let total=10_000;
    h.list=(_,input)=>{const start=Number(input.cursor??0),end=Math.min(total,start+100); return page(Array.from({length:end-start},(_,i)=>row(String(start+i))),end<total?String(end):undefined);};
    const r=await collectSummaries(h,all); expect(r.pages).toBe(100);expect(r.summaries).toHaveLength(total);expect(await snapshotHash(r.summaries)).toMatch(/^[a-f0-9]{64}$/);
    total++; await expect(collectSummaries(h,all)).rejects.toMatchObject({code:"LIMIT_EXCEEDED"});
  });
});
