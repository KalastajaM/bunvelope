// One resolution of an investment_transfer's direction. The ladder it
// replaces was copy-pasted six times across balances, holdings,
// monthly-review and reports, and a seventh copy that omitted `dividend` was
// the 2026-07-24 audit's defect 1 — the monthly review debited a dividend
// that computeEnvelopeBalances credited. (That specific pair is pinned by
// monthly-review-dividend.test.js; this file pins the shared resolver and the
// case the copies disagreed on.)
import { describe, it, expect } from 'vitest';
import {
  txDirection, txEnvelopeEffect, computeEnvelopeBalances, txSpendTotal,
} from '../../js/engine.js';

describe('txDirection', () => {
  it('resolves the four the engine knows', () => {
    expect(txDirection({ direction: 'buy' })).toBe('buy');
    expect(txDirection({ direction: 'sell' })).toBe('sell');
    expect(txDirection({ direction: 'dividend' })).toBe('dividend');
    expect(txDirection({ direction: 'adjust' })).toBe('adjust');
  });

  it('treats an absent or unknown direction as a buy — the historical default', () => {
    expect(txDirection({})).toBe('buy');
    expect(txDirection({ direction: '' })).toBe('buy');
    expect(txDirection({ direction: 'BUY' })).toBe('buy');
    expect(txDirection({ direction: 'nonsense' })).toBe('buy');
    expect(txDirection(null)).toBe('buy');
    expect(txDirection(undefined)).toBe('buy');
  });
});

describe('what each direction does to an envelope', () => {
  const row = (direction) => ({
    id: `t-${direction}`, type: 'investment_transfer', direction,
    date: '2026-03-10', amount: 100, symbol: 'AAPL', envelope_id: 'e1',
    from_account: 'brokerage', to_account: 'checking', status: 'posted',
  });

  it('debits on a buy and credits on a sell or dividend', () => {
    expect(txEnvelopeEffect(row('buy'), 'e1')).toEqual({ mode: 'add', amount: -100 });
    expect(txEnvelopeEffect(row('sell'), 'e1')).toEqual({ mode: 'add', amount: 100 });
    expect(txEnvelopeEffect(row('dividend'), 'e1')).toEqual({ mode: 'add', amount: 100 });
  });

  it('moves nothing on an adjust — a unit correction has no cash leg', () => {
    // The three-way copies resolved `adjust` to `buy`, so such a row would
    // have debited the envelope by its full amount. No budget contains one
    // today (adjust rows live in meta as manual holding rows, never in
    // transactions), which is why this is a latent difference and not a
    // number that just changed.
    expect(txEnvelopeEffect(row('adjust'), 'e1')).toBeNull();
    expect(computeEnvelopeBalances([row('adjust')]).get('e1') ?? 0).toBe(0);
  });

  it('counts only a buy as spend', () => {
    expect(txSpendTotal(row('buy'))).toBe(100);
    expect(txSpendTotal(row('sell'))).toBe(0);
    expect(txSpendTotal(row('dividend'))).toBe(0);
    expect(txSpendTotal(row('adjust'))).toBe(0);
  });

  it('agrees between the per-row seam and the bulk walk', () => {
    for (const d of ['buy', 'sell', 'dividend', 'adjust']) {
      const effect = txEnvelopeEffect(row(d), 'e1');
      const bulk = computeEnvelopeBalances([row(d)]).get('e1') ?? 0;
      expect(bulk).toBe(effect ? effect.amount : 0);
    }
  });
});
