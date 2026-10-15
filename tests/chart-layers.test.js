// Stacking, markers and remembered state for the chart component
// (js/ui/charts/stack.js, markers.js, persist.js). Pure; no DOM.
import { describe, it, expect, afterEach } from 'vitest';
import { stackLayers } from '../js/ui/charts/stack.js';
import { markersByIndex, withMarkerNote } from '../js/ui/charts/markers.js';
import {
  serializeState, deserializeState, loadChartState, saveChartState, loadChartPrefs, saveChartPrefs, setChartBudgetKey,
  getSessionChartState, setSessionChartState,
} from '../js/ui/charts/persist.js';

describe('stackLayers', () => {
  const series = [
    { id: 'a', values: [10, 20, 30] },
    { id: 'debt', values: [-5, -5, -8] },
    { id: 'b', values: [1, NaN, 2] },
  ];

  it('stacks non-negative values up and negative values down, in order', () => {
    const { layers, min, max } = stackLayers(series, 0, 2);
    expect(layers.map(l => l.id)).toEqual(['a', 'debt', 'b']);
    expect(layers[0]).toEqual({ id: 'a', lo: [0, 0, 0], hi: [10, 20, 30] });
    expect(layers[1]).toEqual({ id: 'debt', lo: [-5, -5, -8], hi: [0, 0, 0] });
    expect(layers[2]).toEqual({ id: 'b', lo: [10, 20, 30], hi: [11, 20, 32] });
    expect(min).toBe(-8);
    expect(max).toBe(32);
  });

  it('covers only the window and never excludes zero', () => {
    const { layers, min, max } = stackLayers([{ id: 'a', values: [5, 6, 7] }], 1, 2);
    expect(layers[0]).toEqual({ id: 'a', lo: [0, 0], hi: [6, 7] });
    expect(min).toBe(0);
    expect(max).toBe(7);
    expect(stackLayers([], 0, 1)).toEqual({ layers: [], min: 0, max: 0 });
  });
});

describe('markersByIndex', () => {
  it('groups markers by x index in order and drops unknown keys', () => {
    const spec = {
      x: [{ key: '2026-09-30', label: 'Sep' }, { key: '2026-10-31', label: 'Oct' }],
      markers: [
        { key: '2026-10-31', label: 'first' },
        { key: 'nope', label: 'dropped' },
        { key: '2026-10-31', label: 'second' },
        { key: '2026-09-30', label: 'sep' },
      ],
    };
    const m = markersByIndex(spec);
    expect([...m.keys()].sort()).toEqual([0, 1]);
    expect(m.get(1).map(x => x.label)).toEqual(['first', 'second']);
    expect(m.get(0).map(x => x.label)).toEqual(['sep']);
    expect(markersByIndex({ x: [] }).size).toBe(0);
  });
});

describe('withMarkerNote', () => {
  it('appends the note only when the chart has markers', () => {
    const none = markersByIndex({ x: [{ key: 'a', label: 'A' }], markers: [] });
    const some = markersByIndex({ x: [{ key: 'a', label: 'A' }], markers: [{ key: 'a', label: 'm' }] });
    expect(withMarkerNote('Base.', none, 'Enter activates a marker.')).toBe('Base.');
    expect(withMarkerNote('Base.', some, 'Enter activates a marker.')).toBe('Base. Enter activates a marker.');
  });
});

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };

describe('persist', () => {
  const state = {
    hiddenSeries: new Set(['part']), hiddenItems: new Set(['env-1']),
    zoom: { from: 1, to: 3 }, zoomKeys: { from: 'a', to: 'b' },
    seenSeries: new Set(['base', 'part']), stacked: true,
  };

  it('round-trips toggles and the stacked view, never the zoom', () => {
    const back = deserializeState(JSON.parse(JSON.stringify(serializeState(state))));
    expect([...back.hiddenSeries]).toEqual(['part']);
    expect([...back.hiddenItems]).toEqual(['env-1']);
    expect([...back.seenSeries]).toEqual(['base', 'part']);
    expect(back.stacked).toBe(true);
    expect(back.zoom).toBeNull();
    expect(back.zoomKeys).toBeNull();
  });

  it('reads anything malformed as nothing saved', () => {
    expect(deserializeState(null)).toBeUndefined();
    expect(deserializeState({ v: 2, hiddenSeries: [], hiddenItems: [], seenSeries: [] })).toBeUndefined();
    expect(deserializeState({ v: 1, hiddenSeries: [1], hiddenItems: [], seenSeries: [] })).toBeUndefined();
    expect(deserializeState({ v: 1, hiddenSeries: [], hiddenItems: 'x', seenSeries: [] })).toBeUndefined();
  });

  it('saves and loads per chart id', () => {
    const s = memoryStorage();
    saveChartState('nw-simulation', state, s);
    expect(s.data.has('bv.chart.nw-simulation')).toBe(true);
    expect(loadChartState('nw-simulation', s).stacked).toBe(true);
    expect(loadChartState('other', s)).toBeUndefined();
    s.setItem('bv.chart.bad', '{not json');
    expect(loadChartState('bad', s)).toBeUndefined();
  });

  it('survives missing or throwing storage', () => {
    expect(loadChartState('x', null)).toBeUndefined();
    expect(() => saveChartState('x', state, null)).not.toThrow();
    expect(loadChartState('x', throwing)).toBeUndefined();
    expect(() => saveChartState('x', state, throwing)).not.toThrow();
  });

  it('stores page prefs separately, as a plain object', () => {
    const s = memoryStorage();
    expect(loadChartPrefs('reports-x', s)).toEqual({});
    saveChartPrefs('reports-x', { topN: 5, sort: 'name' }, s);
    expect(s.data.has('bv.chart.reports-x.prefs')).toBe(true);
    expect(loadChartPrefs('reports-x', s)).toEqual({ topN: 5, sort: 'name' });
    s.setItem('bv.chart.arr.prefs', '[1,2]');
    expect(loadChartPrefs('arr', s)).toEqual({});
    expect(loadChartPrefs('x', throwing)).toEqual({});
    expect(() => saveChartPrefs('x', {}, throwing)).not.toThrow();
  });

  afterEach(() => setChartBudgetKey(undefined)); // isolate the module-level scope from other tests

  it('scopes state and prefs keys per budget once a budget key is set', () => {
    const s = memoryStorage();
    setChartBudgetKey('cloud:b1');
    saveChartState('nw-simulation', state, s);
    saveChartPrefs('reports-x', { topN: 5 }, s);
    expect(s.data.has('bv.chart.cloud:b1.nw-simulation')).toBe(true);
    expect(s.data.has('bv.chart.cloud:b1.reports-x.prefs')).toBe(true);
    expect(s.data.has('bv.chart.nw-simulation')).toBe(false);
    expect(loadChartState('nw-simulation', s).stacked).toBe(true);
    expect(loadChartPrefs('reports-x', s)).toEqual({ topN: 5 });
    // A different budget sees neither: this is the whole point of scoping.
    setChartBudgetKey('cloud:b2');
    expect(loadChartState('nw-simulation', s)).toBeUndefined();
    expect(loadChartPrefs('reports-x', s)).toEqual({});
  });

  it('falls back once to the old unscoped key, then migrates it under the scoped key', () => {
    const s = memoryStorage();
    // Pre-scoping install: saved with no budget key set.
    saveChartState('nw-simulation', state, s);
    expect(s.data.has('bv.chart.nw-simulation')).toBe(true);

    setChartBudgetKey('cloud:b1');
    expect(loadChartState('nw-simulation', s)?.stacked).toBe(true);
    // Migrated: now readable directly under the scoped key too.
    expect(s.data.has('bv.chart.cloud:b1.nw-simulation')).toBe(true);

    // "One-time": once the scoped key holds a copy, later loads read that
    // copy and never fall back to the legacy key again, even if it changes.
    s.setItem('bv.chart.nw-simulation', '{not json');
    expect(loadChartState('nw-simulation', s)?.stacked).toBe(true);
  });

  it('a budget with nothing of its own still falls back to the shared legacy value', () => {
    const s = memoryStorage();
    saveChartState('nw-simulation', state, s); // pre-scoping, shared by every budget until each migrates
    setChartBudgetKey('cloud:b2');
    expect(loadChartState('nw-simulation', s)?.stacked).toBe(true);
  });
});

// A budget switch in this app is an in-place SPA swap: loadBudgetIntoState
// runs without a page reload (js/ui/load-budget-dialog.js performSwap,
// cloud-budget-picker.js, guest-budget-picker.js), and a chart id like
// Reports' "spend by envelope" is the same string across every budget. Before
// this fix, index.js's own module-level `STATES` Map was keyed by chart id
// alone, so budget A's live (in-memory) toggles were still sitting there
// when budget B mounted the same chart id — B would show A's hidden items,
// and B's next toggle would overwrite A's saved (localStorage) state too.
// getSessionChartState/setSessionChartState replace that Map, scoped by the
// same budgetKey persist.js already tracks for the localStorage keys above.
describe('session chart state cache (per-budget isolation)', () => {
  afterEach(() => setChartBudgetKey(undefined));

  const mkState = tag => ({
    hiddenSeries: new Set([tag]), hiddenItems: new Set(), zoom: null, zoomKeys: null, seenSeries: new Set(), stacked: false,
  });

  it('does not leak a chart\'s live state across an in-place budget switch, or let the new budget overwrite the old one\'s cache', () => {
    const stateA = mkState('a-only');
    setChartBudgetKey('cloud:a');
    setSessionChartState('reports-spend-by-envelope', stateA);
    expect(getSessionChartState('reports-spend-by-envelope')).toBe(stateA);

    setChartBudgetKey('cloud:b');
    // B must not see A's in-memory state just because the chart id matches.
    expect(getSessionChartState('reports-spend-by-envelope')).toBeUndefined();
    const stateB = mkState('b-only');
    setSessionChartState('reports-spend-by-envelope', stateB);
    expect(getSessionChartState('reports-spend-by-envelope')).toBe(stateB);

    // Switching back to A must not have been clobbered by B's write.
    setChartBudgetKey('cloud:a');
    expect(getSessionChartState('reports-spend-by-envelope')).toBe(stateA);
  });

  it('the unscoped (no budget yet) cache is its own separate slot too', () => {
    const stateNone = mkState('none');
    expect(getSessionChartState('x')).toBeUndefined();
    setSessionChartState('x', stateNone);
    setChartBudgetKey('cloud:a');
    expect(getSessionChartState('x')).toBeUndefined();
    setChartBudgetKey(undefined);
    expect(getSessionChartState('x')).toBe(stateNone);
  });
});
