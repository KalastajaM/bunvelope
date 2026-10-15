// A plan item can be a transfer between two of the user's own accounts
// (`kind: 'account_transfer'`): the monthly move from the account income lands
// on to the account that pays. It posts like a bill (a real, `from_budget`-
// tagged `account_transfer` on its due date) and forecasts like one before it,
// but it is never income, spending, an envelope need or an emergency line:
// moving money between your own accounts does not change what you have.
//
// The "stray" variant below carries an envelope, a buffer and the emergency
// flag, which the editor never gives a transfer. It is what makes the explicit
// `kind === 'account_transfer'` skips observable: without them every
// envelope-gated total would count it as spending.

import { describe, it, expect } from 'vitest';
import {
  materializeDueBudgetItems, forecastScheduledTransactions, forecastDueAheadTransactions,
  computeAccountBalances, computeAnnualTotals, isIncomeLikeItem,
  annualByEnvelope, buildExpenseCalendar, computeMonthlyPlanByEnvelope,
  computeBufferByEnvelope, computeMonthlyEmergencyAmount, computeEmergencyFundRequirement,
  aggregateBudgetAllocation, forecastPlannedExpenses, projectEnvelopeBalance,
  findUnlinkedScheduledPayments, recommendEnvelopeActions, runInvariantCheck,
} from '../../js/engine.js';

const accounts = [
  { id: 'salary', name: 'Salary', type: 'bank' },
  { id: 'card', name: 'Bankcard', type: 'bank' },
];
const envelopes = [{ id: 'food', name: 'Food', category: 'Living' }];

const EVERY_MONTH = {
  Jan: 1500, Feb: 1500, Mar: 1500, Apr: 1500, May: 1500, Jun: 1500,
  Jul: 1500, Aug: 1500, Sep: 1500, Oct: 1500, Nov: 1500, Dec: 1500,
};
const transfer = {
  id: 'tr1', kind: 'account_transfer', description: null,
  account_id: 'salary', to_account_id: 'card',
  default_amount: 1500, monthly_schedule: { ...EVERY_MONTH },
  payment_day: 25, schedule_day_type: 'exact', as_schedule: true, as_schedule_since: '2026-01-01',
  include: true, envelope_id: null, include_in_emergency_budget: false, stress_category: null,
};
// Never produced by the editor; see the header.
const strayTransfer = {
  ...transfer, id: 'tr-stray', envelope_id: 'food', extra_buffer: 300,
  include_in_emergency_budget: true, as_schedule_since: '2026-09-01',
};

const anExpenseItem = {
  id: 'groceries', kind: 'expense', description: 'Groceries', envelope_id: 'food',
  account_id: 'card', default_amount: 400, monthly_schedule: { ...EVERY_MONTH, Jan: true, Feb: true },
  payment_day: 10, include: true, include_in_emergency_budget: true, extra_buffer: 50,
};
const anIncomeItem = {
  id: 'pay', kind: 'income', description: 'Pay', envelope_id: null,
  account_id: 'salary', default_amount: 3000, monthly_schedule: { ...EVERY_MONTH },
  payment_day: 20, include: true,
};

const SEP28 = new Date(2026, 8, 28);
const idGen = () => 'id-1';

describe('posting a planned transfer', () => {
  it('posts one tagged account_transfer per due month since as_schedule_since', () => {
    const { newTxs } = materializeDueBudgetItems([transfer], accounts, envelopes, [], SEP28, idGen);
    expect(newTxs.map(t => t.from_budget)).toEqual([
      'tr1:2026-01', 'tr1:2026-02', 'tr1:2026-03', 'tr1:2026-04', 'tr1:2026-05',
      'tr1:2026-06', 'tr1:2026-07', 'tr1:2026-08', 'tr1:2026-09',
    ]);
    const sep = newTxs.find(t => t.from_budget === 'tr1:2026-09');
    expect(sep).toMatchObject({
      type: 'account_transfer', from_account: 'salary', to_account: 'card',
      amount: 1500, envelope_id: null, payee: 'Transfer', status: 'posted',
      date: '2026-09-25', note: null, id: 'id-1',
    });
    expect(sep.created_at).toBe(SEP28.toISOString());
    expect(sep.modified_at).toBe(SEP28.toISOString());
    for (const t of newTxs) {
      expect(t).not.toHaveProperty('account');
      expect(t.type).toBe('account_transfer');
      expect(t.amount).toBe(1500);
    }
  });

  it('uses the description as the payee when there is one', () => {
    const { newTxs } = materializeDueBudgetItems(
      [{ ...transfer, description: 'To Bankcard', as_schedule_since: '2026-09-01' }],
      accounts, envelopes, [], SEP28, idGen,
    );
    expect(newTxs).toHaveLength(1);
    expect(newTxs[0].payee).toBe('To Bankcard');
  });

  it('posts rows the invariant check accepts', () => {
    const { newTxs } = materializeDueBudgetItems([transfer], accounts, envelopes, [], SEP28,
      (() => { let n = 0; return () => `id-${++n}`; })());
    const report = runInvariantCheck({ accounts, envelopes, transactions: newTxs });
    expect(report.problems).toEqual([]);
  });

  it.each([
    ['the to-account is missing', { to_account_id: null }],
    ['the to-account is unknown', { to_account_id: 'nope' }],
    ['the to-account equals the from-account', { to_account_id: 'salary' }],
    ['it is not scheduled', { as_schedule: false }],
  ])('posts nothing when %s', (_label, over) => {
    const { newTxs } = materializeDueBudgetItems([{ ...transfer, ...over }], accounts, envelopes, [], SEP28, idGen);
    expect(newTxs).toEqual([]);
  });

  it('never needs an envelope', () => {
    const { newTxs } = materializeDueBudgetItems([transfer], accounts, [], [], SEP28, idGen);
    expect(newTxs).toHaveLength(9);
    expect(newTxs.every(t => t.envelope_id === null)).toBe(true);
  });

  it('does not post an occurrence again once a row or tombstone carries its key', () => {
    const item = { ...transfer, as_schedule_since: '2026-09-01' };
    const existing = [{ id: 'x', type: 'account_transfer', date: '2026-09-24', status: 'posted',
      amount: 1500, from_account: 'salary', to_account: 'card', envelope_id: null,
      from_budget: 'tr1:2026-09' }];
    expect(materializeDueBudgetItems([item], accounts, envelopes, existing, SEP28, idGen).newTxs).toEqual([]);
    expect(materializeDueBudgetItems([item], accounts, envelopes, [], SEP28, idGen, [], 'FI',
      ['tr1:2026-09']).newTxs).toEqual([]);
  });
});

describe('forecasting a planned transfer', () => {
  it('gives one transfer row per month ahead, with no account key', () => {
    const rows = forecastScheduledTransactions([transfer], accounts, envelopes, SEP28, '2026-12-31');
    expect(rows.map(r => r.date)).toEqual(['2026-10-25', '2026-11-25', '2026-12-25']);
    for (const r of rows) {
      expect(r).toMatchObject({
        type: 'account_transfer', from_account: 'salary', to_account: 'card',
        amount: 1500, envelope_id: null, payee: 'Transfer', is_forecast: true,
        status: 'scheduled', forecast_budget_item_id: 'tr1', note: null,
      });
      expect(r.id).toBe(`forecast:tr1:${r.forecast_month_key}`);
      expect(r).not.toHaveProperty('account');
    }
    expect(rows[0].forecast_month_key).toBe('2026-10');
  });

  it.each([
    ['the to-account is missing', { to_account_id: undefined }],
    ['the to-account is unknown', { to_account_id: 'nope' }],
    ['the to-account equals the from-account', { to_account_id: 'salary' }],
    ['it is not scheduled', { as_schedule: false }],
  ])('forecasts nothing when %s', (_label, over) => {
    expect(forecastScheduledTransactions([{ ...transfer, ...over }], accounts, envelopes, SEP28, '2026-12-31'))
      .toEqual([]);
  });

  it('includes an owned occurrence whose payment is still ahead (due-ahead)', () => {
    // payment_day 31, next_work_day: Sat 31 Oct 2026 pays Mon 2 Nov. On Nov 1
    // the October occurrence is owned but not yet paid.
    const item = { ...transfer, payment_day: 31, schedule_day_type: 'next_work_day', as_schedule_since: null };
    const rows = forecastDueAheadTransactions([item], accounts, envelopes, new Date(2026, 10, 1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'account_transfer', from_account: 'salary', to_account: 'card', amount: 1500,
      date: '2026-11-02', forecast_month_key: '2026-10', is_forecast: true, envelope_id: null,
    });
    expect(rows[0]).not.toHaveProperty('account');
  });

  it('yields no due-ahead row when nothing is owed ahead', () => {
    expect(forecastDueAheadTransactions([transfer], accounts, envelopes, SEP28)).toEqual([]);
  });

  it('moves the money from one account to the other, total unchanged', () => {
    const rows = forecastScheduledTransactions([transfer], accounts, envelopes, SEP28, '2026-12-31');
    const bal = computeAccountBalances(accounts, rows);
    expect(bal.get('salary')).toBe(-4500);
    expect(bal.get('card')).toBe(4500);
    expect(bal.get('salary') + bal.get('card')).toBe(0);
  });
});

describe('a transfer is neither income nor spending', () => {
  const base = [anExpenseItem, anIncomeItem];

  it('is not income-like', () => {
    expect(isIncomeLikeItem(transfer)).toBe(false);
  });

  it('is left out of the annual totals', () => {
    expect(computeAnnualTotals([transfer, ...base])).toEqual(computeAnnualTotals(base));
    expect(computeAnnualTotals([strayTransfer, ...base])).toEqual(computeAnnualTotals(base));
  });

  it.each([
    ['annualByEnvelope', items => annualByEnvelope(items)],
    ['buildExpenseCalendar', items => buildExpenseCalendar(items)],
    ['computeMonthlyPlanByEnvelope', items => computeMonthlyPlanByEnvelope(items)],
    ['computeBufferByEnvelope', items => computeBufferByEnvelope(items)],
    ['computeMonthlyEmergencyAmount', items => computeMonthlyEmergencyAmount(items, 9)],
    ['computeEmergencyFundRequirement', items => computeEmergencyFundRequirement({
      envelopes: [...envelopes, { id: 'sos', name: 'Emergency' }], budgetItems: items, transactions: [],
      month: '2026-09', meta: { emergency_envelope_id: 'sos' },
    })],
    ['aggregateBudgetAllocation', items => aggregateBudgetAllocation(envelopes, items)],
    ['forecastPlannedExpenses', items => forecastPlannedExpenses(
      items.map(i => ({ ...i, as_schedule: false })), accounts, envelopes, SEP28, '2026-12-31')],
  ])('%s is unchanged by a transfer', (_name, fn) => {
    expect(fn([transfer, ...base])).toEqual(fn(base));
    expect(fn([strayTransfer, ...base])).toEqual(fn(base));
  });

  it('is not an unposted bill in an envelope projection', () => {
    const input = items => ({ envelopeId: 'food', budgetItems: items, accounts, envelopes, today: SEP28, months: 3 });
    expect(projectEnvelopeBalance(input([strayTransfer])).dueUnposted).toBe(0);
    expect(projectEnvelopeBalance(input([transfer])).dueUnposted).toBe(0);
  });

  it('is not proposed for a payment-link repair', () => {
    const paid = [{ id: 'p1', type: 'expense', date: '2026-09-25', status: 'posted', amount: 1500,
      envelope_id: 'food', account: 'card' }];
    expect(findUnlinkedScheduledPayments({
      budgetItems: [strayTransfer], envelopes, transactions: paid, today: SEP28,
    })).toEqual([]);
  });

  it('does not count as a planned expense for an envelope', () => {
    const kinds = items => recommendEnvelopeActions({
      envelopeId: 'food', budgetItems: items, accounts, envelopes, today: SEP28, months: 3,
    }).map(r => r.kind);
    expect(kinds([strayTransfer])).toContain('warn-no-scheduled-expenses');
    expect(kinds([transfer])).toContain('warn-no-scheduled-expenses');
  });
});

describe('emergency fund: a transfer never grants its envelope eligibility', () => {
  // computeEmergencyFundRequirement's whole-result comparison above
  // (`fn([strayTransfer, ...base])` vs `fn(base)`) uses `transactions: []`, so
  // any envelope it might wrongly credit has a balance of 0 either way — it
  // cannot see this specific loop's skip. It also runs alongside
  // `anExpenseItem`, which already names `food` as eligible on its own, so
  // strayTransfer changes nothing there regardless.
  //
  // Isolating the second loop (the one that builds `eligibleEnvIds`) needs
  // strayTransfer as the ONLY item naming `food`, and a real balance sitting
  // in it: removing the `kind === 'account_transfer'` skip there would add
  // `food` to `eligibleEnvIds` and its balance would wrongly count toward
  // `sumOtherBalance`, shrinking the reported requirement.
  const envs = [...envelopes, { id: 'sos', name: 'Emergency' }];
  const transactions = [
    { id: 'seed', type: 'income', date: '2026-09-01', status: 'posted',
      amount: 500, envelope_id: 'food', account: 'salary' },
  ];

  it('does not credit the transfer envelope balance toward the requirement', () => {
    const result = computeEmergencyFundRequirement({
      envelopes: envs, budgetItems: [strayTransfer], transactions,
      month: '2026-09', meta: { emergency_envelope_id: 'sos' },
    });
    expect(result.contributors.some(c => c.envelope_id === 'food')).toBe(false);
    expect(result.sumOtherBalance).toBe(0);
  });
});
