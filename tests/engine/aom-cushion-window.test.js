// §2.6 — computeMoneyCushion calls computeAgeOfMoney and then computes its
// own spend rate over what it believed was the same window. It was not: AoM's
// was `windowDays + 1` calendar days and started a day earlier, while the
// cushion divided by `windowDays`. The dashboard showed both side by side,
// labelled as one 30-day view.
import { describe, it, expect } from 'vitest';
import {
  computeAgeOfMoneyDetailed, computeMoneyCushion,
  trailingWindow, inTrailingWindow,
} from '../../js/engine/history.js';

const REF = new Date('2026-08-27T12:00:00');
const W = 30;
const accounts = [{ id: 'a', name: 'A', type: 'checking', initialBalance: 100000 }];

const posted = (id, type, date, amount) => ({ id, type, date, amount, status: 'posted' });

/** The membership set the cushion's own loop walks, via the shared helper. */
const cushionAdmits = (txs, ref = REF, w = W) => {
  const win = trailingWindow(ref, w);
  return txs
    .filter(t => t.type === 'expense')
    .filter(t => inTrailingWindow(new Date(t.date + 'T00:00:00'), win))
    .map(t => t.id);
};

describe('Age of Money and the money cushion share one window', () => {
  it('admits the same rows on the plan’s boundary ledger', () => {
    const txs = [
      posted('i1', 'income', '2026-06-01', 5000),
      posted('e0', 'expense', '2026-07-27', 100), // ref − 31
      posted('e1', 'expense', '2026-07-28', 100), // ref − 30, the disputed row
      posted('e2', 'expense', '2026-08-27', 100), // ref
    ];
    const aom = computeAgeOfMoneyDetailed(txs, REF, W).perExpense.map(p => p.txId);
    expect(aom).toEqual(cushionAdmits(txs));
    // AoM used to take e1 (ref − 30) and the cushion did not.
    expect(aom).toEqual(['e2']);
  });

  it('spans exactly windowDays, not windowDays + 1', () => {
    // One expense per day for 40 days: whatever the window is, it admits
    // exactly its own length in days.
    const txs = [posted('i', 'income', '2026-01-01', 100000)];
    for (let i = 0; i < 40; i++) {
      const d = new Date(2026, 6, 19 + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
                + `-${String(d.getDate()).padStart(2, '0')}`;
      txs.push(posted(`d${i}`, 'expense', iso, 10));
    }
    expect(computeAgeOfMoneyDetailed(txs, REF, W).perExpense).toHaveLength(W);
    expect(cushionAdmits(txs)).toHaveLength(W);
  });

  it('recentSpend equals recentSpendPerDay * windowDays, exactly', () => {
    // This is the identity the mismatch broke: the cushion divided a 30-day
    // total by 30 while AoM summed 31 days of the same ledger.
    const txs = [posted('i', 'income', '2026-01-01', 100000)];
    for (let i = 0; i < 40; i++) {
      const d = new Date(2026, 6, 19 + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
                + `-${String(d.getDate()).padStart(2, '0')}`;
      txs.push(posted(`d${i}`, 'expense', iso, 10));
    }
    const cushion = computeMoneyCushion(accounts, txs, REF, W);
    const aom = computeAgeOfMoneyDetailed(txs, REF, W);
    expect(cushion.recentSpendPerDay * W).toBeCloseTo(aom.recentSpend, 10);
    expect(cushion.recentSpendPerDay * W).toBe(300);
  });

  it('the window is half-open: ref is in, ref − windowDays is out', () => {
    const win = trailingWindow(REF, W);
    const at = iso => new Date(iso + 'T00:00:00');
    expect(inTrailingWindow(at('2026-08-27'), win)).toBe(true);  // ref
    expect(inTrailingWindow(at('2026-07-29'), win)).toBe(true);  // ref − 29
    expect(inTrailingWindow(at('2026-07-28'), win)).toBe(false); // ref − 30
    expect(inTrailingWindow(at('2026-08-28'), win)).toBe(false); // after ref
  });
});
