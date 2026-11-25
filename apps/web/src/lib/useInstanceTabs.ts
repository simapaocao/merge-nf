import { useCallback, useEffect, useRef, useState } from 'react';
import { clearTabs, closeAllTabs, closeTab, emptyTabs, moveTab, openTab, activateTab, pruneWhenKnown, readTabs, tabsStorageKey, writeTabs, type TabsState } from './tabs';

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
function safeStorage(): MinimalStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}

/**
 * Opened tabs live in memory and are mirrored to sessionStorage per signed-in account.
 * Only ids, their order and the active id are stored; no titles, bodies or tokens.
 * `validIds` stays null until a verified instance snapshot exists, so a fenced read,
 * a transient failure or an unverified response can never delete persisted tabs.
 */
export function useInstanceTabs({ username, serverEpoch, validIds }: { username: string | null; serverEpoch: string | null; validIds: ReadonlySet<string> | null }) {
  const [state, setState] = useState<TabsState>(emptyTabs);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const storage = useRef<MinimalStorage | undefined>(undefined);
  const key = useRef('');

  const contextKey = username && serverEpoch ? tabsStorageKey(username, window.location.origin, serverEpoch) : null;
  useEffect(() => {
    if (!contextKey) { setState(emptyTabs); setHydratedKey(null); key.current = ''; storage.current = undefined; return; }
    if (hydratedKey === contextKey) return;
    storage.current = safeStorage(); key.current = contextKey;
    setState(readTabs(storage.current, contextKey) ?? emptyTabs);
    setHydratedKey(contextKey);
  }, [contextKey, hydratedKey]);

  useEffect(() => {
    if (!hydratedKey || hydratedKey !== key.current) return;
    writeTabs(storage.current, key.current, state);
  }, [state, hydratedKey]);

  // Only a verified snapshot narrows the set; an unknown list is not an empty list.
  useEffect(() => {
    if (!hydratedKey) return;
    setState(value => pruneWhenKnown(value, validIds));
  }, [validIds, hydratedKey]);

  const open = useCallback((instanceId: string) => setState(value => openTab(value, instanceId)), []);
  const activate = useCallback((instanceId: string) => setState(value => activateTab(value, instanceId)), []);
  const close = useCallback((instanceId: string) => setState(value => closeTab(value, instanceId)), []);
  const closeAll = useCallback(() => setState(value => closeAllTabs(value)), []);
  const reorder = useCallback((fromId: string, toId: string, position: 'before' | 'after' = 'before') => setState(value => moveTab(value, fromId, toId, position)), []);
  const hydrated = contextKey !== null && hydratedKey === contextKey;
  return { state: hydrated ? state : emptyTabs, hydrated, open, activate, close, closeAll, reorder };
}
/** Session storage holds no credential material, so logout drops every account's entry. */
export function forgetStoredTabs() { clearTabs(safeStorage()); }
