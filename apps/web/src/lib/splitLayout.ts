/**
 * Multi-NF split-screen layout state & pure geometry calculations.
 *
 * Iframes stay mounted in stable DOM order (`sortFramesForRender`) and are positioned into
 * pane boxes via percentage coordinates, so toggling split mode, resizing dividers or
 * swapping panes never reparents or reloads any surviving iframe.
 */

export type SplitMode = 'single' | 'split-h' | 'split-v' | 'split-3' | 'split-grid';

export type SplitState = {
  mode: SplitMode;
  /** Instance IDs assigned to each pane (length = paneCount(mode)). Null means an empty slot. */
  paneIds: Array<string | null>;
  /** Index of the currently focused pane (0..paneCount-1). */
  focusedPane: number;
  /** Split ratios in percent: [primary] for 2-pane, [first, second] for 3-pane, [col, rightRow] for grid. */
  ratios: [number, number];
};

export type PaneRect = { left: number; top: number; width: number; height: number };
export type DividerSpec = {
  id: 'primary' | 'secondary';
  orientation: 'vertical' | 'horizontal';
  left: number;
  top: number;
  length: number;
};

export const SPLIT_MODE_LABELS: Record<SplitMode, string> = {
  single: '单屏',
  'split-h': '左右双屏',
  'split-v': '上下双屏',
  'split-3': '三屏并排',
  'split-grid': '左主右双',
};

export const SPLIT_STORAGE_PREFIX = 'nf-hub:split:v1:';
const MIN_PANE_PCT = 18;
const MAX_PANE_PCT = 82;
const MIN_TRIPLE_PCT = 15;

export function paneCount(mode: SplitMode): number {
  if (mode === 'single') return 1;
  if (mode === 'split-h' || mode === 'split-v') return 2;
  return 3;
}

export function defaultRatios(mode: SplitMode): [number, number] {
  if (mode === 'split-3') return [33.33, 33.33];
  return [50, 50];
}

export const defaultSplitState: SplitState = {
  mode: 'single',
  paneIds: [null],
  focusedPane: 0,
  ratios: [50, 50],
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function normalizeRatios(mode: SplitMode, ratios: readonly [number, number]): [number, number] {
  const [r0, r1] = ratios;
  if (mode === 'split-3') {
    const first = clamp(r0, MIN_TRIPLE_PCT, 100 - 2 * MIN_TRIPLE_PCT);
    const second = clamp(r1, MIN_TRIPLE_PCT, 100 - first - MIN_TRIPLE_PCT);
    return [Number(first.toFixed(2)), Number(second.toFixed(2))];
  }
  return [
    Number(clamp(r0, MIN_PANE_PCT, MAX_PANE_PCT).toFixed(2)),
    Number(clamp(r1, MIN_PANE_PCT, MAX_PANE_PCT).toFixed(2)),
  ];
}

/** Switch split mode, preserving current visible instances and filling new slots from open tabs / candidates. */
export function setSplitMode(
  state: SplitState,
  mode: SplitMode,
  activeId: string | null,
  candidates: readonly string[],
): SplitState {
  const count = paneCount(mode);
  if (mode === 'single') {
    const keep = state.paneIds[state.focusedPane] ?? activeId ?? state.paneIds.find(Boolean) ?? null;
    return { mode: 'single', paneIds: [keep], focusedPane: 0, ratios: defaultRatios('single') };
  }
  const used = new Set<string>();
  const next: Array<string | null> = [];
  const pushUnique = (id: string | null | undefined) => {
    if (!id || used.has(id) || next.length >= count) return;
    used.add(id);
    next.push(id);
  };
  if (state.mode === 'single') {
    pushUnique(activeId ?? state.paneIds[0]);
  } else {
    for (const id of state.paneIds) pushUnique(id);
    pushUnique(activeId);
  }
  for (const id of candidates) pushUnique(id);
  while (next.length < count) next.push(null);
  const focusedPane = activeId && next.includes(activeId)
    ? next.indexOf(activeId)
    : Math.min(state.focusedPane, count - 1);
  return {
    mode,
    paneIds: next,
    focusedPane,
    ratios: state.mode === mode ? state.ratios : defaultRatios(mode),
  };
}

/** Assign an instance to a pane. If it is already shown in another pane, swap those two panes. */
export function assignPane(state: SplitState, paneIndex: number, instanceId: string | null): SplitState {
  if (paneIndex < 0 || paneIndex >= state.paneIds.length) return state;
  const paneIds = [...state.paneIds];
  if (instanceId) {
    const existing = paneIds.indexOf(instanceId);
    if (existing >= 0 && existing !== paneIndex) {
      paneIds[existing] = paneIds[paneIndex] ?? null;
      paneIds[paneIndex] = instanceId;
      return { ...state, paneIds, focusedPane: paneIndex };
    }
  }
  if (paneIds[paneIndex] === instanceId && state.focusedPane === paneIndex) return state;
  paneIds[paneIndex] = instanceId;
  return { ...state, paneIds, focusedPane: paneIndex };
}

/** Focus or place an instance when the user selects a tab or opens a session. */
export function focusOrAssignInstance(state: SplitState, instanceId: string): SplitState {
  if (!instanceId) return state;
  const existing = state.paneIds.indexOf(instanceId);
  if (existing >= 0) {
    return state.focusedPane === existing ? state : { ...state, focusedPane: existing };
  }
  return assignPane(state, Math.min(state.focusedPane, state.paneIds.length - 1), instanceId);
}

/** Rotate/swap pane assignments so users can quickly flip left/right or cycle 3 panes. */
export function swapPanes(state: SplitState, indexA = 0, indexB = 1): SplitState {
  if (state.mode === 'single' || indexA === indexB) return state;
  if (indexA < 0 || indexB < 0 || indexA >= state.paneIds.length || indexB >= state.paneIds.length) return state;
  const paneIds = [...state.paneIds];
  const temp = paneIds[indexA] ?? null;
  paneIds[indexA] = paneIds[indexB] ?? null;
  paneIds[indexB] = temp;
  const focusedPane = state.focusedPane === indexA ? indexB : state.focusedPane === indexB ? indexA : state.focusedPane;
  return { ...state, paneIds, focusedPane };
}

/** Close one pane in split mode, stepping down 3 -> 2 or 2 -> single without reloading surviving panes. */
export function closeSplitPane(state: SplitState, paneIndex: number): SplitState {
  if (state.mode === 'single' || paneIndex < 0 || paneIndex >= state.paneIds.length) return state;
  const remaining = state.paneIds.filter((_, idx) => idx !== paneIndex);
  if (remaining.length <= 1) {
    return { mode: 'single', paneIds: [remaining[0] ?? null], focusedPane: 0, ratios: defaultRatios('single') };
  }
  const nextMode: SplitMode = 'split-h';
  return {
    mode: nextMode,
    paneIds: remaining.slice(0, 2),
    focusedPane: Math.min(state.focusedPane >= paneIndex ? Math.max(0, state.focusedPane - 1) : state.focusedPane, 1),
    ratios: defaultRatios(nextMode),
  };
}

/** Remove closed or invalid instance IDs from split panes; refill from openIds or step down cleanly. */
export function reconcileSplit(state: SplitState, openIds: readonly string[], activeId: string | null): SplitState {
  const openSet = new Set(openIds);
  if (state.mode === 'single') {
    const keep = activeId && openSet.has(activeId) ? activeId : (state.paneIds[0] && openSet.has(state.paneIds[0]) ? state.paneIds[0] : null);
    return state.paneIds[0] === keep ? state : { ...state, paneIds: [keep], focusedPane: 0 };
  }
  let changed = false;
  const used = new Set<string>();
  const cleaned = state.paneIds.map(id => {
    if (id && openSet.has(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
    if (id !== null) changed = true;
    return null;
  });
  // Fill emptied slots from remaining open tabs not yet on screen.
  const refill = cleaned.map(id => {
    if (id !== null) return id;
    const candidate = openIds.find(item => !used.has(item)) ?? null;
    if (candidate) {
      used.add(candidate);
      changed = true;
    }
    return candidate;
  });
  const liveCount = refill.filter(Boolean).length;
  if (liveCount <= 1) {
    return { mode: 'single', paneIds: [activeId && openSet.has(activeId) ? activeId : refill.find(Boolean) ?? null], focusedPane: 0, ratios: defaultRatios('single') };
  }
  if (!changed) return state;
  const focusedPane = refill[state.focusedPane] ? state.focusedPane : Math.max(0, refill.findIndex(Boolean));
  return { ...state, paneIds: refill, focusedPane };
}

/** Update divider ratio from normalized pointer coordinate (0..100). */
export function resizeSplit(state: SplitState, divider: DividerSpec['id'], percent: number): SplitState {
  if (state.mode === 'single') return state;
  const [r0, r1] = state.ratios;
  let next: [number, number] = [r0, r1];
  if (state.mode === 'split-h' || state.mode === 'split-v') {
    next = [clamp(percent, MIN_PANE_PCT, MAX_PANE_PCT), r1];
  } else if (state.mode === 'split-3') {
    if (divider === 'primary') {
      const first = clamp(percent, MIN_TRIPLE_PCT, r0 + r1 - MIN_TRIPLE_PCT);
      const second = r0 + r1 - first;
      next = [first, second];
    } else {
      const boundary = clamp(percent, r0 + MIN_TRIPLE_PCT, 100 - MIN_TRIPLE_PCT);
      next = [r0, boundary - r0];
    }
  } else if (state.mode === 'split-grid') {
    next = divider === 'primary'
      ? [clamp(percent, MIN_PANE_PCT, MAX_PANE_PCT), r1]
      : [r0, clamp(percent, MIN_PANE_PCT, MAX_PANE_PCT)];
  }
  const normalized = normalizeRatios(state.mode, next);
  if (normalized[0] === r0 && normalized[1] === r1) return state;
  return { ...state, ratios: normalized };
}

export function computePaneRects(state: SplitState): PaneRect[] {
  const [r0, r1] = normalizeRatios(state.mode, state.ratios);
  if (state.mode === 'single') return [{ left: 0, top: 0, width: 100, height: 100 }];
  if (state.mode === 'split-h') {
    return [
      { left: 0, top: 0, width: r0, height: 100 },
      { left: r0, top: 0, width: 100 - r0, height: 100 },
    ];
  }
  if (state.mode === 'split-v') {
    return [
      { left: 0, top: 0, width: 100, height: r0 },
      { left: 0, top: r0, width: 100, height: 100 - r0 },
    ];
  }
  if (state.mode === 'split-3') {
    return [
      { left: 0, top: 0, width: r0, height: 100 },
      { left: r0, top: 0, width: r1, height: 100 },
      { left: r0 + r1, top: 0, width: 100 - r0 - r1, height: 100 },
    ];
  }
  // split-grid: 1 full-height pane on left, 2 stacked panes on right
  return [
    { left: 0, top: 0, width: r0, height: 100 },
    { left: r0, top: 0, width: 100 - r0, height: r1 },
    { left: r0, top: r1, width: 100 - r0, height: 100 - r1 },
  ];
}

export function computeDividers(state: SplitState): DividerSpec[] {
  const [r0, r1] = normalizeRatios(state.mode, state.ratios);
  if (state.mode === 'single') return [];
  if (state.mode === 'split-h') return [{ id: 'primary', orientation: 'vertical', left: r0, top: 0, length: 100 }];
  if (state.mode === 'split-v') return [{ id: 'primary', orientation: 'horizontal', left: 0, top: r0, length: 100 }];
  if (state.mode === 'split-3') {
    return [
      { id: 'primary', orientation: 'vertical', left: r0, top: 0, length: 100 },
      { id: 'secondary', orientation: 'vertical', left: r0 + r1, top: 0, length: 100 },
    ];
  }
  return [
    { id: 'primary', orientation: 'vertical', left: r0, top: 0, length: 100 },
    { id: 'secondary', orientation: 'horizontal', left: r0, top: r1, length: 100 - r0 },
  ];
}

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const VALID_MODES = new Set<SplitMode>(['single', 'split-h', 'split-v', 'split-3', 'split-grid']);

export const splitStorageKey = (username: string, origin: string, serverEpoch: string) =>
  `${SPLIT_STORAGE_PREFIX}${JSON.stringify([origin, username, serverEpoch])}`;

export function readSplitLayout(storage: MinimalStorage | undefined, key: string): SplitState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 2048) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
    const mode = parsed.mode as SplitMode;
    if (typeof mode !== 'string' || !VALID_MODES.has(mode)) return null;
    const expectedLen = paneCount(mode);
    if (!Array.isArray(parsed.paneIds) || parsed.paneIds.length !== expectedLen) return null;
    const seen = new Set<string>();
    const paneIds: Array<string | null> = [];
    for (const item of parsed.paneIds) {
      if (item === null) { paneIds.push(null); continue; }
      if (typeof item !== 'string' || !item || item.length > 64 || seen.has(item)) return null;
      seen.add(item);
      paneIds.push(item);
    }
    const focused = typeof parsed.focusedPane === 'number' && Number.isInteger(parsed.focusedPane)
      ? Math.max(0, Math.min(expectedLen - 1, parsed.focusedPane)) : 0;
    const rawRatios = Array.isArray(parsed.ratios) && parsed.ratios.length === 2
      && typeof parsed.ratios[0] === 'number' && typeof parsed.ratios[1] === 'number'
      ? [parsed.ratios[0], parsed.ratios[1]] as [number, number]
      : defaultRatios(mode);
    return { mode, paneIds, focusedPane: focused, ratios: normalizeRatios(mode, rawRatios) };
  } catch {
    return null;
  }
}

export function writeSplitLayout(storage: MinimalStorage | undefined, key: string, state: SplitState): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ v: 1, mode: state.mode, paneIds: state.paneIds, focusedPane: state.focusedPane, ratios: state.ratios }));
  } catch { /* Storage can be unavailable or full. */ }
}

export function clearSplitLayout(storage: MinimalStorage | undefined): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(SPLIT_STORAGE_PREFIX)) keys.push(k);
    }
    keys.forEach(k => storage.removeItem(k));
  } catch { /* Ignore blocked storage. */ }
}
