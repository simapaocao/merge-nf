import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_BATCH, ACTIVITY_MAX_ITEMS, ACTIVITY_QUERY_ID, ACTIVITY_SNAPSHOT_ROUTE, LIMITS,
  activityHash, activityPublicationSchema, activityQueryInputSchema, activityQueryOutputSchema, activityReceiptSchema,
} from "@nf-hub/protocol";
import { collectActivity, activityHostError } from "../src/activity";
import { ConnectorError } from "../src/errors";
import { HostRpcError } from "../src/host-rpc";
import { FakeHost } from "./fixtures";

const item = (id: string, patch: Record<string, unknown> = {}) => ({ id, reply: false, approval: false, error: false, unread: false, backgroundWorkCount: 0, ...patch });
const hostRow = (id: string, patch: Record<string, unknown> = {}) => ({ id, attention: { reply: false, approval: false, error: false, unread: false }, backgroundWorkCount: 0, ...patch });
const activityPage = (items: unknown[], observedAt = 1_730_000_000_000) => ({ status: "succeeded", data: { items, observedAt }, page: { hasMore: false } });
const hostError = (hostCode: string) => new HostRpcError("queries.execute", { code: -32000, message: "x", data: { code: hostCode } });

describe("activity contract", () => {
  test("fixed route and query id, batch cap matches the documented 1..100 window", () => {
    expect(ACTIVITY_SNAPSHOT_ROUTE).toBe("/api/connector/activity");
    expect(ACTIVITY_QUERY_ID).toBe("narrafork.narrators.activity");
    expect(ACTIVITY_BATCH).toBe(100);
    expect(activityQueryInputSchema.safeParse({ narratorIds: Array.from({ length: 100 }, (_, i) => `s${i}`) }).success).toBe(true);
    expect(activityQueryInputSchema.safeParse({ narratorIds: Array.from({ length: 101 }, (_, i) => `s${i}`) }).success).toBe(false);
    expect(activityQueryInputSchema.safeParse({ narratorIds: [] }).success).toBe(false);
    expect(activityQueryInputSchema.safeParse({ narratorIds: ["a", "a"] }).success).toBe(false);
    expect(activityQueryInputSchema.safeParse({ narratorIds: ["a"], extra: 1 }).success).toBe(false);
  });
  test("host output is projected but its documented fields stay strict", () => {
    // Unknown host keys are tolerated so a richer host build cannot break the projection.
    expect(activityQueryOutputSchema.safeParse({ items: [hostRow("a", { substatus: "PRIVATE", body: "PRIVATE" })], observedAt: 1 }).success).toBe(true);
    // Missing or mistyped documented fields are not tolerated.
    expect(activityQueryOutputSchema.safeParse({ items: [{ id: "a", attention: { reply: true, approval: true, error: true }, backgroundWorkCount: 0 }], observedAt: 1 }).success).toBe(false);
    expect(activityQueryOutputSchema.safeParse({ items: [hostRow("a", { backgroundWorkCount: -1 })], observedAt: 1 }).success).toBe(false);
    expect(activityQueryOutputSchema.safeParse({ items: [hostRow("a"), hostRow("a")], observedAt: 1 }).success).toBe(false);
    expect(activityQueryOutputSchema.safeParse({ items: [hostRow("a")], observedAt: -1 }).success).toBe(false);
  });
  test("publication is a discriminated union: unavailable carries no payload, available is self-consistent", () => {
    const base = { protocolVersion: 1 as const, generation: 2, runId: 7, baseHash: "a".repeat(64) };
    expect(activityPublicationSchema.safeParse({ ...base, available: false }).success).toBe(true);
    // A "false" publication must not smuggle items, count or a hash.
    expect(activityPublicationSchema.safeParse({ ...base, available: false, count: 0 }).success).toBe(false);
    expect(activityPublicationSchema.safeParse({ ...base, available: false, items: [] }).success).toBe(false);
    expect(activityPublicationSchema.safeParse({ ...base, available: true, count: 1, hash: "b".repeat(64), items: [item("a")] }).success).toBe(true);
    // count/items disagreement and duplicate IDs are rejected rather than published.
    expect(activityPublicationSchema.safeParse({ ...base, available: true, count: 2, hash: "b".repeat(64), items: [item("a")] }).success).toBe(false);
    expect(activityPublicationSchema.safeParse({ ...base, available: true, count: 2, hash: "b".repeat(64), items: [item("a"), item("a")] }).success).toBe(false);
    // Unknown fields (a message body, a request ID, an approval text) are refused outright.
    expect(activityPublicationSchema.safeParse({ ...base, available: true, count: 1, hash: "b".repeat(64), items: [{ ...item("a"), body: "PRIVATE" }] }).success).toBe(false);
    expect(activityPublicationSchema.safeParse({ ...base, available: true, count: 1, hash: "b".repeat(64), items: [{ ...item("a"), requestId: "PRIVATE" }] }).success).toBe(false);
    expect(activityPublicationSchema.safeParse({ ...base, available: true, count: 0, hash: "b".repeat(64), items: Array.from({ length: ACTIVITY_MAX_ITEMS + 1 }, (_, i) => item(`s${i}`)) }).success).toBe(false);
  });
  test("receipt is strict and the hash is canonical and id-sorted", async () => {
    expect(activityReceiptSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(activityReceiptSchema.safeParse({ accepted: true, extra: 1 }).success).toBe(false);
    expect(activityReceiptSchema.safeParse({ accepted: false }).success).toBe(false);
    const a = item("a", { reply: true, backgroundWorkCount: 3 }), b = item("b", { unread: true });
    // Order-independent: the canonical form sorts by ID before hashing.
    expect(await activityHash([a, b])).toBe(await activityHash([b, a]));
    expect(await activityHash([b, a])).toMatch(/^[0-9a-f]{64}$/);
    // Every tuple position participates, so a change in any flag or count changes the digest.
    expect(await activityHash([{ ...a, approval: true }])).not.toBe(await activityHash([a]));
    expect(await activityHash([{ ...a, backgroundWorkCount: 4 }])).not.toBe(await activityHash([a]));
    expect(await activityHash([])).toBe(await activityHash([]));
    // Illegal sets are refused instead of hashed silently.
    await expect(activityHash([a, { ...a }])).rejects.toBeDefined();
    await expect(activityHash([{ ...a, body: "PRIVATE" } as never])).rejects.toBeDefined();
  });
});

describe("host activity collection", () => {
  test("asks only for the published base ids and never reads another query", async () => {
    const host = new FakeHost(); const calls: { queryId: string; input: Record<string, unknown> }[] = [];
    host.list = (queryId, input) => { calls.push({ queryId, input }); return activityPage([hostRow("a"), hostRow("b")]); };
    const result = await collectActivity(host, ["b", "a"]);
    expect(calls.map(call => call.queryId)).toEqual([ACTIVITY_QUERY_ID]);
    expect(calls[0]!.input).toEqual({ narratorIds: ["b", "a"] });
    expect(result.items.map(row => row.id)).toEqual(["a", "b"]);
    expect(host.ids).toEqual([ACTIVITY_QUERY_ID]);
  });
  test("projects only whitelisted fields: no substatus, body, title or request id leaves the host", async () => {
    const host = new FakeHost();
    host.list = () => activityPage([hostRow("a", { substatus: "PRIVATE", body: "PRIVATE", title: "PRIVATE", requestId: "PRIVATE", attention: { reply: true, approval: true, error: true, unread: true, permission: "PRIVATE" }, backgroundWorkCount: 2 })]);
    const result = await collectActivity(host, ["a"]);
    expect(result.items).toEqual([{ id: "a", reply: true, approval: true, error: true, unread: true, backgroundWorkCount: 2 }]);
    expect(Object.keys(result.items[0]!).sort()).toEqual(["approval", "backgroundWorkCount", "error", "id", "reply", "unread"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  test("an omitted id is reported as unknown coverage, never a padded all-false row", async () => {
    const short = new FakeHost(); short.list = () => activityPage([hostRow("a")]);
    const partial = await collectActivity(short, ["a", "b"]);
    // The host omits unknown/unreadable/out-of-scope IDs; they are surfaced as unknown so the caller can withhold
    // the publication instead of inventing `reply:false` for them.
    expect(partial.items.map(row => row.id)).toEqual(["a"]);
    expect(partial.unknownIds).toEqual(["b"]);
    expect(JSON.stringify(partial.items)).not.toContain('"b"');
    const none = new FakeHost(); none.list = () => activityPage([]);
    const empty = await collectActivity(none, ["a", "b"]);
    expect(empty.items).toEqual([]); expect(empty.unknownIds).toEqual(["a", "b"]);
    // An answer about an ID that was never asked for cannot be attributed to this publication.
    const extra = new FakeHost(); extra.list = () => activityPage([hostRow("a"), hostRow("outside")]);
    await expect(collectActivity(extra, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_INCOMPLETE" });
    const duplicated = new FakeHost(); duplicated.list = () => activityPage([hostRow("a"), hostRow("a")]);
    await expect(collectActivity(duplicated, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_QUERY_FAILED" });
    const failed = new FakeHost(); failed.list = () => ({ status: "failed", raw: "PRIVATE" });
    await expect(collectActivity(failed, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_QUERY_FAILED" });
  });
  test("empty base scope asks nothing and implies nothing", async () => {
    const host = new FakeHost(); const result = await collectActivity(host, []);
    expect(result.items).toEqual([]); expect(result.unknownIds).toEqual([]); expect(host.ids).toEqual([]);
  });
  test("batches above 100 ids without widening the request shape", async () => {
    const host = new FakeHost(); const inputs: Record<string, unknown>[] = [];
    host.list = (_q, input) => { inputs.push(input); return activityPage((input.narratorIds as string[]).map(id => hostRow(id))); };
    const ids = Array.from({ length: ACTIVITY_BATCH + 5 }, (_, i) => `s${String(i).padStart(4, "0")}`);
    const result = await collectActivity(host, ids);
    expect(inputs.map(input => (input.narratorIds as string[]).length)).toEqual([ACTIVITY_BATCH, 5]);
    expect(result.items).toHaveLength(ids.length);
    expect(result.unknownIds).toEqual([]);
    expect(result.items.map(row => row.id)).toEqual([...ids].sort());
    const tooMany = Array.from({ length: LIMITS.summaries + 1 }, (_, i) => `s${i}`);
    await expect(collectActivity(new FakeHost(), tooMany)).rejects.toMatchObject({ code: "ACTIVITY_LIMIT_EXCEEDED" });
  });
  test("only METHOD_NOT_FOUND means an old host; every confirmed real code stays retryable or denied", async () => {
    const unsupported = new FakeHost(); unsupported.list = () => { throw hostError("METHOD_NOT_FOUND"); };
    await expect(collectActivity(unsupported, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_UNSUPPORTED" });
    const denied = new FakeHost(); denied.list = () => { throw hostError("PERMISSION_DENIED"); };
    await expect(collectActivity(denied, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_PERMISSION_DENIED" });
    // A project conflicting with the trusted scope is a denial, not an absence of signals.
    const outOfScope = new FakeHost(); outOfScope.list = () => { throw hostError("NOT_FOUND_OR_DENIED"); };
    await expect(collectActivity(outOfScope, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_PERMISSION_DENIED" });
    // Real host failures are retryable and must never be cached as "unsupported": that would hide later signals.
    for (const code of ["HOST_UNAVAILABLE", "INVALID_PARAMS", "INTERNAL_ERROR", "TIMEOUT", "CONTEXT_UNAVAILABLE"]) {
      const host = new FakeHost(); host.list = () => { throw hostError(code); };
      await expect(collectActivity(host, ["a"])).rejects.toMatchObject({ code: "ACTIVITY_QUERY_FAILED" });
      expect(activityHostError(hostError(code)).code).toBe("ACTIVITY_QUERY_FAILED");
    }
    expect(activityHostError(hostError("METHOD_NOT_FOUND")).code).toBe("ACTIVITY_UNSUPPORTED");
    expect(activityHostError(hostError("NOT_FOUND_OR_DENIED")).code).toBe("ACTIVITY_PERMISSION_DENIED");
    expect(activityHostError(new ConnectorError("RPC_TIMEOUT")).code).toBe("ACTIVITY_TIMEOUT");
    expect(activityHostError(new ConnectorError("RPC_DENIED")).code).toBe("ACTIVITY_PERMISSION_DENIED");
    expect(activityHostError(new ConnectorError("CANCELLED")).code).toBe("CANCELLED");
    expect(activityHostError(new Error("PRIVATE")).code).toBe("ACTIVITY_QUERY_FAILED");
  });
  test("the 15s monotonic budget fails closed and does not fall back to empty data", async () => {
    const host = new FakeHost(); let clock = 0;
    host.list = () => { clock += 16_000; return activityPage([hostRow("a")]); };
    await expect(collectActivity(host, ["a"], { now: () => clock })).rejects.toMatchObject({ code: "ACTIVITY_TIMEOUT" });
    // A cancelled signal stops the side channel without producing a publication.
    const aborted = new AbortController(); aborted.abort();
    await expect(collectActivity(new FakeHost(), ["a"], { signal: aborted.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });
  test("the request is a single-shot query, never a paginated scan of host data", async () => {
    const host = new FakeHost(); const inputs: Record<string, unknown>[] = [];
    // No cursor is offered, and none would be sent: the activity read is not a page walk.
    host.list = (_query, input) => { inputs.push(input); return activityPage([hostRow("a")]); };
    await collectActivity(host, ["a"]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("cursor");
    expect(inputs[0]).not.toHaveProperty("limit");
  });
});
