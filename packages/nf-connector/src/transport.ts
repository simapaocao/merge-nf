import { ACTIVITY_SNAPSHOT_ROUTE, LIMITS, PROTOCOL_VERSION, activityPublicationSchema, activityReceiptSchema, failedRequestSchema, pairRequestSchema, pairResponseSchema, routes, runRequestSchema, runResponseSchema, snapshotRequestSchema, snapshotResponseSchema, type ActivityPublication, type ActivityReceipt, type FailedRequest, type PairRequest, type PairResponse, type RunResponse, type SnapshotRequest, type SnapshotResponse } from "@nf-hub/protocol";
import { SESSION_METADATA_ROUTE, sessionMetadataPublicationSchema, sessionMetadataReceiptSchema, type SessionMetadataPublication, type SessionMetadataReceipt } from "@nf-hub/protocol";
import { normalizeBaseUrl, type BoundCredential } from "./config";
import { ConnectorError, assertActive } from "./errors";
import { centerTrust, type CenterTrust } from "./center-trust";

export type Fetcher = (url: string, init: RequestInit & { proxy?: false; tls?: { rejectUnauthorized: true; ca?: string } }) => Promise<Response>;
interface Schema<T> { safeParse(input: unknown): { success: true; data: T } | { success: false }; }
export class CenterClient {
  readonly baseUrl: string;
  private readonly trust: CenterTrust;
  constructor(baseUrl: string, private readonly fetcher: Fetcher = fetch, options: Partial<CenterTrust> & { allowLoopbackHttp?: boolean } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl, options);
    this.trust = centerTrust(options.centerCaPem, options.centerCaSha256);
    if (this.trust.centerCaPem !== null && !this.baseUrl.startsWith("https://")) throw new ConnectorError("CONFIG_INVALID");
  }
  private async post<T>(path: string, body: unknown, schema: Schema<T> | null, token: string | null, signal?: AbortSignal, options: { activity?: boolean; sessionMetadata?: boolean } = {}): Promise<T> {
    assertActive(signal);
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, "utf8") > LIMITS.snapshotBytes) throw new ConnectorError("LIMIT_EXCEEDED");
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST", credentials: "omit", redirect: "error", proxy: false,
        // Do not share pooled connections between old and newly confirmed trust settings.
        keepalive: false, tls: { rejectUnauthorized: true, ...(this.trust.centerCaPem === null ? {} : { ca: this.trust.centerCaPem }) }, signal: combined,
        headers: { "Content-Type": "application/json", "Accept": "application/json", ...(token === null ? {} : { "Authorization": `Bearer ${token}` }) }, body: text,
      });
      assertActive(signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // A missing activity route on an older center is reported as "this center does not support it".
        // It never touches the base summary credential, and the caller caches it for this destination.
        if (options.activity === true && response.status === 404) throw new ConnectorError("ACTIVITY_UNSUPPORTED");
        if (options.sessionMetadata === true && response.status === 404) throw new ConnectorError("SESSION_METADATA_UNSUPPORTED");
        if (token !== null && (response.status === 401 || response.status === 403)) throw new ConnectorError("AUTH_REJECTED", true);
        throw new ConnectorError(token === null ? "PAIRING_FAILED" : "HTTP_FAILED");
      }
      if (schema === null) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status !== 204) throw new ConnectorError("RESPONSE_INVALID");
        return undefined as T;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new ConnectorError("RESPONSE_INVALID");
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new ConnectorError("RESPONSE_INVALID");
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 65_536) { await reader.cancel(); throw new ConnectorError("RESPONSE_INVALID"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      assertActive(signal);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new ConnectorError("RESPONSE_INVALID"); }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ConnectorError("RESPONSE_INVALID");
      return parsed.data;
    } catch (error) {
      assertActive(signal);
      if (error instanceof ConnectorError) throw error;
      if (timeout.signal.aborted) throw new ConnectorError("HTTP_TIMEOUT");
      throw new ConnectorError("HTTP_FAILED");
    } finally { clearTimeout(timer); }
  }
  pair(input: PairRequest, signal?: AbortSignal): Promise<PairResponse> {
    return this.post(routes.pair, pairRequestSchema.parse(input), pairResponseSchema, null, signal);
  }
  private bound(credential: BoundCredential): void {
    if (credential.baseUrl !== this.baseUrl) throw new ConnectorError("BASE_URL_CHANGED", true);
    if (credential.centerCaSha256 !== this.trust.centerCaSha256) throw new ConnectorError("CA_CHANGED", true);
  }
  async run(credential: BoundCredential, signal?: AbortSignal): Promise<RunResponse> {
    this.bound(credential);
    const request = runRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, generation: credential.pairing.generation });
    const result = await this.post(routes.runs, request, runResponseSchema, credential.pairing.token, signal);
    if (result.generation !== credential.pairing.generation) throw new ConnectorError("RESPONSE_INVALID");
    return result;
  }
  async snapshot(credential: BoundCredential, input: SnapshotRequest, signal?: AbortSignal): Promise<SnapshotResponse> {
    this.bound(credential);
    const request = snapshotRequestSchema.parse(input);
    if (request.generation !== credential.pairing.generation) throw new ConnectorError("RESPONSE_INVALID");
    const result = await this.post(routes.snapshot(input.runId), request, snapshotResponseSchema, credential.pairing.token, signal);
    if (result.runId !== input.runId) throw new ConnectorError("RESPONSE_INVALID");
    return result;
  }
  async failed(credential: BoundCredential, input: FailedRequest, signal?: AbortSignal): Promise<void> {
    this.bound(credential);
    const request = failedRequestSchema.parse(input);
    if (request.generation !== credential.pairing.generation) throw new ConnectorError("RESPONSE_INVALID");
    await this.post(routes.failed(input.runId), request, null, credential.pairing.token, signal);
  }
  /**
   * Independent activity publication. Same configured center, same Bearer identity, same strict TLS and
   * `redirect: "error"` policy as the base snapshot, but its own fixed route and its own failure domain:
   * nothing here can invalidate, replace or re-scope the base summary credential.
   */
  async sessionMetadata(credential: BoundCredential, input: SessionMetadataPublication, signal?: AbortSignal): Promise<SessionMetadataReceipt> {
    this.bound(credential);
    const request = sessionMetadataPublicationSchema.parse(input);
    if (request.generation !== credential.pairing.generation) throw new ConnectorError("RESPONSE_INVALID");
    return this.post(SESSION_METADATA_ROUTE, request, sessionMetadataReceiptSchema, credential.pairing.token, signal, { sessionMetadata: true });
  }
  async activity(credential: BoundCredential, input: ActivityPublication, signal?: AbortSignal): Promise<ActivityReceipt> {
    this.bound(credential);
    const request = activityPublicationSchema.parse(input);
    if (request.generation !== credential.pairing.generation) throw new ConnectorError("RESPONSE_INVALID");
    return this.post(ACTIVITY_SNAPSHOT_ROUTE, request, activityReceiptSchema, credential.pairing.token, signal, { activity: true });
  }
}
