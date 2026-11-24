import { HOST_METHODS, HOST_QUERIES } from "./constants";
import { ConnectorError } from "./errors";

export interface HostApi {
  request(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
}
export type RpcId = string | number;
export interface RpcMessage { jsonrpc: "2.0"; id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown }; }
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_HEADER = 8192;

export function encodeFrame(message: RpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME) throw new ConnectorError("RPC_INVALID");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Content-Length counts UTF-8 bytes, never JavaScript characters. */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  push(chunk: Uint8Array): RpcMessage[] {
    if (chunk.byteLength > MAX_FRAME * 4) throw new ConnectorError("RPC_INVALID");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: RpcMessage[] = [];
    while (this.buffer.length > 0) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (this.buffer.length > MAX_HEADER) throw new ConnectorError("RPC_INVALID");
        break;
      }
      if (end > MAX_HEADER) throw new ConnectorError("RPC_INVALID");
      const header = this.buffer.subarray(0, end).toString("ascii");
      const lengths = header.split("\r\n").filter(line => /^Content-Length:/i.test(line));
      if (lengths.length !== 1 || !/^Content-Length:\s*[1-9]\d*\s*$/i.test(lengths[0]!)) throw new ConnectorError("RPC_INVALID");
      const length = Number(lengths[0]!.slice(15).trim());
      if (!Number.isSafeInteger(length) || length > MAX_FRAME) throw new ConnectorError("RPC_INVALID");
      if (this.buffer.length < end + 4 + length) break;
      let message: unknown;
      try { message = JSON.parse(this.decoder.decode(this.buffer.subarray(end + 4, end + 4 + length))); }
      catch { throw new ConnectorError("RPC_INVALID"); }
      if (!message || typeof message !== "object" || Array.isArray(message) || (message as RpcMessage).jsonrpc !== "2.0") throw new ConnectorError("RPC_INVALID");
      const frame = message as RpcMessage;
      if (frame.id !== undefined && typeof frame.id !== "string" && (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id))) throw new ConnectorError("RPC_INVALID");
      if (frame.method !== undefined && typeof frame.method !== "string") throw new ConnectorError("RPC_INVALID");
      messages.push(frame);
      this.buffer = this.buffer.subarray(end + 4 + length);
    }
    return messages;
  }
}

const HOST_ERROR_IDS = new Set(["PERMISSION_DENIED", "CONTEXT_UNAVAILABLE", "HOST_UNAVAILABLE", "RUNTIME_NOT_ACTIVE", "STALE_GENERATION", "NOT_NEGOTIATED", "INVALID_PARAMS", "METHOD_NOT_FOUND", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "TOO_MANY_REQUESTS", "REQUEST_CANCELLED", "TIMEOUT", "NOT_FOUND_OR_DENIED"]);
export interface SafeHostDiagnostic { method: string; rpcCode: number | null; hostCode: string; }
export class HostRpcError extends ConnectorError {
  readonly diagnostic: SafeHostDiagnostic;
  constructor(method: string, error: NonNullable<RpcMessage["error"]>) {
    const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
    const hostCode = typeof data.code === "string" && HOST_ERROR_IDS.has(data.code) ? data.code : "UNCLASSIFIED";
    super(hostCode === "PERMISSION_DENIED" ? "RPC_DENIED" : "HOST_UNAVAILABLE");
    this.diagnostic = { method, rpcCode: Number.isSafeInteger(error.code) ? error.code : null, hostCode };
  }
}
type Pending = { method: string; resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };
export class StdioHostRpc implements HostApi {
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<RpcId, Pending>();
  constructor(private readonly write: (message: RpcMessage) => void) {}
  request(method: string, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closed || options.signal?.aborted) return Promise.reject(new ConnectorError("CANCELLED"));
    if (!HOST_METHODS.has(method)) return Promise.reject(new ConnectorError("RPC_DENIED"));
    if (method === "queries.execute" && (!params || typeof params !== "object" || !HOST_QUERIES.has((params as { queryId: string }).queryId))) return Promise.reject(new ConnectorError("RPC_DENIED"));
    if (this.pending.size >= 16) return Promise.reject(new ConnectorError("BUSY"));
    const id = `connector-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (error: ConnectorError) => {
        const pending = this.pending.get(id); if (!pending) return;
        pending.cleanup(); this.pending.delete(id); reject(error);
      };
      const cancel = () => finish(new ConnectorError("CANCELLED"));
      const timer = setTimeout(() => finish(new ConnectorError("RPC_TIMEOUT")), Math.min(options.timeoutMs ?? 10_000, 90_000));
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { method, resolve, reject, cleanup });
      options.signal?.addEventListener("abort", cancel, { once: true });
      try { this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); }
      catch { finish(new ConnectorError("RPC_INVALID")); }
    });
  }
  accept(message: RpcMessage): void {
    if (message.method !== undefined || message.id === undefined) return;
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); pending.cleanup();
    if (message.error) pending.reject(new HostRpcError(pending.method, message.error));
    else if (!("result" in message)) pending.reject(new ConnectorError("RPC_INVALID"));
    else pending.resolve(message.result);
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new ConnectorError("CANCELLED")); }
    this.pending.clear();
  }
}
