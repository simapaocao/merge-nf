import { LIMITS, PROTOCOL_VERSION, activityHash, activityPublicationSchema, pairCodeSchema, pairRequestSchema, snapshotHash, snapshotRequestSchema, type RunResponse } from "@nf-hub/protocol";
import { collectActivity } from "./activity";
import { collectSummaries } from "./collection";
import { DEFAULT_ACTIVITY, DEFAULT_SETTINGS, DEFAULT_STATUS, HostRepository, bindingError, bindingKey, isBound, parseSettings, type ActivityPreference, type ActivityStatus, type ActivitySupport, type BoundCredential, type ConnectionStatus, type Settings } from "./config";
import { CREDENTIAL_KEY, PAIRING_KEY, PLUGIN_VERSION } from "./constants";
import { ACTIVITY_ERROR_CODES, ConnectorError, assertActive, collectionFailure, safeError } from "./errors";
import { HostRpcError, type HostApi } from "./host-rpc";
import { CenterClient } from "./transport";
import type { CenterTrust } from "./center-trust";

export interface ConnectorView {
  settings: Settings; status: ConnectionStatus; active: boolean; paired: boolean; binding: string; instanceId: string | null; generation: number | null; includesProjectNames: boolean | null;
  /** Additive, non-secret activity metadata for the panel. Toggling it never changes `binding`. */
  activityEnabled: boolean; activityNeedsClear: boolean; activityPreferenceSaved: boolean; activitySupport: ActivitySupport; activity: ActivityStatus;
}
/** The activity method is optional so a center client built without it degrades to "no side channel" instead of failing. */
export type CenterLike = Pick<CenterClient, "pair" | "run" | "snapshot" | "failed"> & Partial<Pick<CenterClient, "activity">>;
export interface ControllerOptions { now?: () => number; random?: () => number; center?: (url: string, trust: CenterTrust) => CenterLike; collect?: typeof collectSummaries; collectActivity?: typeof collectActivity; }

export function nextDelay(interval: number, failures: number, random: number): number {
  const retry = failures > 0, base = retry ? Math.min(120_000, interval * 2 ** Math.min(failures - 1, 8)) : interval;
  return Math.min(retry ? 120_000 : Infinity, Math.round(base * (0.9 + Math.max(0, Math.min(1, random)) * 0.2)));
}
function inputRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new ConnectorError("CONFIG_INVALID");
  return value as Record<string, unknown>;
}

export class ConnectorController {
  private readonly repo: HostRepository;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly center: NonNullable<ControllerOptions["center"]>;
  private readonly collect: typeof collectSummaries;
  private readonly gatherActivity: typeof collectActivity;
  private cfg = structuredClone(DEFAULT_SETTINGS);
  private state = { ...DEFAULT_STATUS, activity: structuredClone(DEFAULT_STATUS.activity) };
  private activityPref: ActivityPreference = structuredClone(DEFAULT_ACTIVITY);
  private activityPreferenceSaved = false;
  /** Independent from the base round epoch: a toggle invalidates only the optional collection. */
  private activityTicket = 0;
  private activityAbort: AbortController | null = null;
  /** A submitted true may reach the center even when its reply is late or never observed. */
  private activityRemoteMayExist = false;
  /** Destinations whose center answered 404 on the fixed activity route; retried only after the destination changes. */
  private readonly activityUnsupported = new Set<string>();
  /** A host that reports the activity query as unknown is asked once per activation, not every round. */
  private hostActivityUnsupported = false;
  private cred: BoundCredential | null = null;
  private active = false;
  private loaded = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private task: Promise<void> | null = null;
  private roundAbort: AbortController | null = null;
  private pairAbort: AbortController | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private failures = 0;
  constructor(private readonly host: HostApi, opts: ControllerOptions = {}) {
    this.repo = new HostRepository(host); this.now = opts.now ?? Date.now; this.random = opts.random ?? Math.random;
    this.center = opts.center ?? ((url, trust) => new CenterClient(url, fetch, trust)); this.collect = opts.collect ?? collectSummaries;
    this.gatherActivity = opts.collectActivity ?? collectActivity;
  }
  view(): ConnectorView {
    return structuredClone({
      settings: this.cfg, status: this.state, active: this.active, paired: this.cred !== null && isBound(this.cred, this.cfg),
      binding: bindingKey(this.cfg), instanceId: this.cred?.pairing.instanceId ?? null, generation: this.cred?.pairing.generation ?? null, includesProjectNames: this.cred?.projectNames ?? null,
      activityEnabled: this.activityPreferenceSaved && this.activityPref.enabled, activityNeedsClear: this.activityPref.needsClear,
      activityPreferenceSaved: this.activityPreferenceSaved, activitySupport: this.state.activity.support, activity: this.state.activity,
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work, work); this.writes = result.catch(() => undefined); return result;
  }
  private fenceActivity(): number {
    this.activityAbort?.abort();
    return ++this.activityTicket;
  }
  private halt(): number {
    clearTimeout(this.timer); this.timer = undefined; this.state.nextAttemptAt = null;
    this.fenceActivity(); this.pairAbort?.abort(); this.roundAbort?.abort(); return ++this.epoch;
  }
  private check(epoch: number, signal?: AbortSignal): void {
    assertActive(signal); if (!this.active || this.epoch !== epoch) throw new ConnectorError("CANCELLED");
  }
  private freshStatus(): ConnectionStatus { return { ...DEFAULT_STATUS, activity: structuredClone(DEFAULT_STATUS.activity) }; }
  private publishState(): Promise<void> { return this.repo.writeStatus({ ...this.state }, this.cred).catch(() => undefined); }
  private canRun(): boolean { return this.active && this.loaded && !!this.cred && !this.cfg.paused && !this.cfg.requiresRevocation && this.cfg.confirmed && this.cfg.scope.mode !== "none" && isBound(this.cred, this.cfg); }
  private async stopInvalid(error: ConnectorError): Promise<void> {
    this.cred = null; this.cfg = { ...this.cfg, paused: true, requiresRevocation: true };
    // The base credential barrier is base-only: the activity preference survives, and any pending clear is kept
    // so the next successful base round can still remove stale enhancement at the center.
    this.state = { ...this.freshStatus(), state: error.code === "AUTH_REJECTED" ? "auth-rejected" : "re-pair-required", lastErrorCode: error.code };
    // Both barriers are attempted independently. No invalid credential can be resumed via the UI.
    try { await this.repo.writeSettings(this.cfg); } finally { await this.repo.deleteSecret(CREDENTIAL_KEY); }
  }
  /** Must run in the serialized queue. Until all authoritative reads succeed, do not write any settings or secrets. */
  private async load(epoch: number, schedule: boolean): Promise<void> {
    this.check(epoch);
    if (this.loaded) return;
    try {
      const cfg = await this.repo.settings(), credential = await this.repo.credential(), history = await this.repo.history(credential); this.check(epoch);
      this.cfg = cfg; this.cred = credential;
      this.state = { ...this.freshStatus(), ...history, activity: { ...structuredClone(DEFAULT_STATUS.activity), ...(history.activity ?? {}) } };
      try {
        this.activityPref = await this.repo.activityPreference(); this.check(epoch);
        this.activityPreferenceSaved = true;
        this.activityRemoteMayExist = this.activityRemoteMayExist || this.activityPref.needsClear || this.state.activity.lastPublishedAt !== null;
      } catch {
        this.check(epoch);
        // Optional storage is not part of the base binding/secret barrier. Unreadable consent disables only activity.
        this.activityPref = { ...DEFAULT_ACTIVITY, needsClear: this.activityRemoteMayExist || this.state.activity.lastPublishedAt !== null };
        this.activityPreferenceSaved = false;
        this.state.activity = { ...structuredClone(DEFAULT_STATUS.activity), lastErrorCode: "ACTIVITY_PREFERENCE_READ_FAILED" };
      }
      this.loaded = true;
      if (credential && (!isBound(credential, cfg) || cfg.requiresRevocation)) {
        await this.stopInvalid(new ConnectorError(bindingError(credential, cfg)));
      } else if (this.canRun()) { this.state.state = "ready"; if (schedule) this.schedule(300 + Math.floor(this.random() * 400)); }
      else this.state.state = cfg.requiresRevocation ? (history.lastErrorCode === "AUTH_REJECTED" ? "auth-rejected" : "re-pair-required") : credential ? "paused" : "unconfigured";
    } catch (error) {
      this.check(epoch);
      // Unreadable is not absent, and it is not evidence a center generation ever existed.
      this.loaded = false; this.cred = null; this.state = { ...this.freshStatus(), state: "host-unavailable", lastErrorCode: safeError(error) };
      if (error instanceof HostRpcError) this.state.hostReadError = error.diagnostic;
      throw error;
    }
  }
  async activate(): Promise<void> {
    const epoch = this.halt(); this.active = true; this.loaded = false; this.cred = null;
    this.activityPreferenceSaved = false; this.hostActivityUnsupported = false;
    const attempt = (index: number): Promise<void> => this.serial(async () => {
      if (!this.active || this.epoch !== epoch || this.loaded) return;
      try { await this.load(epoch, true); if (epoch === this.epoch) await this.publishState(); }
      catch (error) {
        const delay = [200, 800, 2000][index];
        if (this.active && this.epoch === epoch && delay !== undefined && (safeError(error) === "HOST_UNAVAILABLE" || safeError(error) === "RPC_TIMEOUT")) {
          this.timer = setTimeout(() => { void attempt(index + 1); }, delay);
        }
      }
    });
    await attempt(0);
  }
  deactivate(): void { this.active = false; this.loaded = false; this.halt(); this.state.state = "inactive"; }
  /** Mutations fence the network synchronously, then persist in the order they reached the backend. */
  async configure(input: unknown): Promise<ConnectorView> {
    this.halt();
    return this.serial(async () => {
      await this.load(this.epoch, false);
      this.cfg = { ...this.cfg, paused: true }; this.state.state = "paused";
      await this.repo.writeSettings(this.cfg); // Even a malformed replacement leaves the publisher paused.
      const draft = inputRecord(input, ["baseUrl", "scope", "wantProjectNames", "intervalMs", "confirmed", "centerCaPem", "centerCaSha256"]);
      // Absence means default trust, never silently carry a previous CA to a different destination.
      const next = parseSettings({ ...this.cfg, ...draft, centerCaPem: draft.centerCaPem ?? null, centerCaSha256: draft.centerCaSha256 ?? null });
      if (this.cred && !isBound(this.cred, next)) {
        const error = new ConnectorError(bindingError(this.cred, next));
        this.cfg = next; await this.stopInvalid(error);
      } else {
        this.cfg = next; await this.repo.writeSettings(next);
        this.state.state = next.requiresRevocation ? "re-pair-required" : this.cred ? "paused" : "unconfigured";
      }
      this.failures = 0; await this.publishState(); return this.view();
    });
  }
  async pause(): Promise<ConnectorView> {
    this.halt();
    return this.serial(async () => {
      await this.load(this.epoch, false);
      this.cfg = { ...this.cfg, paused: true }; this.state.state = "paused";
      await this.repo.writeSettings(this.cfg); await this.publishState(); return this.view();
    });
  }
  async resume(): Promise<ConnectorView> {
    const epoch = this.epoch;
    return this.serial(async () => {
      await this.load(epoch, true);
      this.check(epoch);
      if (this.cfg.requiresRevocation || !this.cred || !isBound(this.cred, this.cfg)) throw new ConnectorError("PAIRING_REQUIRED");
      if (!this.cfg.confirmed || this.cfg.scope.mode === "none") throw new ConnectorError("CONSENT_REQUIRED");
      this.cfg = { ...this.cfg, paused: false }; await this.repo.writeSettings(this.cfg);
      this.check(epoch); this.failures = 0; this.state.state = "ready"; this.schedule(0); await this.publishState(); return this.view();
    });
  }
  async forget(): Promise<ConnectorView> {
    this.halt();
    return this.serial(async () => {
      await this.load(this.epoch, false);
      this.cfg = { ...this.cfg, confirmed: false, paused: true, requiresRevocation: this.cfg.requiresRevocation || !!this.cred };
      this.cred = null; await this.repo.writeSettings(this.cfg); await this.repo.deleteSecret(CREDENTIAL_KEY); await this.repo.deleteSecret(PAIRING_KEY);
      // The activity preference stays untouched: clearing a pairing is not consent to change the side-channel choice.
      this.state = { ...this.freshStatus(), state: this.cfg.requiresRevocation ? "re-pair-required" : "unconfigured" }; await this.publishState(); return this.view();
    });
  }
  /** Opt-in toggle. Deliberately outside `connector-settings`, so it cannot change `binding`, `scopeKey` or the token. */
  async activity(input: unknown): Promise<ConnectorView> {
    const opts = inputRecord(input, ["enabled"]);
    if (typeof opts.enabled !== "boolean") throw new ConnectorError("CONFIG_INVALID");
    const enabled = opts.enabled, epoch = this.epoch, ticket = this.fenceActivity();
    // Fence synchronously, before joining the storage queue. Neither a slow save nor a later re-enable can revive
    // a collection that started under the previous consent. This does not touch roundAbort or the base epoch.
    this.activityPreferenceSaved = false;
    return this.serial(async () => {
      await this.load(epoch, false); this.check(epoch);
      this.activityPreferenceSaved = false;
      const needsClear = this.activityPref.needsClear || (!enabled && (this.activityRemoteMayExist || this.state.activity.lastPublishedAt !== null));
      const next: ActivityPreference = { version: 1, enabled, needsClear };
      try {
        await this.repo.writeActivityPreference(next); this.check(epoch);
      } catch {
        this.check(epoch);
        // Do not advertise a durable disable when storage rejected it. Stop optional traffic in this runtime and
        // expose the uncertainty independently; the original settings, binding and vault remain untouched.
        this.activityPref = { version: 1, enabled: false, needsClear };
        this.activityPreferenceSaved = false;
        this.state.activity = { ...this.state.activity, support: "unknown", lastErrorCode: "ACTIVITY_PREFERENCE_WRITE_FAILED" };
        await this.publishState();
        throw new ConnectorError("ACTIVITY_PREFERENCE_WRITE_FAILED");
      }
      this.activityPref = next;
      this.activityPreferenceSaved = ticket === this.activityTicket;
      if (!enabled) this.state.activity = { ...this.state.activity, lastCount: null, lastHash: null };
      if (this.state.activity.lastErrorCode === "ACTIVITY_PREFERENCE_READ_FAILED" || this.state.activity.lastErrorCode === "ACTIVITY_PREFERENCE_WRITE_FAILED") {
        this.state.activity = { ...this.state.activity, support: "unknown", lastErrorCode: null };
      }
      await this.publishState(); return this.view();
    });
  }
  private async projectCapability(signal: AbortSignal): Promise<boolean> {
    if (!this.cfg.wantProjectNames) return false;
    try {
      // Local availability check only; no raw projects, names or IDs are sent in the pairing exchange.
      const response = await this.host.request("queries.execute", { queryId: "narrafork.projects.list", input: { limit: 1 } }, { signal, timeoutMs: 3_000 }) as { status?: unknown; data?: { items?: unknown }; page?: { hasMore?: unknown; nextCursor?: unknown } } | null;
      return response?.status === "succeeded" && Array.isArray(response.data?.items) && response.data.items.length <= 1 && typeof response.page?.hasMore === "boolean" && (!response.page.hasMore || (typeof response.page.nextCursor === "string" && response.page.nextCursor.length > 0));
    } catch { assertActive(signal); return false; }
  }
  async pair(input: unknown = {}): Promise<ConnectorView> {
    // A stale second settings tab must not interrupt an already paired publisher.
    if (this.pairAbort) throw new ConnectorError("BUSY");
    const epoch = this.epoch;
    return this.serial(async () => {
      await this.load(epoch, true);
      this.check(epoch);
      const opts = inputRecord(input, ["centralRevocationAcknowledged"]);
      if (this.cred || (this.cfg.requiresRevocation && opts.centralRevocationAcknowledged !== true)) throw new ConnectorError("CENTRAL_REVOCATION_REQUIRED");
      if (!this.cfg.baseUrl || !this.cfg.confirmed || this.cfg.scope.mode === "none") throw new ConnectorError("CONSENT_REQUIRED");
      const cfg = structuredClone(this.cfg), binding = bindingKey(cfg), ctrl = new AbortController();
      this.pairAbort = ctrl; this.state.state = "pairing";
      let sent = false;
      try {
        const secret = await this.repo.secret(PAIRING_KEY); this.check(epoch, ctrl.signal);
        let value: unknown;
        try { value = JSON.parse(secret ?? "null"); } catch { throw new ConnectorError("PAIRING_REQUIRED"); }
        const envelope = inputRecord(value, ["code", "binding"]), parsed = pairCodeSchema.safeParse(envelope.code);
        if (!parsed.success || envelope.binding !== binding) throw new ConnectorError("PAIRING_REQUIRED");
        await this.repo.deleteSecret(PAIRING_KEY); this.check(epoch, ctrl.signal);
        const projectNames = await this.projectCapability(ctrl.signal); this.check(epoch, ctrl.signal);
        const disk = await this.repo.settings(); this.check(epoch, ctrl.signal);
        if (!disk.confirmed || bindingKey(disk) !== binding) throw new ConnectorError("SCOPE_CHANGED");
        // Crash before, during or just after exchange: restart stays stopped; never fetch or replay an unconfirmed pairing.
        this.cfg = { ...cfg, paused: true, requiresRevocation: true }; await this.repo.writeSettings(this.cfg); this.check(epoch, ctrl.signal);
        const request = pairRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, code: parsed.data, confirmed: true, scope: cfg.scope, connectorVersion: PLUGIN_VERSION, capabilities: projectNames ? ["summary.v1", "projectNames.v1"] : ["summary.v1"] });
        sent = true; const pairing = await this.center(cfg.baseUrl, cfg).pair(request, ctrl.signal); this.check(epoch, ctrl.signal);
        const credential: BoundCredential = { version: 1, baseUrl: cfg.baseUrl, centerCaSha256: cfg.centerCaSha256, scopeKey: binding, projectNames, pairing };
        await this.repo.setSecret(CREDENTIAL_KEY, JSON.stringify(credential)); this.check(epoch, ctrl.signal);
        this.cfg = { ...cfg, paused: false, requiresRevocation: false }; await this.repo.writeSettings(this.cfg); this.check(epoch, ctrl.signal);
        this.cred = credential; this.state = { ...this.freshStatus(), activity: { ...this.state.activity }, state: "ready", projectNames: projectNames ? "available" : "unavailable" }; this.failures = 0;
        this.schedule(0); await this.publishState(); return this.view();
      } catch (error) {
        this.cred = null; this.cfg = { ...cfg, paused: true, requiresRevocation: cfg.requiresRevocation || sent };
        const code = sent && safeError(error) !== "PAIRING_FAILED" ? "PAIRING_UNCERTAIN" : safeError(error);
        this.state = { ...this.freshStatus(), state: this.cfg.requiresRevocation ? "re-pair-required" : "unconfigured", lastErrorCode: code };
        await this.repo.writeSettings(this.cfg).catch(() => undefined); await this.repo.deleteSecret(CREDENTIAL_KEY).catch(() => undefined); await this.publishState();
        throw new ConnectorError(code);
      } finally { if (this.pairAbort === ctrl) this.pairAbort = null; }
    });
  }
  sync(): ConnectorView {
    if (!this.canRun()) throw new ConnectorError(this.cfg.paused ? "CONSENT_REQUIRED" : "PAIRING_REQUIRED");
    if (this.task) throw new ConnectorError("BUSY");
    this.schedule(0); return this.view();
  }
  private schedule(delay: number): void {
    if (!this.canRun()) return;
    clearTimeout(this.timer); const epoch = this.epoch;
    this.state.nextAttemptAt = this.now() + delay;
    const start = () => {
      if (this.epoch !== epoch || !this.canRun()) return;
      if (this.task) { void this.task.then(start); return; }
      const p = this.round(epoch).catch(() => { /* Network code supplies only fixed, bounded local diagnostics. */ });
      this.task = p; void p.then(() => { if (this.task === p) this.task = null; });
    };
    this.timer = setTimeout(start, delay);
  }
  private async verify(epoch: number, credential: BoundCredential, signal: AbortSignal): Promise<void> {
    this.check(epoch, signal);
    const disk = await this.repo.settings(); this.check(epoch, signal);
    if (!isBound(credential, disk)) { this.cfg = disk; throw new ConnectorError(bindingError(credential, disk), true); }
    if (disk.paused || !disk.confirmed || disk.requiresRevocation) throw new ConnectorError("CANCELLED", true);
    const saved = await this.repo.credential(); this.check(epoch, signal);
    if (!saved || !isBound(saved, disk) || saved.pairing.generation !== credential.pairing.generation || saved.projectNames !== credential.projectNames || saved.pairing.token !== credential.pairing.token) throw new ConnectorError("PAIRING_REQUIRED", true);
  }
  private activityFailure(error: unknown): string {
    const code = safeError(error);
    return ACTIVITY_ERROR_CODES.has(code) ? code : "ACTIVITY_QUERY_FAILED";
  }
  /**
   * One serialized activity publication per base round, tied to that round's successful lease.
   *
   * - `runId` is the base lease of this round and `baseHash` is the accepted base snapshot hash, so the center can
   *   reject stale or out-of-range data instead of trusting arrival order.
   * - IDs come from the exact published base summaries; nothing is re-collected or widened.
   * - Turning the switch off sends `available: false` once, then stops; the flag is cleared only on acceptance.
   * - Errors land in `state.activity` only. They never enter `lastErrorCode`, the retry delay or `stopInvalid`.
   */
  private async publishActivity(epoch: number, credential: BoundCredential, client: Partial<Pick<CenterClient, "activity">>, ctrl: AbortController, round: { runId: number; baseHash: string; ids: readonly string[] }): Promise<void> {
    const pref = this.activityPref;
    if (!this.activityPreferenceSaved || (!pref.enabled && !pref.needsClear)) return;
    const send = client.activity?.bind(client);
    if (send === undefined) return;
    const ticket = this.activityTicket, activity = new AbortController();
    this.activityAbort = activity;
    const signal = AbortSignal.any([ctrl.signal, activity.signal]);
    const current = () => this.active && epoch === this.epoch && ticket === this.activityTicket && !signal.aborted && this.activityPreferenceSaved;
    const base = { protocolVersion: PROTOCOL_VERSION, generation: credential.pairing.generation, runId: round.runId, baseHash: round.baseHash };
    let phase: "collect" | "send" = "collect";
    try {
      if (this.activityUnsupported.has(credential.baseUrl)) {
        this.state.activity = { ...this.state.activity, support: "unsupported", lastErrorCode: "ACTIVITY_UNSUPPORTED" };
        return;
      }
      // A clear always precedes any new enabled observation. Re-enabling never discards an outstanding withdrawal.
      if (pref.needsClear) {
        await this.verify(epoch, credential, signal);
        if (!current() || !this.activityPref.needsClear) return;
        phase = "send";
        const receipt = await send(credential, activityPublicationSchema.parse({ ...base, available: false }), ctrl.signal);
        this.check(epoch, ctrl.signal);
        if (receipt.accepted !== true) throw new ConnectorError("ACTIVITY_RESPONSE_INVALID");
        await this.serial(async () => {
          if (!this.active || epoch !== this.epoch) return;
          this.activityRemoteMayExist = false;
          const next = { ...this.activityPref, needsClear: false };
          // A concurrent failed save remains explicitly unsaved. Do not turn it into an implicit saved consent.
          if (!this.activityPreferenceSaved) { this.activityPref = next; return; }
          try {
            await this.repo.writeActivityPreference(next); this.check(epoch, ctrl.signal);
            this.activityPref = next;
            this.state.activity = { ...this.state.activity, lastPublishedAt: null, lastCount: null, lastHash: null, lastErrorCode: null };
          } catch {
            this.check(epoch, ctrl.signal);
            this.activityPref = { ...next, enabled: false };
            this.activityPreferenceSaved = false;
            this.state.activity = { ...this.state.activity, support: "unknown", lastErrorCode: "ACTIVITY_PREFERENCE_WRITE_FAILED" };
          }
        });
        return;
      }
      if (this.hostActivityUnsupported) {
        this.state.activity = { ...this.state.activity, support: "unsupported", lastErrorCode: "ACTIVITY_UNSUPPORTED" };
        return;
      }
      let collection;
      try {
        collection = await this.gatherActivity(this.host, round.ids, { signal, now: () => performance.now() });
      } catch (error) {
        if (!current()) return;
        if (safeError(error) === "ACTIVITY_UNSUPPORTED") this.hostActivityUnsupported = true;
        throw error;
      }
      if (!current() || !this.activityPref.enabled || this.activityPref.needsClear) return;
      const expected = new Set(round.ids);
      if (collection.unknownIds.length > 0 || collection.items.length !== expected.size || collection.items.some(item => !expected.has(item.id))) throw new ConnectorError("ACTIVITY_INCOMPLETE");
      const items = collection.items.map(item => ({ id: item.id, reply: item.reply, approval: item.approval, error: item.error, unread: item.unread, backgroundWorkCount: item.backgroundWorkCount }));
      const publication = activityPublicationSchema.parse({ ...base, available: true, count: items.length, hash: await activityHash(items), items });
      if (!publication.available) throw new ConnectorError("ACTIVITY_RESPONSE_INVALID");
      await this.verify(epoch, credential, signal);
      // Every await above is a consent race boundary, including hashing and the authoritative settings reads.
      if (!current() || !this.activityPref.enabled || this.activityPref.needsClear) return;
      phase = "send";
      this.activityRemoteMayExist = true;
      // Once sent, a toggle cannot retract the HTTP request. Keep its parent signal and remember the possible
      // publication so disabling while the first true is in flight still owes a clear on a later base run.
      const receipt = await send(credential, publication, ctrl.signal); this.check(epoch, ctrl.signal);
      if (receipt.accepted !== true) throw new ConnectorError("ACTIVITY_RESPONSE_INVALID");
      if (!current() || !this.activityPref.enabled || this.activityPref.needsClear) {
        this.activityPref = { ...this.activityPref, needsClear: true };
        return;
      }
      this.state.activity = { support: "available", lastPublishedAt: this.now(), lastCount: publication.count, lastHash: publication.hash, lastErrorCode: null };
    } catch (error) {
      if (!current()) return;
      const code = this.activityFailure(error);
      // Host METHOD_NOT_FOUND and center 404 are separate caches; one must not poison the other.
      if (code === "ACTIVITY_UNSUPPORTED" && phase === "send") this.activityUnsupported.add(credential.baseUrl);
      const support: ActivitySupport = code === "ACTIVITY_UNSUPPORTED" ? "unsupported" : code === "ACTIVITY_PERMISSION_DENIED" ? "denied" : "unknown";
      this.state.activity = { ...this.state.activity, support, lastErrorCode: code };
    } finally {
      if (this.activityAbort === activity) this.activityAbort = null;
    }
  }
  private async round(epoch: number): Promise<void> {
    const cfg = structuredClone(this.cfg), credential = this.cred;
    if (!credential || !this.canRun()) return;
    const ctrl = new AbortController(); this.roundAbort = ctrl;
    const client = this.center(credential.baseUrl, cfg);
    let run: RunResponse | null = null, submitted = false, delay: number | null = null;
    this.state = { ...this.state, state: "collecting", lastAttemptAt: this.now(), nextAttemptAt: null };
    try {
      await this.verify(epoch, credential, ctrl.signal);
      run = await client.run(credential, ctrl.signal); this.check(epoch, ctrl.signal);
      // The lease is interpreted by the center. The collection budget is monotonic and independent of host wall-clock skew.
      const deadline = performance.now() + LIMITS.collectMs, budget = new AbortController(), timer = setTimeout(() => budget.abort(), LIMITS.collectMs);
      let collection;
      try {
        collection = await this.collect(this.host, cfg.scope, { projectNames: credential.projectNames, signal: AbortSignal.any([ctrl.signal, budget.signal]), now: () => performance.now() });
        if (budget.signal.aborted || performance.now() >= deadline) throw new ConnectorError("COLLECTION_TIMEOUT");
      } catch (error) { if (budget.signal.aborted && !ctrl.signal.aborted) throw new ConnectorError("COLLECTION_TIMEOUT"); throw error; }
      finally { clearTimeout(timer); }
      this.check(epoch, ctrl.signal);
      const request = snapshotRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, generation: credential.pairing.generation, runId: run.runId, count: collection.summaries.length, hash: await snapshotHash(collection.summaries), summaries: collection.summaries });
      if (Buffer.byteLength(JSON.stringify(request), "utf8") > LIMITS.snapshotBytes) throw new ConnectorError("LIMIT_EXCEEDED");
      await this.verify(epoch, credential, ctrl.signal);
      if (performance.now() >= deadline) throw new ConnectorError("COLLECTION_TIMEOUT");
      submitted = true; const receipt = await client.snapshot(credential, request, ctrl.signal); this.check(epoch, ctrl.signal);
      this.failures = 0; this.state = { ...this.state, state: "ready", lastSuccessAt: receipt.acceptedAt, lastCount: request.count, lastErrorCode: null, projectNames: credential.projectNames ? "available" : "unavailable" };
      delay = nextDelay(cfg.intervalMs, 0, this.random());
      // Optional side channel, only after the base publication above is already accepted. Everything inside is
      // isolated: an unsupported host, a missing center route or a denied permission cannot retract this success,
      // cannot change the retry delay and cannot touch the base credential.
      try { await this.publishActivity(epoch, credential, client, ctrl, { runId: run.runId, baseHash: request.hash, ids: collection.summaries.map(row => row.id) }); }
      catch { /* Activity failures are recorded inside their own state; the accepted base round stands. */ }
    } catch (error) {
      if (!this.active || epoch !== this.epoch || ctrl.signal.aborted) return;
      let fault = error instanceof ConnectorError ? error : new ConnectorError("HOST_UNAVAILABLE");
      if (run && !submitted && !fault.terminal) {
        try {
          await this.verify(epoch, credential, ctrl.signal);
          await client.failed(credential, { protocolVersion: PROTOCOL_VERSION, generation: credential.pairing.generation, runId: run.runId, errorCode: collectionFailure(fault) }, ctrl.signal);
        } catch (other) { if (other instanceof ConnectorError && other.terminal) fault = other; }
      }
      if (!this.active || epoch !== this.epoch || ctrl.signal.aborted) return;
      if (fault.terminal) await this.serial(async () => { if (epoch === this.epoch) await this.stopInvalid(fault); });
      else { this.state.state = "backoff"; this.state.lastErrorCode = fault.code; if (fault.code === "PROJECT_QUERY_FAILED") this.state.projectNames = "unavailable"; delay = nextDelay(cfg.intervalMs, ++this.failures, this.random()); }
    } finally {
      if (this.roundAbort === ctrl) this.roundAbort = null;
      if (this.active && epoch === this.epoch) { if (delay !== null) this.schedule(delay); await this.publishState(); }
    }
  }
  async command(id: string, input?: unknown): Promise<ConnectorView> {
    if (id === "connector-status") {
      const opts = inputRecord(input ?? {}, ["retryRead"]);
      if (this.active && !this.loaded && opts.retryRead === true) {
        const epoch = this.epoch;
        await this.serial(async () => { try { await this.load(epoch, true); } catch { /* Return sanitized status; never write uncertain local state. */ } });
      }
      return this.view();
    }
    if (!this.active) throw new ConnectorError("INACTIVE");
    switch (id) {
      case "connector-configure": return this.configure(input);
      case "connector-pair": return this.pair(input ?? {});
      case "connector-pause": return this.pause();
      case "connector-resume": return this.resume();
      case "connector-sync": return this.sync();
      case "connector-activity": return this.activity(input ?? {});
      case "connector-forget": return this.forget();
      default: throw new ConnectorError("RPC_DENIED");
    }
  }
}
