// §2.12 — `stress_cut_pct` is a single flat cut applied to every scenario an
// item is hit by; `stress_cut_pcts` is the per-scenario map that replaced it.
// An item on the legacy fallback cannot express "cut 25% in a mild scenario,
// 100% in a severe one" — every scenario gets the same cut, so the A–E
// severity ladder is flat for it. 46 of the owner's items are in that state.
//
// The code is correct and documented; this is a DATA item. What the app can do
// is make the review tractable, which is what the expansion action is for.
import { describe, it, expect } from 'vitest';
import {
  itemsNeedingCutExpansion, expandFlatCuts, stressCutPct, adjustedAnnual,
  cutScenariosFor, itemsWithFlatLadder, SCENARIOS,
} from '../js/engine/stress.js';

const ALL_MONTHS = {
  Jan: 100, Feb: 100, Mar: 100, Apr: 100, May: 100, Jun: 100,
  Jul: 100, Aug: 100, Sep: 100, Oct: 100, Nov: 100, Dec: 100,
};
const item = over => ({
  id: 'i1', envelope_id: 'e1', include: true, kind: 'expense',
  monthly_schedule: { ...ALL_MONTHS }, stress_category: 'C',
  stress_cut_pct: 0.5, ...over,
});

describe('expanding flat stress cuts into per-scenario cuts', () => {
  it('finds items carrying only a non-zero scalar', () => {
    const items = [
      item({ id: 'scalar' }),                                   // needs it
      item({ id: 'zero', stress_cut_pct: 0 }),                  // nothing to expand
      item({ id: 'mapped', stress_cut_pcts: { C: 0.25 } }),     // already migrated
      item({ id: 'nocat', stress_category: null }),             // no scenario hits it
      item({ id: 'z', stress_category: 'Z' }),
    ];
    expect(itemsNeedingCutExpansion(items).map(i => i.id)).toEqual(['scalar']);
  });

  it('seeds every hitting scenario from the scalar', () => {
    const [out] = expandFlatCuts([item()]);
    expect(out.stress_cut_pcts).toBeDefined();
    const hitting = cutScenariosFor(out);
    expect(hitting.length).toBeGreaterThan(1);
    for (const s of hitting) expect(out.stress_cut_pcts[s]).toBe(0.5);
  });

  it('is value-preserving — no figure moves', () => {
    // The assertion §2.12 names as proof the expansion was faithful.
    const before = item();
    const [after] = expandFlatCuts([before]);
    for (const s of SCENARIOS) {
      expect(stressCutPct(after, s)).toBe(stressCutPct(before, s));
      expect(adjustedAnnual(after, s)).toBe(adjustedAnnual(before, s));
    }
  });

  it('leaves an already-migrated item exactly as it was', () => {
    const mapped = item({ id: 'mapped', stress_cut_pcts: { C: 0.25, B: 1 } });
    const [out] = expandFlatCuts([mapped]);
    expect(out).toBe(mapped); // same reference — untouched
  });

  it('does not mutate the input array or its items', () => {
    const src = item();
    const arr = [src];
    const out = expandFlatCuts(arr);
    expect(out).not.toBe(arr);
    expect(src.stress_cut_pcts).toBeUndefined();
  });

  it('returns the same array when there is nothing to expand', () => {
    const arr = [item({ stress_cut_pct: 0 })];
    expect(expandFlatCuts(arr)).toBe(arr);
  });

  it('after expanding, nothing is left needing expansion', () => {
    const expanded = expandFlatCuts([item(), item({ id: 'i2' })]);
    expect(itemsNeedingCutExpansion(expanded)).toEqual([]);
  });

  it('the ladder only diverges once a level is edited', () => {
    const [out] = expandFlatCuts([item()]);
    const hitting = cutScenariosFor(out);
    // Identical across the ladder immediately after expanding...
    const cuts = hitting.map(s => stressCutPct(out, s));
    expect(new Set(cuts).size).toBe(1);
    // ...and only then does a severe scenario differ from a milder one.
    out.stress_cut_pcts[hitting[0]] = 1;
    expect(stressCutPct(out, hitting[0])).toBe(1);
    expect(stressCutPct(out, hitting[hitting.length - 1])).toBe(0.5);
  });
});

describe('the flat-ladder review queue', () => {
  const ids = items => itemsWithFlatLadder(items).map(i => i.id);

  it('lists items cut identically in every scenario that hits them', () => {
    expect(ids([
      item({ id: 'scalar' }),                                               // legacy flat
      item({ id: 'uniform', stress_cut_pcts: { A: 0.3, B: 0.3, C: 0.3 } }), // expanded, untouched
      item({ id: 'ladder', stress_cut_pcts: { A: 1, B: 0.5, C: 0.3 } }),    // reviewed
      item({ id: 'partial', stress_cut_pcts: { C: 0.25 } }),                // A and B read 0
      item({ id: 'zero', stress_cut_pct: 0 }),                              // never cut
      item({ id: 'catA', stress_category: 'A' }),                           // one rung, no ladder
      item({ id: 'z', stress_category: 'Z' }),
      item({ id: 'off', include: false }),
      item({ id: 'xfer', kind: 'account_transfer' }),
    ])).toEqual(['scalar', 'uniform']);
  });

  it('keeps an item queued after expansion, until one scenario differs', () => {
    const [out] = expandFlatCuts([item()]);
    expect(ids([out])).toEqual(['i1']);
    out.stress_cut_pcts.A = 1;
    expect(ids([out])).toEqual([]);
  });

  it('puts the largest annual amount first', () => {
    const small = item({ id: 'small', monthly_schedule: { Jan: 10 } });
    const big = item({ id: 'big' });
    expect(ids([small, big])).toEqual(['big', 'small']);
  });
});
