// Two additive engine changes for plan items that name an account.
//
// 1. A planned (not auto-posting) expense item may name the account that pays
//    for it. The Forecast lens charges that account when it is live; an
//    unknown or archived account, or none at all, falls back to the history
//    attribution (`resolveEnvelopeAccounts`) exactly as before.
//
// 2. `findUnlinkedScheduledPayments` also proposes links for scheduled plan
//    transfers (`kind: 'account_transfer'`): an untagged real transfer with the
//    same from/to accounts, the same amount and a nearby date, under the same
//    mutual-uniqueness rule bills use. Envelope-scoped calls stay bills-only.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  lensTransactions, computeAccountBalances, findUnlinkedScheduledPayments, forecastPlannedExpenses,
} from '../../js/engine.js';
import { _resetLensCache } from '../../js/engine/lens.js';
import { forecastRowsFor } from '../../js/core/effective-txs.js';

const EVERY_MONTH = {
  Jan: 200, Feb: 200, Mar: 200, Apr: 200, May: 200, Jun: 200,
  Jul: 200, Aug: 200, Sep: 200, Oct: 200, Nov: 200, Dec: 200,
};

describe('planned rows: account attribution', () => {
  const accounts = [
    { id: 'hist', name: 'History bank', type: 'bank' },
    { id: 'card', name: 'Card', type: 'bank' },
    { id: 'old', name: 'Old bank', type: 'bank', archived: true },
  ];
  const envelopes = [{ id: 'food', name: 'Food' }];
  // Food has always been paid from `hist`, so history attributes it there.
  const history = [
    { id: 'h1', type: 'expense', date: '2026-07-05', status: 'posted', amount: 50,
      envelope_id: 'food', account: 'hist' },
    { id: 'h2', type: 'expense', date: '2026-08-05', status: 'posted', amount: 50,
      envelope_id: 'food', account: 'hist' },
  ];
  const item = (over = {}) => ({
    id: 'groceries', kind: 'expense', description: 'Groceries', envelope_id: 'food',
    default_amount: 200, monthly_schedule: { ...EVERY_MONTH }, payment_day: 20,
    include: true, as_schedule: false, ...over,
  });
  const TODAY = new Date(2026, 8, 10); // 2026-09-10
  const HORIZON = '2026-09-30';        // one planned row: 2026-09-20, 200

  const balances = (budgetItem) => {
    const txs = lensTransactions(
      { transactions: history, budgetItems: [budgetItem], accounts, envelopes, envelopeTemplates: [] },
      { lens: 'forecast', horizon: HORIZON, today: TODAY },
    );
    const planned = txs.filter(t => t.is_planned);
    return { planned, bal: computeAccountBalances(accounts, txs) };
  };

  beforeEach(() => _resetLensCache());

  it('charges the explicit live account, not the history account', () => {
    const { planned, bal } = balances(item({ account_id: 'card' }));
    expect(planned).toHaveLength(1);
    expect(planned[0].account).toBe('card');
    expect(bal.get('card')).toBe(-200);
    expect(bal.get('hist')).toBe(-100);
  });

  it('falls back to history when the account is unknown', () => {
    const { planned, bal } = balances(item({ account_id: 'nope' }));
    expect(planned[0].account).toBe('hist');
    expect(bal.get('hist')).toBe(-300);
    expect(bal.get('card') || 0).toBe(0);
  });

  it('falls back to history when the account is archived', () => {
    const { planned, bal } = balances(item({ account_id: 'old' }));
    expect(planned[0].account).toBe('hist');
    expect(bal.get('hist')).toBe(-300);
    expect(bal.get('old') || 0).toBe(0);
  });

  it('attributes from history when the item names no account (unchanged)', () => {
    for (const account_id of [undefined, null, '']) {
      _resetLensCache();
      const { planned, bal } = balances(item({ account_id }));
      expect(planned[0].account).toBe('hist');
      expect(bal.get('hist')).toBe(-300);
    }
  });
});

describe('forecastPlannedExpenses: only a live account is carried', () => {
  // The source rule, so every caller of the planned rows (the lens, and
  // `forecastRowsFor` behind the effective transaction list) sees the same
  // thing: a live account, or null. Never a dead one.
  const accounts = [
    { id: 'card', name: 'Card', type: 'bank' },
    { id: 'old', name: 'Old bank', type: 'bank', archived: true },
  ];
  const envelopes = [{ id: 'food', name: 'Food' }];
  const item = (over = {}) => ({
    id: 'groceries', kind: 'expense', description: 'Groceries', envelope_id: 'food',
    default_amount: 200, monthly_schedule: { ...EVERY_MONTH }, payment_day: 20,
    include: true, as_schedule: false, ...over,
  });
  const TODAY = new Date(2026, 8, 10);
  const END = '2026-09-30';
  const direct = (it) => forecastPlannedExpenses([it], accounts, envelopes, TODAY, END);
  const viaState = (it) => forecastRowsFor({
    transactions: [], budgetItems: [it], accounts, envelopes, today: TODAY, endStr: END,
  }).filter(r => r.is_planned);

  for (const [label, run] of [['directly', direct], ['via forecastRowsFor', viaState]]) {
    it(`keeps a live account (${label})`, () => {
      const rows = run(item({ account_id: 'card' }));
      expect(rows).toHaveLength(1);
      expect(rows[0].account).toBe('card');
    });

    it(`drops stale explicit accounts and applies the fallback in effective forecasts (${label})`, () => {
      expect(run(item({ account_id: 'nope' }))[0].account).toBe(run === direct ? null : 'card');
      expect(run(item({ account_id: 'old' }))[0].account).toBe(run === direct ? null : 'card');
    });

    it(`resolves unspecified accounts only in effective forecasts (${label})`, () => {
      for (const account_id of [undefined, null, '']) {
        const rows = run(item({ account_id }));
        expect(rows).toHaveLength(1);
        expect(rows[0].account).toBe(run === direct ? null : 'card');
      }
    });
  }

  it('produces the same row as before for an item with no account', () => {
    expect(direct(item())).toEqual([{
      id: 'planned:groceries:2026-09',
      is_forecast: true,
      is_planned: true,
      forecast_budget_item_id: 'groceries',
      forecast_month_key: '2026-09',
      forecast_dedup_key: 'groceries:2026-09',
      // payment_day 20: a bill by the fill % default (resolveFundingStyle).
      forecast_bill: true,
      type: 'expense',
      date: '2026-09-20',
      status: 'scheduled',
      amount: 200,
      envelope_id: 'food',
      account: null,
      payee: 'Groceries',
      note: null,
    }]);
  });
});

describe('findUnlinkedScheduledPayments: planned transfers', () => {
  const envelopes = [{ id: 'food', name: 'Food' }];
  const NO_MONTHS = {
    Jan: false, Feb: false, Mar: false, Apr: false, May: false, Jun: false,
    Jul: false, Aug: false, Sep: false, Oct: false, Nov: false, Dec: false,
  };
  const transferItem = (over = {}) => ({
    id: 'tr1', kind: 'account_transfer', description: 'Move to card',
    account_id: 'salary', to_account_id: 'card',
    default_amount: 1500, monthly_schedule: { ...NO_MONTHS, Sep: 1500 },
    payment_day: 25, schedule_day_type: 'exact', as_schedule: true, as_schedule_since: '2026-09-01',
    include: true, envelope_id: null, ...over,
  });
  const realTransfer = (over = {}) => ({
    id: 't-sep', type: 'account_transfer', date: '2026-09-25', status: 'posted',
    amount: 1500, from_account: 'salary', to_account: 'card', payee: 'Transfer', ...over,
  });
  const billItem = {
    id: 'bi-tax', kind: 'expense', envelope_id: 'food', description: 'Property tax',
    default_amount: 183.6, include: true, payment_day: 6, as_schedule: true,
    as_schedule_since: '2026-09-01', account_id: 'salary',
    monthly_schedule: { ...NO_MONTHS, Sep: 183.6 },
  };
  const billPayment = {
    id: 'x-sep', type: 'expense', date: '2026-09-06', status: 'posted',
    amount: 183.6, envelope_id: 'food', account: 'salary', payee: 'Property tax',
  };
  const TODAY = new Date(2026, 8, 28); // 2026-09-28

  const find = (transactions, over = {}) => findUnlinkedScheduledPayments({
    budgetItems: [transferItem()], envelopes, transactions, today: TODAY, tombstones: [], ...over,
  });

  it('with accounts, proposes nothing for an item whose account is gone', () => {
    const accounts = [{ id: 'salary' }, { id: 'card' }];
    const all = [realTransfer(), billPayment];
    const items = [transferItem(), billItem];
    // Both still resolve: both proposed.
    expect(find(all, { budgetItems: items, accounts }).map(p => p.itemId).sort())
      .toEqual(['bi-tax', 'tr1']);
    // The transfer's destination was deleted: the materialiser would never
    // post it, so its key must not be written either.
    expect(find(all, { budgetItems: items, accounts: [{ id: 'salary' }] }).map(p => p.itemId))
      .toEqual(['bi-tax']);
    // The paying account was deleted: neither can post.
    expect(find(all, { budgetItems: items, accounts: [{ id: 'card' }] })).toEqual([]);
    // An archived account still posts, so it still links.
    expect(find(all, {
      budgetItems: items, accounts: [{ id: 'salary', archived: true }, { id: 'card' }],
    })).toHaveLength(2);
    // Without accounts the check is off, as before.
    expect(find(all, { budgetItems: items, accounts: undefined })).toHaveLength(2);
  });

  it('proposes a unique matching transfer with the right key and shape', () => {
    const out = find([realTransfer()]);
    expect(out).toEqual([{
      key: 'tr1:2026-09',
      itemId: 'tr1',
      itemDescription: 'Move to card',
      envelopeId: null,
      envelopeName: '',
      monthKey: '2026-09',
      dueDate: '2026-09-25',
      dueAmount: 1500,
      txId: 't-sep',
      txDate: '2026-09-25',
      txPayee: 'Transfer',
      txAmount: 1500,
      fromAccount: 'salary',
      toAccount: 'card',
    }]);
  });

  it('links a transfer made a few days early', () => {
    expect(find([realTransfer({ date: '2026-09-20' })])).toHaveLength(1);
  });

  it('refuses when two transfers could settle the one occurrence', () => {
    expect(find([realTransfer(), realTransfer({ id: 't-dup' })])).toEqual([]);
  });

  it('refuses an amount mismatch', () => {
    expect(find([realTransfer({ amount: 1400 })])).toEqual([]);
  });

  it('refuses the swapped direction', () => {
    expect(find([realTransfer({ from_account: 'card', to_account: 'salary' })])).toEqual([]);
  });

  it('refuses a transfer involving a different account', () => {
    expect(find([realTransfer({ to_account: 'savings' })])).toEqual([]);
    expect(find([realTransfer({ from_account: 'savings' })])).toEqual([]);
  });

  it('refuses a transfer that already carries a key', () => {
    expect(find([realTransfer({ from_budget: 'other:2026-09' })])).toEqual([]);
  });

  it('refuses a transfer that is not posted', () => {
    expect(find([realTransfer({ status: 'scheduled' })])).toEqual([]);
  });

  it('refuses a transfer too far from the due date', () => {
    expect(find([realTransfer({ date: '2026-09-05' })])).toEqual([]);
  });

  it('proposes nothing for a disabled or unscheduled transfer item', () => {
    expect(find([realTransfer()], { budgetItems: [transferItem({ include: false })] })).toEqual([]);
    expect(find([realTransfer()], { budgetItems: [transferItem({ as_schedule: false })] })).toEqual([]);
  });

  it('proposes nothing for a transfer item missing an account or pointing at itself', () => {
    expect(find([realTransfer()], { budgetItems: [transferItem({ to_account_id: null })] })).toEqual([]);
    expect(find([realTransfer({ to_account: 'salary' })],
      { budgetItems: [transferItem({ to_account_id: 'salary' })] })).toEqual([]);
  });

  it('proposes nothing when the occurrence key is already settled or tombstoned', () => {
    expect(find([realTransfer(), realTransfer({ id: 'posted', from_budget: 'tr1:2026-09' })])).toEqual([]);
    expect(find([realTransfer()], { tombstones: ['tr1:2026-09'] })).toEqual([]);
  });

  it('leaves transfers out of an envelope-scoped call', () => {
    const out = find([realTransfer(), billPayment], {
      budgetItems: [transferItem(), billItem], envelopeId: 'food',
    });
    expect(out.map(p => p.key)).toEqual(['bi-tax:2026-09']);
  });

  it('proposes bills and transfers together; bill rows gain no new fields', () => {
    const out = find([realTransfer(), billPayment], { budgetItems: [transferItem(), billItem] });
    expect(out.map(p => p.key)).toEqual(['bi-tax:2026-09', 'tr1:2026-09']);
    expect(out[0]).toEqual({
      key: 'bi-tax:2026-09',
      itemId: 'bi-tax',
      itemDescription: 'Property tax',
      envelopeId: 'food',
      envelopeName: 'Food',
      monthKey: '2026-09',
      dueDate: '2026-09-06',
      dueAmount: 183.6,
      txId: 'x-sep',
      txDate: '2026-09-06',
      txPayee: 'Property tax',
      txAmount: 183.6,
    });
  });

  it('does not let a real expense settle a transfer, nor a transfer settle a bill', () => {
    const expenseAsTransfer = { ...billPayment, id: 'e1', amount: 1500, date: '2026-09-25' };
    expect(find([expenseAsTransfer])).toEqual([]);
    const transferAsBill = realTransfer({ amount: 183.6, date: '2026-09-06' });
    expect(find([transferAsBill], { budgetItems: [billItem] })).toEqual([]);
  });
});
