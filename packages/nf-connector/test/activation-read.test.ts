import { expect, test } from "bun:test";
import { HostRepository } from "../src/config";
import { CREDENTIAL_KEY } from "../src/constants";
import { HostRpcError, StdioHostRpc, type RpcMessage } from "../src/host-rpc";
import { FakeHost, draft, fixture, until } from "./fixtures";

test("0.9.14 unset secret is exactly {key, value:null}; malformed, wrong-key and denied reads are not absence", async () => {
  const host = new FakeHost(), repo = new HostRepository(host);
  expect(await repo.credential()).toBe(null);
  for (const result of [undefined, null, {}, {key:CREDENTIAL_KEY}, {key:"other",value:null}, {key:CREDENTIAL_KEY,value:3}]) {
    host.request=async()=>result; await expect(repo.credential()).rejects.toMatchObject({code:"SECRET_UNAVAILABLE"});
  }
  host.request=async()=>{throw new HostRpcError("secrets.get",{code:-32003,message:"DO_NOT_ECHO",data:{code:"PERMISSION_DENIED"}});};
  await expect(repo.credential()).rejects.toMatchObject({code:"RPC_DENIED"});
});

test("transient first activation never invents revocation or writes defaults; a fresh successful read allows first pairing",async()=>{
  const f=fixture(),request=f.host.request.bind(f.host); let first=true;
  f.host.request=async(m,p,o)=>{if(first&&m==="storage.get"){first=false;throw new HostRpcError(m,{code:-32603,message:"DO_NOT_ECHO",data:{code:"CONTEXT_UNAVAILABLE",details:{reason:"BINDING_MISSING"}}});}return request(m,p,o);};
  try {await f.controller.activate(); const v=f.controller.view();
    expect(v.status).toMatchObject({state:"host-unavailable",lastErrorCode:"HOST_UNAVAILABLE",hostReadError:{method:"storage.get",rpcCode:-32603,hostCode:"CONTEXT_UNAVAILABLE"}});
    expect(v.settings.requiresRevocation).toBe(false);expect(f.host.storage.size).toBe(0);expect(f.host.secrets.size).toBe(0);
    await until(()=>f.controller.view().status.state==="unconfigured");
    await f.pair();expect(f.center.pairs).toHaveLength(1);expect(f.controller.view().paired).toBe(true);
  }finally{f.controller.deactivate();}
});

test("unreadable existing credential blocks configure, pair, forget and resume without overwriting host state; explicit refresh restores it",async()=>{
  const f=fixture(),r=f.make(), request=f.host.request.bind(f.host);let deny=false;
  f.host.request=async(m,p,o)=>{if(deny&&m==="secrets.get")throw new HostRpcError(m,{code:-32003,message:"DO_NOT_ECHO",data:{code:"PERMISSION_DENIED",details:"DO_NOT_ECHO"}});return request(m,p,o);};
  try{await f.controller.activate();await f.pair();await f.controller.pause();f.controller.deactivate();
    const before=structuredClone([...f.host.storage]), secret=f.host.secrets.get(CREDENTIAL_KEY); deny=true;
    await r.activate();expect(r.view().status).toMatchObject({state:"host-unavailable",lastErrorCode:"RPC_DENIED"});
    await expect(r.configure(draft())).rejects.toMatchObject({code:"RPC_DENIED"});await expect(r.pair({centralRevocationAcknowledged:true})).rejects.toMatchObject({code:"RPC_DENIED"});
    await expect(r.forget()).rejects.toMatchObject({code:"RPC_DENIED"});await expect(r.resume()).rejects.toMatchObject({code:"RPC_DENIED"});
    expect([...f.host.storage]).toEqual(before);expect(f.host.secrets.get(CREDENTIAL_KEY)).toBe(secret);expect(f.center.pairs).toHaveLength(1);expect(JSON.stringify(r.view())).not.toContain("DO_NOT_ECHO");
    deny=false;const restored=await r.command("connector-status",{retryRead:true});expect(restored.paired).toBe(true);expect(restored.status.state).toBe("paused");
  }finally{f.controller.deactivate();r.deactivate();}
});

test("RPC reply diagnostics expose only allowlisted host error IDs, method and numeric code",async()=>{
  const sent:RpcMessage[]=[];const host=new StdioHostRpc(m=>sent.push(m));try{
    const p=host.request("storage.get",{secret:"DO_NOT_ECHO"});host.accept({jsonrpc:"2.0",id:sent[0]!.id!,error:{code:-32603,message:"DO_NOT_ECHO",data:{code:"DO_NOT_ECHO",details:{value:"DO_NOT_ECHO"}}}});
    await expect(p).rejects.toMatchObject({code:"HOST_UNAVAILABLE",diagnostic:{method:"storage.get",rpcCode:-32603,hostCode:"UNCLASSIFIED"}});
  }finally{host.close();}
});
