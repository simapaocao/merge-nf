import { LIMITS, idSchema, scopePredicate, scopeSchema, sortedSummaries, summarySchema, type PublishScope, type Summary } from "@nf-hub/protocol";
import { ConnectorError, assertActive } from "./errors";
import type { HostApi } from "./host-rpc";

type RecordLike = Record<string, unknown>;
export interface Collection { summaries: Summary[]; projectNames: "available" | "unavailable" | "not-needed"; pages: number; }
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
  if (scope.mode === "none") return { summaries: [], projectNames: "not-needed", pages: 0 };
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
  const selected = scopePredicate(scope), seenIds = new Set<string>(), summaries: Summary[] = [];
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
  return { summaries: sortedSummaries(summaries), projectNames, pages };
}
