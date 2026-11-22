import { useSyncExternalStore } from 'react';

export type AppearanceScheme = 'auto' | 'light' | 'dark';
export type AppearancePreferences = { scheme: AppearanceScheme; oled: boolean; sidebar: boolean };
export type AppearanceSnapshot = AppearancePreferences & { theme: 'light' | 'dark' | 'oled'; dark: boolean };
export type AppearanceStore = {
  getSnapshot: () => AppearanceSnapshot;
  subscribe: (listener: () => void) => () => void;
  setPreferences: (patch: Partial<AppearancePreferences>) => void;
};
export type AppearanceRuntime = {
  key: string;
  defaults: AppearancePreferences;
  normalize: (value: unknown) => AppearancePreferences;
  parse: (raw: unknown) => AppearancePreferences;
  resolve: (preferences: AppearancePreferences, systemDark: boolean) => AppearanceSnapshot['theme'];
  createStore: (host: unknown) => AppearanceStore;
  store: AppearanceStore;
};
declare global {
  interface Window { __NF_HUB_APPEARANCE__?: AppearanceRuntime }
}

// A failed optional first-paint resource must not prevent logging in.
const fallback = Object.freeze({ scheme: 'auto', oled: false, sidebar: false, theme: 'light', dark: false } as const);
const unavailableStore: AppearanceStore = {
  getSnapshot: () => fallback,
  subscribe: () => () => {},
  setPreferences: () => {},
};
export function useAppearance() {
  const runtime = typeof window === 'undefined' ? undefined : window.__NF_HUB_APPEARANCE__;
  const store = runtime?.store ?? unavailableStore;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, unavailableStore.getSnapshot);
  return { ...snapshot, setPreferences: store.setPreferences, available: !!runtime };
}
