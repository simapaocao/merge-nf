import { z } from 'zod';
import { LIMITS } from './constants';
import { generationSchema, versionSchema } from './connector';
import { idSchema, timeSchema } from './summary';

/**
 * Opt-in activity metadata side channel. It is deliberately separate from `summary.v1`:
 * the pairing request, run lease, snapshot request/response and their hashes are untouched,
 * so an old center or an old host can be degraded to `available: false` without invalidating
 * an existing pairing. Nothing here widens scope, capability hashes or token handling.
 */
export const ACTIVITY_QUERY_ID = 'narrafork.narrators.activity' as const;
/** Fixed center route. Never derived from a user-supplied path. */
export const ACTIVITY_SNAPSHOT_ROUTE = '/api/connector/activity' as const;
/** Host-side cap per activity page; the connector batches instead of widening this. */
export const ACTIVITY_BATCH = 100;
/** Local budget for the whole activity collection, measured with a monotonic clock. */
export const ACTIVITY_COLLECT_MS = 15_000;
export const ACTIVITY_MAX_ITEMS = LIMITS.summaries;
export const ACTIVITY_HASH_VERSION = 1 as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const workCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Host `attention` is read as an explicit whitelist; any other host field is dropped, never forwarded. */
export const activityAttentionSchema = z.object({ reply: z.boolean(), approval: z.boolean(), error: z.boolean(), unread: z.boolean() });
export type ActivityAttention = z.infer<typeof activityAttentionSchema>;

export const activityQueryInputSchema = z.strictObject({
  narratorIds: z.array(idSchema).min(1).max(ACTIVITY_BATCH).refine(xs => new Set(xs).size === xs.length),
  projectId: idSchema.optional(),
});
export type ActivityQueryInput = z.infer<typeof activityQueryInputSchema>;

/** Tolerant on unknown host keys (projection), strict about the documented types and unique IDs. */
export const activityQueryRowSchema = z.object({ id: idSchema, attention: activityAttentionSchema, backgroundWorkCount: workCount });
export const activityQueryOutputSchema = z.object({
  items: z.array(activityQueryRowSchema).max(ACTIVITY_BATCH).refine(rows => new Set(rows.map(row => row.id)).size === rows.length),
  observedAt: timeSchema,
});
export type ActivityQueryOutput = z.infer<typeof activityQueryOutputSchema>;

/** Wire item: flat, no title, no message body, no substatus, no request IDs. */
export const activityItemSchema = z.strictObject({
  id: idSchema,
  reply: z.boolean(), approval: z.boolean(), error: z.boolean(), unread: z.boolean(),
  backgroundWorkCount: workCount,
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

const activityItemsSchema = z.array(activityItemSchema).max(ACTIVITY_MAX_ITEMS)
  .refine(xs => new Set(xs.map(x => x.id)).size === xs.length);

const publicationBase = { protocolVersion: versionSchema, generation: generationSchema, runId: generationSchema, baseHash: sha256Hex };

export const activityAvailableSchema = z.strictObject({
  ...publicationBase, available: z.literal(true),
  count: z.number().int().min(0).max(ACTIVITY_MAX_ITEMS), hash: sha256Hex, items: activityItemsSchema,
});
export const activityUnavailableSchema = z.strictObject({ ...publicationBase, available: z.literal(false) });
export const activityPublicationSchema = z.discriminatedUnion('available', [activityAvailableSchema, activityUnavailableSchema])
  .refine(p => !p.available || p.count === p.items.length);
export type ActivityAvailable = z.infer<typeof activityAvailableSchema>;
export type ActivityUnavailable = z.infer<typeof activityUnavailableSchema>;
export type ActivityPublication = z.infer<typeof activityPublicationSchema>;

/** The center acknowledges without echoing any activity data. */
export const activityReceiptSchema = z.strictObject({ accepted: z.literal(true) });
export type ActivityReceipt = z.infer<typeof activityReceiptSchema>;

/**
 * Canonical `activityHash` v1: SHA-256 over UTF-8 JSON of id-sorted tuples
 * `[id, reply, approval, error, unread, backgroundWorkCount]`, no whitespace.
 * Input is validated first, so duplicate IDs or unknown fields cannot be hashed silently.
 */
export async function activityHash(items: readonly ActivityItem[]): Promise<string> {
  const rows = activityItemsSchema.parse(items)
    .slice()
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(item => [item.id, item.reply, item.approval, item.error, item.unread, item.backgroundWorkCount]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
