// QA 2026-09-23 #7 — `computeEnvelopeBalances` date-sorted the whole ledger
// on every call, only because `fill { mode: 'set' }` overwrites a running
// balance and is therefore order-sensitive. Every other effect is a
// commutative delta. The walk no longer sorts: an envelope ends at its last
// set (by date, then index) plus the deltas ordered after it, and a ledger
// with no set-mode line is a single unsorted pass.
//
// The oracle below is the always-sorted walk as it stood before, built from
// the same public per-transaction rules. The new walk sums the same deltas in
// array order instead of date order, and float addition is not associative,
// so the comparison is numeric (1e-9, far below a cent) — the same tolerance
// envelope-walker-equivalence.test.js uses for the same reason.
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeBalances, txEnvelopeIds, txEnvelopeEffect, filterTransactions,
} from '../../js/engine/balances.js';
import { arbLedger } from './arbitraries.js';

function sortedOracle(transactions, opts = {}) {
  const txs = (opts.onlyPosted || opts.asOf) ? filterTransactions(transactions, opts) : transactions;
  const ordered = txs.map((tx, i) => ({ tx, i }));
  ordered.sort((a, b) => {
    const da = (a.tx.date || '').slice(0, 10);
    const db = (b.tx.date || '').slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });
  const out = new Map();
  for (const { tx } of ordered) {
    for (const id of txEnvelopeIds(tx)) {
      const e = txEnvelopeEffect(tx, id);
      if (!e) continue;
      if (e.mode === 'set') out.set(id, e.value);
      else out.set(id, (out.get(id) ?? 0) + e.amount);
    }
  }
  return out;
}

const EPS = 1e-9;
function expectSameBalances(actual, expected) {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [k, v] of expected) {
    expect(Math.abs((actual.get(k) ?? NaN) - v), `envelope ${k}: ${actual.get(k)} vs ${v}`).toBeLessThan(EPS);
  }
}

// Strip every set-mode line so the ledger takes the fast path.
const addOnly = ledger => ledger.map(tx => (tx.type === 'fill'
  ? { ...tx, lines: tx.lines.map(l => ({ ...l, mode: 'add' })) }
  : tx));

const arbOpts = fc.record({
  onlyPosted: fc.boolean(),
  asOf: fc.option(fc.integer({ min: 0, max: 900 }).map(o =>
    new Date(Date.UTC(2025, 0, 1) + o * 86_400_000).toISOString().slice(0, 10)), { nil: null }),
});

describe('computeEnvelopeBalances — fast path without set-mode fills', () => {
  it('matches the always-sorted walk on add-only ledgers', () => {
    fc.assert(fc.property(arbLedger(40), arbOpts, (ledger, opts) => {
      const txs = addOnly(ledger);
      expectSameBalances(computeEnvelopeBalances(txs, opts), sortedOracle(txs, opts));
    }), { numRuns: 400 });
  });

  it('matches the always-sorted walk on ledgers with set-mode fills', () => {
    fc.assert(fc.property(arbLedger(40), arbOpts, (ledger, opts) => {
      const txs = ledger.slice();
      expectSameBalances(computeEnvelopeBalances(txs, opts), sortedOracle(txs, opts));
    }), { numRuns: 400 });
  });

  it('gives the same answer whatever order an add-only ledger is stored in', () => {
    fc.assert(fc.property(arbLedger(30), (ledger) => {
      const txs = addOnly(ledger);
      expectSameBalances(computeEnvelopeBalances(txs.slice().reverse()), computeEnvelopeBalances(txs));
    }), { numRuns: 200 });
  });

  it('still honours date order when a set-mode fill is present', () => {
    // Array order puts the later-dated expense first; a raw-order walk would
    // let the earlier-dated set wipe it out.
    const txs = [
      { id: 'x', type: 'expense', date: '2026-02-01', envelope_id: 'e1', amount: 30 },
      { id: 's', type: 'fill', date: '2026-01-01', lines: [{ envelope_id: 'e1', mode: 'set', amount: 100 }] },
    ];
    expect(computeEnvelopeBalances(txs).get('e1')).toBe(70);
  });

  it('on a same-date tie, array order decides which side of a set a delta falls', () => {
    const d = '2026-01-10';
    const txs = [
      { id: 'a', type: 'expense', date: d, envelope_id: 'e1', amount: 1 },           // before set: wiped
      { id: 's1', type: 'fill', date: d, lines: [{ envelope_id: 'e1', mode: 'set', amount: 50 }] },
      { id: 'b', type: 'expense', date: d, envelope_id: 'e1', amount: 2 },           // after s1, before s2: wiped
      { id: 's2', type: 'fill', date: d, lines: [{ envelope_id: 'e1', mode: 'set', amount: 100 }] },
      { id: 'c', type: 'expense', date: d, envelope_id: 'e1', amount: 4 },           // after s2: counts
      { id: 'z', type: 'expense', date: '2026-01-09', envelope_id: 'e1', amount: 8 }, // earlier date: wiped
      { id: 'y', type: 'income', date: '2026-01-11', envelope_id: 'e1', amount: 16 }, // later date: counts
      { id: 'o', type: 'expense', date: '2026-01-01', envelope_id: 'e2', amount: 3 }, // other envelope
    ];
    const got = computeEnvelopeBalances(txs);
    expect(got.get('e1')).toBe(100 - 4 + 16);
    expect(got.get('e2')).toBe(-3);
    expectSameBalances(got, sortedOracle(txs));
  });

  it('a later-dated set earlier in the array still wins over an earlier-dated one', () => {
    const txs = [
      { id: 's2', type: 'fill', date: '2026-03-01', lines: [{ envelope_id: 'e1', mode: 'set', amount: 100 }] },
      { id: 's1', type: 'fill', date: '2026-02-01', lines: [{ envelope_id: 'e1', mode: 'set', amount: 10 }] },
      { id: 'x', type: 'expense', date: '2026-02-15', envelope_id: 'e1', amount: 5 },
    ];
    expect(computeEnvelopeBalances(txs).get('e1')).toBe(100);
  });
});
