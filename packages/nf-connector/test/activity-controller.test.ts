import { describe, expect, test } from "bun:test";
import { ACTIVITY_SNAPSHOT_ROUTE, activityHash, activityPublicationSchema, snapshotHash, type ActivityPublication } from "@nf-hub/protocol";
import { ConnectorController, type CenterLike, type ControllerOptions } from "../src/controller";
import { DEFAULT_ACTIVITY, parseActivityPreference } from "../src/config";
import { ACTIVITY_SETTINGS_KEY, CREDENTIAL_KEY, SETTINGS_KEY, STATUS_KEY } from "../src/constants";
import type { ActivityCollection } from "../src/activity";
import type { FakeHost } from "./fixtures";
import { ConnectorError } from "../src/errors";
import { HostRpcError } from "../src/host-rpc";
import { BASE, NOW, FakeCenter, deferred, draft, fixture, page, row, until } from "./fixtures";

const ACTIVITY = "narrafork.narrators.activity";
const activityRow = (id: string, patch: Record<string, unknown> = {}) => ({ id, attention: { reply: false, approval: false, error: false, unread: false }, backgroundWorkCount: 0, ...patch });
const activityPage = (items: unknown[]) => ({ status: "succeeded", data: { items, observedAt: NOW }, page: { hasMore: false } });
const answeredAll = (input: Record<string, unknown>) => activityPage((input.narratorIds as string[]).map(id => activityRow(id)));
/** Keep FakeCenter's prototype methods; the side channel augments, rather than replaces, the base client. */
class ActivityCenter extends FakeCenter {
  readonly published: ActivityPublication[] = [];
  constructor(private readonly reject?: ConnectorError) { super(); }
  async activity(_credential: unknown, input: ActivityPublication) {
    this.published.push(input);
    if (this.reject) throw this.reject;
    return { accepted: true as const };
  }
}
function activityCenter(overrides: { reject?: ConnectorError } = {}) { return new ActivityCenter(overrides.reject); }
/** A legacy center still implements the base protocol; only the new route is missing. */
class LegacyActivityCenter extends FakeCenter {
  readonly calls: string[] = [];
  async activity(): Promise<{ accepted: true }> {
    this.calls.push(ACTIVITY_SNAPSHOT_ROUTE);
    throw new ConnectorError("ACTIVITY_UNSUPPORTED");
  }
}
function legacyCenter() { return new LegacyActivityCenter(); }
function activityFixture<T extends FakeCenter & CenterLike>(center: T, options: Omit<ControllerOptions, "center"> = {}) {
  const f = fixture({ ...options, center: () => center });
  // Assertions observe the same instance used by the controller, not fixture()'s unused default center.
  return { ...f, center };
}
/** Observe the final persisted base status, without polling or sleeping through a controlled race. */
function roundFinished(host: FakeHost, center: FakeCenter, number: number): Promise<void> {
  const done = deferred<void>(), previous = host.request;
  host.request = async (method, params, options) => {
    const result = await previous.call(host, method, params, options);
    const p = params as { key?: unknown; value?: { state?: unknown; nextAttemptAt?: unknown } } | undefined;
    if (method === "storage.set" && p?.key === STATUS_KEY && p.value?.state === "ready" && typeof p.value.nextAttemptAt === "number" && center.snapshots.length >= number) done.resolve();
    return result;
  };
  return done.promise.finally(() => { host.request = previous; });
}
const collected = (reply = false): ActivityCollection => ({
  items: [{ id: "chosen", reply, approval: !reply, error: false, unread: false, backgroundWorkCount: 0 }], unknownIds: [], observedAt: NOW,
});
/** The round is fully finished (a next attempt was scheduled and the task slot is free). */
async function idle(controller: ConnectorController): Promise<void> {
  await until(() => controller.view().status.nextAttemptAt !== null);
  await Bun.sleep(15);
}
/** Start a fresh round without racing the previous one's task slot. */
async function resync(controller: ConnectorController): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { controller.sync(); return; } catch { await Bun.sleep(5); }
  }
  throw new Error("sync remained busy");
}

describe("activity opt-in preference", () => {
  test("defaults to off and is stored outside the binding", async () => {
    expect(DEFAULT_ACTIVITY).toEqual({ version: 1, enabled: false, needsClear: false });
    expect(parseActivityPreference(null)).toEqual(DEFAULT_ACTIVITY);
    expect(() => parseActivityPreference({ version: 1, enabled: true })).toThrow("CONFIG_INVALID");
    expect(() => parseActivityPreference({ version: 1, enabled: true, needsClear: false, extra: 1 })).toThrow("CONFIG_INVALID");
    const f = fixture(); try {
      await f.controller.activate();
      const paired = await f.pair();
      const before = paired.binding;
      const enabled = await f.controller.activity({ enabled: true });
      expect(enabled.activityEnabled).toBe(true);
      // The binding digest is the pairing/consent identity: toggling activity must not invalidate the credential.
      expect(enabled.binding).toBe(before); expect(enabled.settings.requiresRevocation).toBe(false); expect(enabled.paired).toBe(true);
      // The preference lives under its own key; the settings document stays byte-compatible with older builds.
      const saved = f.host.storage.get(SETTINGS_KEY) as Record<string, unknown>;
      expect(JSON.stringify(saved)).not.toContain("enabled");
      expect(f.host.storage.get(ACTIVITY_SETTINGS_KEY)).toEqual({ version: 1, enabled: true, needsClear: false });
    } finally { f.controller.deactivate(); }
  });
  test("rejects a malformed toggle instead of silently keeping the old value", async () => {
    const f = fixture(); try {
      await f.controller.activate();
      await expect(f.controller.activity({ enabled: "yes" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(f.controller.activity({ enabled: true, extra: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(f.controller.view().activityEnabled).toBe(false);
    } finally { f.controller.deactivate(); }
  });
});

describe("activity consent and storage races", () => {
  test("closing aborts only activity collection and discards a late source reply", async () => {
    const entered = deferred<AbortSignal>(), source = deferred<ActivityCollection>(), center = activityCenter();
    const f = activityFixture(center, { collectActivity: async (_host, _ids, options) => {
      if (!options?.signal) throw new Error("missing activity signal");
      entered.resolve(options.signal);
      return source.promise; // Deliberately ignore abort to exercise the post-await ticket barrier.
    } });
    try {
      await f.controller.activate(); await f.controller.activity({ enabled: true });
      const completed = roundFinished(f.host, center, 1); await f.pair();
      const signal = await entered.promise, credential = f.host.secrets.get(CREDENTIAL_KEY), binding = f.controller.view().binding;
      const closing = f.controller.activity({ enabled: false });
      expect(signal.aborted).toBe(true);
      await closing;
      source.resolve(collected(true)); await completed;
      expect(center.snapshots).toHaveLength(1); expect(center.failures).toHaveLength(0);
      expect(center.published).toHaveLength(0);
      expect(f.controller.view()).toMatchObject({ activityEnabled: false, activityNeedsClear: false, activityPreferenceSaved: true, binding, paired: true });
      expect(f.controller.view().status).toMatchObject({ state: "ready", lastSuccessAt: NOW, lastErrorCode: null });
      expect(f.host.secrets.get(CREDENTIAL_KEY)).toBe(credential);
    } finally { source.resolve(collected(true)); f.controller.deactivate(); }
  });

  test("close then reopen cannot reuse a collection from the previous ticket", async () => {
    const entered = deferred<AbortSignal>(), oldSource = deferred<ActivityCollection>(), center = activityCenter();
    let collections = 0;
    const f = activityFixture(center, { collectActivity: async (_host, _ids, options) => {
      if (++collections === 1) {
        if (!options?.signal) throw new Error("missing activity signal");
        entered.resolve(options.signal); return oldSource.promise;
      }
      return collected(false);
    } });
    try {
      await f.controller.activate(); await f.controller.activity({ enabled: true });
      const first = roundFinished(f.host, center, 1); await f.pair();
      const oldSignal = await entered.promise;
      await f.controller.activity({ enabled: false }); await f.controller.activity({ enabled: true });
      expect(oldSignal.aborted).toBe(true);
      oldSource.resolve(collected(true)); await first;
      expect(center.published).toHaveLength(0);
      const second = roundFinished(f.host, center, 2);
      await f.controller.pause(); await f.controller.resume(); await second;
      expect(collections).toBe(2); expect(center.published).toHaveLength(1);
      const publication = center.published[0]!;
      if (!publication.available) throw new Error("expected fresh activity");
      expect(publication.runId).toBe(center.snapshots[1]!.runId);
      expect(publication.items[0]).toMatchObject({ reply: false, approval: true });
    } finally { oldSource.resolve(collected(true)); f.controller.deactivate(); }
  });

  test("closing while the first true is in flight preserves a clear until a later run accepts false", async () => {
    const center = activityCenter(), trueEntered = deferred<void>(), trueReceipt = deferred<void>();
    const clearEntered = deferred<ActivityPublication>(), clearReceipt = deferred<void>();
    const send = center.activity.bind(center);
    center.activity = async (credential, publication) => {
      const receipt = await send(credential, publication);
      if (publication.available) { trueEntered.resolve(); await trueReceipt.promise; }
      else { clearEntered.resolve(publication); await clearReceipt.promise; }
      return receipt;
    };
    const f = activityFixture(center, { collectActivity: async () => collected() });
    try {
      await f.controller.activate(); await f.controller.activity({ enabled: true });
      const first = roundFinished(f.host, center, 1); await f.pair(); await trueEntered.promise;
      expect(f.controller.view().activity.lastPublishedAt).toBe(null);
      const off = await f.controller.activity({ enabled: false });
      expect(off.activityNeedsClear).toBe(true);
      expect(f.host.storage.get(ACTIVITY_SETTINGS_KEY)).toEqual({ version: 1, enabled: false, needsClear: true });
      trueReceipt.resolve(); await first;
      expect(f.controller.view().activityNeedsClear).toBe(true);
      expect(center.published).toHaveLength(1); // No same-run attempt to retract an already-sent true.
      const second = roundFinished(f.host, center, 2);
      await f.controller.pause(); await f.controller.resume();
      const clear = await clearEntered.promise;
      expect(clear.available).toBe(false);
      expect(clear.runId).toBe(center.snapshots[1]!.runId);
      expect(clear.runId).not.toBe(center.published[0]!.runId);
      expect(clear.baseHash).toBe(center.snapshots[1]!.hash);
      expect(f.controller.view().activityNeedsClear).toBe(true);
      clearReceipt.resolve(); await second;
      expect(f.controller.view()).toMatchObject({ activityEnabled: false, activityNeedsClear: false, activityPreferenceSaved: true });
      const third = roundFinished(f.host, center, 3);
      await f.controller.pause(); await f.controller.resume(); await third;
      expect(center.published).toHaveLength(2);
      expect(center.published.map(publication => publication.available)).toEqual([true, false]);
    } finally { trueReceipt.resolve(); clearReceipt.resolve(); f.controller.deactivate(); }
  });

  test("reopening before a late true receipt keeps the clear owed and collects again only afterwards", async () => {
    const center = activityCenter(), sent = deferred<void>(), accept = deferred<void>();
    const send = center.activity.bind(center);
    center.activity = async (credential, publication) => {
      const receipt = await send(credential, publication);
      if (publication.available && center.published.length === 1) { sent.resolve(); await accept.promise; }
      return receipt;
    };
    let collections = 0;
    const f = activityFixture(center, { collectActivity: async () => { collections++; return collected(); } });
    try {
      await f.controller.activate(); await f.controller.activity({ enabled: true });
      const first = roundFinished(f.host, center, 1); await f.pair(); await sent.promise;
      await f.controller.activity({ enabled: false });
      const on = await f.controller.activity({ enabled: true });
      expect(on.activityNeedsClear).toBe(true);
      accept.resolve(); await first;
      const second = roundFinished(f.host, center, 2);
      await f.controller.pause(); await f.controller.resume(); await second;
      expect(center.published.map(publication => publication.available)).toEqual([true, false]);
      expect(f.controller.view()).toMatchObject({ activityEnabled: true, activityNeedsClear: false });
      const third = roundFinished(f.host, center, 3);
      await f.controller.pause(); await f.controller.resume(); await third;
      expect(collections).toBe(2);
      expect(center.published.map(publication => publication.available)).toEqual([true, false, true]);
      expect(center.published[2]!.runId).toBe(center.snapshots[2]!.runId);
    } finally { accept.resolve(); f.controller.deactivate(); }
  });

  test("a preference read failure leaves the existing base credential and publisher healthy", async () => {
    const center = activityCenter(), f = activityFixture(center); let restarted: ConnectorController | undefined;
    try {
      await f.controller.activate();
      const first = roundFinished(f.host, center, 1); await f.pair(); await first;
      await f.controller.activity({ enabled: true }); f.controller.deactivate();
      const credential = f.host.secrets.get(CREDENTIAL_KEY), settings = structuredClone(f.host.storage.get(SETTINGS_KEY));
      const request = f.host.request;
      f.host.request = async (method, params, options) => {
        if (method === "storage.get" && (params as { key?: unknown })?.key === ACTIVITY_SETTINGS_KEY) throw new ConnectorError("RPC_DENIED");
        return request.call(f.host, method, params, options);
      };
      restarted = f.make(); const second = roundFinished(f.host, center, 2); await restarted.activate();
      expect(restarted.view()).toMatchObject({ paired: true, activityEnabled: false, activityPreferenceSaved: false });
      expect(restarted.view().status).toMatchObject({ state: "ready", lastErrorCode: null, activity: { support: "unknown", lastErrorCode: "ACTIVITY_PREFERENCE_READ_FAILED" } });
      await second;
      expect(center.snapshots).toHaveLength(2); expect(center.published).toHaveLength(0);
      expect(f.host.ids).not.toContain(ACTIVITY);
      expect(f.host.secrets.get(CREDENTIAL_KEY)).toBe(credential);
      expect(f.host.storage.get(SETTINGS_KEY)).toEqual(settings);
      expect(restarted.view().settings.requiresRevocation).toBe(false);
      expect(restarted.view().status.lastErrorCode).toBe(null);
    } finally { f.controller.deactivate(); restarted?.deactivate(); }
  });

  test("a rejected disable is not displayed as durable and never damages base auth", async () => {
    const center = activityCenter(), f = activityFixture(center, { collectActivity: async () => collected() });
    try {
      await f.controller.activate(); await f.controller.activity({ enabled: true });
      const first = roundFinished(f.host, center, 1); await f.pair(); await first;
      const credential = f.host.secrets.get(CREDENTIAL_KEY), before = f.controller.view().binding;
      const request = f.host.request;
      f.host.request = async (method, params, options) => {
        if (method === "storage.set" && (params as { key?: unknown })?.key === ACTIVITY_SETTINGS_KEY) throw new ConnectorError("RPC_DENIED");
        return request.call(f.host, method, params, options);
      };
      await expect(f.controller.activity({ enabled: false })).rejects.toMatchObject({ code: "ACTIVITY_PREFERENCE_WRITE_FAILED" });
      expect(f.controller.view()).toMatchObject({ paired: true, binding: before, activityEnabled: false, activityNeedsClear: true, activityPreferenceSaved: false });
      expect(f.controller.view().status).toMatchObject({ state: "ready", lastErrorCode: null, activity: { support: "unknown", lastErrorCode: "ACTIVITY_PREFERENCE_WRITE_FAILED" } });
      // The stored value really is still enabled; the UI must explicitly say that the disable was not saved.
      expect(f.host.storage.get(ACTIVITY_SETTINGS_KEY)).toEqual({ version: 1, enabled: true, needsClear: false });
      const second = roundFinished(f.host, center, 2);
      await f.controller.pause(); await f.controller.resume(); await second;
      expect(center.snapshots).toHaveLength(2); expect(center.published).toHaveLength(1);
      expect(f.host.secrets.get(CREDENTIAL_KEY)).toBe(credential);
      expect(f.controller.view().settings.requiresRevocation).toBe(false);
      f.host.request = request;
      const saved = await f.controller.activity({ enabled: false });
      expect(saved.activityPreferenceSaved).toBe(true); expect(saved.activityNeedsClear).toBe(true);
    } finally { f.controller.deactivate(); }
  });

  test("a rejected enable remains off and its separate error survives a base success", async () => {
    const center = activityCenter(), f = activityFixture(center);
    try {
      await f.controller.activate();
      const request = f.host.request;
      f.host.request = async (method, params, options) => {
        if (method === "storage.set" && (params as { key?: unknown })?.key === ACTIVITY_SETTINGS_KEY) throw new ConnectorError("RPC_DENIED");
        return request.call(f.host, method, params, options);
      };
      await expect(f.controller.activity({ enabled: true })).rejects.toMatchObject({ code: "ACTIVITY_PREFERENCE_WRITE_FAILED" });
      const completed = roundFinished(f.host, center, 1); await f.pair(); await completed;
      expect(f.controller.view()).toMatchObject({ activityEnabled: false, activityPreferenceSaved: false, paired: true });
      expect(f.controller.view().status).toMatchObject({ state: "ready", lastSuccessAt: NOW, lastErrorCode: null, activity: { lastErrorCode: "ACTIVITY_PREFERENCE_WRITE_FAILED" } });
      expect(center.published).toHaveLength(0); expect(f.host.ids).not.toContain(ACTIVITY);
    } finally { f.controller.deactivate(); }
  });
});

describe("activity publication", () => {
  test("off by default: no host activity query and no activity request", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      await f.controller.activate(); await f.pair();
      await until(() => f.controller.view().status.lastSuccessAt === NOW);
      expect(f.host.ids).not.toContain(ACTIVITY);
      expect(center.published).toHaveLength(0);
      expect(f.controller.view().activityEnabled).toBe(false);
    } finally { f.controller.deactivate(); }
  });
  test("enabled: exactly the published base ids, tied to that round's lease and base hash", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = (queryId, input) => queryId === ACTIVITY
        ? activityPage((input.narratorIds as string[]).map(id => activityRow(id, { attention: { reply: id === "chosen", approval: false, error: false, unread: true }, backgroundWorkCount: 2 })))
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen"), row("unpublished")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => center.published.length === 1);
      const base = f.center.snapshots[0]!, publication = center.published[0]!;
      expect(activityPublicationSchema.safeParse(publication).success).toBe(true);
      expect(publication.available).toBe(true);
      if (!publication.available) throw new Error("expected available");
      // runId and baseHash belong to the same successful base round, not to an older or later one.
      expect(publication.runId).toBe(base.runId);
      expect(publication.baseHash).toBe(await snapshotHash(base.summaries));
      expect(publication.generation).toBe(2);
      // Exactly the published IDs: an unpublished or out-of-scope row never appears.
      expect(publication.items.map(item => item.id)).toEqual(base.summaries.map(summary => summary.id));
      expect(publication.count).toBe(publication.items.length);
      expect(publication.hash).toBe(await activityHash(publication.items));
      // The activity hash is a different canonical form from the base snapshot hash.
      expect(publication.hash).not.toBe(publication.baseHash);
      expect(JSON.stringify(publication)).not.toContain("unpublished");
      expect(f.controller.view().status.activity).toMatchObject({ support: "available", lastCount: 1, lastHash: publication.hash, lastErrorCode: null });
    } finally { f.controller.deactivate(); }
  });
  test("a failing activity source never retracts the base success or changes its retry delay", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = queryId => queryId === ACTIVITY ? { status: "failed", raw: "PRIVATE" }
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.lastErrorCode !== null);
      const view = f.controller.view();
      // Base health is untouched: the round succeeded and the side channel carries its own error.
      expect(view.status.state).not.toBe("backoff");
      expect(view.status.lastSuccessAt).toBe(NOW);
      expect(view.status.lastErrorCode).toBe(null);
      expect(view.status.activity.lastErrorCode).toBe("ACTIVITY_QUERY_FAILED");
      expect(view.status.activity.support).toBe("unknown");
      expect(view.paired).toBe(true);
      expect(f.center.snapshots).toHaveLength(1);
      expect(f.center.failures).toHaveLength(0);
      expect(center.published).toHaveLength(0);
      expect(JSON.stringify(f.host.storage)).not.toContain("PRIVATE");
    } finally { f.controller.deactivate(); }
  });
  test("a legacy center 404 is remembered for the destination and never retried every round", async () => {
    const center = legacyCenter(), f = activityFixture(center); try {
      f.host.list = (queryId, input) => queryId === ACTIVITY ? answeredAll(input)
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.support === "unsupported");
      expect(f.center.snapshots).toHaveLength(1);
      expect(f.controller.view().status.lastSuccessAt).toBe(NOW);
      await idle(f.controller); await resync(f.controller);
      await until(() => f.center.snapshots.length === 2); await idle(f.controller);
      // One 404 per destination, not one per round.
      expect(center.calls).toHaveLength(1);
      expect(f.controller.view().status.activity.lastErrorCode).toBe("ACTIVITY_UNSUPPORTED");
      // A legacy center is not an auth failure: the credential and the pairing survive.
      expect(f.host.secrets.get(CREDENTIAL_KEY)).toContain("t".repeat(43));
      expect(f.controller.view().settings.requiresRevocation).toBe(false);
    } finally { f.controller.deactivate(); }
  });
  test("an old host is asked once; base summaries keep flowing", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = queryId => {
        if (queryId === ACTIVITY) throw new HostRpcError("queries.execute", { code: -32601, message: "x", data: { code: "METHOD_NOT_FOUND" } });
        return queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      };
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.support === "unsupported");
      await idle(f.controller); await resync(f.controller);
      await until(() => f.center.snapshots.length === 2); await idle(f.controller);
      expect(f.host.ids.filter(id => id === ACTIVITY)).toHaveLength(1);
      expect(center.published).toHaveLength(0);
      expect(f.controller.view().status.lastSuccessAt).toBe(NOW);
    } finally { f.controller.deactivate(); }
  });
  test("turning it off sends one available:false clear on the next base round, then stops", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = (queryId, input) => queryId === ACTIVITY ? answeredAll(input)
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => center.published.length === 1 && center.published[0]!.available);
      await idle(f.controller);
      const off = await f.controller.activity({ enabled: false });
      expect(off.activityEnabled).toBe(false); expect(off.activityNeedsClear).toBe(true);
      await resync(f.controller); await until(() => center.published.length === 2);
      const clear = center.published[1]!;
      expect(clear.available).toBe(false);
      // The clear carries no items, count or hash and still belongs to a real base round.
      expect(Object.keys(clear).sort()).toEqual(["available", "baseHash", "generation", "protocolVersion", "runId"]);
      expect(clear.runId).toBe(f.center.snapshots[1]!.runId);
      expect(clear.baseHash).toBe(f.center.snapshots[1]!.hash);
      await until(() => !f.controller.view().activityNeedsClear);
      // After the accepted clear nothing more is asked of the host or the center.
      await idle(f.controller); await resync(f.controller);
      await until(() => f.center.snapshots.length === 3); await idle(f.controller);
      expect(f.host.ids.filter(id => id === ACTIVITY)).toHaveLength(1);
      expect(center.published).toHaveLength(2);
    } finally { f.controller.deactivate(); }
  });
  test("a toggle that never published asks for no clear at all", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      await f.controller.activate(); await f.pair();
      await until(() => f.controller.view().status.lastSuccessAt === NOW); await idle(f.controller);
      // Enabling then disabling before anything was accepted leaves the center with nothing to withdraw.
      await f.controller.activity({ enabled: true });
      const off = await f.controller.activity({ enabled: false });
      expect(off.activityEnabled).toBe(false);
      expect(off.activityNeedsClear).toBe(false);
      await resync(f.controller); await until(() => f.center.snapshots.length === 2); await idle(f.controller);
      expect(center.published).toHaveLength(0);
    } finally { f.controller.deactivate(); }
  });
  test("a denied activity permission is its own state and never a base auth failure", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = queryId => {
        if (queryId === ACTIVITY) throw new HostRpcError("queries.execute", { code: -32000, message: "x", data: { code: "PERMISSION_DENIED" } });
        return queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      };
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.support === "denied");
      const view = f.controller.view();
      expect(view.status.activity.lastErrorCode).toBe("ACTIVITY_PERMISSION_DENIED");
      expect(view.status.lastErrorCode).toBe(null); expect(view.status.state).not.toBe("auth-rejected");
      expect(view.settings.requiresRevocation).toBe(false); expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(true);
      expect(f.center.snapshots).toHaveLength(1);
    } finally { f.controller.deactivate(); }
  });
  test("a project conflicting with the trusted scope is reported as denied, not as absent signals", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = queryId => {
        if (queryId === ACTIVITY) throw new HostRpcError("queries.execute", { code: -32000, message: "x", data: { code: "NOT_FOUND_OR_DENIED" } });
        return queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      };
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.support === "denied");
      expect(f.controller.view().status.activity.lastErrorCode).toBe("ACTIVITY_PERMISSION_DENIED");
      expect(center.published).toHaveLength(0);
    } finally { f.controller.deactivate(); }
  });
  test("a center rejecting the activity token does not clear the base credential", async () => {
    const center = activityCenter({ reject: new ConnectorError("AUTH_REJECTED", true) }), f = activityFixture(center); try {
      f.host.list = (queryId, input) => queryId === ACTIVITY ? answeredAll(input)
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.lastErrorCode === "AUTH_REJECTED");
      const view = f.controller.view();
      // The base round already succeeded, so its success stands; the activity error stays in its own slot.
      expect(view.status.lastSuccessAt).toBe(NOW); expect(view.paired).toBe(true);
      expect(view.settings.requiresRevocation).toBe(false);
      expect(f.host.secrets.has(CREDENTIAL_KEY)).toBe(true);
      expect(f.center.failures).toHaveLength(0);
      expect(f.center.snapshots).toHaveLength(1);
    } finally { f.controller.deactivate(); }
  });
  test("partial host coverage is withheld: the published set must equal the base ID set exactly", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = (queryId, input) => {
        // The host omits unknown/unreadable/out-of-scope IDs by contract.
        if (queryId === ACTIVITY) return activityPage([activityRow((input.narratorIds as string[])[0]!, { attention: { reply: true, approval: false, error: false, unread: false } })]);
        return queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("a"), row("b")]);
      };
      await f.controller.activate(); await f.controller.activity({ enabled: true });
      await f.pair({ ...draft(), scope: { mode: "sessions", sessionIds: ["a", "b"], includeArchived: false } });
      await until(() => f.controller.view().status.activity.lastErrorCode !== null);
      // Nothing is published: a subset would either mismatch the center's pinned ID set or read as an all-clear.
      expect(center.published).toHaveLength(0);
      expect(f.controller.view().status.activity.lastErrorCode).toBe("ACTIVITY_INCOMPLETE");
      expect(f.controller.view().status.lastSuccessAt).toBe(NOW);
    } finally { f.controller.deactivate(); }
  });
  test("no coverage at all is an error, not an empty all-clear publication", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = queryId => queryId === ACTIVITY ? activityPage([])
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.lastErrorCode !== null);
      expect(f.controller.view().status.activity.lastErrorCode).toBe("ACTIVITY_INCOMPLETE");
      expect(center.published).toHaveLength(0);
      expect(f.controller.view().status.lastSuccessAt).toBe(NOW);
    } finally { f.controller.deactivate(); }
  });
  test("a row that was not in the published base set is rejected, not published", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = (queryId, input) => {
        if (queryId === ACTIVITY) return activityPage([...(input.narratorIds as string[]).map(id => activityRow(id)), activityRow("late")]);
        return queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      };
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.lastErrorCode !== null);
      expect(f.controller.view().status.activity.lastErrorCode).toBe("ACTIVITY_INCOMPLETE");
      expect(center.published).toHaveLength(0);
      expect(f.center.snapshots).toHaveLength(1);
    } finally { f.controller.deactivate(); }
  });
  test("a paused publisher never opens the activity network path", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      await f.controller.activate(); await f.pair();
      await until(() => f.controller.view().status.lastSuccessAt === NOW); await idle(f.controller);
      // Enabling the switch while paused must not start a round or a network request on its own.
      await f.controller.activity({ enabled: true }); await f.controller.pause();
      await Bun.sleep(30);
      expect(center.published).toHaveLength(0);
      expect(f.host.ids).not.toContain(ACTIVITY);
      expect(f.controller.view().status.activity.lastPublishedAt).toBe(null);
    } finally { f.controller.deactivate(); }
  });
  test("activity state persists across restart without storing any item content", async () => {
    const center = activityCenter(), f = activityFixture(center), restarted = f.make(); try {
      f.host.list = (queryId, input) => queryId === ACTIVITY ? activityPage((input.narratorIds as string[]).map(id => activityRow(id, { backgroundWorkCount: 4 })))
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => center.published.length === 1);
      f.controller.deactivate();
      // Only bounded metadata is persisted: no item list, no titles, no background details.
      const saved = JSON.stringify([...f.host.storage]);
      expect(saved).not.toContain('"items"'); expect(saved).not.toContain("标题"); expect(saved).not.toContain("backgroundWorkCount");
      await restarted.activate();
      const view = restarted.view();
      expect(view.activityEnabled).toBe(true);
      expect(view.activity.support).toBe("available");
      expect(view.activity.lastCount).toBe(1);
      expect(view.activity.lastHash).toMatch(/^[0-9a-f]{64}$/);
    } finally { f.controller.deactivate(); restarted.deactivate(); }
  });
  test("the base summary wire shape is unchanged when activity is off", async () => {
    const f = fixture(); try {
      await f.controller.activate(); await f.pair();
      await until(() => f.controller.view().status.lastSuccessAt === NOW);
      const wire = f.center.snapshots[0]!;
      expect(Object.keys(wire).sort()).toEqual(["count", "generation", "hash", "protocolVersion", "runId", "summaries"]);
      expect(wire.hash).toBe(await snapshotHash(wire.summaries));
      expect(f.host.ids).not.toContain(ACTIVITY);
      expect(f.destinations.every(url => url === BASE)).toBe(true);
      expect(f.center.pairs[0]!.capabilities).toEqual(["summary.v1"]);
    } finally { f.controller.deactivate(); }
  });
  test("activity is not attempted before a successful base publication", async () => {
    const center = activityCenter(), f = activityFixture(center); try {
      f.host.list = queryId => queryId === ACTIVITY ? activityPage([activityRow("chosen")]) : { status: "failed" };
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.center.failures.length === 1);
      expect(center.published).toHaveLength(0);
      expect(f.host.ids).not.toContain(ACTIVITY);
      expect(f.controller.view().status.activity.lastPublishedAt).toBe(null);
    } finally { f.controller.deactivate(); }
  });
  test("the unsupported cache is per process: a fresh runtime asks again instead of inheriting the verdict", async () => {
    const legacy = legacyCenter(), fresh = activityCenter();
    const f = activityFixture(legacy); try {
      f.host.list = (queryId, input) => queryId === ACTIVITY ? answeredAll(input)
        : queryId === "narrafork.projects.list" ? page([{ id: "p", name: "项目" }]) : page([row("chosen")]);
      await f.controller.activate(); await f.controller.activity({ enabled: true }); await f.pair();
      await until(() => f.controller.view().status.activity.support === "unsupported");
      expect(legacy.calls).toHaveLength(1);
    } finally { f.controller.deactivate(); }
    // Same binding, new runtime and a center that now implements the route: the cached 404 must not be inherited,
    // so the side channel recovers without re-pairing.
    const other = new ConnectorController(f.host, { random: () => 0.5, center: () => fresh });
    try {
      await other.activate();
      await until(() => fresh.published.length > 0);
      expect(other.view().activity.support).toBe("available");
      expect(other.view().settings.requiresRevocation).toBe(false);
    } finally { other.deactivate(); }
  });
});
