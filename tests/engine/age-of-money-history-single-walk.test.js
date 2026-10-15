// computeAgeOfMoneyHistory used to replay the whole FIFO queue once per
// month (13x for the dashboard's 12-month trend). It now walks the history
// once and sums each window's draws. The oracle is the per-month headline
// metric itself: every sample must equal `computeAgeOfMoney` at that
// month-end EXACTLY, not within a tolerance, because the sums run over the
// same draws in the same order.
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { computeAgeOfMoney, computeAgeOfMoneyHistory, aomPoolTransactions } from '../../js/engine.js';

// The spending pool: transfers to and from 'sav' cross its edge and are marked
// as outflows and inflows (aomPoolTransactions); 'chk' -> 'card' stays neutral.
const POOL = new Set(['chk', 'card']);

const pad = (n) => String(n).padStart(2, '0');

// Rows spread over ~16 months ending at the reference date, so windows see
// empty stretches, starved spending and heavy months alike.
const arbRow = fc.record({
  type: fc.constantFrom('income', 'expense', 'expense', 'account_transfer'),
  dayOffset: fc.integer({ min: 0, max: 480 }),
  cents: fc.integer({ min: 1, max: 400000 }),
  status: fc.constantFrom('posted', 'posted', 'posted', 'scheduled'),
  route: fc.constantFrom(['chk', 'sav'], ['sav', 'chk'], ['chk', 'card']),
});

function toLedger(rows, ref) {
  return rows.map((r, i) => {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - r.dayOffset);
    return {
      id: `t${i}`,
      type: r.type,
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      amount: r.cents / 100,
      status: r.status,
      account: 'chk',
      envelope_id: r.type === 'expense' ? 'food' : null,
      ...(r.type === 'account_transfer' ? { from_account: r.route[0], to_account: r.route[1] } : {}),
    };
  });
}

describe('computeAgeOfMoneyHistory: one walk, same answers', () => {
  it('equals computeAgeOfMoney at every month-end, exactly', () => {
    fc.assert(fc.property(
      fc.array(arbRow, { maxLength: 120 }),
      fc.integer({ min: 0, max: 400 }),
      fc.constantFrom(30, 14, 60),
      (rows, refShift, windowDays) => {
        const ref = new Date(2026, 8, 29 - refShift);
        const txs = aomPoolTransactions(toLedger(rows, new Date(2026, 8, 29)), POOL);
        const history = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 12, windowDays });
        expect(history).toHaveLength(12);
        for (const sample of history) {
          expect(sample.aom).toBe(computeAgeOfMoney(txs, sample.refDate, windowDays));
        }
      },
    ), { numRuns: 300 });
  });

  it('reads nothing but the ledger: a fresh copy of the same rows gives the same history', () => {
    const txs = toLedger([
      { type: 'income', dayOffset: 90, cents: 300000, status: 'posted' },
      { type: 'expense', dayOffset: 40, cents: 50000, status: 'posted' },
      { type: 'expense', dayOffset: 5, cents: 120000, status: 'posted' },
    ], new Date(2026, 8, 29));
    const ref = new Date(2026, 8, 29);
    const a = computeAgeOfMoneyHistory(txs, { refDate: ref });
    const b = computeAgeOfMoneyHistory(txs.map(t => ({ ...t })), { refDate: ref });
    expect(b.map(s => s.aom)).toEqual(a.map(s => s.aom));
    expect(a.at(-1).aom).toBe(computeAgeOfMoney(txs, a.at(-1).refDate));
  });
});
