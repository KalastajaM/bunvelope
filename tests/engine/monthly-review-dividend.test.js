// tests/engine/monthly-review-dividend.test.js — regression for the dividend
// sign bug: runMonthlyReview used to collapse investment_transfer direction to
// buy/sell only, so a dividend carrying an envelope_id was counted as a debit
// (spending) while computeEnvelopeBalances credits it. Dividends and sells
// return money to the envelope; the review's debit buckets must skip both.

import { describe, it, expect } from 'vitest';
import { runMonthlyReview } from '../../js/engine/monthly-review.js';

const envelopes = [{ id: 'inv', name: 'Investing', category: 'Savings' }];
const refDate = new Date(2026, 6, 15); // 2026-07-15
const month = '2026-07';

function reviewRow(transactions) {
  const balances = new Map([['inv', 100]]);
  const rows = runMonthlyReview(envelopes, [], balances, transactions, month, refDate);
  return rows.find(r => r.envelope_id === 'inv');
}

describe('runMonthlyReview investment_transfer directions', () => {
  it('does not count a posted dividend as an actual debit', () => {
    const row = reviewRow([{
      id: 'd1', type: 'investment_transfer', direction: 'dividend',
      envelope_id: 'inv', from_account: 'broker', to_account: 'bank',
      amount: 50, date: '2026-07-05', status: 'posted',
    }]);
    expect(row.actual).toBe(0);
    expect(row.scheduled).toBe(0);
  });

  it('does not count a future-dated dividend as a scheduled debit', () => {
    const row = reviewRow([{
      id: 'd2', type: 'investment_transfer', direction: 'dividend',
      envelope_id: 'inv', from_account: 'broker', to_account: 'bank',
      amount: 50, date: '2026-07-25', status: 'posted',
    }]);
    expect(row.actual).toBe(0);
    expect(row.scheduled).toBe(0);
  });

  it('skips sells the same way', () => {
    const row = reviewRow([
      { id: 's1', type: 'investment_transfer', direction: 'sell',
        envelope_id: 'inv', from_account: 'broker', to_account: 'bank',
        amount: 80, date: '2026-07-05', status: 'posted' },
      { id: 's2', type: 'investment_transfer', direction: 'sell',
        envelope_id: 'inv', from_account: 'broker', to_account: 'bank',
        amount: 80, date: '2026-07-25', status: 'posted' },
    ]);
    expect(row.actual).toBe(0);
    expect(row.scheduled).toBe(0);
  });

  it('still counts buys as debits (control)', () => {
    const row = reviewRow([
      { id: 'b1', type: 'investment_transfer', direction: 'buy',
        envelope_id: 'inv', from_account: 'bank', to_account: 'broker',
        amount: 60, date: '2026-07-05', status: 'posted' },
      { id: 'b2', type: 'investment_transfer', direction: 'buy',
        envelope_id: 'inv', from_account: 'bank', to_account: 'broker',
        amount: 40, date: '2026-07-25', status: 'posted' },
    ]);
    expect(row.actual).toBe(60);
    expect(row.scheduled).toBe(40);
  });
});
