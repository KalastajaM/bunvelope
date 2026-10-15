// "Disabled" (`include === false`) on a scheduled plan item pauses it: no post
// on its due date, no forecast rows, no due-ahead rows. Owner decision
// 2026-09-28; rejected: Disabled only affecting the plan totals. Only an
// explicit `false` disables; a legacy item with no `include` field stays
// enabled, so existing budgets keep posting exactly as before.

import { describe, it, expect } from 'vitest';
import {
  materializeDueBudgetItems, forecastScheduledTransactions, forecastDueAheadTransactions,
} from '../../js/engine.js';

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const accounts = [
  { id: 'salary', name: 'Salary', type: 'bank' },
  { id: 'card', name: 'Card', type: 'bank' },
  { id: 'broker', name: 'Broker', type: 'investment' },
];
const envelopes = [{ id: 'bills', name: 'Bills' }];

const base = {
  default_amount: 100, monthly_schedule: { ...ALL }, payment_day: 10,
  schedule_day_type: 'exact', as_schedule: true, as_schedule_since: '2026-07-01',
};
const KINDS = {
  expense: { ...base, id: 'exp', kind: 'expense', envelope_id: 'bills', account_id: 'card', default_amount: -100 },
  income: { ...base, id: 'inc', kind: 'income', envelope_id: null, account_id: 'salary' },
  investment_transfer: {
    ...base, id: 'inv', kind: 'investment_transfer', direction: 'buy',
    envelope_id: 'bills', account_id: 'card', investment_account_id: 'broker', default_amount: -100,
  },
  account_transfer: {
    ...base, id: 'tr', kind: 'account_transfer', envelope_id: null,
    account_id: 'salary', to_account_id: 'card', default_amount: -100,
  },
};

const SEP28 = new Date(2026, 8, 28);
const idGen = () => 'id';

const posted = items => materializeDueBudgetItems(items, accounts, envelopes, [], SEP28, idGen).newTxs;
const forecast = items => forecastScheduledTransactions(items, accounts, envelopes, SEP28, '2026-12-31');

describe('a disabled scheduled item is paused', () => {
  for (const [kind, item] of Object.entries(KINDS)) {
    describe(kind, () => {
      const off = { ...item, include: false };

      it('is not posted', () => {
        expect(posted([off])).toEqual([]);
      });

      it('produces no forecast rows', () => {
        expect(forecast([off])).toEqual([]);
      });

      it('produces no due-ahead rows', () => {
        // payment_day 31 with next_work_day: Sat Oct 31 2026 pays Mon Nov 2,
        // so on Nov 1 the October occurrence is owned but still ahead.
        const shifted = { ...off, payment_day: 31, schedule_day_type: 'next_work_day' };
        const on = { ...shifted, include: true };
        const NOV1 = new Date(2026, 10, 1);
        // The fixture really does produce a due-ahead row when enabled...
        expect(forecastDueAheadTransactions([on], accounts, envelopes, NOV1)).toHaveLength(1);
        // ...and none when disabled.
        expect(forecastDueAheadTransactions([shifted], accounts, envelopes, NOV1)).toEqual([]);
      });

      it('enabled (include: true) and legacy (no include) behave identically', () => {
        const on = { ...item, include: true };
        const legacy = { ...item };
        delete legacy.include;
        expect(posted([on])).toHaveLength(3); // Jul, Aug, Sep
        expect(posted([legacy])).toEqual(posted([on]));
        expect(forecast([on])).toHaveLength(3); // Oct, Nov, Dec
        expect(forecast([legacy])).toEqual(forecast([on]));
      });

      it('pausing one item leaves the others posting', () => {
        const other = { ...KINDS.expense, id: 'other', include: true };
        expect(posted([off, other]).map(t => t.from_budget))
          .toEqual(['other:2026-07', 'other:2026-08', 'other:2026-09']);
      });
    });
  }
});
