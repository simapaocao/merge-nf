import { z } from 'zod';
import { LIMITS } from './constants';
import { generationSchema, versionSchema } from './connector';
import { idSchema, timeSchema } from './summary';

/** Type metadata from the same host list as the base snapshot, separate from summary.v1 and its hash. */
export const SESSION_METADATA_ROUTE = '/api/connector/session-metadata' as const;
export const SESSION_METADATA_MAX_ITEMS = LIMITS.summaries;
export const SESSION_METADATA_HASH_VERSION = 1 as const;
export const sessionKindSchema = z.enum(['primary', 'subagent']);
export type SessionKind = z.infer<typeof sessionKindSchema>;
export const SESSION_RELATIONSHIPS_QUERY_ID = 'narrafork.narrators.relationships' as const;
export const SESSION_RELATIONSHIPS_BATCH = 100;
export const SESSION_RELATIONSHIPS_COLLECT_MS = 15_000;
const parentFields = { parentKnown: z.boolean(), parentId: idSchema.nullable() };
const validParent = (item: { id: string; parentKnown: boolean; parentId: string | null }) =>
  (item.parentKnown || item.parentId === null) && item.parentId !== item.id;
export const sessionRelationshipsInputSchema = z.strictObject({
  narratorIds: z.array(idSchema).min(1).max(SESSION_RELATIONSHIPS_BATCH).refine(ids => new Set(ids).size === ids.length),
  projectId: idSchema.optional(),
});
/** The host can return richer records; the connector projects only the documented relationship fields. */
export const sessionRelationshipRowSchema = z.object({ id: idSchema, ...parentFields }).refine(validParent);
export const sessionRelationshipsOutputSchema = z.object({
  items: z.array(sessionRelationshipRowSchema).max(SESSION_RELATIONSHIPS_BATCH).refine(items => new Set(items.map(item => item.id)).size === items.length),
  observedAt: timeSchema,
});
export type SessionRelationshipsInput = z.infer<typeof sessionRelationshipsInputSchema>;
export type SessionRelationshipsOutput = z.infer<typeof sessionRelationshipsOutputSchema>;
/** Unknown type is null. Unknown parent is false/null; true/null explicitly means no direct parent. */
export const sessionMetadataItemSchema = z.strictObject({ id: idSchema, kind: sessionKindSchema.nullable(), ...parentFields }).refine(validParent);
export type SessionMetadataItem = z.infer<typeof sessionMetadataItemSchema>;
export const sessionMetadataItemsSchema = z.array(sessionMetadataItemSchema).max(SESSION_METADATA_MAX_ITEMS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const base = { protocolVersion: versionSchema, generation: generationSchema, runId: generationSchema, baseHash: digestSchema };
export const sessionMetadataAvailableSchema = z.strictObject({
  ...base, available: z.literal(true), count: z.number().int().min(0).max(SESSION_METADATA_MAX_ITEMS),
  hash: digestSchema, items: sessionMetadataItemsSchema,
});
export const sessionMetadataUnavailableSchema = z.strictObject({ ...base, available: z.literal(false) });
export const sessionMetadataPublicationSchema = z.discriminatedUnion('available', [sessionMetadataAvailableSchema, sessionMetadataUnavailableSchema])
  .refine(publication => !publication.available || publication.count === publication.items.length);
export type SessionMetadataPublication = z.infer<typeof sessionMetadataPublicationSchema>;
export const sessionMetadataReceiptSchema = z.strictObject({ accepted: z.literal(true) });
export type SessionMetadataReceipt = z.infer<typeof sessionMetadataReceiptSchema>;

/** v1: SHA-256 of UTF-8 JSON of id-sorted [id,kind,parentKnown,parentId] tuples (UTF-16 ordinal order, no whitespace). */
export async function sessionMetadataHash(items: readonly SessionMetadataItem[]): Promise<string> {
  const rows = sessionMetadataItemsSchema.parse(items).slice()
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(item => [item.id, item.kind, item.parentKnown, item.parentId]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
