// tests/engine/roll-forward.test.js — rollForwardEnvelopeBalances advances
// balances month by month; a cursor bug here compounds into every future
// month's review. The per-month math is runMonthlyReview's (tested
// elsewhere); what this pins is the walking loop: the ≤-current shortcut,
// iteration count, year rollover, and input non-mutation.

import { describe, it, expect } from 'vitest';
import { rollForwardEnvelopeBalances } from '../../js/engine/monthly-review.js';

const envelopes = [{ id: 'food', name: 'Food' }];
const ref = new Date(2026, 2, 15); // 2026-03-15

describe('rollForwardEnvelopeBalances', () => {
  it('returns the input untouched for the current or a past month', () => {
    const balances = new Map([['food', 80]]);
    expect(rollForwardEnvelopeBalances(envelopes, [], balances, [], '2026-03', ref)).toBe(balances);
    expect(rollForwardEnvelopeBalances(envelopes, [], balances, [], '2026-01', ref)).toBe(balances);
  });

  it('carries balances across months when nothing is planned or spent', () => {
    const balances = new Map([['food', 80]]);
    const out = rollForwardEnvelopeBalances(envelopes, [], balances, [], '2026-05', ref);
    expect(out).not.toBe(balances);
    expect(out.get('food')).toBe(80);
    // The input map must not be mutated.
    expect(balances.get('food')).toBe(80);
  });

  it('walks across a year boundary', () => {
    const refNov = new Date(2026, 10, 3); // 2026-11-03
    const balances = new Map([['food', 42]]);
    const out = rollForwardEnvelopeBalances(envelopes, [], balances, [], '2027-02', refNov);
    expect(out.get('food')).toBe(42);
  });
});
