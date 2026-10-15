// QA 2026-09-23 #8 — the dashboard's balance sparkline asked
// `computeAccountBalances` for six month-ends, one call each, and every one
// was a separate cache entry and a separate full walk. The checkpoint helper
// answers all of them in one pass. Its contract is that each entry equals the
// separate `computeAccountBalances(accounts, txs, { onlyPosted, asOf })` call
// for that date — the same end-of-day, local-date cutoff.
//
// The one-pass form groups deltas per checkpoint before accumulating them, so
// the additions happen in a different order than the per-call walk; float
// addition is not associative, and the comparison is numeric (1e-9).
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  computeAccountBalances, computeAccountBalancesAtDates,
} from '../../js/engine.js';
import { ACCOUNTS, arbLedger } from './arbitraries.js';

const EPS = 1e-9;
function expectSameBalances(actual, expected, label) {
  expect([...actual.keys()].sort(), label).toEqual([...expected.keys()].sort());
  for (const [k, v] of expected) {
    expect(Math.abs((actual.get(k) ?? NaN) - v), `${label} account ${k}: ${actual.get(k)} vs ${v}`)
      .toBeLessThan(EPS);
  }
}

const ISO = o => new Date(Date.UTC(2025, 0, 1) + o * 86_400_000).toISOString().slice(0, 10);
// A checkpoint in every form `asOf` accepts: an ISO string, a local Date at
// midnight, a local Date late in the day (end-of-day semantics), and a
// datetime string (only its date part counts).
const arbCheckpoint = fc.integer({ min: -5, max: 905 }).chain(o => fc.constantFrom(
  ISO(o),
  new Date(`${ISO(o)}T00:00:00`),
  new Date(`${ISO(o)}T23:59:30`),
  `${ISO(o)}T08:00:00Z`,
));

describe('computeAccountBalancesAtDates', () => {
  it('equals a separate computeAccountBalances call per checkpoint', () => {
    fc.assert(fc.property(
      arbLedger(40),
      fc.array(arbCheckpoint, { minLength: 1, maxLength: 8 }),
      fc.boolean(),
      (ledger, dates, onlyPosted) => {
        const got = computeAccountBalancesAtDates(ACCOUNTS, ledger, { dates, onlyPosted });
        expect(got).toHaveLength(dates.length);
        dates.forEach((asOf, i) => {
          const want = computeAccountBalances(ACCOUNTS, ledger, { onlyPosted, asOf });
          expectSameBalances(got[i], want, `checkpoint ${i} (${String(asOf)})`);
        });
      },
    ), { numRuns: 400 });
  });

  it('returns results in the caller\'s order, not sorted order', () => {
    const txs = [
      { id: 'a', type: 'income', account: 'chk', amount: 10, date: '2026-01-10' },
      { id: 'b', type: 'income', account: 'chk', amount: 20, date: '2026-02-10' },
    ];
    const [feb, jan, before] = computeAccountBalancesAtDates(
      ACCOUNTS, txs, { dates: ['2026-02-28', '2026-01-31', '2025-12-31'] },
    );
    expect(feb.get('chk')).toBe(1030);
    expect(jan.get('chk')).toBe(1010);
    expect(before.get('chk')).toBe(1000);
  });

  it('includes a transaction dated exactly on the checkpoint (end of day)', () => {
    const txs = [{ id: 'a', type: 'expense', account: 'chk', amount: 5, date: '2026-01-31' }];
    const [eom] = computeAccountBalancesAtDates(ACCOUNTS, txs, { dates: [new Date(2026, 0, 31)] });
    expect(eom.get('chk')).toBe(995);
  });

  it('excludes scheduled and forecast rows when onlyPosted', () => {
    const txs = [
      { id: 'a', type: 'expense', account: 'chk', amount: 5, date: '2026-01-10', status: 'scheduled' },
      { id: 'b', type: 'expense', account: 'chk', amount: 7, date: '2026-01-10', is_forecast: true },
      { id: 'c', type: 'expense', account: 'chk', amount: 1, date: '2026-01-10' },
    ];
    const [posted] = computeAccountBalancesAtDates(ACCOUNTS, txs, { dates: ['2026-01-31'], onlyPosted: true });
    const want = computeAccountBalances(ACCOUNTS, txs, { onlyPosted: true, asOf: '2026-01-31' });
    expect(posted.get('chk')).toBe(want.get('chk'));
  });

  it('handles no dates and no transactions', () => {
    expect(computeAccountBalancesAtDates(ACCOUNTS, [], { dates: [] })).toEqual([]);
    const [m] = computeAccountBalancesAtDates(ACCOUNTS, null, { dates: ['2026-01-01'] });
    expect(m.get('chk')).toBe(1000);
  });

  it('does not share a cache entry with computeAccountBalances for the same opts', () => {
    // Both are memoized per transactions array, keyed by (accounts, opts).
    const txs = [{ id: 'a', type: 'income', account: 'chk', amount: 10, date: '2026-01-10' }];
    const single = computeAccountBalances(ACCOUNTS, txs, {});
    const multi = computeAccountBalancesAtDates(ACCOUNTS, txs, {});
    expect(single).toBeInstanceOf(Map);
    expect(multi).toEqual([]);
    expect(computeAccountBalances(ACCOUNTS, txs, {})).toBe(single);
  });

  it('returns read-only maps, like the cached single-date API', () => {
    const [m] = computeAccountBalancesAtDates(ACCOUNTS, [], { dates: ['2026-01-01'] });
    expect(() => m.set('chk', 0)).toThrow();
  });
});
