import { LIMITS, PROTOCOL_VERSION, pairCodeSchema, pairRequestSchema, snapshotHash, snapshotRequestSchema, type RunResponse } from "@nf-hub/protocol";
import { collectSummaries } from "./collection";
import { DEFAULT_SETTINGS, DEFAULT_STATUS, HostRepository, bindingError, bindingKey, isBound, parseSettings, type BoundCredential, type ConnectionStatus, type Settings } from "./config";
import { CREDENTIAL_KEY, PAIRING_KEY, PLUGIN_VERSION } from "./constants";
import { ConnectorError, assertActive, collectionFailure, safeError } from "./errors";
import { HostRpcError, type HostApi } from "./host-rpc";
import { CenterClient } from "./transport";
import type { CenterTrust } from "./center-trust";

export interface ConnectorView { settings: Settings; status: ConnectionStatus; active: boolean; paired: boolean; binding: string; instanceId: string | null; generation: number | null; includesProjectNames: boolean | null; }
export interface ControllerOptions { now?: () => number; random?: () => number; center?: (url: string, trust: CenterTrust) => Pick<CenterClient, "pair" | "run" | "snapshot" | "failed">; collect?: typeof collectSummaries; }
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
  private cfg = structuredClone(DEFAULT_SETTINGS);
  private state = { ...DEFAULT_STATUS };
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
  }
  view(): ConnectorView {
    return structuredClone({ settings: this.cfg, status: this.state, active: this.active, paired: this.cred !== null && isBound(this.cred, this.cfg), binding: bindingKey(this.cfg), instanceId: this.cred?.pairing.instanceId ?? null, generation: this.cred?.pairing.generation ?? null, includesProjectNames: this.cred?.projectNames ?? null });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work, work); this.writes = result.catch(() => undefined); return result;
  }
  private halt(): number {
    clearTimeout(this.timer); this.timer = undefined; this.state.nextAttemptAt = null;
    this.pairAbort?.abort(); this.roundAbort?.abort(); return ++this.epoch;
  }
  private check(epoch: number, signal?: AbortSignal): void {
    assertActive(signal); if (!this.active || this.epoch !== epoch) throw new ConnectorError("CANCELLED");
  }
  private publishState(): Promise<void> { return this.repo.writeStatus({ ...this.state }, this.cred).catch(() => undefined); }
  private canRun(): boolean { return this.active && this.loaded && !!this.cred && !this.cfg.paused && !this.cfg.requiresRevocation && this.cfg.confirmed && this.cfg.scope.mode !== "none" && isBound(this.cred, this.cfg); }
  private async stopInvalid(error: ConnectorError): Promise<void> {
    this.cred = null; this.cfg = { ...this.cfg, paused: true, requiresRevocation: true };
    this.state = { ...DEFAULT_STATUS, state: error.code === "AUTH_REJECTED" ? "auth-rejected" : "re-pair-required", lastErrorCode: error.code };
    // Both barriers are attempted independently. No invalid credential can be resumed via the UI.
    try { await this.repo.writeSettings(this.cfg); } finally { await this.repo.deleteSecret(CREDENTIAL_KEY); }
  }
  /** Must run in the serialized queue. Until all authoritative reads succeed, do not write any settings or secrets. */
  private async load(epoch: number, schedule: boolean): Promise<void> {
    this.check(epoch);
    if (this.loaded) return;
    try {
      const cfg = await this.repo.settings(), credential = await this.repo.credential(), history = await this.repo.history(credential); this.check(epoch);
      this.cfg = cfg; this.cred = credential; this.state = { ...DEFAULT_STATUS, ...history };
      this.loaded = true;
      if (credential && (!isBound(credential, cfg) || cfg.requiresRevocation)) {
        await this.stopInvalid(new ConnectorError(bindingError(credential, cfg)));
      } else if (this.canRun()) { this.state.state = "ready"; if (schedule) this.schedule(300 + Math.floor(this.random() * 400)); }
      else this.state.state = cfg.requiresRevocation ? (history.lastErrorCode === "AUTH_REJECTED" ? "auth-rejected" : "re-pair-required") : credential ? "paused" : "unconfigured";
    } catch (error) {
      this.check(epoch);
      // Unreadable is not absent, and it is not evidence a center generation ever existed.
      this.loaded = false; this.cred = null; this.state = { ...DEFAULT_STATUS, state: "host-unavailable", lastErrorCode: safeError(error) };
      if (error instanceof HostRpcError) this.state.hostReadError = error.diagnostic;
      throw error;
    }
  }
  async activate(): Promise<void> {
    const epoch = this.halt(); this.active = true; this.loaded = false; this.cred = null;
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
      this.state = { ...DEFAULT_STATUS, state: this.cfg.requiresRevocation ? "re-pair-required" : "unconfigured" }; await this.publishState(); return this.view();
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
        this.cred = credential; this.state = { ...DEFAULT_STATUS, state: "ready", projectNames: projectNames ? "available" : "unavailable" }; this.failures = 0;
        this.schedule(0); await this.publishState(); return this.view();
      } catch (error) {
        this.cred = null; this.cfg = { ...cfg, paused: true, requiresRevocation: cfg.requiresRevocation || sent };
        const code = sent && safeError(error) !== "PAIRING_FAILED" ? "PAIRING_UNCERTAIN" : safeError(error);
        this.state = { ...DEFAULT_STATUS, state: this.cfg.requiresRevocation ? "re-pair-required" : "unconfigured", lastErrorCode: code };
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
      case "connector-forget": return this.forget();
      default: throw new ConnectorError("RPC_DENIED");
    }
  }
}
