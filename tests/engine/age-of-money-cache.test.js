// Guards the _prepareAomTxs memo added to js/engine/history.js. The filter,
// date-parse and sort step is shared across every refDate and cached by
// transactions-array identity — so the risk is a cached prep leaking stale or
// wrongly-ordered rows into the FIFO walk and silently changing money math.

import { describe, it, expect } from 'vitest';
import {
  computeAgeOfMoney,
  computeAgeOfMoneyDetailed,
  computeAgeOfMoneyHistory,
  computeMoneyCushion,
} from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];

function sampleTxs() {
  return [
    { id: 'i1', type: 'income',  date: '2026-01-05', amount: 2000, account: 'a1', status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-02-10', amount:  300, account: 'a1', status: 'posted' },
    { id: 'i2', type: 'income',  date: '2026-03-01', amount: 1500, account: 'a1', status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-03-20', amount:  450, account: 'a1', status: 'posted' },
    { id: 'e3', type: 'expense', date: '2026-04-12', amount:  220, account: 'a1', status: 'posted' },
  ];
}

describe('Age-of-Money prep cache', () => {
  it('gives the same result on a cached array as on a fresh one', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const shared = sampleTxs();

    // First call populates the cache, second call reads it.
    const first  = computeAgeOfMoney(shared, ref, 30);
    const second = computeAgeOfMoney(shared, ref, 30);
    // A structurally identical but distinct array misses the cache entirely.
    const cold   = computeAgeOfMoney(sampleTxs(), ref, 30);

    expect(second).toBe(first);
    expect(cold).toBe(first);
  });

  it('is not sensitive to the order rows arrive in', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const ordered = sampleTxs();
    const shuffled = [ordered[3], ordered[0], ordered[4], ordered[1], ordered[2]];

    expect(computeAgeOfMoney(shuffled, ref, 30))
      .toBe(computeAgeOfMoney(ordered, ref, 30));
  });

  it('reflects added rows once the array identity changes', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const base = sampleTxs();
    const before = computeAgeOfMoney(base, ref, 30);

    // Mirrors how the session's commit writes: a new array, never an
    // in-place mutation of the old one.
    const after = computeAgeOfMoney(
      [...base, { id: 'e4', type: 'expense', date: '2026-04-28', amount: 900, account: 'a1', status: 'posted' }],
      ref,
      30,
    );

    expect(after).not.toBe(before);
  });

  it('history and cushion agree with a standalone call at the same refDate', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = sampleTxs();

    // computeAgeOfMoneyHistory drives 12 walks off one shared prep; the last
    // sample is end-of-month for refDate, which computeAgeOfMoney should match.
    const history = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 12 });
    const last = history[history.length - 1];
    expect(last.aom).toBe(computeAgeOfMoney(txs, last.refDate, 30));

    const cushion = computeMoneyCushion(ACCOUNTS, txs, ref, 30);
    expect(cushion.aom).toBe(computeAgeOfMoney(txs, ref, 30));
  });

  it('keeps the detailed variant in step with the lean one', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = sampleTxs();
    // Run the lean variant first so the detailed one reads a warm cache.
    const lean = computeAgeOfMoney(txs, ref, 30);
    expect(computeAgeOfMoneyDetailed(txs, ref, 30).aom).toBe(lean);
  });

  it('still drops unposted, non-income/expense and zero-amount rows', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const clean = sampleTxs();
    const noisy = [
      ...clean,
      { id: 'x1', type: 'expense', date: '2026-04-20', amount: 500, account: 'a1', status: 'scheduled' },
      { id: 'x2', type: 'account_transfer', date: '2026-04-21', amount: 800, account: 'a1', status: 'posted' },
      { id: 'x3', type: 'expense', date: '2026-04-22', amount: 0, account: 'a1', status: 'posted' },
      { id: 'x4', type: 'expense', date: 'not-a-date', amount: 75, account: 'a1', status: 'posted' },
    ];

    expect(computeAgeOfMoney(noisy, ref, 30)).toBe(computeAgeOfMoney(clean, ref, 30));
  });
});
