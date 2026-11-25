import { describe, expect, test } from "bun:test";
import {
  SESSION_METADATA_ROUTE, SESSION_RELATIONSHIPS_QUERY_ID, activityHash, sessionMetadataHash,
  sessionMetadataItemSchema, sessionMetadataPublicationSchema, sessionMetadataReceiptSchema,
  sessionRelationshipsInputSchema, snapshotHash, type ActivityPublication, type SessionMetadataItem, type SessionMetadataPublication,
} from "@nf-hub/protocol";
import { collectSessionRelationships, collectSummaries } from "../src/collection";
import { bindingKey, type BoundCredential } from "../src/config";
import { ConnectorError } from "../src/errors";
import { HostRpcError } from "../src/host-rpc";
import { CenterClient } from "../src/transport";
import { STATUS_KEY } from "../src/constants";
import { BASE, NOW, PAIR, TOKEN, FakeCenter, FakeHost, deferred, draft, fixture, page, row } from "./fixtures";

const all = { mode: "all" as const, includeArchived: false, acknowledgeHidden: true as const };
const item = (id: string, kind: SessionMetadataItem["kind"] = null): SessionMetadataItem => ({ id, kind, parentKnown: false, parentId: null });
const relation = (id: string, parentKnown: boolean, parentId: string | null) => ({ id, parentKnown, parentId });
const reply = (items: unknown[]) => ({ status: "succeeded", data: { items, observedAt: NOW } });
class MetadataCenter extends FakeCenter {
  publications: SessionMetadataPublication[] = [];
  activities: ActivityPublication[] = [];
  metadataError: ConnectorError | null = null;
  async sessionMetadata(_credential: BoundCredential, publication: SessionMetadataPublication) {
    this.publications.push(publication);
    if (this.metadataError) throw this.metadataError;
    return { accepted: true as const };
  }
  async activity(_credential: BoundCredential, publication: ActivityPublication) {
    this.activities.push(publication); return { accepted: true as const };
  }
}
function setup(center = new MetadataCenter()) {
  const f = fixture({ center: () => center });
  return { ...f, center };
}
/** Resolve on the final status write rather than using sleeps to order base and side-channel requests. */
function completed(host: FakeHost, center: FakeCenter, count: number): Promise<void> {
  const done = deferred<void>(), request = host.request;
  host.request = async (method, params, options) => {
    const result = await request.call(host, method, params, options);
    const p = params as { key?: unknown; value?: { state?: unknown; nextAttemptAt?: unknown } } | undefined;
    if (method === "storage.set" && p?.key === STATUS_KEY && p.value?.state === "ready" && typeof p.value.nextAttemptAt === "number" && center.snapshots.length >= count) done.resolve();
    return result;
  };
  return done.promise.finally(() => { host.request = request; });
}

describe("session type and direct-parent metadata", () => {
  test("strict four-field contract, explicit unknown and canonical hash leave the old base hash unchanged", async () => {
    const base = { protocolVersion: 1 as const, generation: 2, runId: 1, baseHash: "a".repeat(64) };
    const a = item("a", "primary"), b = { ...item("b", "subagent"), parentKnown: true, parentId: "a" };
    expect(sessionMetadataItemSchema.safeParse({ ...a, parentKnown: false, parentId: "b" }).success).toBe(false);
    expect(sessionMetadataItemSchema.safeParse({ ...a, parentKnown: true, parentId: "a" }).success).toBe(false);
    expect(sessionMetadataItemSchema.safeParse({ ...a, parentTitle: "PRIVATE" }).success).toBe(false);
    expect(sessionMetadataItemSchema.safeParse({ id: "a", kind: "primary" }).success).toBe(false);
    expect(sessionMetadataPublicationSchema.safeParse({ ...base, available: true, count: 2, hash: "b".repeat(64), items: [a, b] }).success).toBe(true);
    expect(sessionMetadataPublicationSchema.safeParse({ ...base, available: true, count: 1, hash: "b".repeat(64), items: [a, b] }).success).toBe(false);
    expect(sessionMetadataPublicationSchema.safeParse({ ...base, available: false, items: [] }).success).toBe(false);
    expect(sessionMetadataReceiptSchema.safeParse({ accepted: true, kind: "primary" }).success).toBe(false);
    expect(sessionRelationshipsInputSchema.safeParse({ narratorIds: ["a", "a"] }).success).toBe(false);
    await expect(sessionMetadataHash([a, a])).rejects.toBeDefined();
    expect(await sessionMetadataHash([a, b])).toBe(await sessionMetadataHash([b, a]));
    expect(await sessionMetadataHash([a])).not.toBe(await sessionMetadataHash([{ ...a, kind: "subagent" }]));
    expect(await sessionMetadataHash([a])).not.toBe(await sessionMetadataHash([{ ...a, parentKnown: true }]));
    const host = new FakeHost(); host.list = () => page([row("a", { type: "primary" })]);
    const before = await collectSummaries(host, all);
    host.list = () => page([row("a", { type: "subagent", parentNarratorId: "PRIVATE" })]);
    const after = await collectSummaries(host, all);
    expect(after.summaries).toEqual(before.summaries);
    expect(await snapshotHash(after.summaries)).toBe(await snapshotHash(before.summaries));
    expect(Object.keys(after.summaries[0]!).sort()).toEqual(["id", "lastMessageAt", "projectId", "status", "title", "updatedAt"]);
    expect(host.ids).toEqual(["narrafork.narrators.list", "narrafork.narrators.list"]);
  });

  test("one scoped list projects known types and null for missing/unknown types, without private fields", async () => {
    const host = new FakeHost();
    host.list = () => page([row("primary", { type: "primary", body: "PRIVATE", parentNarratorId: "PRIVATE" }), row("child", { type: "subagent" }), row("unknown", { type: "future" }), row("missing"), row("outside", { type: "primary" })]);
    const result = await collectSummaries(host, { mode: "sessions", sessionIds: ["primary", "child", "unknown", "missing"], includeArchived: false });
    expect(result.sessionMetadata).toEqual([item("child", "subagent"), item("missing"), item("primary", "primary"), item("unknown")]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("outside");
    expect(host.ids).toEqual(["narrafork.narrators.list"]);
  });

  test("relationships use 100-ID batches and the complete base ID set, including a parent in a later batch", async () => {
    const host = new FakeHost(), metadata = Array.from({ length: 102 }, (_, i) => item(`s${i}`, i === 0 ? "primary" : "subagent"));
    const batches: string[][] = [];
    host.list = (query, input) => {
      expect(query).toBe(SESSION_RELATIONSHIPS_QUERY_ID);
      expect(Object.keys(input)).toEqual(["narratorIds"]);
      const ids = input.narratorIds as string[]; batches.push(ids);
      return reply(ids.filter(id => id !== "s3").map(id => id === "s0" ? relation(id, true, "s101") : id === "s1" ? relation(id, true, "OUTSIDE_PRIVATE") : relation(id, true, null)));
    };
    const result = await collectSessionRelationships(host, metadata);
    expect(batches.map(ids => ids.length)).toEqual([100, 2]);
    expect(result.items[0]).toEqual({ id: "s0", kind: "primary", parentKnown: true, parentId: "s101" });
    expect(result.items[1]).toEqual(item("s1", "subagent"));
    expect(result.items[2]).toEqual({ ...item("s2", "subagent"), parentKnown: true });
    expect(result.items[3]).toEqual(item("s3", "subagent"));
    expect(JSON.stringify(result)).not.toContain("OUTSIDE_PRIVATE");
  });

  test("old host, denied/invalid/failed source, malformed parent and timeout keep kinds and make parents unknown", async () => {
    const metadata = [item("child", "subagent")];
    for (const code of ["METHOD_NOT_FOUND", "PERMISSION_DENIED", "NOT_FOUND_OR_DENIED", "HOST_UNAVAILABLE", "INVALID_PARAMS"]) {
      const host = new FakeHost(); host.list = () => { throw new HostRpcError("queries.execute", { code: -32000, message: "PRIVATE", data: { code } }); };
      const result = await collectSessionRelationships(host, metadata);
      expect(result.items).toEqual(metadata);
      expect(result.support).toBe(code === "METHOD_NOT_FOUND" ? "unsupported" : code === "PERMISSION_DENIED" || code === "NOT_FOUND_OR_DENIED" ? "denied" : "unknown");
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
    const host = new FakeHost(); host.list = () => reply([relation("child", true, "child")]);
    expect((await collectSessionRelationships(host, metadata)).items).toEqual(metadata);
    let now = 0; host.list = () => { now = 16_000; return reply([relation("child", true, null)]); };
    expect(await collectSessionRelationships(host, metadata, { now: () => now })).toMatchObject({ items: metadata, support: "unknown", errorCode: "RELATIONSHIPS_TIMEOUT" });
  });

  test("default channel publishes after base and sends a kind change on a new run with the same base hash", async () => {
    const f = setup(); let kind = "primary";
    f.host.list = query => {
      if (query === SESSION_RELATIONSHIPS_QUERY_ID) throw new HostRpcError("queries.execute", { code: -32601, message: "PRIVATE", data: { code: "METHOD_NOT_FOUND" } });
      return page([row("chosen", { type: kind })]);
    };
    try {
      await f.controller.activate(); const first = completed(f.host, f.center, 1); await f.pair(); await first;
      expect(f.controller.view().activityEnabled).toBe(false); expect(f.center.activities).toHaveLength(0);
      kind = "subagent";
      const second = completed(f.host, f.center, 2); await f.controller.pause(); await f.controller.resume(); await second;
      expect(f.center.publications).toHaveLength(2);
      const one = f.center.publications[0]!, two = f.center.publications[1]!;
      if (!one.available || !two.available) throw new Error("expected metadata");
      expect(one.baseHash).toBe(two.baseHash); expect(one.hash).not.toBe(two.hash);
      expect(two.runId).toBe(f.center.snapshots[1]!.runId); expect(two.runId).not.toBe(one.runId);
      expect(two.items).toEqual([{ id: "chosen", kind: "subagent", parentKnown: false, parentId: null }]);
      expect(f.host.ids.filter(query => query === SESSION_RELATIONSHIPS_QUERY_ID)).toHaveLength(1);
      expect(f.controller.view().sessionMetadata).toMatchObject({ support: "available", parentSupport: "unsupported", parentErrorCode: "RELATIONSHIPS_UNSUPPORTED" });
      expect(two.hash).toBe(await sessionMetadataHash(two.items));
      expect(f.center.snapshots[0]!.hash).toBe(f.center.snapshots[1]!.hash);
      expect(f.center.pairs[0]!.capabilities).toEqual(["summary.v1"]);
    } finally { f.controller.deactivate(); }
  });

  test("metadata 404/auth/HTTP failures never break base auth or suppress independently enabled activity", async () => {
    for (const code of ["SESSION_METADATA_UNSUPPORTED", "AUTH_REJECTED", "HTTP_FAILED"] as const) {
      const f = setup(); f.center.metadataError = new ConnectorError(code, code === "AUTH_REJECTED");
      f.host.list = (query, input) => query === SESSION_RELATIONSHIPS_QUERY_ID ? reply([relation("chosen", false, null)])
        : query === "narrafork.narrators.activity" ? reply((input.narratorIds as string[]).map(id => ({ id, attention: { reply: true, approval: false, error: false, unread: false }, backgroundWorkCount: 0 })))
        : page([row("chosen", { type: "subagent" })]);
      try {
        await f.controller.activate(); await f.controller.activity({ enabled: true });
        const first = completed(f.host, f.center, 1); await f.pair(); await first;
        expect(f.controller.view()).toMatchObject({ paired: true, settings: { requiresRevocation: false }, status: { state: "ready", lastSuccessAt: NOW, lastErrorCode: null }, sessionMetadata: { lastErrorCode: code } });
        expect(f.center.failures).toHaveLength(0); expect(f.center.activities).toHaveLength(1);
        const activity = f.center.activities[0]!;
        if (!activity.available) throw new Error("expected activity");
        expect(activity.hash).toBe(await activityHash(activity.items));
        if (code === "SESSION_METADATA_UNSUPPORTED") {
          const second = completed(f.host, f.center, 2); await f.controller.pause(); await f.controller.resume(); await second;
          expect(f.center.publications).toHaveLength(1); expect(f.center.activities).toHaveLength(2);
        }
      } finally { f.controller.deactivate(); }
    }
  });

  test("no metadata/query before base acceptance; pausing fences a late base receipt", async () => {
    const f = setup(), entered = deferred<void>(), receipt = deferred<void>(), snapshot = f.center.snapshot.bind(f.center);
    f.center.snapshot = async (credential, input) => { const result = await snapshot(credential, input); entered.resolve(); await receipt.promise; return result; };
    try {
      await f.controller.activate(); await f.pair(); await entered.promise;
      expect(f.center.publications).toHaveLength(0); expect(f.host.ids).not.toContain(SESSION_RELATIONSHIPS_QUERY_ID);
      await f.controller.pause(); receipt.resolve();
      expect(f.center.publications).toHaveLength(0); expect(f.controller.view().settings.paused).toBe(true);
    } finally { receipt.resolve(); f.controller.deactivate(); }
  });

  test("transport uses the fixed route, original Bearer and TLS policy, strict receipt and only route-specific 404 fallback", async () => {
    const credential: BoundCredential = { version: 1, baseUrl: BASE, centerCaSha256: null, scopeKey: bindingKey(draft()), projectNames: false, pairing: PAIR };
    const publication: SessionMetadataPublication = { protocolVersion: 1, generation: PAIR.generation, runId: 1, baseHash: "a".repeat(64), available: false };
    const client = new CenterClient(BASE, async (url, init) => {
      expect(url).toBe(BASE + SESSION_METADATA_ROUTE);
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", proxy: false, tls: { rejectUnauthorized: true } });
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(String(init.body))).toEqual(publication);
      return Response.json({ accepted: true });
    });
    expect(await client.sessionMetadata(credential, publication)).toEqual({ accepted: true });
    for (const [status, code] of [[404, "SESSION_METADATA_UNSUPPORTED"], [401, "AUTH_REJECTED"], [403, "AUTH_REJECTED"], [500, "HTTP_FAILED"]] as const) {
      await expect(new CenterClient(BASE, async () => new Response("PRIVATE", { status })).sessionMetadata(credential, publication)).rejects.toMatchObject({ code });
    }
    await expect(new CenterClient(BASE, async () => Response.json({ accepted: true, extra: "PRIVATE" })).sessionMetadata(credential, publication)).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });
});
