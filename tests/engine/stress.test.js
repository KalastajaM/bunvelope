import { describe, it, expect } from 'vitest';
import * as facade from '../../js/engine.js';
import * as stress from '../../js/engine/stress.js';
import {
  scenarioHits,
  stressCutFor,
  cutScenariosFor,
  stressCutPct,
  setStressCutPct,
  clearStressCuts,
  annualAmount,
  adjustedAnnual,
  clampFrac,
  isTransferItem,
} from '../../js/engine/stress.js';

// Minimal item factory: include=true and a flat 12-month schedule unless overridden.
function item(overrides = {}) {
  const sched = {};
  for (const m of ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']) sched[m] = true;
  return {
    id: 'i1', kind: 'expense', include: true,
    default_amount: 100, monthly_schedule: sched,
    stress_category: null, stress_cut_pct: 0,
    ...overrides,
  };
}

describe('isTransferItem', () => {
  it('is true only for kind === account_transfer', () => {
    expect(isTransferItem(item({ kind: 'account_transfer' }))).toBe(true);
    expect(isTransferItem(item({ kind: 'expense' }))).toBe(false);
    expect(isTransferItem(item({ kind: 'income' }))).toBe(false);
    expect(isTransferItem(item({ kind: 'investment_transfer' }))).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isTransferItem(null)).toBe(false);
    expect(isTransferItem(undefined)).toBe(false);
  });

  it('is a separate guard from scenarioHits: kind, not category, decides it', () => {
    // The editor never sets a stress_category on a transfer, so scenarioHits
    // already returns false for one in practice — but scenarioHits itself
    // only looks at stress_category, not kind. A caller that wants to be
    // defensive against a transfer carrying a leftover category (e.g. from
    // switching kind and back) must check isTransferItem too, not rely on
    // scenarioHits alone.
    const transfer = item({ kind: 'account_transfer', stress_category: 'A' });
    expect(isTransferItem(transfer)).toBe(true);
    expect(scenarioHits('A', transfer)).toBe(true);
  });
});

describe('clampFrac', () => {
  it('clamps to 0..1 and coerces', () => {
    expect(clampFrac(0.5)).toBe(0.5);
    expect(clampFrac(2)).toBe(1);
    expect(clampFrac(-1)).toBe(0);
    expect(clampFrac('0.25')).toBe(0.25);
    expect(clampFrac(NaN)).toBe(0);
    expect(clampFrac(undefined)).toBe(0);
  });
});

describe('scenarioHits', () => {
  it('A (most severe) hits only scenario A', () => {
    const it = item({ stress_category: 'A' });
    expect(scenarioHits('A', it)).toBe(true);
    expect(scenarioHits('B', it)).toBe(false);
    expect(scenarioHits('E', it)).toBe(false);
  });

  it('D hits A–D but not E', () => {
    const it = item({ stress_category: 'D' });
    expect(['A','B','C','D'].every(s => scenarioHits(s, it))).toBe(true);
    expect(scenarioHits('E', it)).toBe(false);
  });

  it('null, Z, empty and invalid categories never hit', () => {
    for (const cat of [null, 'Z', '', 'F', undefined]) {
      const it = item({ stress_category: cat });
      expect(['A','B','C','D','E'].some(s => scenarioHits(s, it))).toBe(false);
    }
  });
});

describe('cutScenariosFor', () => {
  it('returns the category level plus every more-severe level', () => {
    expect(cutScenariosFor(item({ stress_category: 'D' }))).toEqual(['A','B','C','D']);
    expect(cutScenariosFor(item({ stress_category: 'A' }))).toEqual(['A']);
    expect(cutScenariosFor(item({ stress_category: 'E' }))).toEqual(['A','B','C','D','E']);
  });

  it('is empty for null/Z/invalid', () => {
    expect(cutScenariosFor(item({ stress_category: null }))).toEqual([]);
    expect(cutScenariosFor(item({ stress_category: 'Z' }))).toEqual([]);
    expect(cutScenariosFor(item({ stress_category: 'F' }))).toEqual([]);
  });
});

describe('stressCutPct', () => {
  it('falls back to the legacy scalar for every hitting scenario', () => {
    const it = item({ stress_category: 'D', stress_cut_pct: 0.25 });
    expect(stressCutPct(it, 'A')).toBe(0.25);
    expect(stressCutPct(it, 'D')).toBe(0.25);
    expect(stressCutPct(it, 'E')).toBe(0); // E doesn't hit cat D
  });

  it('a present map is authoritative — scalar is dead, missing key → 0', () => {
    const it = item({ stress_category: 'D', stress_cut_pct: 0.25, stress_cut_pcts: { B: 0.5 } });
    expect(stressCutPct(it, 'B')).toBe(0.5);
    expect(stressCutPct(it, 'A')).toBe(0); // missing key, scalar NOT used
    expect(stressCutPct(it, 'C')).toBe(0);
    expect(stressCutPct(it, 'D')).toBe(0);
    expect(stressCutPct(it, 'E')).toBe(0); // doesn't hit
  });

  it('clamps stored map values', () => {
    const it = item({ stress_category: 'D', stress_cut_pcts: { A: 2, B: -1, C: 0.5 } });
    expect(stressCutPct(it, 'A')).toBe(1);
    expect(stressCutPct(it, 'B')).toBe(0);
    expect(stressCutPct(it, 'C')).toBe(0.5);
  });

  it('returns 0 for non-hitting scenarios regardless of map', () => {
    const it = item({ stress_category: 'Z', stress_cut_pcts: { A: 0.9 } });
    expect(stressCutPct(it, 'A')).toBe(0);
  });
});

describe('setStressCutPct', () => {
  it('seeds all hitting scenarios from the scalar on first write, then sets the target', () => {
    const it = item({ stress_category: 'D', stress_cut_pct: 0.25 });
    setStressCutPct(it, 'A', 0.8);
    expect(it.stress_cut_pcts).toEqual({ A: 0.8, B: 0.25, C: 0.25, D: 0.25 });
  });

  it('later edits mutate only the target', () => {
    const it = item({ stress_category: 'D', stress_cut_pct: 0.25 });
    setStressCutPct(it, 'A', 0.8);
    setStressCutPct(it, 'B', 0.5);
    expect(it.stress_cut_pcts).toEqual({ A: 0.8, B: 0.5, C: 0.25, D: 0.25 });
  });

  it('clamps the value', () => {
    const it = item({ stress_category: 'A' });
    setStressCutPct(it, 'A', 5);
    expect(it.stress_cut_pcts.A).toBe(1);
  });

  it('is a no-op for a scenario that does not hit', () => {
    const it = item({ stress_category: 'D' });
    setStressCutPct(it, 'E', 0.5);
    expect(it.stress_cut_pcts).toBeUndefined();
  });
});

describe('clearStressCuts', () => {
  it('removes the map and zeroes the scalar', () => {
    const it = item({ stress_category: 'D', stress_cut_pct: 0.25, stress_cut_pcts: { A: 0.8 } });
    clearStressCuts(it);
    expect(it.stress_cut_pcts).toBeUndefined();
    expect(it.stress_cut_pct).toBe(0);
    // With cat D and no map/scalar, every hitting scenario resolves to 0.
    expect(stressCutPct(it, 'A')).toBe(0);
  });
});

describe('annualAmount & adjustedAnnual', () => {
  it('sums the 12-month schedule', () => {
    expect(annualAmount(item({ default_amount: 100 }))).toBe(1200);
  });

  it('returns 0 for excluded items', () => {
    expect(annualAmount(item({ include: false }))).toBe(0);
  });

  it('Baseline is uncut; a hitting scenario applies its cut', () => {
    const it = item({ default_amount: 100, stress_category: 'D', stress_cut_pcts: { A: 0.8, D: 0.1 } });
    expect(adjustedAnnual(it, 'Baseline')).toBe(1200);
    expect(adjustedAnnual(it, 'A')).toBeCloseTo(240, 6);  // 1200 * (1 - 0.8)
    expect(adjustedAnnual(it, 'D')).toBeCloseTo(1080, 6);  // 1200 * (1 - 0.1)
    expect(adjustedAnnual(it, 'E')).toBe(1200);            // E doesn't hit cat D
  });
});

describe('the module surface (moved from js/stress-model.js)', () => {
  const FUNCTIONS = [
    'clampFrac', 'isTransferItem', 'scenarioHits', 'cutScenariosFor', 'stressCutPct', 'setStressCutPct',
    'itemsNeedingCutExpansion', 'itemsWithFlatLadder', 'expandFlatCuts', 'clearStressCuts',
    'annualAmount', 'adjustedAnnual', 'stressCutFor',
  ];

  it('exports every former stress-model function, and the facade re-exports them', () => {
    for (const name of FUNCTIONS) {
      expect(typeof stress[name], name).toBe('function');
      expect(facade[name], name).toBe(stress[name]);
    }
  });

  it('exports the same constants with the same values', () => {
    expect(stress.MONTHS).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(stress.SCENARIOS).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(stress.CAT_CHOICES).toEqual(['A', 'B', 'C', 'D', 'E', 'Z']);
    expect(facade.MONTHS).toBe(stress.MONTHS);
    expect(facade.SCENARIOS).toBe(stress.SCENARIOS);
    expect(facade.CAT_CHOICES).toBe(stress.CAT_CHOICES);
  });
});

describe('stressCutFor', () => {
  it('is 0 for a scenario the item is not hit by', () => {
    expect(stressCutFor(item({ stress_category: 'B', stress_cut_pct: 0.4 }), 'D')).toBe(0);
    expect(stressCutFor(item({ stress_category: 'Z', stress_cut_pct: 0.4 }), 'A')).toBe(0);
    expect(stressCutFor(item({ stress_category: null, stress_cut_pct: 0.4 }), 'A')).toBe(0);
  });

  it('is the item cut for a scenario that hits it', () => {
    expect(stressCutFor(item({ stress_category: 'C', stress_cut_pct: 0.4 }), 'A')).toBeCloseTo(0.4);
    expect(stressCutFor(item({ stress_category: 'C', stress_cut_pcts: { A: 0.9, C: 0.3 } }), 'C')).toBe(0.3);
  });

  it('is never a cut for a transfer, even with a stale category', () => {
    const transfer = item({ kind: 'account_transfer', stress_category: 'C', stress_cut_pct: 0.5 });
    expect(stressCutFor(transfer, 'C')).toBe(0);
    expect(stressCutFor(item({ stress_category: 'C', stress_cut_pct: 0.5 }), 'C')).toBe(0.5);
  });
});
