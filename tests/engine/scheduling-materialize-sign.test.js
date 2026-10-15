// tests/engine/scheduling-materialize-sign.test.js — regression: materialized
// scheduled expenses used to be emitted with a negative amount, violating the
// write-boundary sign convention and tripping validateAmountSign (status-bar
// invariant badge) until the next full reload.

import { describe, it, expect } from 'vitest';
import { materializeDueBudgetItems, forecastScheduledTransactions } from '../../js/engine/scheduling.js';
import { validateAmountSign } from '../../js/engine/insights.js';

const accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 0 }];
const envelopes = [{ id: 'rent', name: 'Rent', category: 'Home' }];

const rentItem = {
  id: 'rent-item', kind: 'expense', envelope_id: 'rent',
  as_schedule: true, account_id: 'bank',
  payment_day: 5,
  default_amount: 900,
  monthly_schedule: { Jan: true, Feb: true },
  include: true,
  as_schedule_since: '2026-01-01',
  description: 'Rent',
};

describe('materializeDueBudgetItems sign convention', () => {
  it('emits expenses with a positive magnitude and posted status', () => {
    let n = 0;
    const today = new Date('2026-02-20T12:00:00');
    const { newTxs } = materializeDueBudgetItems([rentItem], accounts, envelopes, [], today, () => `t${++n}`);
    expect(newTxs.length).toBe(2);
    for (const tx of newTxs) {
      expect(tx.type).toBe('expense');
      expect(tx.amount).toBe(900);
      expect(tx.status).toBe('posted');
    }
  });

  it('emits nothing that trips validateAmountSign', () => {
    let n = 0;
    const today = new Date('2026-02-20T12:00:00');
    const { newTxs } = materializeDueBudgetItems([rentItem], accounts, envelopes, [], today, () => `t${++n}`);
    for (const tx of newTxs) {
      expect(validateAmountSign(tx)).toEqual([]);
    }
  });
});

describe('forecastScheduledTransactions sign convention', () => {
  it('emits forecast expenses with a positive magnitude', () => {
    const today = new Date('2026-01-20T12:00:00');
    const rows = forecastScheduledTransactions([rentItem], accounts, envelopes, today, '2026-02-28');
    const expenses = rows.filter(r => r.type === 'expense');
    expect(expenses.length).toBeGreaterThan(0);
    for (const row of expenses) {
      expect(row.amount).toBe(900);
      expect(row.is_forecast).toBe(true);
    }
  });
});
