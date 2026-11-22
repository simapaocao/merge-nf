// Fixed bounded synthetic benchmark, no listener/files, no real NF or external network.
// bun --no-env-file tests/integration/summary-budget.ts
import assert from 'node:assert/strict';
import { arch, cpus, platform, release } from 'node:os';
import { overviewSchema, routes, sessionsSchema, type Summary } from '../../packages/protocol/src';
import { BASE, httpFixture, makeActor, packet, summary } from '../../apps/server/test/fixture';

if (process.argv.length !== 2) throw new Error('No endpoint, DB or size arguments are supported');
const ROUNDS = 21; // one full warm-up pass excluded, 20 measured passes
const QUERY_ROUNDS = 51; // one warm-up excluded
function p95(ms: number[]) {
  assert(ms.length >= 20);
  const ordered = [...ms].sort((a,b)=>a-b);
  return { n:ordered.length, p95Ms:Number(ordered[Math.ceil(.95*ordered.length)-1]!.toFixed(2)) };
}
async function shape(instances: number, perInstance: number) {
  assert.equal(instances*perInstance,10_000);
  const f=await httpFixture();
  try {
    const actors=Array.from({length:instances},(_,i)=>makeActor(f.db,`fixture-${i}`,BASE));
    const source=Array.from({length:perInstance},(_,j)=>summary(`s${j.toString().padStart(5,'0')}`,{
      title:j%100===0?'needle':'sample',status:(['working','waiting','idle'] as const)[j%3],projectId:`p${j%7}`
    }));
    const snapshot:number[]=[],batch:number[]=[],page:number[]=[],search:number[]=[];
    for(let round=0;round<ROUNDS;round++) {
      // Each independent fixture host reports once each simulated 65 s. The real process clock measures latency.
      f.clock.now=BASE+(round+1)*65_000;
      const items:Summary[]=source.map(s=>({...s,updatedAt:f.clock.now})); // force nonduplicate replacement
      const allStart=performance.now();
      for(const a of actors) {
        const auth={authorization:`Bearer ${a.token}`};
        const rr=await f.req(routes.runs,'POST',{protocolVersion:1,generation:a.generation},auth);
        assert.equal(rr.status,201); const {runId}=await rr.json() as {runId:number};
        const body=await packet(a,runId,items);
        const start=performance.now(), res=await f.req(routes.snapshot(runId),'POST',body,auth);
        assert.equal(res.status,200); const ack=await res.json() as {duplicate:boolean;runId:number};
        assert.equal(ack.runId,runId); assert.equal(ack.duplicate,false);
        if(round) snapshot.push(performance.now()-start);
      }
      if(round) batch.push(performance.now()-allStart);
    }
    const auth={cookie:f.cookie};
    assert.equal(overviewSchema.parse(await (await f.req(routes.overview,'GET',undefined,auth)).json()).freshCounts?.total,10_000);
    for(let i=0;i<QUERY_ROUNDS;i++) {
      for(const [url,total,bucket] of [[`${routes.sessions}?page=100&pageSize=100`,10_000,page],
                                      [`${routes.sessions}?q=needle&page=1&pageSize=100`,100,search]] as const) {
        const start=performance.now(), r=await f.req(url,'GET',undefined,auth); assert.equal(r.status,200);
        const value=await r.json(), elapsed=performance.now()-start;
        const rows=sessionsSchema.parse(value); assert.equal(rows.total,total); assert.equal(rows.items.length,100);
        if(i) bucket.push(elapsed);
      }
    }
    return {instances,summariesPerInstance:perInstance,snapshot:p95(snapshot),sequentialBatch:p95(batch),lastPage:p95(page),search:p95(search),
      sqlite:f.db.query<{v:string},[]>('SELECT sqlite_version() AS v').get()!.v};
  } finally {f.db.close();}
}
console.log(JSON.stringify({kind:'in-process authenticated request / :memory: SQLite; no network, TLS, disk or browser SLA',
  environment:{os:platform(),osRelease:release(),arch:arch(),cpu:cpus()[0]?.model,bun:Bun.version},
  sampling:'nearest rank; JSON serialize/route/deserialize; batch also includes startRun and client hashing; serial load, no writes during reads',
  scenarios:[await shape(10,1000),await shape(1,10_000)]},null,2));
