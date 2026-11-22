import { expect } from "bun:test";
import { type FailedRequest, type PairRequest, type PairResponse, type SnapshotRequest } from "@nf-hub/protocol";
import { ConnectorController, type ControllerOptions } from "../src/controller";
import { DEFAULT_SETTINGS, type BoundCredential } from "../src/config";
import { PAIRING_KEY } from "../src/constants";
import type { HostApi } from "../src/host-rpc";

export const NOW = 1_730_000_000_000, BASE = "https://hub.example.test/aggregate", CODE = "x".repeat(22), TOKEN = "t".repeat(43);
export const PAIR: PairResponse = { protocolVersion: 1, generation: 2, instanceId: "627cb634-8af6-4bc2-9d79-f1eb987cc80b", token: TOKEN };
export const SCOPE = { mode: "sessions", sessionIds: ["chosen"], includeArchived: false } as const;
export const row = (id: string, patch: Record<string, unknown> = {}) => ({ id, projectId: "p", status: "idle", title: "标题", updatedAt: "2024-10-27T03:33:20.000Z", lastMessageAt: null, ...patch });
export const page = (items: unknown[], nextCursor?: string) => ({status:"succeeded",data:{items},page:{hasMore:nextCursor !== undefined, ...(nextCursor === undefined ? {} : {nextCursor})}});
export class FakeHost implements HostApi {
  storage = new Map<string, unknown>(); secrets = new Map<string,string>(); ids: string[] = [];
  list: (queryId: string, input: Record<string,unknown>, signal?: AbortSignal) => unknown = query => query === "narrafork.projects.list" ? page([{id:"p", name:"项目"}]) : page([row("chosen"),row("unpublished")]);
  async request(method: string, params?: unknown, options: {signal?:AbortSignal;timeoutMs?:number} = {}): Promise<unknown> {
    const p = params as Record<string,unknown>; const key = String(p?.key);
    switch(method) {
      case "storage.get": return this.storage.has(key) ? {value:structuredClone(this.storage.get(key))} : null;
      case "storage.set": this.storage.set(key,structuredClone(p.value)); return {value:p.value};
      case "secrets.get": return {key,value:this.secrets.get(key) ?? null};
      case "secrets.set": this.secrets.set(key,String(p.value)); return {key,stored:true};
      case "secrets.delete": return {key, deleted:this.secrets.delete(key)};
      case "queries.execute": this.ids.push(String(p.queryId)); return this.list(String(p.queryId),p.input as Record<string,unknown>,options.signal);
      default: throw Error("unexpected_host_method");
    }
  }
}
export class FakeCenter {
  pairs: PairRequest[] = []; runs: number[] = []; snapshots: SnapshotRequest[] = []; failures: FailedRequest[] = []; nextRun = 0;
  async pair(input: PairRequest): Promise<PairResponse> { this.pairs.push(input); return PAIR; }
  async run(credential: BoundCredential) { this.runs.push(credential.pairing.generation); return {protocolVersion:1 as const,generation:credential.pairing.generation,runId:++this.nextRun,expiresAt:Date.now()+120_000}; }
  async snapshot(_credential: BoundCredential,input: SnapshotRequest) { this.snapshots.push(input); return {runId:input.runId,acceptedAt:NOW,duplicate:false}; }
  async failed(_credential: BoundCredential,input: FailedRequest) { this.failures.push(input); }
}
export const draft = () => ({ baseUrl:BASE,intervalMs:DEFAULT_SETTINGS.intervalMs,wantProjectNames:false,scope:{mode:"sessions" as const,includeArchived:false,sessionIds:["chosen"]},confirmed:true });
export function fixture(opts: ControllerOptions = {}) {
  const host = new FakeHost(), center = new FakeCenter(), destinations: string[] = [];
  const make = () => new ConnectorController(host, { random:() => 0.5, center:url => {destinations.push(url);return center;},...opts });
  const controller = make();
  async function pair(config: Record<string,unknown> = draft(), acknowledge = false) {
    const view = await controller.configure(config); host.secrets.set(PAIRING_KEY,JSON.stringify({code:CODE,binding:view.binding}));
    return controller.pair({centralRevocationAcknowledged:acknowledge});
  }
  return {host,center,destinations,make,controller,pair};
}
export async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now()+3000;
  while (!check() && performance.now()<deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}
export function deferred<T>() { let resolve!: (x:T) => void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; }
