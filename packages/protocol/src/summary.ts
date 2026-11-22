import { z } from 'zod';
import { LIMITS } from './constants';

// Wire times are integer Unix milliseconds (no locale parsing). Strings are measured in UTF-16 units.
export const timeSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const plainText = (max: number) => z.string().max(max).regex(/^[^\p{Cc}\p{Cs}]*$/u);
export const idSchema = plainText(256).min(1).refine(s => s.trim() === s && s !== '.' && s !== '..');
export const statusSchema = z.enum(['working', 'waiting', 'idle', 'archived', 'unknown']);
export type SessionStatus = z.infer<typeof statusSchema>;
export const summarySchema = z.strictObject({
  id: idSchema, title: plainText(512), status: statusSchema, projectId: idSchema.nullable(),
  projectName: plainText(256).min(1).optional(), lastMessageAt: timeSchema.nullable(), updatedAt: timeSchema,
}).refine(s => s.projectId !== null || s.projectName === undefined);
export type Summary = z.infer<typeof summarySchema>;
const ids = z.array(idSchema).max(LIMITS.summaries).refine(xs => new Set(xs).size === xs.length);
export const scopeSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none'), includeArchived: z.literal(false) }),
  z.strictObject({ mode: z.literal('all'), includeArchived: z.boolean(), acknowledgeHidden: z.literal(true) }),
  z.strictObject({ mode: z.literal('projects'), includeArchived: z.boolean(), projectIds: ids, includeStandalone: z.boolean() }).refine(s => s.projectIds.length > 0 || s.includeStandalone),
  z.strictObject({ mode: z.literal('sessions'), includeArchived: z.boolean(), sessionIds: ids.refine(xs => xs.length > 0) }),
]);
export type PublishScope = z.infer<typeof scopeSchema>;
export const EMPTY_SCOPE: PublishScope = { mode: 'none', includeArchived: false };
/** Compile once per collection/validation so checking a large whitelist stays linear. */
export function scopePredicate(scope: PublishScope): (s: Pick<Summary, 'id' | 'projectId' | 'status'>) => boolean {
  const selected = new Set(scope.mode === 'projects' ? scope.projectIds : scope.mode === 'sessions' ? scope.sessionIds : []);
  return s => (s.status !== 'archived' || scope.includeArchived) && (scope.mode === 'all' ||
    (scope.mode === 'projects' && (s.projectId === null ? scope.includeStandalone : selected.has(s.projectId))) ||
    (scope.mode === 'sessions' && selected.has(s.id)));
}
export function sortedSummaries(summaries: readonly Summary[]): Summary[] {
  return Array.from(summaries).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** SHA-256 of UTF-8 JSON of id-sorted tuples, in JS UTF-16 ordinal order, no whitespace, absent name = null. */
export async function snapshotHash(summaries: readonly Summary[]): Promise<string> {
  const rows = sortedSummaries(summaries).map(s => [s.id, s.title, s.status, s.projectId, s.projectName ?? null, s.lastMessageAt, s.updatedAt]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
