import { describe, expect, test } from "bun:test";
import { routes } from "@nf-hub/protocol";
import manifest from "../manifest.json";
import { bindingKey, normalizeBaseUrl, type BoundCredential } from "../src/config";
import { HOST_PROTOCOL, PLUGIN_ID, PLUGIN_VERSION } from "../src/constants";
import { FrameDecoder, StdioHostRpc, encodeFrame, type RpcMessage } from "../src/host-rpc";
import { PluginRuntime } from "../src/runtime";
import { CenterClient, type Fetcher } from "../src/transport";
import { BASE, CODE, PAIR, TOKEN, draft } from "./fixtures";
const credential: BoundCredential = { version:1,baseUrl:BASE,centerCaSha256:null,scopeKey:bindingKey(draft()),projectNames:false,pairing:PAIR };
const request = {protocolVersion:1 as const,code:CODE,scope:draft().scope,confirmed:true as const,connectorVersion:PLUGIN_VERSION,capabilities:["summary.v1" as const]};

describe("stdio host boundary",()=>{
  test("UTF-8 frame boundaries and fragmented/multiple reads; reject duplicate sizes",()=>{
    const m:RpcMessage={jsonrpc:"2.0",id:1,result:"中文😀"}, b=encodeFrame(m), d=new FrameDecoder();expect(d.push(b.subarray(0,b.length-2))).toEqual([]);expect(d.push(Buffer.concat([b.subarray(b.length-2),b]))).toEqual([m,m]);expect(()=>new FrameDecoder().push(Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"))).toThrow("RPC_INVALID");
  });
  test("only two host list methods allowed, timeout and close remove pending requests",async()=>{
    const sent:RpcMessage[]=[];const h=new StdioHostRpc(m=>sent.push(m));await expect(h.request("queries.execute",{queryId:"not-a-list"})).rejects.toMatchObject({code:"RPC_DENIED"});await expect(h.request("commands.execute",{})).rejects.toMatchObject({code:"RPC_DENIED"}); expect(sent).toEqual([]);
    const slow=h.request("storage.get",{}, {timeoutMs:5});await expect(slow).rejects.toMatchObject({code:"RPC_TIMEOUT"});const pending=h.request("storage.get",{});h.close();await expect(pending).rejects.toMatchObject({code:"CANCELLED"});
  });
  test("real host handshake vocabulary; unknown runtime method cannot execute",async()=>{
    const sent:RpcMessage[]=[];const write=(m:RpcMessage)=>{sent.push(m);};const h=new StdioHostRpc(write), r=new PluginRuntime(h,write,()=>undefined);
    try{r.hello("a".repeat(64));const m=sent.pop()!;expect(m).toMatchObject({method:"hello",params:{pluginId:PLUGIN_ID,rpcProtocol:HOST_PROTOCOL}});await r.dispatch({jsonrpc:"2.0",id:1,method:"initialize",params:{pluginId:PLUGIN_ID,protocol:HOST_PROTOCOL,features:["host_api.requests"]}});expect(sent.pop()?.result).toEqual({initialized:true,protocol:HOST_PROTOCOL});await r.dispatch({jsonrpc:"2.0",id:2,method:"unknown",params:{private:"PRIVATE"}});expect(sent.pop()?.error?.code).toBe(-32601);}finally{r.close();}
  });
  test("manifest and entrypoints agree; no business write/OS privileges",()=>{
    expect(manifest.pluginId).toBe(PLUGIN_ID);expect(manifest.version).toBe(PLUGIN_VERSION); expect(manifest.server.transport).toBe("stdio");expect(manifest.ui.format).toBe("iife");expect(manifest.activationEvents).toContain("onStartup");expect([...manifest.permissions.host].sort()).toEqual(["query.read.narrators","query.read.projects","secret.use_self","storage.read_self","storage.write_self","ui.panel"]);expect(manifest.contributes.commands.every(c=>c.handler==="server")).toBe(true);
  });
});
describe("center transport",()=>{
  test("HTTPS only, canonical binding incl. path, reject credentials, redirect paths and ambiguous URL components",()=>{
    expect(normalizeBaseUrl("https://HUB.EXAMPLE.test:443/aggregate/")).toBe(BASE);for(const url of ["http://127.0.0.1:80","http://hub.test","https://name:pw@hub.test","https://hub.test?x=1","https://hub.test#x","https://hub.test/a%2Fb"])expect(()=>normalizeBaseUrl(url)).toThrow("CONFIG_INVALID");expect(normalizeBaseUrl("http://127.0.0.1:8090/",{allowLoopbackHttp:true})).toBe("http://127.0.0.1:8090");expect(()=>normalizeBaseUrl("http://example.test/",{allowLoopbackHttp:true})).toThrow("CONFIG_INVALID");
  });
  test("pair sends no token/cookies, report sends only bound bearer; redirects, proxy and TLS settings",async()=>{
    const sent:{url:string; init:Parameters<Fetcher>[1]}[]=[];
    const c=new CenterClient(BASE,async(url,init)=>{sent.push({url,init}); return Response.json(url.endsWith(routes.pair)?PAIR:{protocolVersion:1,generation:2,runId:5,expiresAt:100});});
    await c.pair(request);await c.run(credential);expect(sent.map(x=>x.url)).toEqual([BASE+routes.pair,BASE+routes.runs]);const [p,r]=sent;expect(p!.init).toMatchObject({method:"POST",credentials:"omit",redirect:"error",proxy:false,tls:{rejectUnauthorized:true}});expect(new Headers(p!.init.headers).has("authorization")).toBe(false);expect(new Headers(r!.init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);expect(Object.keys(JSON.parse(r!.init.body as string)).sort()).toEqual(["generation","protocolVersion"]);
    const wrong=new CenterClient("https://wrong.test",async()=>{throw Error("MUST NOT SEND");});await expect(wrong.run(credential)).rejects.toMatchObject({code:"BASE_URL_CHANGED",terminal:true});
  });
  test("extra JSON fields never become commands; 401/403 stop, malformed/oversize response does not leak bodies",async()=>{
    for(const status of [401,403]) {const c=new CenterClient(BASE,async()=>new Response("DO_NOT_LOG",{status}));await expect(c.run(credential)).rejects.toMatchObject({code:"AUTH_REJECTED",terminal:true});}
    for(const response of [Response.json({...PAIR,arbitraryCommand:"DO_NOT_LOG"}),new Response("X".repeat(70000),{headers:{"Content-Type":"application/json"}}),new Response("DO_NOT_LOG")]){const c=new CenterClient(BASE,async()=>response);await expect(c.pair(request)).rejects.toMatchObject({code:"RESPONSE_INVALID"});}
  });
  test("generation and receipt must match; failures require protocol 204",async()=>{
    const c=new CenterClient(BASE,async()=>Response.json({protocolVersion:1,generation:3,runId:5,expiresAt:100})); await expect(c.run(credential)).rejects.toMatchObject({code:"RESPONSE_INVALID"});await expect(c.failed(credential,{protocolVersion:1,generation:2,runId:5,errorCode:"QUERY_FAILED"})).rejects.toMatchObject({code:"RESPONSE_INVALID"});
  });
});
