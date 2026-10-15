// js/ui/charts/persist.js — remembering a chart across visits: which lines,
// items and reference lines are hidden, which series it has already seen,
// whether the stacked view is on, and an explicitly selected vertical scale.
// Zoom is deliberately not stored (it is
// exploratory; a stale zoom on the next visit reads as missing data). Page
// choices around a chart (picked envelopes, top-N, sort) are stored beside it
// as plain prefs. Storage may be missing, full or blocked (private windows,
// cleared site data), so every access is guarded and a failure just means
// "nothing remembered".
//
// Keys are scoped per budget, the same idea as page-filter.js's
// `pageFilterKey`/`budgetKeyOf`, so the demo and a real budget (or two cloud
// budgets) never share a chart's hidden series or prefs. This module stays
// DOM/app-agnostic on purpose (it is imported straight into node-env tests),
// so it does not import app.js or read `state` itself: js/state/load-budget.js
// calls `setChartBudgetKey(budgetKeyOf(ref))` once a budget is loaded, and
// every load/save below just reads that module-level value. No budget key
// set yet (e.g. these tests) means the old unscoped `bv.chart.<id>` key,
// unchanged from before scoping existed.

const PREFIX = 'bv.chart.';
const VERSION = 1;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @type {string | undefined} set once per budget load; see module doc above */
let budgetKey;

/**
 * Scope every chart key to this budget from now on. Pass a falsy value to go
 * back to the unscoped key (no budget loaded).
 * @param {string | null | undefined} key  e.g. `budgetKeyOf(state.budgetFolder)`
 */
export function setChartBudgetKey(key) {
  budgetKey = key || undefined;
}

/** The current budget scope, or undefined when none is set. */
export function getChartBudgetKey() {
  return budgetKey;
}

/**
 * Session-only cache of a chart's live ChartState, so index.js's mountChart
 * can survive a remount (a page revisit, a resize-triggered rebuild) without
 * a localStorage round-trip. Keyed by the CURRENT budget scope + chart id,
 * not just the chart id: a budget switch is an in-place SPA swap (no page
 * reload — js/ui/load-budget-dialog.js, cloud-budget-picker.js and
 * guest-budget-picker.js all call loadBudgetIntoState without reloading),
 * and a chart id like Reports' "spend by envelope" is the same string across
 * every budget. Without the scope in the key, a toggle made in budget A
 * would still be sitting in the cache when budget B mounts the same chart
 * id, showing A's hidden items in B and then writing them into B's saved
 * (scoped) state on the next toggle. Never explicitly cleared: once the
 * scope changes, the old scope's entries simply stop being addressable.
 * @type {Map<string, import('./model.js').ChartState>}
 */
const sessionStates = new Map();

function sessionKey(id) {
  return `${budgetKey ?? ''}\u0000${id}`;
}

/** @returns {import('./model.js').ChartState | undefined} */
export function getSessionChartState(id) {
  return sessionStates.get(sessionKey(id));
}

/** @param {import('./model.js').ChartState} state */
export function setSessionChartState(id, state) {
  sessionStates.set(sessionKey(id), state);
}

function unscopedKey(id, suffix = '') {
  return `${PREFIX}${id}${suffix}`;
}

function storageKey(id, suffix = '') {
  return budgetKey ? `${PREFIX}${budgetKey}.${id}${suffix}` : unscopedKey(id, suffix);
}

/**
 * Read under the scoped key, falling back once to the pre-scoping unscoped
 * key so an existing install doesn't lose what it already had saved; the
 * value is written back under the scoped key so later reads (and other
 * budgets, which never see this fallback) go straight to it.
 */
function readScoped(id, suffix, storage) {
  const key = storageKey(id, suffix);
  const text = storage.getItem(key);
  if (text != null || !budgetKey) return text;
  const legacy = storage.getItem(unscopedKey(id, suffix));
  if (legacy == null) return null;
  try { storage.setItem(key, legacy); } catch { /* migration is best-effort */ }
  return legacy;
}

const strings = a => Array.isArray(a) && a.every(x => typeof x === 'string');

/** @param {import('./model.js').ChartState} state */
export function serializeState(state) {
  return {
    v: VERSION,
    hiddenSeries: [...state.hiddenSeries],
    hiddenItems: [...state.hiddenItems],
    seenSeries: [...(state.seenSeries ?? [])],
    stacked: !!state.stacked,
    ...(state.yScale ? { yScale: state.yScale } : {}),
  };
}

/**
 * @param {any} raw  parsed JSON
 * @returns {import('./model.js').ChartState | undefined}
 */
export function deserializeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION) return undefined;
  if (!strings(raw.hiddenSeries) || !strings(raw.hiddenItems) || !strings(raw.seenSeries)) return undefined;
  return {
    hiddenSeries: new Set(raw.hiddenSeries),
    hiddenItems: new Set(raw.hiddenItems),
    seenSeries: new Set(raw.seenSeries),
    stacked: raw.stacked === true,
    ...(['fit', 'zero'].includes(raw.yScale) ? { yScale: raw.yScale } : {}),
    zoom: null,
    zoomKeys: null,
  };
}

export function loadChartState(id, storage = defaultStorage()) {
  if (!storage) return undefined;
  try {
    const text = readScoped(id, '', storage);
    return text ? deserializeState(JSON.parse(text)) : undefined;
  } catch {
    return undefined;
  }
}

export function saveChartState(id, state, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(storageKey(id), JSON.stringify(serializeState(state)));
  } catch {
    // Full or blocked: the chart still works, it just won't remember.
  }
}

/** @returns {Record<string, any>} */
export function loadChartPrefs(id, storage = defaultStorage()) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(readScoped(id, '.prefs', storage) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveChartPrefs(id, prefs, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(storageKey(id, '.prefs'), JSON.stringify(prefs));
  } catch {
    // Full or blocked: see saveChartState.
  }
}
