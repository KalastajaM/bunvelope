// §2.3 — the required monthly deposit took its ceiling on a float, so where
// `annual / 12 * 100` landed a hair above an exact integer it rounded up a
// cent the schedule does not require. Permanently: two envelopes on the
// owner's budget were one cent high in every one of the twelve reference
// months, and `startNext` (projected + D) inherited it.
import { describe, it, expect } from 'vitest';
import { calcDepositAndRequired } from '../../js/engine/monthly-review.js';

/** rolling array[1..12]; position 0 is unused by the engine. */
const roll = cells => {
  const r = new Array(13).fill(0);
  for (let m = 1; m <= 12; m++) r[m] = cells[(m - 1) % cells.length];
  return r;
};

describe('calcDepositAndRequired takes its ceiling in integer cents', () => {
  it('a schedule summing to exactly 12 x returns D === x, not x + 0.01', () => {
    // Twelve equal cells: the answer is the cell, with nothing to round up.
    expect(calcDepositAndRequired(roll([12.34]), 0).D).toBe(12.34);
    expect(calcDepositAndRequired(roll([100]), 0).D).toBe(100);
    expect(calcDepositAndRequired(roll([0.01]), 0).D).toBe(0.01);
  });

  it('does not add a cent that float error invented', () => {
    // Alternating 0.05 / 0.01 sums to 0.36000000000000004 rather than 0.36.
    // The old `Math.ceil(annual / 12 * 100) / 100` read that as 0.04; the
    // honest cent value of the sum is 36, and 36/12 = 3 exactly.
    const r = roll([0.05, 0.01]);
    let annual = 0;
    for (let m = 1; m <= 12; m++) annual += r[m];
    expect(annual).not.toBe(0.36);                       // the float residue
    expect(Math.ceil(annual / 12 * 100) / 100).toBe(0.04); // what v1 returned
    expect(calcDepositAndRequired(r, 0).D).toBe(0.03);     // what it owes
  });

  it('still rounds a genuinely fractional cent UP', () => {
    // The ceiling is not a rounding-to-nearest: a schedule the twelfths do
    // not divide must still be covered.
    const r = new Array(13).fill(0);
    r[1] = 1.00;   // annual = 100 cents, 100/12 = 8.33… → 9 cents
    for (let m = 2; m <= 12; m++) r[m] = 0;
    expect(calcDepositAndRequired(r, 0).D).toBe(0.09);
  });

  it('req is untouched by this change', () => {
    // Deliberately left on its existing rounding — moving both figures at
    // once would make the review's diff impossible to eyeball.
    const r = roll([0]);
    r[6] = 120;
    const { req } = calcDepositAndRequired(r, 0);
    expect(req).toBeGreaterThan(0);
    expect(Number.isFinite(req)).toBe(true);
    // buffer still adds on top
    expect(calcDepositAndRequired(r, 50).req).toBe(Math.round((req + 50) * 100) / 100);
  });
});
