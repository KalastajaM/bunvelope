// The Charts range presets, shared with the Money flow page (js/ui/date-range.js).
import { describe, it, expect } from 'vitest';
import { RANGE_PRESETS, resolveRangePreset } from '../js/ui/date-range.js';

const oct2 = new Date(2026, 9, 2, 12);

describe('resolveRangePreset', () => {
  it('lists the preset buttons in order', () => {
    expect(RANGE_PRESETS).toEqual(['ytd', '12m', '6m', '3m', 'all']);
  });

  it('runs every preset to today', () => {
    expect(resolveRangePreset({ preset: 'ytd' }, oct2)).toEqual({ from: '2026-01-01', to: '2026-10-02' });
    expect(resolveRangePreset({ preset: '12m' }, oct2)).toEqual({ from: '2025-10-01', to: '2026-10-02' });
    expect(resolveRangePreset({ preset: '6m' }, oct2)).toEqual({ from: '2026-04-01', to: '2026-10-02' });
    expect(resolveRangePreset({ preset: '3m' }, oct2)).toEqual({ from: '2026-07-01', to: '2026-10-02' });
  });

  it('all and an unknown preset are unbounded; custom passes through', () => {
    expect(resolveRangePreset({ preset: 'all' }, oct2)).toEqual({ from: null, to: null });
    expect(resolveRangePreset({ preset: 'nope' }, oct2)).toEqual({ from: null, to: null });
    expect(resolveRangePreset({ preset: 'custom', from: '2026-02-01', to: null }, oct2)).toEqual({ from: '2026-02-01', to: null });
  });

  it('steps back whole months from a month end', () => {
    // 31 May − 3 months is February, not "31 February" rolled into March.
    expect(resolveRangePreset({ preset: '3m' }, new Date(2026, 4, 31, 12)).from).toBe('2026-02-01');
    expect(resolveRangePreset({ preset: '6m' }, new Date(2026, 7, 31, 12)).from).toBe('2026-02-01');
  });

  it('does not touch the date it is given', () => {
    const d = new Date(2026, 9, 2, 12);
    resolveRangePreset({ preset: '12m' }, d);
    expect(d.getMonth()).toBe(9);
  });
});
