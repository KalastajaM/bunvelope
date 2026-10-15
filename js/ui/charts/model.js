// js/ui/charts/model.js — the pure half of the chart component: which series
// and items are showing, the axis over them, the zoom window, where a point
// sits in pixels, what the tooltip lists, and the table/CSV of what is in
// view. No DOM and no i18n, so Vitest covers it in Node; render.js draws from
// it, interact.js turns pointer positions into indices with it.
// Design: docs/superpowers/specs/2026-09-27-interactive-charts-design.md

import { round2 } from '../../utils.js';
import { stackLayers } from './stack.js';

export const DEFAULT_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  '#06b6d4', '#a855f7', '#eab308', '#22c55e', '#e11d48',
];

/** Legend and state id of the Low–High band entry. */
export const BAND_ID = '__band';
/** Zoom is offered only above this many x points. */
export const ZOOMABLE_ABOVE = 6;
/** A zoom window never shows fewer points than this. */
export const MIN_ZOOM_POINTS = 3;
/**
 * Hidden hbar/pie item ids are kept even once the item has no row in the
 * current period (a payee or envelope with no activity this month should
 * stay hidden when it reappears next month, not silently come back). That
 * means the set can only grow across remounts, so it is capped here; the
 * oldest hidden ids (by when they were first hidden) are dropped past this
 * many, which comfortably exceeds any real envelope/payee list.
 */
export const MAX_HIDDEN_ITEMS = 300;

/** Legend and state id prefix of a reference line. */
export const REF_PREFIX = 'ref:';
export const refId = id => `${REF_PREFIX}${id}`;

/**
 * @typedef {{ from: number, to: number }} ZoomWindow
 * @typedef {{ from: string, to: string }} ZoomKeys
 * @typedef {{
 *   hiddenSeries: Set<string>, hiddenItems: Set<string>, zoom: ZoomWindow | null,
 *   zoomKeys: ZoomKeys | null, seenSeries: Set<string>, stacked: boolean, yScale?: string,
 * }} ChartState
 */

export function paletteFor(i) {
  return DEFAULT_PALETTE[((i % DEFAULT_PALETTE.length) + DEFAULT_PALETTE.length) % DEFAULT_PALETTE.length];
}

/** A value to draw: missing or non-finite counts as 0, as it always has. */
export function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  if (n <= 1) return 1 * pow;
  if (n <= 2) return 2 * pow;
  if (n <= 2.5) return 2.5 * pow;
  if (n <= 5) return 5 * pow;
  return 10 * pow;
}

/**
 * Axis range for the four-interval y axis, always including zero. When the
 * data has both signs, the four intervals are shared between the two sides in
 * proportion, so zero stays on a gridline and a small dip below zero takes
 * one interval rather than half the chart. (The range used to be symmetric:
 * Reports' Income vs Spending ran to −€50 000 for a few hundred euros of
 * savings withdrawals, ux-review U23.)
 */
export function niceMinMax(min, max) {
  if (min > 0) min = 0;
  if (max < 0) max = 0;
  if (min === 0 && max === 0) return { min: 0, max: 1 };
  if (min === 0) return { min: 0, max: niceMax(max) };
  if (max === 0) return { min: -niceMax(-min), max: 0 };
  const neg = -min;
  const k = Math.min(3, Math.max(1, Math.round((4 * neg) / (neg + max))));
  const step = niceMax(Math.max(neg / k, max / (4 - k)));
  return { min: -k * step, max: (4 - k) * step };
}

const cleanFloat = x => Number(x.toPrecision(12));

/**
 * Axis range fitted to a data span rather than always including zero, for a
 * zoomed line chart (bars and the unzoomed view keep `niceMinMax`). Data that
 * touches or crosses zero still puts zero on a gridline. A flat range (or one
 * so close to flat it would divide by ~0) is padded to 10% of its magnitude
 * and centred, otherwise the data is padded 5% on each side; either way the
 * padding never crosses zero, and the result rounds out to a nice
 * four-interval step that fully encloses the padded span.
 */
export function niceFitRange(min, max) {
  if (min > max) { const t = min; min = max; max = t; }
  if (min <= 0 && max >= 0) return niceMinMax(min, max);
  let span = max - min;
  const mag = Math.max(Math.abs(min), Math.abs(max));
  let lo;
  let hi;
  if (span <= mag * 1e-9) {
    span = (mag * 0.1) || 1;
    lo = min - span / 2;
    hi = max + span / 2;
  } else {
    const pad = span * 0.05;
    lo = min - pad;
    hi = max + pad;
  }
  if (min > 0) lo = Math.max(0, lo);
  if (max < 0) hi = Math.min(0, hi);
  let step = niceMax((hi - lo) / 4);
  let a = Math.floor(lo / step) * step;
  while (a + 4 * step < hi) {
    step = niceMax(step * 1.01);
    a = Math.floor(lo / step) * step;
  }
  return { min: cleanFloat(a), max: cleanFloat(a + 4 * step) };
}

const isSeriesKind = spec => spec.kind === 'line' || spec.kind === 'bar';

/** Nothing to draw: the chart shows "No data" and no toolbar. */
export function isEmpty(spec) {
  if (spec.kind === 'hbar') return !(spec.items || []).length;
  if (spec.kind === 'pie') return !(spec.items || []).some(it => num(it.value) > 0);
  return !(spec.x || []).length || !(spec.series || []).length;
}

/**
 * Legend entries in display order. The band's low and high series are one
 * entry, placed right after the series they surround; reference lines follow
 * the series, each under its `ref:` id.
 * @returns {{ id: string, name: string, color: string, band: boolean, ref: boolean }[]}
 */
export function legendEntries(spec, bandName = '') {
  const band = spec.band;
  /** @type {{ id: string, name: string, color: string, band: boolean, ref: boolean }[]} */
  const out = [];
  (spec.series || []).forEach((s, i) => {
    if (band && (s.id === band.low || s.id === band.high)) return;
    const color = s.color || paletteFor(i);
    out.push({ id: s.id, name: s.name, color, band: false, ref: false });
    if (band && s.id === band.around) out.push({ id: BAND_ID, name: bandName, color, band: true, ref: false });
  });
  for (const r of spec.refLines || []) {
    out.push({ id: refId(r.id), name: r.name, color: r.color || 'var(--ink-2)', band: false, ref: true });
  }
  return out;
}

/** Reference lines still showing. */
export function visibleRefLines(spec, state) {
  return (spec.refLines || []).filter(r => !state.hiddenSeries.has(refId(r.id)));
}

/** The stacked view applies: a line chart with a stack, switched on. */
export function isStacked(spec, state) {
  return !!(spec.stack && state.stacked && spec.kind === 'line');
}

/** The visible stack series, in stack order. */
export function stackSeries(spec, state) {
  const byId = new Map((spec.series || []).map(s => [s.id, s]));
  return (spec.stack?.ids || []).map(id => byId.get(id)).filter(s => s && isSeriesVisible(spec, state, s.id));
}

/** Whether a series is drawn. The band's low and high follow the band entry. */
export function isSeriesVisible(spec, state, id) {
  const band = spec.band;
  if (band && (id === band.low || id === band.high)) return !state.hiddenSeries.has(BAND_ID);
  return !state.hiddenSeries.has(id);
}

/** A stable id for an item; the payee/envelope "Other (n)" row has no key. */
export function itemId(item) {
  return item.key != null ? String(item.key) : `label:${item.label}`;
}

export function canZoom(spec) {
  return isSeriesKind(spec) && (spec.x || []).length > ZOOMABLE_ABOVE;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * A zoom window from two x indices in either order: whole points, at least
 * MIN_ZOOM_POINTS wide (grown around its middle), inside the data. Null when
 * it would cover everything, which is the unzoomed state.
 * @returns {ZoomWindow | null}
 */
export function clampZoom(a, b, n) {
  if (n <= MIN_ZOOM_POINTS) return null;
  let from = clampInt(Math.min(a, b), 0, n - 1);
  let to = clampInt(Math.max(a, b), 0, n - 1);
  while (to - from + 1 < MIN_ZOOM_POINTS) {
    if (from > 0) from--;
    if (to - from + 1 < MIN_ZOOM_POINTS && to < n - 1) to++;
  }
  return from === 0 && to === n - 1 ? null : { from, to };
}

/**
 * A zoom window plus the month keys of its edges, so it can be remapped to
 * new indices after a remount reorders or shifts the x points. `zoom: null`
 * always carries `zoomKeys: null`.
 * @param {any} spec
 * @param {ChartState} state
 * @param {ZoomWindow | null} zoom
 * @returns {ChartState}
 */
export function withZoom(spec, state, zoom) {
  return {
    ...state,
    zoom,
    zoomKeys: zoom ? { from: String(spec.x[zoom.from].key), to: String(spec.x[zoom.to].key) } : null,
  };
}

/**
 * The state for a (re)mounted chart. The first mount takes each series'
 * `hidden` flag; a remount keeps the user's toggles, dropping ids the new
 * spec no longer has, plus a currently-unseen id whose series says `hidden`
 * (a part appearing for the first time honours it; one the user has already
 * un-hidden does not go back to hidden just because the spec still marks it
 * so). The remembered zoom is looked up by month key rather than index, so a
 * period change that shifts positions still lands on the same months; a
 * missing key, or data too short to zoom, resets it. Never everything
 * hidden.
 * @param {any} spec
 * @param {ChartState | undefined} prev
 * @returns {ChartState}
 */
export function reconcileState(spec, prev) {
  const ids = new Set(legendEntries(spec).map(e => e.id));
  const prevSeen = prev?.seenSeries ?? new Set();
  const hiddenById = new Map([
    ...(spec.series || []).map(s => [s.id, !!s.hidden]),
    ...(spec.refLines || []).map(r => [refId(r.id), !!r.hidden]),
  ]);
  // A stack part appearing while the stacked view is already on is a part of
  // an existing feature turning up, not a new series the spec gets to hide by
  // default (fix wave 2026-09-27, item 3).
  const stackSkipIds = new Set(prev?.stacked && spec.stack ? spec.stack.ids : []);
  let hiddenSeries;
  if (prev) {
    hiddenSeries = new Set([...prev.hiddenSeries].filter(id => ids.has(id)));
    for (const id of ids) {
      if (stackSkipIds.has(id)) continue;
      if (!prevSeen.has(id) && hiddenById.get(id)) hiddenSeries.add(id);
    }
  } else {
    hiddenSeries = new Set([...ids].filter(id => hiddenById.get(id)));
  }
  if (ids.size && [...ids].every(id => hiddenSeries.has(id))) {
    // Reset to the spec's own defaults rather than showing everything: a
    // stack part the spec marks hidden should stay hidden even after an
    // all-hidden rescue, as long as some other id's default leaves it shown.
    const defaults = new Set([...ids].filter(id => hiddenById.get(id)));
    hiddenSeries = [...ids].every(id => defaults.has(id)) ? new Set() : defaults;
  }
  // seenSeries tracks only ids present on THIS mount, not everything ever
  // seen: a series absent for one mount and back later must be treated as
  // new again (and hidden per its spec default), while a series continuously
  // present that the user un-hid must stay shown (fix wave 2026-09-27, item 1).
  const seenSeries = new Set(ids);

  // A hidden id is kept even when this period's items don't include it (a
  // payee/envelope idle this month stays hidden when it returns), so this
  // does NOT filter down to itemIds the way hiddenSeries does above. It is
  // only trimmed when hiding every id this period happens to have would
  // leave nothing to show (the same "never everything hidden" rule as
  // hiddenSeries), and only the ids from THIS period are unhidden then —
  // ids remembered for absent items keep their hidden state.
  let hiddenItems = new Set(prev ? prev.hiddenItems : []);
  const itemIds = new Set((spec.items || []).map(itemId));
  if (itemIds.size && [...itemIds].every(id => hiddenItems.has(id))) {
    hiddenItems = new Set([...hiddenItems].filter(id => !itemIds.has(id)));
  }
  if (hiddenItems.size > MAX_HIDDEN_ITEMS) {
    // Set iteration order is insertion order, so the earliest-hidden ids
    // (least likely to be the ones a returning user still cares about) are
    // the ones dropped.
    hiddenItems = new Set([...hiddenItems].slice(-MAX_HIDDEN_ITEMS));
  }

  const n = (spec.x || []).length;
  let zoom = null;
  let zoomKeys = null;
  if (prev?.zoomKeys && canZoom(spec)) {
    const indexOf = new Map((spec.x || []).map((x, i) => [String(x.key), i]));
    const from = indexOf.get(prev.zoomKeys.from);
    const to = indexOf.get(prev.zoomKeys.to);
    if (from != null && to != null) {
      const clamped = clampZoom(from, to, n);
      zoom = clamped;
      zoomKeys = clamped ? { from: String(spec.x[clamped.from].key), to: String(spec.x[clamped.to].key) } : null;
    }
  }
  const stacked = !!(spec.stack && prev?.stacked);
  return { hiddenSeries, hiddenItems, zoom, zoomKeys, seenSeries, stacked,
    ...(spec.scaleControl ? { yScale: prev?.yScale === 'zero' ? 'zero' : 'fit' } : {}),
  };
}

/** Hide or show one legend entry; hiding the last visible one is refused. */
export function toggleSeries(spec, state, id) {
  const hidden = new Set(state.hiddenSeries);
  if (hidden.has(id)) {
    hidden.delete(id);
  } else {
    const visible = legendEntries(spec).filter(e => !hidden.has(e.id));
    if (visible.length <= 1) return state;
    hidden.add(id);
  }
  return { ...state, hiddenSeries: hidden };
}

/**
 * Switch the stacked view. On shows every stack series (parts may start
 * hidden); off hides again the ones the spec marks `hidden`. Never leaves
 * everything hidden.
 */
export function setStacked(spec, state, on) {
  if (!spec.stack || spec.kind !== 'line') return state;
  const hidden = new Set(state.hiddenSeries);
  const specHidden = new Set((spec.series || []).filter(s => s.hidden).map(s => s.id));
  for (const id of spec.stack.ids) {
    if (on) hidden.delete(id);
    else if (specHidden.has(id)) hidden.add(id);
  }
  const ids = legendEntries(spec).map(e => e.id);
  if (ids.every(id => hidden.has(id))) for (const id of spec.stack.ids) hidden.delete(id);
  return { ...state, stacked: !!on, hiddenSeries: hidden };
}

/** The x window in view: the zoom, or everything. */
export function zoomWindow(spec, state) {
  const n = (spec.x || []).length;
  return state.zoom ?? { from: 0, to: Math.max(0, n - 1) };
}

/**
 * The y axis for what is in view: visible series inside the zoom window,
 * visible reference lines, and in the stacked view the stack's extents in
 * place of the parts' own values. A zoomed line chart fits the axis to that
 * data (`niceFitRange`); an explicit scaleControl also fits unzoomed lines
 * unless Start at zero is selected. Other unzoomed charts keep the zero-based
 * `niceMinMax` axis. In the stacked view the axis always includes zero, even
 * when zoomed, because the layers are anchored there (`stackLayers`'
 * `min`/`max` always straddle it, which pulls a "fit" range back through
 * `niceMinMax`).
 */
export function yRange(spec, state) {
  const win = zoomWindow(spec, state);
  const fit = spec.kind === 'line' && !isStacked(spec, state)
    && (spec.scaleControl ? state.yScale !== 'zero' : !!state.zoom);
  let min = fit ? Infinity : 0;
  let max = fit ? -Infinity : 0;
  const see = v => {
    if (v < min) min = v;
    if (v > max) max = v;
  };
  const stacked = isStacked(spec, state);
  const stackIds = new Set(stacked ? spec.stack.ids : []);
  for (const s of spec.series || []) {
    if (!isSeriesVisible(spec, state, s.id) || stackIds.has(s.id)) continue;
    for (let i = win.from; i <= win.to; i++) see(num(s.values[i]));
  }
  if (stacked) {
    const ext = stackLayers(stackSeries(spec, state), win.from, win.to);
    see(ext.min);
    see(ext.max);
  }
  for (const r of visibleRefLines(spec, state)) see(num(r.value));
  if (!fit) return niceMinMax(min, max);
  if (min === Infinity) return niceMinMax(0, 0);
  return niceFitRange(min, max);
}

/**
 * Zoom in (factor < 1) or out (factor > 1) around an x index, keeping that
 * index at the same relative place in the window. Null once it covers all.
 * @param {ZoomWindow} win
 * @returns {ZoomWindow | null}
 */
export function zoomBy(win, n, factor, center) {
  const count = win.to - win.from + 1;
  const next = Math.max(MIN_ZOOM_POINTS, Math.round(count * factor));
  if (next >= n) return null;
  const rel = count > 1 ? (center - win.from) / (count - 1) : 0.5;
  const from = Math.max(0, Math.min(n - next, Math.round(center - rel * (next - 1))));
  return clampZoom(from, from + next - 1, n);
}

/**
 * Pixel x of an x index. Line points span the plot edge to edge; bars sit
 * centred in equal slots.
 * @param {ZoomWindow} win
 */
export function xForIndex(kind, i, win, plotLeft, plotWidth) {
  const count = win.to - win.from + 1;
  const k = i - win.from;
  if (kind === 'bar') return plotLeft + (k + 0.5) * (plotWidth / count);
  return count === 1 ? plotLeft + plotWidth / 2 : plotLeft + k * (plotWidth / (count - 1));
}

/**
 * The x index nearest a pixel x, inside the window.
 * @param {ZoomWindow} win
 */
export function nearestIndex(kind, px, win, plotLeft, plotWidth) {
  const count = win.to - win.from + 1;
  const k = kind === 'bar'
    ? Math.floor((px - plotLeft) / (plotWidth / count))
    : count === 1 ? 0 : Math.round((px - plotLeft) / (plotWidth / (count - 1)));
  return win.from + Math.max(0, Math.min(count - 1, k));
}

/**
 * What the tooltip lists at one x index: every visible legend entry in
 * legend order; the band as one row carrying its low and high; a reference
 * line with its constant value.
 */
export function tooltipRows(spec, state, index, bandName = '') {
  const byId = new Map((spec.series || []).map(s => [s.id, s]));
  const refById = new Map((spec.refLines || []).map(r => [refId(r.id), r]));
  const at = id => num(byId.get(id)?.values[index]);
  return legendEntries(spec, bandName)
    .filter(e => !state.hiddenSeries.has(e.id))
    .map(e => {
      if (e.band) return { id: e.id, name: e.name, color: e.color, band: true, low: at(spec.band.low), high: at(spec.band.high) };
      if (e.ref) return { id: e.id, name: e.name, color: e.color, band: false, ref: true, value: num(refById.get(e.id)?.value) };
      return { id: e.id, name: e.name, color: e.color, band: false, value: at(e.id), missing: isGap(spec, byId.get(e.id)?.values[index]) };
    });
}

/**
 * With `spec.gaps`, a missing value is "no data" in the tooltip and the table
 * rather than a real 0 (e.g. an Age of Money month with too little history).
 * It still draws as 0.
 */
function isGap(spec, v) {
  return !!spec.gaps && !Number.isFinite(v);
}

/** Hide or show one item (hbar, pie); hiding the last visible one is refused. */
export function toggleItem(spec, state, id) {
  const hidden = new Set(state.hiddenItems);
  if (hidden.has(id)) {
    hidden.delete(id);
  } else {
    const visible = (spec.items || []).map(itemId).filter(x => !hidden.has(x));
    if (visible.length <= 1) return state;
    hidden.add(id);
  }
  return { ...state, hiddenItems: hidden };
}

export function showAllItems(state) {
  return { ...state, hiddenItems: new Set() };
}

/**
 * How many of THIS period's items are hidden — what the toolbar's "N hidden
 * · Show all" chip should count. `state.hiddenItems` can also hold ids for
 * items absent from the current period (reconcileState keeps those on
 * purpose, so a hidden envelope/payee stays hidden if it reappears later);
 * counting the whole set there would show a number bigger than what "Show
 * all" actually reveals right now.
 */
export function hiddenItemCountInView(spec, state) {
  let n = 0;
  for (const it of spec.items || []) if (state.hiddenItems.has(itemId(it))) n++;
  return n;
}

/**
 * Items still showing, each with its colour (fixed by its place in the full
 * list, so hiding one does not repaint the rest) and its share, in percent,
 * of the visible total. A pie keeps positive values only.
 */
export function visibleItems(spec, state) {
  const shown = (spec.items || [])
    .map((it, i) => ({ ...it, id: itemId(it), color: it.color || paletteFor(i), value: num(it.value) }))
    .filter(it => !state.hiddenItems.has(it.id) && (spec.kind !== 'pie' || it.value > 0));
  const total = shown.reduce((s, it) => s + Math.abs(it.value), 0);
  return shown.map(it => ({ ...it, share: total ? (Math.abs(it.value) / total) * 100 : 0 }));
}

/**
 * What is in view, as rows and columns for the table and the CSV: the x
 * points in the zoom window by the visible series (a band as its low and
 * high columns), or the visible items by one value column.
 * @param {{ label: string, value: string }} headers  first-column and item-value headings
 */
export function tableData(spec, state, headers) {
  if (spec.kind === 'hbar' || spec.kind === 'pie') {
    return {
      columns: [headers.label, headers.value],
      rows: visibleItems(spec, state).map(it => ({ label: it.label, values: [it.value] })),
    };
  }
  const win = zoomWindow(spec, state);
  const cols = (spec.series || []).filter(s => isSeriesVisible(spec, state, s.id));
  const refs = visibleRefLines(spec, state);
  const rows = [];
  for (let i = win.from; i <= win.to; i++) {
    rows.push({
      label: spec.x[i].label,
      values: [...cols.map(s => (isGap(spec, s.values[i]) ? null : num(s.values[i]))), ...refs.map(r => num(r.value))],
    });
  }
  return { columns: [headers.label, ...cols.map(s => s.name), ...refs.map(r => r.name)], rows };
}

// A text cell that starts with =, +, - or @ is a formula in Excel/Sheets;
// prefix it with an apostrophe (a text-forcing marker Excel/Sheets strip on
// display) so opening the CSV never runs one. Numeric cells never go through
// this function, so they are untouched.
export function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * RFC 4180 CSV: header row, quoted where needed, raw numbers (dot decimal, no
 * grouping), CRLF line ends, and a UTF-8 BOM, which Excel needs to show ä/ö.
 * A gap (null, see `isGap`) is an empty cell.
 * @param {{ columns: string[], rows: { label: string, values: (number | null)[] }[] }} table
 */
export function toCsv(table) {
  const lines = [table.columns.map(csvCell).join(',')];
  for (const r of table.rows) lines.push([csvCell(r.label), ...r.values.map(v => (v == null ? '' : String(round2(v))))].join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
