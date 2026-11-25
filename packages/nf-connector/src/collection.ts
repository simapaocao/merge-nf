import { LIMITS, idSchema, scopePredicate, scopeSchema, sortedSummaries, summarySchema, type PublishScope, type SessionMetadataItem, type Summary } from "@nf-hub/protocol";
import { SESSION_RELATIONSHIPS_BATCH, SESSION_RELATIONSHIPS_COLLECT_MS, SESSION_RELATIONSHIPS_QUERY_ID, sessionRelationshipsInputSchema, sessionRelationshipsOutputSchema } from "@nf-hub/protocol";
import { ConnectorError, assertActive } from "./errors";
import { HostRpcError, type HostApi } from "./host-rpc";

type RecordLike = Record<string, unknown>;
export interface Collection { summaries: Summary[]; sessionMetadata: SessionMetadataItem[]; projectNames: "available" | "unavailable" | "not-needed"; pages: number; }
export interface CollectOptions { signal?: AbortSignal; now?: () => number; projectNames?: boolean; }
function record(value: unknown): RecordLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("INVALID_RECORD");
  return value as RecordLike;
}
function id(value: unknown): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new ConnectorError("INVALID_RECORD");
  return parsed.data;
}
export function safeText(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new ConnectorError("INVALID_RECORD");
  const clean = value.replace(/[\p{Cc}\p{Cs}]/gu, " ");
  let end = Math.min(clean.length, max);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(clean[end - 1]!)) end--;
  return clean.slice(0, end);
}
export function hostTime(value: unknown, nullable = false): number | null {
  if ((value === null || value === undefined) && nullable) return null;
  const result = typeof value === "number" ? value : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0 || result > 8_640_000_000_000_000) throw new ConnectorError("INVALID_RECORD");
  return result;
}
/** Explicit whitelist: host fields such as model, handle, path, text and substatus never leave this function. */
export function redactSummary(value: unknown): Summary {
  const row = record(value);
  if (!("projectId" in row) || row.projectId === undefined || typeof row.status !== "string") throw new ConnectorError("INVALID_RECORD");
  const status = ["working", "waiting", "idle", "archived"].includes(row.status as string) ? row.status as Summary["status"] : "unknown";
  const parsed = summarySchema.safeParse({
    id: id(row.id), title: safeText(row.title, 512), status,
    projectId: row.projectId == null ? null : id(row.projectId),
    lastMessageAt: hostTime(row.lastMessageAt, true), updatedAt: hostTime(row.updatedAt),
  });
  if (!parsed.success) throw new ConnectorError("INVALID_RECORD");
  return parsed.data;
}

export async function collectSummaries(host: HostApi, rawScope: PublishScope, options: CollectOptions = {}): Promise<Collection> {
  const scope = scopeSchema.parse(rawScope);
  const now = options.now ?? Date.now;
  const deadline = now() + LIMITS.collectMs;
  let pages = 0;
  const check = () => { assertActive(options.signal); if (now() >= deadline) throw new ConnectorError("COLLECTION_TIMEOUT"); };
  if (scope.mode === "none") return { summaries: [], sessionMetadata: [], projectNames: "not-needed", pages: 0 };
  async function traverse(queryId: string, input: RecordLike, consume: (row: unknown) => void): Promise<void> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    while (true) {
      check();
      if (++pages > LIMITS.hostPages) throw new ConnectorError("LIMIT_EXCEEDED");
      let result: unknown;
      try {
        result = await host.request("queries.execute", { queryId, input: { ...input, limit: LIMITS.pageSize, ...(cursor ? { cursor } : {}) } }, { signal: options.signal, timeoutMs: Math.min(10_000, deadline - now()) });
      } catch (error) {
        check();
        if (error instanceof ConnectorError && error.code === "RPC_TIMEOUT") throw new ConnectorError("COLLECTION_TIMEOUT");
        throw new ConnectorError("QUERY_FAILED");
      }
      check();
      const response = record(result);
      if (response.status !== "succeeded") throw new ConnectorError("QUERY_FAILED");
      const data = record(response.data), page = record(response.page);
      if (!Array.isArray(data.items) || data.items.length > LIMITS.pageSize || typeof page.hasMore !== "boolean") throw new ConnectorError("CURSOR_INVALID");
      for (const row of data.items) { check(); consume(row); }
      if (!page.hasMore) {
        if (page.nextCursor !== null && page.nextCursor !== undefined && page.nextCursor !== "") throw new ConnectorError("CURSOR_INVALID");
        return;
      }
      if (data.items.length === 0 || typeof page.nextCursor !== "string" || page.nextCursor.length === 0 || page.nextCursor.length > 8192 || cursors.has(page.nextCursor)) throw new ConnectorError("CURSOR_INVALID");
      cursor = page.nextCursor; cursors.add(cursor);
    }
  }
  const selected = scopePredicate(scope), seenIds = new Set<string>(), summaries: Summary[] = [], sessionMetadata: SessionMetadataItem[] = [];
  const statusFilter = scope.includeArchived ? {} : { status: ["idle", "working", "waiting"] };
  // Use supported upstream filters. Standalone and session-ID filters require scanning local summaries.
  const projectIds = scope.mode === "projects" && !scope.includeStandalone ? scope.projectIds : [undefined];
  for (const projectId of projectIds) await traverse("narrafork.narrators.list", { ...statusFilter, ...(projectId ? { projectId } : {}) }, row => {
    const summary = redactSummary(row);
    if (seenIds.has(summary.id)) throw new ConnectorError("DUPLICATE_ID");
    seenIds.add(summary.id);
    if (!selected(summary)) return;
    if (summaries.length >= LIMITS.summaries) throw new ConnectorError("LIMIT_EXCEEDED");
    summaries.push(summary);
    // Capture only the public enum from this exact list row after scope filtering; never attach it to Summary.
    const kind = record(row).type;
    sessionMetadata.push({ id: summary.id, kind: kind === "primary" || kind === "subagent" ? kind : null, parentKnown: false, parentId: null });
  });
  const wanted = new Set(summaries.flatMap(row => row.projectId === null ? [] : [row.projectId]));
  let projectNames: Collection["projectNames"] = "not-needed";
  if (wanted.size && options.projectNames === true) {
    const names = new Map<string, string>(), seenProjects = new Set<string>();
    try {
      await traverse("narrafork.projects.list", {}, raw => {
        const project = record(raw), projectId = id(project.id);
        if (seenProjects.has(projectId)) throw new ConnectorError("DUPLICATE_ID");
        seenProjects.add(projectId);
        if (wanted.has(projectId)) {
          const name = safeText(project.name, 256).trim();
          if (name) names.set(projectId, name);
        }
      });
      for (const row of summaries) if (row.projectId !== null && names.has(row.projectId)) row.projectName = names.get(row.projectId)!;
      projectNames = "available";
    } catch (error) {
      check();
      if (error instanceof ConnectorError && ["CANCELLED", "COLLECTION_TIMEOUT", "LIMIT_EXCEEDED"].includes(error.code)) throw error;
      // Capability was fixed at pairing; breaking that promise fails the complete round.
      throw new ConnectorError("PROJECT_QUERY_FAILED");
    }
  }
  check();
  sessionMetadata.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { summaries: sortedSummaries(summaries), sessionMetadata, projectNames, pages };
}

export interface RelationshipsCollection {
  items: SessionMetadataItem[];
  support: "available" | "unsupported" | "denied" | "unknown";
  errorCode: string | null;
}
/** A bounded optional query over the complete published ID set, never a details/root/ancestor lookup. */
export async function collectSessionRelationships(host: HostApi, metadata: readonly SessionMetadataItem[], options: Pick<CollectOptions, "signal" | "now"> = {}): Promise<RelationshipsCollection> {
  const unknown = metadata.map(item => ({ id: item.id, kind: item.kind, parentKnown: false, parentId: null }));
  const now = options.now ?? Date.now, deadline = now() + SESSION_RELATIONSHIPS_COLLECT_MS;
  const all = new Set(unknown.map(item => item.id)), parents = new Map<string, { parentKnown: boolean; parentId: string | null }>();
  try {
    assertActive(options.signal);
    for (let offset = 0; offset < unknown.length; offset += SESSION_RELATIONSHIPS_BATCH) {
      assertActive(options.signal);
      if (now() >= deadline) return { items: unknown, support: "unknown", errorCode: "RELATIONSHIPS_TIMEOUT" };
      const batch = unknown.slice(offset, offset + SESSION_RELATIONSHIPS_BATCH).map(item => item.id);
      const result = record(await host.request("queries.execute", { queryId: SESSION_RELATIONSHIPS_QUERY_ID, input: sessionRelationshipsInputSchema.parse({ narratorIds: batch }) }, {
        signal: options.signal, timeoutMs: Math.min(10_000, Math.max(1, deadline - now())),
      }));
      assertActive(options.signal);
      if (now() >= deadline) return { items: unknown, support: "unknown", errorCode: "RELATIONSHIPS_TIMEOUT" };
      if (result.status !== "succeeded") return { items: unknown, support: "unknown", errorCode: "RELATIONSHIPS_QUERY_FAILED" };
      const response = sessionRelationshipsOutputSchema.safeParse(result.data);
      if (!response.success) return { items: unknown, support: "unknown", errorCode: "RELATIONSHIPS_QUERY_FAILED" };
      const asked = new Set(batch);
      for (const item of response.data.items) {
        if (!asked.has(item.id)) return { items: unknown, support: "unknown", errorCode: "RELATIONSHIPS_QUERY_FAILED" };
        // The public host query checks its own scope/ACL. The connector further restricts the parent to the full
        // exact base publication, including parents in a later batch and excluding every unsynchronised parent.
        if (item.parentKnown && (item.parentId === null || all.has(item.parentId))) parents.set(item.id, { parentKnown: true, parentId: item.parentId });
      }
    }
    return { items: unknown.map(item => ({ ...item, ...parents.get(item.id) })), support: "available", errorCode: null };
  } catch (error) {
    assertActive(options.signal);
    const hostCode = error instanceof HostRpcError ? error.diagnostic.hostCode : null;
    if (hostCode === "METHOD_NOT_FOUND") return { items: unknown, support: "unsupported", errorCode: "RELATIONSHIPS_UNSUPPORTED" };
    if (hostCode === "NOT_FOUND_OR_DENIED" || hostCode === "PERMISSION_DENIED" || error instanceof ConnectorError && error.code === "RPC_DENIED") {
      return { items: unknown, support: "denied", errorCode: "RELATIONSHIPS_PERMISSION_DENIED" };
    }
    return { items: unknown, support: "unknown", errorCode: error instanceof ConnectorError && error.code === "RPC_TIMEOUT" ? "RELATIONSHIPS_TIMEOUT" : "RELATIONSHIPS_QUERY_FAILED" };
  }
}
