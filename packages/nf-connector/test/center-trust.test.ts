import { expect, test } from "bun:test";
import { routes, snapshotHash } from "@nf-hub/protocol";
import { centerTrust, DEFAULT_TRUST } from "../src/center-trust";
import { bindingKey, parseCredential, type BoundCredential } from "../src/config";
import { CREDENTIAL_KEY, PAIRING_KEY, PLUGIN_VERSION, SETTINGS_KEY } from "../src/constants";
import { CenterClient } from "../src/transport";
import { BASE, CODE, PAIR, TOKEN, draft, fixture, until, deferred, page, row } from "./fixtures";
import { ephemeralPki } from "./ephemeral-pki";

const request = { protocolVersion:1 as const, code:CODE, scope:draft().scope, confirmed:true as const, connectorVersion:PLUGIN_VERSION, capabilities:["summary.v1" as const] };

test("public trust is the default; a supplied override must be one exact public CA and match the confirmed DER fingerprint",()=>{
  const p = ephemeralPki(), {centerCaPem:pem,centerCaSha256:hash} = p.trust, leaf = p.leaf();
  expect(centerTrust(undefined,undefined)).toEqual(DEFAULT_TRUST);
  expect(centerTrust(pem.replace(/\n/g,"\r\n"),hash).centerCaSha256).toBe(hash);
  for (const bad of ["", " ", {}, "/etc/ca.pem", "x".repeat(16385), leaf.key, leaf.cert, pem+pem, pem+leaf.key, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"]) {
    expect(()=>centerTrust(bad,hash)).toThrow("CA_INVALID");
  }
  for (const other of [null,"",hash.toUpperCase(),"0".repeat(64)]) expect(()=>centerTrust(pem,other)).toThrow("CA_FINGERPRINT_MISMATCH");
  const old = parseCredential(JSON.stringify({version:1,baseUrl:BASE,scopeKey:bindingKey(draft()),projectNames:false,pairing:PAIR}));
  expect(old?.centerCaSha256).toBe(null); expect(bindingKey({...draft(),centerCaSha256:null})).toBe(bindingKey(draft()));
  expect(bindingKey({...draft(),centerCaSha256:hash})).not.toBe(bindingKey(draft()));
});

test("real loopback TLS: same CA and hostname allow all four routes; wrong CA, default CA and wrong SAN receive no HTTP request",async()=>{
  const p = ephemeralPki(), other = ephemeralPki(), hits: {path:string;auth:string|null;body:string}[] = [];
  function serve(tls: ReturnType<typeof p.leaf>) {
    return Bun.serve({hostname:"127.0.0.1",port:0,tls,async fetch(req) {
      const path = new URL(req.url).pathname; hits.push({path,auth:req.headers.get("authorization"),body:await req.text()});
      if (path === routes.pair) return Response.json(PAIR);
      if (path === routes.runs) return Response.json({protocolVersion:1,generation:2,runId:1,expiresAt:Date.now()+120_000});
      if (path === routes.snapshot(1)) return Response.json({runId:1,acceptedAt:Date.now(),duplicate:false});
      return new Response(null,{status:204});
    }});
  }
  const ok = serve(p.leaf()), wrongName = serve(p.leaf([192,0,2,1]));
  try {
    const base = `https://127.0.0.1:${ok.port}`, badBase = `https://127.0.0.1:${wrongName.port}`;
    const client = new CenterClient(base,fetch,p.trust), pairing = await client.pair(request);
    const cred: BoundCredential = {version:1,baseUrl:base,centerCaSha256:p.trust.centerCaSha256,scopeKey:"0".repeat(64),projectNames:false,pairing};
    await client.run(cred); await client.snapshot(cred,{protocolVersion:1,generation:2,runId:1,count:0,hash:await snapshotHash([]),summaries:[]});
    await client.failed(cred,{protocolVersion:1,generation:2,runId:1,errorCode:"QUERY_FAILED"});
    expect(hits.map(h=>h.path)).toEqual([routes.pair,routes.runs,routes.snapshot(1),routes.failed(1)]);
    expect(hits[0]!.auth).toBe(null); expect(hits.slice(1).every(h=>h.auth===`Bearer ${TOKEN}`)).toBe(true);
    for (const h of hits) { expect(h.body).not.toContain("CERTIFICATE"); expect(h.body).not.toContain(p.trust.centerCaSha256); }
    await expect(new CenterClient(base).pair(request)).rejects.toMatchObject({code:"HTTP_FAILED"});
    await expect(new CenterClient(base,fetch,other.trust).pair(request)).rejects.toMatchObject({code:"HTTP_FAILED"});
    await expect(new CenterClient(badBase,fetch,p.trust).run({...cred,baseUrl:badBase})).rejects.toMatchObject({code:"HTTP_FAILED"});
    await expect(new CenterClient(base,fetch,other.trust).run(cred)).rejects.toMatchObject({code:"CA_CHANGED",terminal:true});
    expect(hits).toHaveLength(4);
  } finally { await ok.stop(true); await wrongName.stop(true); }
});

test("CA rotation fences an in-flight run; stale pairing, resume and replay after restart cannot send the old credential",async()=>{
  const old=ephemeralPki().trust, next=ephemeralPki().trust, f=fixture(), restart=f.make(), gate=deferred<ReturnType<typeof page>>(); let entered=false;
  try {
    f.host.list=()=>{entered=true;return gate.promise;}; await f.controller.activate();
    const paired=await f.pair({...draft(),...old}); await until(()=>entered);
    const saved=f.host.secrets.get(CREDENTIAL_KEY)!; expect(saved).toContain(old.centerCaSha256); expect(saved).not.toContain("CERTIFICATE");
    expect(f.host.storage.get(SETTINGS_KEY)).toMatchObject({centerCaSha256:old.centerCaSha256});
    const replaced=await f.controller.configure({...draft(),...next}); gate.resolve(page([row("chosen")]));
    expect(replaced.paired).toBe(false); expect(replaced.settings).toMatchObject({paused:true,requiresRevocation:true,centerCaSha256:next.centerCaSha256});
    expect(replaced.status.lastErrorCode).toBe("CA_CHANGED"); expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(false);
    f.host.secrets.set(PAIRING_KEY,JSON.stringify({code:CODE,binding:paired.binding}));
    await expect(f.controller.pair()).rejects.toMatchObject({code:"CENTRAL_REVOCATION_REQUIRED"});
    await expect(f.controller.pair({centralRevocationAcknowledged:true})).rejects.toMatchObject({code:"PAIRING_REQUIRED"});
    f.controller.deactivate(); await restart.activate(); await expect(restart.resume()).rejects.toMatchObject({code:"PAIRING_REQUIRED"});
    expect(f.center.pairs).toHaveLength(1); expect(f.center.runs).toHaveLength(1); expect(f.center.snapshots).toHaveLength(0); expect(f.center.failures).toHaveLength(0);
  } finally {gate.resolve(page([]));f.controller.deactivate();restart.deactivate();}
});

test("external persisted trust drift clears the old binding on activation before any request",async()=>{
  const f=fixture(), r=f.make(), trust=ephemeralPki().trust;try {
    await f.controller.activate();await f.pair();f.controller.deactivate();
    const cfg=f.host.storage.get(SETTINGS_KEY) as Record<string,unknown>;f.host.storage.set(SETTINGS_KEY,{...cfg,...trust});
    await r.activate();expect(r.view().status).toMatchObject({state:"re-pair-required",lastErrorCode:"CA_CHANGED",nextAttemptAt:null});expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(false);expect(f.center.runs).toHaveLength(0);
  } finally {f.controller.deactivate();r.deactivate();}
});
