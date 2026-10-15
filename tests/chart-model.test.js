// The chart component's pure half (js/ui/charts/model.js): what is visible,
// the axis over it, the zoom window, tooltip rows, and the table/CSV rows.
import { describe, it, expect } from 'vitest';
import {
  BAND_ID, paletteFor, niceMinMax, niceFitRange, isEmpty, legendEntries, isSeriesVisible,
  reconcileState, toggleSeries, withZoom, yRange, canZoom, clampZoom, zoomBy, zoomWindow, xForIndex, nearestIndex, tooltipRows,
  itemId, toggleItem, showAllItems, visibleItems, hiddenItemCountInView, tableData, toCsv,
  REF_PREFIX, refId, visibleRefLines, isStacked, stackSeries, setStacked,
} from '../js/ui/charts/model.js';
import { serializeState, deserializeState } from '../js/ui/charts/persist.js';

const roundTrip = state => deserializeState(JSON.parse(JSON.stringify(serializeState(state))));

const months = n => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `M${i + 1}` }));
const monthsFrom = (start, n) => Array.from({ length: n }, (_, i) => ({ key: `k${start + i}`, label: `M${start + i + 1}` }));

function lineSpec(overrides = {}) {
  return {
    id: 't', kind: 'line', x: months(4),
    series: [
      { id: 'base', name: 'Base', values: [10, 20, 30, 40] },
      { id: 'low', name: 'Low', values: [5, 15, 25, 35] },
      { id: 'high', name: 'High', values: [15, 25, 35, 45] },
      { id: 'part', name: 'Part', values: [-100, 0, 0, 900] },
    ],
    ...overrides,
  };
}
const band = { low: 'low', high: 'high', around: 'base' };

describe('isEmpty', () => {
  it('is empty without x points or series, or a pie with nothing positive', () => {
    expect(isEmpty({ kind: 'line', x: [], series: [{ id: 'a', values: [] }] })).toBe(true);
    expect(isEmpty({ kind: 'line', x: months(2), series: [] })).toBe(true);
    expect(isEmpty({ kind: 'hbar', items: [] })).toBe(true);
    expect(isEmpty({ kind: 'pie', items: [{ key: 'a', label: 'A', value: 0 }] })).toBe(true);
    expect(isEmpty(lineSpec())).toBe(false);
    expect(isEmpty({ kind: 'pie', items: [{ key: 'a', label: 'A', value: 5 }] })).toBe(false);
  });
});

describe('legendEntries', () => {
  it('lists every series with its palette colour', () => {
    const e = legendEntries(lineSpec());
    expect(e.map(x => x.id)).toEqual(['base', 'low', 'high', 'part']);
    expect(e[3].color).toBe(paletteFor(3));
    expect(e.every(x => !x.band)).toBe(true);
  });

  it('folds the band low and high into one entry after the series they surround', () => {
    const e = legendEntries(lineSpec({ band }), 'Range');
    expect(e.map(x => x.id)).toEqual(['base', BAND_ID, 'part']);
    expect(e[1]).toMatchObject({ name: 'Range', band: true, color: paletteFor(0) });
  });

  it('prefers an explicit colour', () => {
    const spec = lineSpec();
    spec.series[0].color = 'var(--danger)';
    expect(legendEntries(spec)[0].color).toBe('var(--danger)');
  });
});

describe('reconcileState and toggles', () => {
  it('takes each series\' hidden flag on first mount', () => {
    const spec = lineSpec();
    spec.series[3].hidden = true;
    const s = reconcileState(spec, undefined);
    expect([...s.hiddenSeries]).toEqual(['part']);
    expect(s.zoom).toBeNull();
  });

  it('never starts with everything hidden', () => {
    const spec = lineSpec();
    for (const x of spec.series) x.hidden = true;
    expect(reconcileState(spec, undefined).hiddenSeries.size).toBe(0);
  });

  it('keeps the user\'s toggles on remount and drops ids that are gone', () => {
    const prev = { hiddenSeries: new Set(['part', 'gone']), hiddenItems: new Set(), zoom: null };
    expect([...reconcileState(lineSpec(), prev).hiddenSeries]).toEqual(['part']);
  });

  it('a series appearing for the first time on a remount starts hidden if it says so', () => {
    const spec = lineSpec();
    const s0 = reconcileState(spec, undefined);
    expect([...s0.seenSeries].sort()).toEqual(['base', 'high', 'low', 'part']);
    const spec2 = lineSpec();
    spec2.series.push({ id: 'extra', name: 'Extra', values: [1, 2, 3, 4], hidden: true });
    const s1 = reconcileState(spec2, s0);
    expect(s1.hiddenSeries.has('extra')).toBe(true);
    expect(s1.seenSeries.has('extra')).toBe(true);
  });

  it('a series the user un-hid stays shown on a later remount, even though the spec still marks it hidden', () => {
    const spec = lineSpec();
    spec.series[3].hidden = true; // 'part' starts hidden
    const s0 = reconcileState(spec, undefined);
    const s1 = toggleSeries(spec, s0, 'part'); // user un-hides it
    expect(s1.hiddenSeries.has('part')).toBe(false);
    const s2 = reconcileState(spec, s1); // remount with the same spec (still hidden: true)
    expect(s2.hiddenSeries.has('part')).toBe(false);
  });

  it('a part un-hidden by the user stays shown across a serialize/deserialize remount while present', () => {
    const spec = lineSpec();
    spec.series[3].hidden = true; // 'part' starts hidden
    const s0 = reconcileState(spec, undefined);
    const s1 = toggleSeries(spec, s0, 'part'); // user un-hides it
    const persisted = roundTrip(s1); // e.g. a page reload, reading localStorage back
    const s2 = reconcileState(spec, persisted); // same spec, 'part' still present, still hidden: true
    expect(s2.hiddenSeries.has('part')).toBe(false);
  });

  it('seenSeries reflects only ids present now, so a part absent for one visit and back for the next is treated as new again', () => {
    // Visit 1: 'part' present, hidden by default.
    const spec1 = lineSpec();
    spec1.series[3].hidden = true;
    const s0 = reconcileState(spec1, undefined);
    expect(s0.hiddenSeries.has('part')).toBe(true);
    const persisted1 = roundTrip(s0);

    // Visit 2: 'part' is absent from the spec entirely.
    const spec2 = lineSpec();
    spec2.series = spec2.series.filter(s => s.id !== 'part');
    const s1 = reconcileState(spec2, persisted1);
    expect(s1.seenSeries.has('part')).toBe(false);
    const persisted2 = roundTrip(s1);

    // Visit 3: 'part' comes back, still marked hidden in the spec. Because it
    // was absent (unseen) on the previous visit, it should be treated as a
    // fresh arrival and hidden again, not silently left visible.
    const spec3 = lineSpec();
    spec3.series[3].hidden = true;
    const s2 = reconcileState(spec3, persisted2);
    expect(s2.hiddenSeries.has('part')).toBe(true);
  });

  it('a new stack part does not get auto-hidden while the stacked view is already on', () => {
    const spec = {
      id: 'nw', kind: 'line', x: months(2),
      series: [
        { id: 'cash', name: 'Cash', values: [100, 120], hidden: true },
        { id: 'debt', name: 'Debt', values: [-5, -5], hidden: true },
      ],
      stack: { ids: ['cash', 'debt'] },
    };
    const on = setStacked(spec, reconcileState(spec, undefined), true);
    expect(on.stacked).toBe(true);
    const spec2 = {
      ...spec,
      series: [...spec.series, { id: 'invest', name: 'Invest', values: [1, 2], hidden: true }],
      stack: { ids: ['cash', 'debt', 'invest'] },
    };
    const s1 = reconcileState(spec2, on);
    expect(s1.stacked).toBe(true);
    expect(s1.hiddenSeries.has('invest')).toBe(false);
  });

  it('the all-hidden fallback resets to the spec defaults rather than clearing everything, when a default leaves something visible', () => {
    const spec = {
      id: 'nw', kind: 'line', x: months(2),
      series: [
        { id: 'base', name: 'Base', values: [10, 20] },
        { id: 'low', name: 'Low', values: [5, 15] },
        { id: 'high', name: 'High', values: [15, 25] },
        { id: 'cash', name: 'Cash', values: [100, 120], hidden: true },
        { id: 'debt', name: 'Debt', values: [-5, -5], hidden: true },
      ],
      band: { low: 'low', high: 'high', around: 'base' },
      stack: { ids: ['cash', 'debt'] },
    };
    // Stored state (e.g. from a previous visit): only 'cash' was shown, the
    // rest hidden; here it too has since been hidden, so everything is.
    const prev = {
      hiddenSeries: new Set(['base', BAND_ID, 'cash', 'debt']),
      hiddenItems: new Set(),
      zoom: null, zoomKeys: null,
      seenSeries: new Set(['base', BAND_ID, 'cash', 'debt']),
      stacked: false,
    };
    const s = reconcileState(spec, prev);
    // Falls back to the spec's own defaults: base and the band are not
    // marked hidden, so they come back; cash/debt stay hidden per spec.
    expect([...s.hiddenSeries].sort()).toEqual(['cash', 'debt']);
  });

  it('hides and shows a series, refusing to hide the last visible one', () => {
    const spec = { id: 't', kind: 'line', x: months(2), series: [
      { id: 'a', name: 'A', values: [1, 2] }, { id: 'b', name: 'B', values: [3, 4] }] };
    const s0 = reconcileState(spec, undefined);
    const s1 = toggleSeries(spec, s0, 'a');
    expect(s1.hiddenSeries.has('a')).toBe(true);
    expect(toggleSeries(spec, s1, 'b')).toBe(s1);
    expect(toggleSeries(spec, s1, 'a').hiddenSeries.has('a')).toBe(false);
  });

  it('hiding the band hides both its low and high series', () => {
    const spec = lineSpec({ band });
    const s = toggleSeries(spec, reconcileState(spec, undefined), BAND_ID);
    expect(isSeriesVisible(spec, s, 'low')).toBe(false);
    expect(isSeriesVisible(spec, s, 'high')).toBe(false);
    expect(isSeriesVisible(spec, s, 'base')).toBe(true);
  });

  it('keeps a hidden hbar/pie item id even once its item has no row this period', () => {
    const spec1 = { id: 'h', kind: 'hbar', items: [{ key: 'a', label: 'A', value: 10 }, { key: 'b', label: 'B', value: 5 }] };
    const s0 = toggleItem(spec1, reconcileState(spec1, undefined), 'a');
    expect(s0.hiddenItems.has('a')).toBe(true);
    // 'a' is gone this period (idle envelope/payee); the old code dropped it
    // here because it filtered hiddenItems down to this mount's item ids.
    const spec2 = { id: 'h', kind: 'hbar', items: [{ key: 'b', label: 'B', value: 5 }, { key: 'c', label: 'C', value: 1 }] };
    const s1 = reconcileState(spec2, s0);
    expect(s1.hiddenItems.has('a')).toBe(true);
    // And it comes back hidden if 'a' reappears later, without the user
    // having to hide it again.
    const s2 = reconcileState(spec1, s1);
    expect(s2.hiddenItems.has('a')).toBe(true);
    expect(itemId(spec1.items[1])).toBe('b');
  });

  it('un-hides only this period\'s items when they would otherwise all be hidden, keeping remembered ids for absent items', () => {
    const spec = { id: 'h', kind: 'hbar', items: [{ key: 'a', label: 'A', value: 10 }, { key: 'b', label: 'B', value: 5 }] };
    const prev = {
      hiddenSeries: new Set(), hiddenItems: new Set(['a', 'b', 'zzz-absent']),
      zoom: null, zoomKeys: null, seenSeries: new Set(), stacked: false,
    };
    const s = reconcileState(spec, prev);
    // 'a' and 'b' are this period's only items and both were hidden, which
    // would leave nothing to show, so they are un-hidden...
    expect(s.hiddenItems.has('a')).toBe(false);
    expect(s.hiddenItems.has('b')).toBe(false);
    // ...but the id for an item this period never had stays remembered.
    expect(s.hiddenItems.has('zzz-absent')).toBe(true);
  });

  it('bounds hiddenItems so remembered-but-absent ids cannot grow without limit', () => {
    const spec = { id: 'h', kind: 'hbar', items: [{ key: 'live', label: 'Live', value: 1 }] };
    const many = new Set(Array.from({ length: 305 }, (_, i) => `old-${i}`));
    const prev = { hiddenSeries: new Set(), hiddenItems: many, zoom: null, zoomKeys: null, seenSeries: new Set(), stacked: false };
    const s = reconcileState(spec, prev);
    expect(s.hiddenItems.size).toBeLessThanOrEqual(300);
    // The most recently added (highest-numbered) ids are the ones kept.
    expect(s.hiddenItems.has('old-304')).toBe(true);
    expect(s.hiddenItems.has('old-0')).toBe(false);
  });
});

describe('yRange', () => {
  it('covers only the visible series', () => {
    const spec = lineSpec();
    const all = reconcileState(spec, undefined);
    expect(yRange(spec, all)).toEqual(niceMinMax(-100, 900));
    const noPart = toggleSeries(spec, all, 'part');
    expect(yRange(spec, noPart)).toEqual(niceMinMax(0, 45));
  });

  it('counts the band\'s low and high while the band shows', () => {
    const spec = lineSpec({ band });
    const s = toggleSeries(spec, reconcileState(spec, undefined), 'part');
    expect(yRange(spec, s)).toEqual(niceMinMax(0, 45));
    const noBand = toggleSeries(spec, s, BAND_ID);
    expect(yRange(spec, noBand)).toEqual(niceMinMax(0, 40));
  });

  it('fits a zoomed line chart to the visible data instead of a zero-based axis', () => {
    const spec = {
      id: 't', kind: 'line', x: months(4),
      series: [{ id: 'a', name: 'A', values: [0, 19130, 20442, 0] }],
    };
    const zoomedIn = { hiddenSeries: new Set(), hiddenItems: new Set(), zoom: { from: 1, to: 2 } };
    expect(yRange(spec, zoomedIn)).toEqual({ min: 19000, max: 21000 });
    const unzoomed = { hiddenSeries: new Set(), hiddenItems: new Set(), zoom: null };
    expect(yRange(spec, unzoomed)).toEqual(niceMinMax(0, 20442));
  });

  it('keeps a zoomed bar chart zero-based', () => {
    const spec = {
      id: 't', kind: 'bar', x: months(4),
      series: [{ id: 'a', name: 'A', values: [0, 19130, 20442, 0] }],
    };
    const zoomedIn = { hiddenSeries: new Set(), hiddenItems: new Set(), zoom: { from: 1, to: 2 } };
    expect(yRange(spec, zoomedIn)).toEqual(niceMinMax(0, 20442));
  });

  it('excludes hidden series from the fitted range of a zoomed line chart', () => {
    const spec = {
      id: 't', kind: 'line', x: months(4),
      series: [
        { id: 'a', name: 'A', values: [0, 19130, 20442, 0] },
        { id: 'b', name: 'B', values: [0, -900000, 900000, 0] },
      ],
    };
    const zoomedHidingB = { hiddenSeries: new Set(['b']), hiddenItems: new Set(), zoom: { from: 1, to: 2 } };
    expect(yRange(spec, zoomedHidingB)).toEqual({ min: 19000, max: 21000 });
  });
});

describe('niceFitRange', () => {
  it('pads the data by 5% and rounds to a nice four-interval step', () => {
    expect(niceFitRange(19130, 20442)).toEqual({ min: 19000, max: 21000 });
  });

  it('centres a flat range (min === max) on 10% of the magnitude', () => {
    expect(niceFitRange(100, 100)).toEqual({ min: 95, max: 105 });
  });

  it('defers to niceMinMax when the data touches or crosses zero', () => {
    expect(niceFitRange(-800, 26000)).toEqual(niceMinMax(-800, 26000));
  });

  it('never pads across zero on an all-negative range', () => {
    expect(niceFitRange(-40, -5)).toEqual({ min: -60, max: 20 });
  });

  it('accepts its arguments in either order', () => {
    expect(niceFitRange(20442, 19130)).toEqual({ min: 19000, max: 21000 });
  });

  it('always encloses the data with a nice four-interval step', () => {
    const cases = [[19130, 20442], [100, 100], [-40, -5], [-800, 26000], [0.001, 0.002], [1, 1], [-5, -5]];
    for (const [a, b] of cases) {
      const min = Math.min(a, b);
      const max = Math.max(a, b);
      const { min: lo, max: hi } = niceFitRange(a, b);
      expect(lo).toBeLessThanOrEqual(min);
      expect(hi).toBeGreaterThanOrEqual(max);
      const step = (hi - lo) / 4;
      const pow = Math.pow(10, Math.floor(Math.log10(step)));
      const mantissa = Number((step / pow).toPrecision(10));
      expect([1, 2, 2.5, 5, 10]).toContain(mantissa);
    }
  });
});

describe('zoom', () => {
  it('is offered for line and bar charts above six points only', () => {
    expect(canZoom({ kind: 'line', x: months(6) })).toBe(false);
    expect(canZoom({ kind: 'line', x: months(7) })).toBe(true);
    expect(canZoom({ kind: 'bar', x: months(12) })).toBe(true);
    expect(canZoom({ kind: 'hbar', x: months(12) })).toBe(false);
  });

  it('clamps a window to whole points, in either order, inside the data', () => {
    expect(clampZoom(5, 2, 10)).toEqual({ from: 2, to: 5 });
    expect(clampZoom(-3, 4.4, 10)).toEqual({ from: 0, to: 4 });
  });

  it('grows a window narrower than three points around its middle', () => {
    expect(clampZoom(4, 4, 10)).toEqual({ from: 3, to: 5 });
    expect(clampZoom(0, 0, 10)).toEqual({ from: 0, to: 2 });
    expect(clampZoom(9, 9, 10)).toEqual({ from: 7, to: 9 });
  });

  it('is null (unzoomed) when the window covers everything', () => {
    expect(clampZoom(0, 9, 10)).toBeNull();
    expect(clampZoom(-5, 20, 10)).toBeNull();
    expect(clampZoom(0, 1, 3)).toBeNull();
  });

  it('is null for three or fewer points, whatever the indices', () => {
    expect(clampZoom(0, 0, 1)).toBeNull();
    expect(clampZoom(0, 1, 2)).toBeNull();
    expect(clampZoom(0, 2, 3)).toBeNull();
  });

  it('zoomWindow is the whole range when not zoomed', () => {
    expect(zoomWindow({ x: months(8) }, { zoom: null })).toEqual({ from: 0, to: 7 });
    expect(zoomWindow({ x: months(8) }, { zoom: { from: 2, to: 5 } })).toEqual({ from: 2, to: 5 });
  });

  it('zooms in by a factor around a point and back out to null', () => {
    const inWin = zoomBy({ from: 0, to: 11 }, 12, 0.5, 6);
    expect(inWin).toEqual({ from: 3, to: 8 });
    expect(zoomBy(/** @type {any} */ (inWin), 12, 2, 6)).toBeNull();
  });

  it('never zooms in past three points', () => {
    expect(zoomBy({ from: 3, to: 5 }, 12, 0.5, 4)).toEqual({ from: 3, to: 5 });
  });

  it('zooming around the first or last index stays inside the data and keeps at least three points', () => {
    const win = { from: 0, to: 11 };
    expect(zoomBy(win, 12, 0.5, 0)).toEqual({ from: 0, to: 5 });
    expect(zoomBy(win, 12, 0.5, 11)).toEqual({ from: 6, to: 11 });
  });

  it('withZoom carries the zoomed indices\' month keys alongside the window, and clears them when unzoomed', () => {
    const spec = { x: months(6) };
    const base = reconcileState(spec, undefined);
    expect(base.zoomKeys).toBeNull();
    const zoomed = withZoom(spec, base, { from: 1, to: 3 });
    expect(zoomed.zoom).toEqual({ from: 1, to: 3 });
    expect(zoomed.zoomKeys).toEqual({ from: 'k1', to: 'k3' });
    expect(withZoom(spec, zoomed, null).zoomKeys).toBeNull();
  });

  it('a remembered zoom by month key remaps to the new indices when the data shifts', () => {
    const spec10 = { kind: 'line', x: months(10), series: [{ id: 'a', name: 'A', values: [] }] };
    const zoomed = withZoom(spec10, reconcileState(spec10, undefined), { from: 2, to: 4 }); // keys k2..k4
    const shifted = { ...spec10, x: [{ key: 'k-1', label: 'M0' }, ...months(10)] }; // k2 is now at index 3
    const next = reconcileState(shifted, zoomed);
    expect(next.zoom).toEqual({ from: 3, to: 5 });
    expect(next.zoomKeys).toEqual({ from: 'k2', to: 'k4' });
  });

  it('a remembered zoom resets when one of its month keys is gone from the new data', () => {
    const spec10 = { kind: 'line', x: months(10), series: [{ id: 'a', name: 'A', values: [] }] };
    const zoomed = withZoom(spec10, reconcileState(spec10, undefined), { from: 2, to: 4 }); // keys k2..k4
    const replaced = { ...spec10, x: monthsFrom(100, 8) }; // none of the old keys exist
    const next = reconcileState(replaced, zoomed);
    expect(next.zoom).toBeNull();
    expect(next.zoomKeys).toBeNull();
  });

  it('yRange follows the zoom window', () => {
    const spec = { kind: 'line', x: months(8), series: [{ id: 'a', name: 'A', values: [0, 10, 20, 30, 40, 50, 60, 70] }] };
    expect(yRange(spec, { hiddenSeries: new Set(), hiddenItems: new Set(), zoom: { from: 0, to: 2 } })).toEqual({ min: 0, max: 20 });
    expect(yRange(spec, { hiddenSeries: new Set(), hiddenItems: new Set(), zoom: null })).toEqual({ min: 0, max: 100 });
  });
});

describe('pixel geometry', () => {
  it('spreads line points edge to edge across the window', () => {
    const win = { from: 0, to: 4 };
    expect(xForIndex('line', 0, win, 10, 100)).toBe(10);
    expect(xForIndex('line', 2, win, 10, 100)).toBe(60);
    expect(xForIndex('line', 4, win, 10, 100)).toBe(110);
    expect(xForIndex('line', 2, { from: 2, to: 4 }, 10, 100)).toBe(10);
    expect(xForIndex('line', 0, { from: 0, to: 0 }, 10, 100)).toBe(60);
  });

  it('centres bars in equal slots', () => {
    const win = { from: 0, to: 3 };
    expect(xForIndex('bar', 0, win, 0, 100)).toBe(12.5);
    expect(xForIndex('bar', 3, win, 0, 100)).toBe(87.5);
  });

  it('finds the nearest index, clamped to the window', () => {
    const win = { from: 0, to: 4 };
    expect(nearestIndex('line', 58, win, 10, 100)).toBe(2);
    expect(nearestIndex('line', -50, win, 10, 100)).toBe(0);
    expect(nearestIndex('line', 500, win, 10, 100)).toBe(4);
    expect(nearestIndex('line', 10, { from: 2, to: 4 }, 10, 100)).toBe(2);
    expect(nearestIndex('bar', 30, { from: 0, to: 3 }, 0, 100)).toBe(1);
    expect(nearestIndex('bar', 100, { from: 0, to: 3 }, 0, 100)).toBe(3);
  });

  it('with a 1-point window returns that index for any px', () => {
    const win = { from: 2, to: 2 };
    expect(nearestIndex('line', -1000, win, 10, 100)).toBe(2);
    expect(nearestIndex('line', 0, win, 10, 100)).toBe(2);
    expect(nearestIndex('line', 1000, win, 10, 100)).toBe(2);
    expect(nearestIndex('bar', -1000, win, 10, 100)).toBe(2);
    expect(nearestIndex('bar', 1000, win, 10, 100)).toBe(2);
  });
});

describe('tooltipRows', () => {
  it('lists visible entries in legend order, the band as one range row', () => {
    const spec = lineSpec({ band });
    const s = reconcileState(spec, undefined);
    const rows = tooltipRows(spec, s, 1, 'Range');
    expect(rows.map(r => r.id)).toEqual(['base', BAND_ID, 'part']);
    expect(rows[0]).toMatchObject({ band: false, value: 20 });
    expect(rows[1]).toMatchObject({ band: true, name: 'Range', low: 15, high: 25 });
  });

  it('omits hidden entries and reads a missing value as 0', () => {
    const spec = lineSpec();
    spec.series[0].values[2] = NaN;
    const s = toggleSeries(spec, reconcileState(spec, undefined), 'part');
    const rows = tooltipRows(spec, s, 2);
    expect(rows.map(r => r.id)).toEqual(['base', 'low', 'high']);
    expect(rows[0]).toMatchObject({ value: 0 });
  });
});

const hbarSpec = () => ({
  id: 'h', kind: 'hbar',
  items: [
    { key: 'a', label: 'Alpha', value: 60 },
    { key: 'b', label: 'Beta', value: 30 },
    { key: null, label: 'Other (3)', value: 10 },
  ],
});

describe('items', () => {
  it('ids items by key, or by label for the keyless Other row', () => {
    expect(itemId({ key: 7, label: 'x' })).toBe('7');
    expect(itemId({ key: null, label: 'Other (3)' })).toBe('label:Other (3)');
  });

  it('shares are of the visible total and recompute after hiding', () => {
    const spec = hbarSpec();
    const s = reconcileState(spec, undefined);
    expect(visibleItems(spec, s).map(it => it.share)).toEqual([60, 30, 10]);
    const s2 = toggleItem(spec, s, 'a');
    const shown = visibleItems(spec, s2);
    expect(shown.map(it => it.id)).toEqual(['b', 'label:Other (3)']);
    expect(shown.map(it => it.share)).toEqual([75, 25]);
    expect(shown[0].color).toBe(paletteFor(1));
  });

  it('keeps each shown item\'s colour after hiding an earlier one, compared to the unhidden run', () => {
    const spec = hbarSpec();
    const before = visibleItems(spec, reconcileState(spec, undefined));
    const s = toggleItem(spec, reconcileState(spec, undefined), 'a');
    const after = visibleItems(spec, s);
    expect(after.map(it => it.id)).toEqual(['b', 'label:Other (3)']);
    for (const it of after) {
      expect(it.color).toBe(before.find(b => b.id === it.id).color);
    }
  });

  it('a pie keeps positive values only', () => {
    const spec = { id: 'p', kind: 'pie', items: [
      { key: 'a', label: 'A', value: 5 }, { key: 'b', label: 'B', value: 0 }, { key: 'c', label: 'C', value: -2 }] };
    expect(visibleItems(spec, reconcileState(spec, undefined)).map(it => it.id)).toEqual(['a']);
  });

  it('refuses to hide the last item; Show all brings them back', () => {
    const spec = hbarSpec();
    let s = reconcileState(spec, undefined);
    s = toggleItem(spec, s, 'a');
    s = toggleItem(spec, s, 'b');
    expect(toggleItem(spec, s, 'label:Other (3)')).toBe(s);
    expect(showAllItems(s).hiddenItems.size).toBe(0);
  });

  it('keeps a hidden id the new data no longer has, so it stays hidden if it comes back', () => {
    const prev = { hiddenSeries: new Set(), hiddenItems: new Set(['a', 'zzz']), zoom: null };
    expect([...reconcileState(hbarSpec(), prev).hiddenItems].sort()).toEqual(['a', 'zzz']);
  });

  it('hiddenItemCountInView counts only ids present in this period\'s items, not remembered-but-absent ones', () => {
    const spec = hbarSpec();
    const prev = {
      hiddenSeries: new Set(), hiddenItems: new Set(['a', 'zzz-absent', 'also-absent']),
      zoom: null, zoomKeys: null, seenSeries: new Set(), stacked: false,
    };
    const s = reconcileState(spec, prev);
    // The remembered set carries all three (this is the fix from the round
    // before: absent ids are not dropped)...
    expect(s.hiddenItems.size).toBe(3);
    // ...but the toolbar count — what "Show all" will actually reveal on
    // screen right now — only counts 'a', which is in spec.items.
    expect(hiddenItemCountInView(spec, s)).toBe(1);
  });

  it('hiddenItemCountInView is 0 once none of this period\'s items are hidden, even with ids remembered for absent ones', () => {
    const spec = hbarSpec();
    const s = { hiddenSeries: new Set(), hiddenItems: new Set(['zzz-absent']), zoom: null, zoomKeys: null, seenSeries: new Set(), stacked: false };
    expect(hiddenItemCountInView(spec, s)).toBe(0);
  });
});

describe('gaps', () => {
  const headers = { label: 'Period', value: 'Value' };
  const gapSpec = gaps => ({
    id: 'g', kind: 'bar', x: months(3), gaps,
    series: [{ id: 'aom', name: 'AoM', values: [12, null, 0] }],
  });

  it('marks a missing value as a gap only when the chart opts in', () => {
    const on = gapSpec(true);
    const s = reconcileState(on, undefined);
    expect(tooltipRows(on, s, 1)[0]).toMatchObject({ value: 0, missing: true });
    expect(tooltipRows(on, s, 2)[0]).toMatchObject({ value: 0, missing: false });
    const off = gapSpec(undefined);
    expect(tooltipRows(off, reconcileState(off, undefined), 1)[0]).toMatchObject({ value: 0, missing: false });
  });

  it('leaves a gap empty in the table and the CSV, a real 0 stays 0', () => {
    const spec = gapSpec(true);
    const table = tableData(spec, reconcileState(spec, undefined), headers);
    expect(table.rows.map(r => r.values)).toEqual([[12], [null], [0]]);
    expect(toCsv(table)).toBe('\uFEFFPeriod,AoM\r\nM1,12\r\nM2,\r\nM3,0\r\n');
  });
});

describe('tableData and toCsv', () => {
  const headers = { label: 'Period', value: 'Value' };

  it('series: rows in the zoom window, columns for visible series (band as low and high)', () => {
    const spec = { ...lineSpec({ band }), x: months(4) };
    let s = reconcileState(spec, undefined);
    s = toggleSeries(spec, s, 'part');
    s = { ...s, zoom: { from: 1, to: 2 } };
    expect(tableData(spec, s, headers)).toEqual({
      columns: ['Period', 'Base', 'Low', 'High'],
      rows: [
        { label: 'M2', values: [20, 15, 25] },
        { label: 'M3', values: [30, 25, 35] },
      ],
    });
  });

  it('items: one value column of the visible items', () => {
    const spec = hbarSpec();
    const s = toggleItem(spec, reconcileState(spec, undefined), 'b');
    expect(tableData(spec, s, { label: 'Item', value: 'Value' })).toEqual({
      columns: ['Item', 'Value'],
      rows: [{ label: 'Alpha', values: [60] }, { label: 'Other (3)', values: [10] }],
    });
  });

  it('writes RFC 4180 CSV with a BOM, CRLF and raw rounded numbers', () => {
    const csv = toCsv({
      columns: ['Item', 'Value, €'],
      rows: [
        { label: 'Café "Bar"', values: [1234.5] },
        { label: 'Two\nlines', values: [-0.456] },
        { label: 'Plain', values: [1000000] },
      ],
    });
    expect(csv).toBe('﻿Item,"Value, €"\r\n"Café ""Bar""",1234.5\r\n"Two\nlines",-0.46\r\nPlain,1000000\r\n');
  });

  it('guards text cells that start with =, +, - or @ against formula injection', () => {
    const csv = toCsv({
      columns: ['=SUM(A1)', 'Value'],
      rows: [
        { label: '=cmd', values: [1] },
        { label: '+1lure', values: [2] },
        { label: '-1lure', values: [3] },
        { label: '@lure', values: [4] },
        { label: 'Normal', values: [5] },
      ],
    });
    expect(csv).toBe(
      "﻿'=SUM(A1),Value\r\n'=cmd,1\r\n'+1lure,2\r\n'-1lure,3\r\n'@lure,4\r\nNormal,5\r\n",
    );
  });
});

describe('reference lines', () => {
  const withRefs = () => ({
    id: 't', kind: 'line', x: months(3),
    series: [{ id: 'spend', name: 'Spending', values: [100, 200, 300] }],
    refLines: [{ id: 'avg', name: 'Average', value: 250 }, { id: 'goal', name: 'Goal', value: 900, hidden: true }],
  });

  it('adds a legend entry per line after the series, with a ref id', () => {
    const e = legendEntries(withRefs());
    expect(e.map(x => x.id)).toEqual(['spend', refId('avg'), refId('goal')]);
    expect(REF_PREFIX).toBe('ref:');
    expect(e[1]).toMatchObject({ name: 'Average', ref: true, band: false });
    expect(e[0].ref).toBe(false);
  });

  it('honours hidden and toggles like a series', () => {
    const spec = withRefs();
    const s = reconcileState(spec, undefined);
    expect(visibleRefLines(spec, s).map(r => r.id)).toEqual(['avg']);
    const s2 = toggleSeries(spec, s, refId('avg'));
    expect(visibleRefLines(spec, s2)).toEqual([]);
  });

  it('counts visible reference values toward the axis', () => {
    const spec = withRefs();
    const s = reconcileState(spec, undefined);
    expect(yRange(spec, s)).toEqual(niceMinMax(0, 300));
    const shown = toggleSeries(spec, s, refId('goal'));
    expect(yRange(spec, shown)).toEqual(niceMinMax(0, 900));
  });

  it('lists visible lines in the tooltip and the table', () => {
    const spec = withRefs();
    const s = reconcileState(spec, undefined);
    const rows = tooltipRows(spec, s, 1);
    expect(rows.map(r => r.id)).toEqual(['spend', refId('avg')]);
    expect(rows[1]).toMatchObject({ ref: true, value: 250 });
    expect(tableData(spec, s, { label: 'Period', value: 'Value' })).toEqual({
      columns: ['Period', 'Spending', 'Average'],
      rows: [
        { label: 'M1', values: [100, 250] },
        { label: 'M2', values: [200, 250] },
        { label: 'M3', values: [300, 250] },
      ],
    });
  });
});

describe('stacked view', () => {
  const stackSpec = () => ({
    id: 'nw', kind: 'line', x: months(2),
    series: [
      { id: 'total', name: 'Total', values: [95, 115] },
      { id: 'cash', name: 'Cash', values: [100, 120], hidden: true },
      { id: 'debt', name: 'Debt', values: [-5, -5], hidden: true },
    ],
    stack: { ids: ['cash', 'debt'] },
  });

  it('starts off, and is never on for a spec without a stack', () => {
    const spec = stackSpec();
    const s = reconcileState(spec, undefined);
    expect(s.stacked).toBe(false);
    expect(isStacked(spec, s)).toBe(false);
    expect(isStacked(lineSpec(), { ...reconcileState(lineSpec(), undefined), stacked: true })).toBe(false);
  });

  it('turning it on shows the stack series; off hides the spec-hidden ones again', () => {
    const spec = stackSpec();
    const on = setStacked(spec, reconcileState(spec, undefined), true);
    expect(on.stacked).toBe(true);
    expect(stackSeries(spec, on).map(s => s.id)).toEqual(['cash', 'debt']);
    const off = setStacked(spec, on, false);
    expect(off.stacked).toBe(false);
    expect([...off.hiddenSeries].sort()).toEqual(['cash', 'debt']);
  });

  it('uses the stack extents for the axis', () => {
    const spec = stackSpec();
    const on = setStacked(spec, reconcileState(spec, undefined), true);
    expect(yRange(spec, on)).toEqual(niceMinMax(-5, 120));
  });

  it('keeps the stacked view on remount', () => {
    const spec = stackSpec();
    const on = setStacked(spec, reconcileState(spec, undefined), true);
    expect(reconcileState(spec, on).stacked).toBe(true);
  });

  it('does nothing for a chart that is not a line (stacking is line-only)', () => {
    const spec = {
      id: 'b', kind: 'bar', x: months(2),
      series: [{ id: 'a', name: 'A', values: [1, 2] }],
      stack: { ids: ['a'] },
    };
    const s = reconcileState(spec, undefined);
    expect(setStacked(spec, s, true)).toBe(s);
  });

  it('never leaves everything hidden when turning stacking off would hide every remaining series', () => {
    const spec = {
      id: 'x', kind: 'line', x: months(2),
      series: [
        { id: 'cash', name: 'Cash', values: [1, 2], hidden: true },
        { id: 'debt', name: 'Debt', values: [1, 2], hidden: true },
      ],
      stack: { ids: ['cash', 'debt'] },
    };
    const on = setStacked(spec, reconcileState(spec, undefined), true);
    expect(on.hiddenSeries.size).toBe(0);
    const off = setStacked(spec, on, false);
    expect(off.hiddenSeries.size).toBe(0);
  });

  it('excludes a hidden stack part from the stack extents used for the axis', () => {
    const spec = stackSpec();
    let s = setStacked(spec, reconcileState(spec, undefined), true);
    s = toggleSeries(spec, s, 'debt'); // hide the debt part again
    expect(yRange(spec, s)).toEqual(niceMinMax(0, 120));
  });

  it('keeps zero in the axis for a stacked, zoomed line chart (the layers are anchored there)', () => {
    const spec = stackSpec();
    const on = setStacked(spec, reconcileState(spec, undefined), true);
    const zoomed = { ...on, zoom: { from: 0, to: 1 } };
    const r = yRange(spec, zoomed);
    expect(r.min).toBeLessThanOrEqual(0);
    expect(r.max).toBeGreaterThanOrEqual(0);
  });
});
