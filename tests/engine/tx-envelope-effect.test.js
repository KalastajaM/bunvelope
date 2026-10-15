// txEnvelopeEffect is the per-transaction seam the 12-month projection walks.
// Its whole reason to exist is `set`-mode fills, which overwrite the running
// balance instead of adding to it — a plain delta number cannot express that.
// The equivalence test is the guard against this drifting from
// computeEnvelopeBalances, which applies the same rules in bulk.

import { describe, it, expect } from 'vitest';
import { txEnvelopeEffect, computeEnvelopeBalances } from '../../js/engine.js';

const CORPUS = [
  { id: 't1', type: 'income',  date: '2026-01-01', amount: 500, envelope_id: 'e1', status: 'posted' },
  { id: 't2', type: 'expense', date: '2026-01-02', amount: 120, envelope_id: 'e1', status: 'posted' },
  { id: 't3', type: 'expense', date: '2026-01-03', amount: 100, status: 'posted',
    envelope_splits: [{ envelope_id: 'e1', amount: 60 }, { envelope_id: 'e2', amount: 40 }] },
  { id: 't4', type: 'fill', date: '2026-01-04', status: 'posted',
    lines: [{ envelope_id: 'e1', mode: 'add', amount: 200 }] },
  { id: 't5', type: 'envelope_transfer', date: '2026-01-05', amount: 75,
    from_envelope_id: 'e1', to_envelope_id: 'e2', status: 'posted' },
  { id: 't6', type: 'debt_payment', date: '2026-01-06', amount: 30, envelope_id: 'e1', status: 'posted' },
  { id: 't7', type: 'investment_transfer', date: '2026-01-07', amount: 90,
    direction: 'buy', envelope_id: 'e1', status: 'posted' },
  { id: 't8', type: 'investment_transfer', date: '2026-01-08', amount: 15,
    direction: 'dividend', envelope_id: 'e1', status: 'posted' },
  { id: 't9', type: 'adjustment', date: '2026-01-09', amount: -25,
    target: 'envelope', target_id: 'e1', status: 'posted' },
  // A set-mode fill — the corpus previously contained only an 'add'-mode
  // fill, so the equivalence test below never exercised the `set` branch of
  // either txEnvelopeEffect or _computeEnvelopeBalancesRaw at all.
  { id: 't10', type: 'fill', date: '2026-01-10', status: 'posted',
    lines: [{ envelope_id: 'e1', mode: 'set', amount: 700 }] },
];

// Mirrors the date-sort-with-stable-index-tiebreaker that
// _computeEnvelopeBalancesRaw applies internally (js/engine/balances.js:78-84).
// txEnvelopeEffect has no way to enforce this itself — it only ever sees one
// transaction — so any caller folding its results must sort first. This
// helper stands in for that caller obligation.
function sortByDateThenIndex(txs) {
  return txs
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => {
      const da = (a.tx.date || '').slice(0, 10);
      const db = (b.tx.date || '').slice(0, 10);
      if (da !== db) return da < db ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ tx }) => tx);
}

describe('txEnvelopeEffect', () => {
  it('returns null for transactions that do not touch the envelope', () => {
    expect(txEnvelopeEffect(CORPUS[0], 'e2')).toBeNull();
    expect(txEnvelopeEffect({ type: 'account_transfer', amount: 100 }, 'e1')).toBeNull();
  });

  it('signs each type the way computeEnvelopeBalances does', () => {
    expect(txEnvelopeEffect(CORPUS[1], 'e1')).toEqual({ mode: 'add', amount: -120 });
    expect(txEnvelopeEffect(CORPUS[2], 'e1')).toEqual({ mode: 'add', amount: -60 });
    expect(txEnvelopeEffect(CORPUS[6], 'e1')).toEqual({ mode: 'add', amount: -90 });
    expect(txEnvelopeEffect(CORPUS[7], 'e1')).toEqual({ mode: 'add', amount: 15 });
    expect(txEnvelopeEffect(CORPUS[8], 'e1')).toEqual({ mode: 'add', amount: -25 });
  });

  it('reports a set-mode fill as a set, not a delta', () => {
    const tx = { id: 's1', type: 'fill', date: '2026-02-01',
      lines: [{ envelope_id: 'e1', mode: 'set', amount: 400 }] };
    expect(txEnvelopeEffect(tx, 'e1')).toEqual({ mode: 'set', value: 400 });
  });

  it('folds an add that follows a set within one fill into the set value', () => {
    const tx = { id: 's2', type: 'fill', date: '2026-02-01', lines: [
      { envelope_id: 'e1', mode: 'set', amount: 400 },
      { envelope_id: 'e1', mode: 'add', amount: 50 },
    ] };
    expect(txEnvelopeEffect(tx, 'e1')).toEqual({ mode: 'set', value: 450 });
  });

  // The mirror case: an add *before* a set within one fill. A `set` must
  // discard whatever the preceding `add` accumulated, not add on top of it
  // (that would be an add-before-set ordering bug: `acc = amt` degenerating
  // into `acc += amt`). Asserted against computeEnvelopeBalances rather than
  // a hardcoded literal so the two can't independently drift and still agree
  // by coincidence.
  it('discards a preceding add when a set follows it within one fill (add-before-set)', () => {
    const tx = { id: 's3', type: 'fill', date: '2026-02-01', lines: [
      { envelope_id: 'e1', mode: 'add', amount: 50 },
      { envelope_id: 'e1', mode: 'set', amount: 400 },
    ] };
    const bulk = computeEnvelopeBalances([tx]).get('e1');
    expect(txEnvelopeEffect(tx, 'e1')).toEqual({ mode: 'set', value: bulk });
  });

  it('agrees with computeEnvelopeBalances over the whole corpus, walked out of date order', () => {
    const bulk = computeEnvelopeBalances(CORPUS).get('e1') || 0;

    // Deliberately shuffled so this test cannot get away with walking in
    // array order — CORPUS happens to be written in date order, which would
    // silently exempt the sort-before-fold contract documented on
    // txEnvelopeEffect. sortByDateThenIndex below is what makes the walk
    // correct; removing it should make this test fail whenever a `set` in
    // the corpus lands out of position relative to its true date order.
    const shuffled = [
      CORPUS[6], CORPUS[1], CORPUS[9], CORPUS[3], CORPUS[0],
      CORPUS[8], CORPUS[2], CORPUS[7], CORPUS[5], CORPUS[4],
    ];

    let walked = 0;
    for (const tx of sortByDateThenIndex(shuffled)) {
      const eff = txEnvelopeEffect(tx, 'e1');
      if (!eff) continue;
      if (eff.mode === 'set') walked = eff.value;
      else walked += eff.amount;
    }

    expect(Math.round(walked * 100) / 100).toBe(Math.round(bulk * 100) / 100);
  });
});

// `__none__` is the sentinel for "deliberately unenveloped". The bulk walker
// drops it for expense/income/investment_transfer and keeps it for the rest —
// an asymmetry the first cut of txEnvelopeEffect missed entirely, because the
// corpus above never uses the sentinel. These assert the seam and the bulk
// walker agree on it, per type, rather than trusting either in isolation.
describe('txEnvelopeEffect — the __none__ sentinel', () => {
  const bulkFor = tx => computeEnvelopeBalances([tx]).get('__none__');

  const DROPPED = [
    { id: 'n1', type: 'expense', date: '2026-01-02', amount: 50, envelope_id: '__none__', status: 'posted' },
    { id: 'n2', type: 'income',  date: '2026-01-03', amount: 80, envelope_id: '__none__', status: 'posted' },
    { id: 'n3', type: 'investment_transfer', date: '2026-01-04', amount: 40,
      direction: 'buy', envelope_id: '__none__', status: 'posted' },
    { id: 'n4', type: 'expense', date: '2026-01-05', amount: 30, status: 'posted',
      envelope_splits: [{ envelope_id: '__none__', amount: 30 }] },
  ];

  it.each(DROPPED)('drops $type the way the bulk walker does', (tx) => {
    expect(txEnvelopeEffect(tx, '__none__')).toBeNull();
    expect(bulkFor(tx)).toBeUndefined();
  });

  const KEPT = [
    { type: 'fill', tx: { id: 'k1', type: 'fill', date: '2026-01-06', status: 'posted',
        lines: [{ envelope_id: '__none__', mode: 'add', amount: 25 }] }, expected: 25 },
    { type: 'debt_payment', tx: { id: 'k2', type: 'debt_payment', date: '2026-01-07', amount: 10,
        envelope_id: '__none__', status: 'posted' }, expected: -10 },
    { type: 'adjustment', tx: { id: 'k3', type: 'adjustment', date: '2026-01-08', amount: -5,
        target: 'envelope', target_id: '__none__', status: 'posted' }, expected: -5 },
    // envelope_transfer is the type most similar in shape to the fill
    // add/set bug just fixed — it was missing from this table entirely.
    { type: 'envelope_transfer', tx: { id: 'k4', type: 'envelope_transfer', date: '2026-01-09', amount: 20,
        from_envelope_id: '__none__', to_envelope_id: 'e1', status: 'posted' }, expected: -20 },
  ];

  it.each(KEPT)('keeps $type the way the bulk walker does', ({ tx, expected }) => {
    const eff = txEnvelopeEffect(tx, '__none__');
    const walked = eff.mode === 'set' ? eff.value : eff.amount;
    expect(walked).toBe(expected);
    expect(bulkFor(tx)).toBe(expected);
  });
});
