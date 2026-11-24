import {
  ACTIVITY_BATCH, ACTIVITY_COLLECT_MS, ACTIVITY_MAX_ITEMS, ACTIVITY_QUERY_ID,
  activityItemSchema, activityQueryInputSchema, activityQueryOutputSchema, idSchema,
  type ActivityItem,
} from "@nf-hub/protocol";
import { ConnectorError, assertActive } from "./errors";
import { HostRpcError, type HostApi } from "./host-rpc";

export interface ActivityCollection {
  /** Rows the host actually answered, projected to the public whitelist and sorted by ID. */
  items: ActivityItem[];
  /** Requested base IDs the host omitted because they are unknown, unreadable or outside the trusted scope. */
  unknownIds: string[];
  observedAt: number;
}
export interface ActivityOptions { signal?: AbortSignal; now?: () => number; }

/**
 * The single host code that means "this host build does not expose the activity query": `queries.execute`
 * itself already works, so an unknown query ID is reported as METHOD_NOT_FOUND.
 *
 * Every other confirmed host code is a real outcome and must not be mistaken for "unsupported", because caching
 * it would silently turn missing signals into a permanent no-signal state:
 * - INVALID_PARAMS: strict input rejected -> our request disagreed with the host contract.
 * - NOT_FOUND_OR_DENIED: the requested project conflicts with the trusted scope -> denied, not absent.
 * - HOST_UNAVAILABLE (adapter/source missing, incomplete, over budget, background failure): retryable.
 * - CANCELLED: this round was fenced off.
 */
const UNSUPPORTED_HOST_CODE = "METHOD_NOT_FOUND";

/**
 * Map a host RPC failure to an activity-only local code. The base summary path is never involved:
 * an unsupported host or a denied permission degrades this side channel only, and a missing answer
 * is reported as an error instead of being turned into all-false attention flags.
 */
export function activityHostError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError && error.code === "CANCELLED") return error;
  if (error instanceof ConnectorError && error.code === "RPC_TIMEOUT") return new ConnectorError("ACTIVITY_TIMEOUT");
  if (error instanceof ConnectorError && error.code === "RPC_DENIED") return new ConnectorError("ACTIVITY_PERMISSION_DENIED");
  if (error instanceof HostRpcError) {
    if (error.diagnostic.hostCode === "PERMISSION_DENIED") return new ConnectorError("ACTIVITY_PERMISSION_DENIED");
    // A project that conflicts with the trusted scope is a denial, not an absence of signals.
    if (error.diagnostic.hostCode === "NOT_FOUND_OR_DENIED") return new ConnectorError("ACTIVITY_PERMISSION_DENIED");
    // Only an explicitly unknown query ID means "this host predates the activity query". A host-side unavailability
    // stays a retryable failure so a transient outage is never cached as "no activity signals exist".
    if (error.diagnostic.hostCode === UNSUPPORTED_HOST_CODE) return new ConnectorError("ACTIVITY_UNSUPPORTED");
  }
  return new ConnectorError("ACTIVITY_QUERY_FAILED");
}

/**
 * Collect attention/background metadata for exactly the published base summary IDs.
 *
 * Contract:
 * - Only IDs that survived the original scope filter and were actually published are asked for.
 * - No message, event, detail or substatus read: a single whitelisted query, projected fields only.
 * - The host omits IDs that are unknown, unreadable or outside the trusted scope. Those are returned as
 *   `unknownIds` and are never turned into all-false attention flags.
 * - A row that was not requested, or a duplicated row, fails the batch: that answer does not belong to this
 *   publication and cannot be trusted for any ID.
 * - The result is sorted by ID so the canonical hash never depends on host ordering.
 */
export async function collectActivity(host: HostApi, baseIds: readonly string[], options: ActivityOptions = {}): Promise<ActivityCollection> {
  const now = options.now ?? Date.now;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of baseIds) {
    const parsed = idSchema.safeParse(raw);
    if (!parsed.success) throw new ConnectorError("INVALID_RECORD");
    if (seen.has(parsed.data)) throw new ConnectorError("DUPLICATE_ID");
    seen.add(parsed.data); ids.push(parsed.data);
  }
  if (ids.length > ACTIVITY_MAX_ITEMS) throw new ConnectorError("ACTIVITY_LIMIT_EXCEEDED");
  // An empty base scope has no rows to describe; nothing is asked of the host and nothing is implied.
  if (ids.length === 0) return { items: [], unknownIds: [], observedAt: now() };

  const deadline = now() + ACTIVITY_COLLECT_MS;
  const check = () => { assertActive(options.signal); if (now() >= deadline) throw new ConnectorError("ACTIVITY_TIMEOUT"); };
  const items: ActivityItem[] = [], answered = new Set<string>();
  let observedAt = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < ids.length; offset += ACTIVITY_BATCH) {
    check();
    const batch = ids.slice(offset, offset + ACTIVITY_BATCH);
    const input = activityQueryInputSchema.parse({ narratorIds: batch });
    let result: unknown;
    try {
      result = await host.request("queries.execute", { queryId: ACTIVITY_QUERY_ID, input }, { signal: options.signal, timeoutMs: Math.min(10_000, Math.max(1, deadline - now())) });
    } catch (error) { check(); throw activityHostError(error); }
    check();
    const response = result && typeof result === "object" && !Array.isArray(result) ? result as { status?: unknown; data?: unknown } : null;
    if (response?.status !== "succeeded") throw new ConnectorError("ACTIVITY_QUERY_FAILED");
    const parsed = activityQueryOutputSchema.safeParse(response.data);
    if (!parsed.success) throw new ConnectorError("ACTIVITY_QUERY_FAILED");
    const wanted = new Set(batch);
    for (const row of parsed.data.items) {
      // A row outside the requested base IDs means the answer does not belong to this publication.
      if (!wanted.has(row.id)) throw new ConnectorError("ACTIVITY_INCOMPLETE");
      wanted.delete(row.id); answered.add(row.id);
      items.push(activityItemSchema.parse({
        id: row.id, reply: row.attention.reply, approval: row.attention.approval,
        error: row.attention.error, unread: row.attention.unread, backgroundWorkCount: row.backgroundWorkCount,
      }));
    }
    // Whatever the host omitted stays unknown for this round; it is reported, never synthesised as false.
    observedAt = Math.min(observedAt, parsed.data.observedAt);
  }
  check();
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { items, unknownIds: ids.filter(id => !answered.has(id)).sort(), observedAt: Number.isFinite(observedAt) ? observedAt : now() };
}
