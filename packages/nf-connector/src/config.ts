import { createHash } from "node:crypto";
import { EMPTY_SCOPE, LIMITS, pairResponseSchema, scopeSchema, type PairResponse, type PublishScope } from "@nf-hub/protocol";
import { CREDENTIAL_KEY, GLOBAL_SCOPE, SETTINGS_KEY, STATUS_KEY } from "./constants";
import { ConnectorError } from "./errors";
import type { HostApi, SafeHostDiagnostic } from "./host-rpc";
import { centerTrust, DEFAULT_TRUST, type CenterTrust } from "./center-trust";

export interface Settings extends CenterTrust { version: 1; baseUrl: string; scope: PublishScope; wantProjectNames: boolean; intervalMs: number; confirmed: boolean; paused: boolean; requiresRevocation: boolean; }
export interface BoundCredential { version: 1; baseUrl: string; centerCaSha256: string | null; scopeKey: string; projectNames: boolean; pairing: PairResponse; }
export interface ConnectionStatus {
  state: "inactive" | "host-unavailable" | "unconfigured" | "paused" | "pairing" | "ready" | "collecting" | "backoff" | "auth-rejected" | "re-pair-required";
  lastSuccessAt: number | null; lastAttemptAt: number | null; lastErrorCode: string | null; lastCount: number | null;
  projectNames: "available" | "unavailable" | "not-needed"; nextAttemptAt: number | null;
  hostReadError?: SafeHostDiagnostic;
}
export const DEFAULT_SETTINGS: Settings = { version: 1, baseUrl: "", ...DEFAULT_TRUST, scope: EMPTY_SCOPE, wantProjectNames: true, intervalMs: LIMITS.intervalMs, confirmed: false, paused: true, requiresRevocation: false };
export const DEFAULT_STATUS: ConnectionStatus = { state: "inactive", lastSuccessAt: null, lastAttemptAt: null, lastErrorCode: null, lastCount: null, projectNames: "not-needed", nextAttemptAt: null };

/** The production entry never enables the loopback exception. Base paths are supported; redirects and URL credentials are not. */
export function normalizeBaseUrl(raw: unknown, options: { allowLoopbackHttp?: boolean } = {}): string {
  if (typeof raw !== "string" || raw.length > 2048 || !/^https?:\/\//i.test(raw) || /[\u0000-\u0020\\?#]/u.test(raw)) throw new ConnectorError("CONFIG_INVALID");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConnectorError("CONFIG_INVALID"); }
  if (!url.hostname || url.username || url.password || /%(?:2f|5c|2e)/i.test(raw) || url.pathname.includes("//")) throw new ConnectorError("CONFIG_INVALID");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(options.allowLoopbackHttp === true && loopback && url.protocol === "http:")) throw new ConnectorError("CONFIG_INVALID");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}
/** This is a local consent/binding digest, not the wire snapshot hash. No large list needs to be stored in the vault. */
export function bindingKey(settings: Pick<Settings, "baseUrl" | "scope" | "wantProjectNames"> & { centerCaSha256?: string | null }): string {
  const scope = settings.scope;
  const descriptor = scope.mode === "projects" ? [scope.mode, scope.includeArchived, [...scope.projectIds].sort(), scope.includeStandalone] : scope.mode === "sessions" ? [scope.mode, scope.includeArchived, [...scope.sessionIds].sort()] : [scope.mode, scope.includeArchived];
  const fields: unknown[] = [settings.baseUrl, descriptor, settings.wantProjectNames];
  // Preserve existing 0.1.0 default-trust pairings; custom trust always has a distinct digest.
  if (settings.centerCaSha256 != null) fields.push(["center-ca-sha256", settings.centerCaSha256]);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("CONFIG_INVALID");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["version", "baseUrl", "centerCaPem", "centerCaSha256", "scope", "wantProjectNames", "intervalMs", "confirmed", "paused", "requiresRevocation"].includes(key))) throw new ConnectorError("CONFIG_INVALID");
  const scope = scopeSchema.safeParse(input.scope);
  if (input.version !== 1 || !scope.success || typeof input.confirmed !== "boolean" || typeof input.wantProjectNames !== "boolean" || typeof input.paused !== "boolean" || typeof input.requiresRevocation !== "boolean" || typeof input.intervalMs !== "number" || !Number.isInteger(input.intervalMs) || input.intervalMs < 5_000 || input.intervalMs > 3_600_000) throw new ConnectorError("CONFIG_INVALID");
  const baseUrl = input.baseUrl === "" ? "" : normalizeBaseUrl(input.baseUrl);
  const trust = centerTrust(input.centerCaPem, input.centerCaSha256);
  if (trust.centerCaPem !== null && !baseUrl) throw new ConnectorError("CONFIG_INVALID");
  return { version: 1, baseUrl, ...trust, scope: scope.data, wantProjectNames: input.wantProjectNames, intervalMs: input.intervalMs, confirmed: input.confirmed, paused: input.paused, requiresRevocation: input.requiresRevocation };
}
export function bindingError(credential: BoundCredential, settings: Settings): "BASE_URL_CHANGED" | "CA_CHANGED" | "SCOPE_CHANGED" {
  return credential.baseUrl !== settings.baseUrl ? "BASE_URL_CHANGED" : credential.centerCaSha256 !== settings.centerCaSha256 ? "CA_CHANGED" : "SCOPE_CHANGED";
}
export function isBound(credential: BoundCredential, settings: Settings): boolean { return (!credential.projectNames || settings.wantProjectNames) && credential.baseUrl === settings.baseUrl && credential.centerCaSha256 === settings.centerCaSha256 && credential.scopeKey === bindingKey(settings); }
function historyBinding(credential: BoundCredential | null): string | null {
  return credential ? `${credential.pairing.instanceId}:${credential.pairing.generation}:${credential.scopeKey}` : null;
}
export function parseCredential(raw: unknown): BoundCredential | null {
  if (raw === null || raw === undefined) return null;
  try {
    if (typeof raw !== "string" || raw.length > 4096) throw new Error();
    const input = JSON.parse(raw);
    if (!input || input.version !== 1 || typeof input.scopeKey !== "string" || !/^[a-f0-9]{64}$/.test(input.scopeKey) || typeof input.projectNames !== "boolean" || Object.keys(input).some(key => !["version", "baseUrl", "centerCaSha256", "scopeKey", "projectNames", "pairing"].includes(key))) throw new Error();
    const baseUrl = normalizeBaseUrl(input.baseUrl), centerCaSha256 = input.centerCaSha256 ?? null;
    if (baseUrl !== input.baseUrl || (centerCaSha256 !== null && (typeof centerCaSha256 !== "string" || !/^[0-9a-f]{64}$/.test(centerCaSha256)))) throw new Error();
    return { version: 1, baseUrl, centerCaSha256, scopeKey: input.scopeKey, projectNames: input.projectNames, pairing: pairResponseSchema.parse(input.pairing) };
  } catch { throw new ConnectorError("SECRET_UNAVAILABLE", true); }
}
export class HostRepository {
  constructor(private readonly host: HostApi) {}
  private async value(key: string): Promise<unknown> {
    const entry = await this.host.request("storage.get", { scope: GLOBAL_SCOPE, key }) as { value?: unknown } | null;
    if (entry === null) return null;
    if (typeof entry !== "object" || !("value" in entry)) throw new ConnectorError("RPC_INVALID");
    return entry.value;
  }
  async settings(): Promise<Settings> {
    const value = await this.value(SETTINGS_KEY);
    return value === null ? structuredClone(DEFAULT_SETTINGS) : parseSettings(value);
  }
  async writeSettings(settings: Settings): Promise<void> { await this.host.request("storage.set", { scope: GLOBAL_SCOPE, key: SETTINGS_KEY, value: parseSettings(settings) }); }
  async writeStatus(status: ConnectionStatus, credential: BoundCredential | null): Promise<void> { await this.host.request("storage.set", { scope: GLOBAL_SCOPE, key: STATUS_KEY, value: { ...status, historyBinding: historyBinding(credential) } }); }
  async history(credential: BoundCredential | null): Promise<Partial<ConnectionStatus>> {
    const data = await this.value(STATUS_KEY);
    if (!data || typeof data !== "object") return {};
    const v = data as Record<string, unknown>;
    if (v.historyBinding !== historyBinding(credential)) return {};
    // Only whitelisted metadata is restored; never replay in-progress runs or previously collected rows.
    const lastSuccessAt = typeof v.lastSuccessAt === "number" && Number.isSafeInteger(v.lastSuccessAt) && v.lastSuccessAt >= 0 && v.lastSuccessAt <= 8_640_000_000_000_000 ? v.lastSuccessAt : null;
    const lastCount = typeof v.lastCount === "number" && Number.isInteger(v.lastCount) && v.lastCount >= 0 && v.lastCount <= LIMITS.summaries ? v.lastCount : null;
    const lastErrorCode = typeof v.lastErrorCode === "string" && ["AUTH_REJECTED", "PROJECT_QUERY_FAILED", "PAIRING_UNCERTAIN", "BASE_URL_CHANGED", "CA_CHANGED", "CA_INVALID", "CA_FINGERPRINT_MISMATCH", "SCOPE_CHANGED"].includes(v.lastErrorCode) ? v.lastErrorCode : null;
    return { lastSuccessAt, lastCount, lastErrorCode };
  }
  async secret(key: string): Promise<string | null> {
    const entry = await this.host.request("secrets.get", { key }) as { key?: unknown; value?: unknown } | null;
    // NF 0.9.14 returns {key, value:null} for an unset secret. A denied read or malformed reply is not a missing secret.
    if (!entry || entry.key !== key || !("value" in entry)) throw new ConnectorError("SECRET_UNAVAILABLE");
    if (entry.value === null) return null;
    if (typeof entry.value !== "string") throw new ConnectorError("SECRET_UNAVAILABLE");
    return entry.value;
  }
  async setSecret(key: string, value: string): Promise<void> { await this.host.request("secrets.set", { key, value }); }
  async deleteSecret(key: string): Promise<void> { await this.host.request("secrets.delete", { key }); }
  async credential(): Promise<BoundCredential | null> { return parseCredential(await this.secret(CREDENTIAL_KEY)); }
}
