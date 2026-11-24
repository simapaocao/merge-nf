export const PROTOCOL_VERSION = 1 as const;
export const LIMITS = Object.freeze({ summaries: 10_000, snapshotBytes: 16 * 1024 * 1024, hostPages: 500, pageSize: 100, collectMs: 90_000, runMs: 120_000, freshMs: 120_000, lostMs: 180_000, pairingMs: 600_000, intervalMs: 30_000 });
/** Default card preview per group. Configurable per request, never above LIMITS.pageSize. */
export const SESSION_GROUP_PREVIEW = 6;
export const CSRF_HEADER = 'X-CSRF-Token';
const instance = (id: string) => `/api/instances/${encodeURIComponent(id)}`;
const run = (id: number) => `/api/connector/runs/${id}`;
export const routes = Object.freeze({
  login: '/api/auth/login', me: '/api/auth/me', logout: '/api/auth/logout',
  instances: '/api/instances', instance, pairing: (id: string) => `${instance(id)}/pairing`, revoke: (id: string) => `${instance(id)}/revoke`,
  overview: '/api/overview', sessions: '/api/sessions', projects: '/api/projects', changes: '/api/changes', changesWithInstances: '/api/changes?instances=1',
  // Additive read-only projections. Kept as separate endpoints so the strict legacy shapes stay unchanged.
  instanceActivity: '/api/instance-activity', sessionGroups: '/api/session-groups',
  pair: '/api/connector/pair', runs: '/api/connector/runs', snapshot: (id: number) => `${run(id)}/snapshot`, failed: (id: number) => `${run(id)}/failed`,
});
