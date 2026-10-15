// Y-axis range for the four-interval chart axis (ux-review U23).
import { describe, it, expect } from 'vitest';
import { niceMinMax } from '../js/ui/charts/model.js';

describe('niceMinMax', () => {
  it('starts at zero for all-positive data', () => {
    expect(niceMinMax(100, 23000)).toEqual({ min: 0, max: 25000 });
  });

  it('gives a small negative dip one interval, not half the axis', () => {
    const r = niceMinMax(-800, 26000);
    expect(r.min).toBeLessThan(0);
    expect(-r.min).toBeLessThanOrEqual(r.max / 3);
    // Zero sits on one of the four gridlines.
    const step = (r.max - r.min) / 4;
    expect(Math.abs(r.min / step - Math.round(r.min / step))).toBeLessThan(1e-9);
    expect(r.max).toBeGreaterThanOrEqual(26000);
  });

  it('stays symmetric when both sides are the same size', () => {
    expect(niceMinMax(-1000, 1000)).toEqual({ min: -1000, max: 1000 });
  });

  it('handles all-negative and empty data', () => {
    expect(niceMinMax(-40, -5)).toEqual({ min: -50, max: 0 });
    expect(niceMinMax(0, 0)).toEqual({ min: 0, max: 1 });
  });
});

import { yRange, reconcileState, BAND_ID, tableData, toCsv } from '../js/ui/charts/model.js';
import { serializeState, deserializeState } from '../js/ui/charts/persist.js';

describe('explicit forecast scale', () => {
  const specOf = values => ({ kind: 'line', scaleControl: true, x: values.map((_, i) => ({ key: String(i), label: String(i) })), series: [{ id: 'base', name: 'Expected', values }] });
  it.each([[0, 0], [100, 100], [-100, -100], [-100, 20], [100, 10000]])('fits finite data %j with a nonempty range', (...values) => {
    const spec = specOf(values), state = reconcileState(spec);
    const range = yRange(spec, state);
    expect(range.min).toBeLessThan(range.max);
    expect(range.min).toBeLessThanOrEqual(Math.min(...values));
    expect(range.max).toBeGreaterThanOrEqual(Math.max(...values));
  });
  it('includes visible uncertainty bounds and drops hidden outliers', () => {
    const spec = { ...specOf([1000, 1001]), band: { low: 'low', high: 'high', around: 'base' } };
    spec.series.push({ id: 'low', values: [900, 950] }, { id: 'high', values: [1100, 1200] }, { id: 'other', values: [100000, 100000] });
    const state = reconcileState(spec);
    expect(yRange(spec, state).max).toBeGreaterThanOrEqual(100000);
    state.hiddenSeries.add('other');
    expect(yRange(spec, state).max).toBeGreaterThanOrEqual(1200);
    expect(yRange(spec, state).min).toBeLessThanOrEqual(900);
    state.hiddenSeries.add(BAND_ID);
    expect(yRange(spec, state).min).toBeGreaterThan(900);
    expect(yRange(spec, state).max).toBeLessThan(1200);
  });
  it('keeps table/CSV values identical and remembers the scale', () => {
    const spec = specOf([1000, 1001]), fit = reconcileState(spec), zero = { ...fit, yScale: 'zero' };
    expect(yRange(spec, fit).min).toBeGreaterThan(0);
    expect(yRange(spec, zero).min).toBe(0);
    expect(yRange(spec, { ...zero, zoom: { from: 0, to: 1 } }).min).toBe(0);
    expect(toCsv(tableData(spec, fit, { label: 'Year' }))).toBe(toCsv(tableData(spec, zero, { label: 'Year' })));
    expect(reconcileState(spec, deserializeState(serializeState(zero))).yScale).toBe('zero');
  });
  it('keeps bars, stacked lines and other unzoomed charts anchored at zero', () => {
    const spec = specOf([1000, 1001]);
    expect(yRange({ ...spec, kind: 'bar' }, reconcileState(spec)).min).toBe(0);
    const stacked = { ...spec, stack: { ids: ['base'] } };
    expect(yRange(stacked, { ...reconcileState(stacked), stacked: true }).min).toBe(0);
    expect(yRange({ ...spec, scaleControl: false }, reconcileState(spec)).min).toBe(0);
  });
});
