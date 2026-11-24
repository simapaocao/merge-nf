/** Opened instance tabs. Pure state so ordering, closing and restore rules stay testable without React. */
export type TabsState = { openIds: string[]; activeId: string | null };
export const emptyTabs: TabsState = { openIds: [], activeId: null };
const MAX_STORED_TABS = 32;

/** Opening an already open instance only activates it; the first-open order never changes. */
export function openTab(state: TabsState, instanceId: string): TabsState {
  if (!instanceId) return state;
  if (state.openIds.includes(instanceId)) return state.activeId === instanceId ? state : { openIds: state.openIds, activeId: instanceId };
  return { openIds: [...state.openIds, instanceId], activeId: instanceId };
}
export function activateTab(state: TabsState, instanceId: string): TabsState {
  return state.openIds.includes(instanceId) && state.activeId !== instanceId ? { openIds: state.openIds, activeId: instanceId } : state;
}
/** Closing a view never touches the instance itself. The next active tab is the right neighbour, then the left one. */
export function closeTab(state: TabsState, instanceId: string): TabsState {
  const index = state.openIds.indexOf(instanceId);
  if (index < 0) return state;
  const openIds = state.openIds.filter(id => id !== instanceId);
  if (state.activeId !== instanceId) return { openIds, activeId: state.activeId };
  return { openIds, activeId: state.openIds[index + 1] ?? state.openIds[index - 1] ?? null };
}
export const nextActiveOnClose = (state: TabsState, instanceId: string) => closeTab(state, instanceId).activeId;
export const closeAllTabs = (state: TabsState): TabsState => (state.openIds.length ? emptyTabs : state);
/** Roving tabindex order for the tablist. Arrow keys wrap; Home/End jump to the ends. */
export function keyboardTarget(openIds: readonly string[], activeId: string | null, key: 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End'): string | null {
  const count = openIds.length;
  if (!count) return null;
  if (key === 'Home') return openIds[0]!;
  if (key === 'End') return openIds[count - 1]!;
  const current = activeId ? openIds.indexOf(activeId) : -1;
  if (key === 'ArrowRight') return openIds[current < 0 ? 0 : (current + 1) % count]!;
  return openIds[current < 0 ? count - 1 : (current - 1 + count) % count]!;
}
/** Drop ids that no longer exist after the instance list is known. Unknown ids are never guessed back. */
export function pruneTabs(state: TabsState, valid: ReadonlySet<string>): TabsState {
  const openIds = state.openIds.filter(id => valid.has(id));
  if (openIds.length === state.openIds.length) return state;
  return { openIds, activeId: state.activeId && valid.has(state.activeId) ? state.activeId : null };
}
/**
 * A null set means the instance list is not authoritative yet: an unverified read, a fenced
 * epoch or a transient failure. Tabs are kept untouched instead of being pruned to nothing.
 */
export function pruneWhenKnown(state: TabsState, validIds: ReadonlySet<string> | null): TabsState {
  return validIds ? pruneTabs(state, validIds) : state;
}

export const TABS_STORAGE_PREFIX = 'nf-hub:tabs:v1:';
/** Stable server database identity, excluding the changing revision/freshness suffix. */
export function tabsServerEpoch(version: string | null): string | null {
  const match = version?.match(/^([a-f0-9]{32})(?:\.\d+){3,}$/i);
  return match?.[1] ?? null;
}
/** Identity-scoped key: only non-secret origin, account and stable server epoch. */
export const tabsStorageKey = (username: string, origin: string, serverEpoch: string) => `${TABS_STORAGE_PREFIX}${JSON.stringify([origin, username, serverEpoch])}`;
type MinimalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function decode(raw: string | null): TabsState | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'v' && key !== 'ids' && key !== 'active')) return null;
  if (record.v !== 1 || !Array.isArray(record.ids)) return null;
  const openIds: string[] = [];
  for (const id of record.ids) {
    if (typeof id !== 'string' || !id || id.length > 64 || openIds.includes(id)) return null;
    openIds.push(id);
    if (openIds.length > MAX_STORED_TABS) return null;
  }
  const active = record.active ?? null;
  if (active !== null && (typeof active !== 'string' || !openIds.includes(active))) return null;
  return { openIds, activeId: active };
}
export function readTabs(storage: MinimalStorage | undefined, key: string): TabsState | null {
  if (!storage) return null;
  try { return decode(storage.getItem(key)); } catch { return null; }
}
export function writeTabs(storage: MinimalStorage | undefined, key: string, state: TabsState): void {
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify({ v: 1, ids: state.openIds, active: state.activeId })); } catch { /* Storage can be unavailable or full. */ }
}
/** Every account's entry goes, so a later login never inherits another session's tabs. */
export function clearTabs(storage: MinimalStorage | undefined): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && key.startsWith(TABS_STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach(key => storage.removeItem(key));
  } catch { /* Nothing to clean when storage is blocked. */ }
}
