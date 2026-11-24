import { z } from 'zod';
import { capabilitiesSchema, failureCodeSchema, pairCodeSchema } from './connector';
import { LIMITS, SESSION_GROUP_PREVIEW } from './constants';
import { idSchema, plainText, scopeSchema, statusSchema, summarySchema, timeSchema } from './summary';

export const errorCodeSchema = z.enum(['UNAUTHENTICATED','FORBIDDEN','BAD_ORIGIN','CSRF','INVALID_INPUT','INVALID_PAIRING','NOT_FOUND','CONFLICT','REVOKE_FIRST','INVALID_SCOPE','DUPLICATE_ID','HASH_MISMATCH','COUNT_MISMATCH','STALE_RUN','RUN_EXPIRED','RUN_CLOSED','TOO_LARGE','RATE_LIMITED','BUSY','UNSUPPORTED_MEDIA','INTERNAL']);
export const errorResponseSchema = z.strictObject({ error: z.strictObject({ code: errorCodeSchema }) });
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const usernameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.@-]+$/);
export const loginSchema = z.strictObject({ username: usernameSchema, password: z.string().min(1).max(512) });
export const authSchema = z.strictObject({ username: usernameSchema, csrfToken: z.string().min(32) });
export type Auth = z.infer<typeof authSchema>;
export const embedStatusSchema = z.enum(['unverified','verified','blocked']);
export const connectionSchema = z.enum(['unpaired','connected','lost','revoked']);
export const freshnessSchema = z.enum(['never','fresh','stale']);
const displayFields = { alias: plainText(80).trim().min(1), group: plainText(80), color: z.string().regex(/^#[A-Fa-f0-9]{6}$/), order: z.number().int().min(-1_000_000).max(1_000_000), favorite: z.boolean(), browserBaseUrl: z.string().min(1).max(2048), embedStatus: embedStatusSchema };
export const createInstanceSchema = z.strictObject({ ...displayFields, group: displayFields.group.default(''), color: displayFields.color.default('#396B78'), order: displayFields.order.default(0), favorite: displayFields.favorite.default(false), embedStatus: embedStatusSchema.default('unverified') });
export const updateInstanceSchema = z.strictObject(displayFields).partial().refine(x => Object.keys(x).length > 0);
export const instanceSchema = z.strictObject({ ...displayFields, id: z.uuid(), generation: z.number().int().nonnegative(), scope: scopeSchema, connection: connectionSchema, freshness: freshnessSchema, lastContactAt: timeSchema.nullable(), lastSuccessAt: timeSchema.nullable(), lastError: failureCodeSchema.nullable(), sessionCount: z.number().int().nonnegative().nullable(), connectorVersion: z.string().nullable(), nfVersion: z.string().nullable(), capabilities: capabilitiesSchema.nullable() });
export type Instance = z.infer<typeof instanceSchema>;
export type CreateInstance = z.input<typeof createInstanceSchema>;
export type UpdateInstance = z.infer<typeof updateInstanceSchema>;
export const instancesSchema = z.strictObject({ items: z.array(instanceSchema) });
export const pairingSchema = z.strictObject({ code: pairCodeSchema, expiresAt: timeSchema });
export type Pairing = z.infer<typeof pairingSchema>;
const count = z.number().int().nonnegative();
export const freshCountsSchema = z.strictObject({ total: count, working: count, waiting: count, idle: count, archived: count, unknown: count });
export const overviewSchema = z.strictObject({ configuredInstances: count, connectedInstances: count, freshInstances: count, staleInstances: count, lostInstances: count, staleSessions: count, freshCounts: freshCountsSchema.nullable() });
export type Overview = z.infer<typeof overviewSchema>;
export const sessionRowSchema = z.strictObject({ ...summarySchema.shape, instanceId: z.uuid(), freshness: freshnessSchema, lastSuccessAt: timeSchema });
export type SessionRow = z.infer<typeof sessionRowSchema>;
const pageFields = { page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSize).default(50) };
const wireBool = z.enum(['true','false']).transform(v => v === 'true');
/** Card section identity. Declared before the query schemas so both can reference the same closed enum. */
export const sessionGroupSchema = z.enum(['attention','running','recent']);
export type SessionGroup = z.infer<typeof sessionGroupSchema>;
export const sessionsQuerySchema = z.strictObject({ ...pageFields, q: plainText(256).optional(), instanceId: z.uuid().optional(), status: statusSchema.optional(), projectId: idSchema.optional(), standalone: wireBool.optional(), includeArchived: wireBool.optional(), group: sessionGroupSchema.optional() }).refine(f => !(f.standalone && f.projectId) && (!f.projectId || !!f.instanceId));
export const projectsQuerySchema = z.strictObject({ ...pageFields, instanceId: z.uuid().optional(), q: plainText(256).optional() });
export const projectSchema = z.strictObject({ instanceId: z.uuid(), projectId: idSchema, projectName: plainText(256).nullable() });
export type Project = z.infer<typeof projectSchema>;
const pageResult = { page: count, pageSize: count, total: count };
export const sessionsSchema = z.strictObject({ ...pageResult, items: z.array(sessionRowSchema) });
export const projectsSchema = z.strictObject({ ...pageResult, items: z.array(projectSchema) });
export const changesSchema = z.strictObject({ version: z.string().min(1) });
export const changesQuerySchema = z.strictObject({ instances:z.literal('1').optional() });
export const changesWithInstancesSchema = changesSchema.extend({ instances:z.array(instanceSchema) });
export type ChangesWithInstances = z.infer<typeof changesWithInstancesSchema>;
export type SessionsPage = z.infer<typeof sessionsSchema>;
export type ProjectsPage = z.infer<typeof projectsSchema>;
export type Changes = z.infer<typeof changesSchema>;

/**
 * Additive read-only projections for the tab bar and the card sections.
 *
 * These live in new endpoints instead of widening `overviewSchema` / `sessionsSchema`, because those are
 * strict objects already shipped to installed clients: an extra key would fail their parse.
 *
 * Every capability the center cannot derive from the currently published summary set is reported as
 * `supported:false` with a null count, never as `0` and never inferred from a neighbouring status.
 */
/**
 * A capability count is either genuinely known or explicitly absent. `supported:true, count:0` is a real
 * zero and must stay valid; the contradiction this rejects is "not supported yet still reporting a number".
 */
const capabilityCount = z.strictObject({ supported: z.boolean(), count: count.nullable() })
  .refine(v => v.supported ? v.count !== null : v.count === null);
export const instanceActivitySchema = z.strictObject({ items: z.array(z.strictObject({
  instanceId: z.uuid(),
  freshness: freshnessSchema,
  lastSuccessAt: timeSchema.nullable(),
  // Null unless this instance currently holds a fresh, authorized, non-archived generation.
  counts: freshCountsSchema.nullable(),
  runningCount: count.nullable().default(null),
  attention: capabilityCount,
  background: capabilityCount,
})) });
export type InstanceActivity = z.infer<typeof instanceActivitySchema>;
export type InstanceActivityItem = InstanceActivity['items'][number];
/** Coverage describes activity metadata, not the always-available baseline working status. */
export const activityCoverageSchema = z.enum(['none','partial','complete']);
export type ActivityCoverage = z.infer<typeof activityCoverageSchema>;
export const groupActivitySchema = z.strictObject({
  reply:z.boolean(), approval:z.boolean(), error:z.boolean(), unread:z.boolean(),
  backgroundWorkCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
/** Only the new group projection gains activity; the installed /api/sessions shape stays unchanged. */
export const groupSessionRowSchema = sessionRowSchema.extend({activity:groupActivitySchema.nullable().default(null)});
export type GroupSessionRow = z.infer<typeof groupSessionRowSchema>;
const groupFields = { coverage:activityCoverageSchema.default('none'), items:z.array(groupSessionRowSchema) };
export const sessionGroupsSchema = z.strictObject({
  total: count, previewSize: count,
  attention:z.strictObject({...groupFields,supported:z.boolean(),total:count.nullable()}),
  running:z.strictObject({...groupFields,supported:z.boolean(),total:count}),
  recent:z.strictObject({...groupFields,supported:z.boolean(),total:count}),
});
export type SessionGroups = z.infer<typeof sessionGroupsSchema>;
/** Card preview query. Reuses the list filters but never carries paging: a preview has one bounded size. */
export const sessionGroupsQuerySchema = z.strictObject({
  q: plainText(256).optional(), instanceId: z.uuid().optional(), status: statusSchema.optional(), projectId: idSchema.optional(),
  standalone: wireBool.optional(), includeArchived: wireBool.optional(),
  previewSize: z.coerce.number().int().min(1).max(LIMITS.pageSize).default(SESSION_GROUP_PREVIEW),
}).refine(f => !(f.standalone && f.projectId) && (!f.projectId || !!f.instanceId));
export type SessionGroupsQuery = z.infer<typeof sessionGroupsQuerySchema>;
