import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeBalances,
  computeEnvelopeRunningBalances,
  computeAccountBalances,
  computeAccountRunningBalances,
  computeUnallocated,
  aggregateSpendingByEnvelope,
  aggregateIncomeVsSpending,
  aggregateSpendingByMonth,
  buildExpenseCalendar,
  aggregateBudgetAllocation,
  materializeDueBudgetItems,
  materializeDueTemplateFills,
  calcDepositAndRequired,
  computeBufferByEnvelope,
  computeMonthlyEmergencyAmount,
  runMonthlyReview,
  annualByEnvelope,
  computeDynamicTemplateLines,
  resolveTemplateLines,
  computeEmergencyFundRequirement,
  computeAnnualInterest,
  computeAnnualTotals,
  forecastScheduledTransactions,
  computeEnvelopeUpcomingDeltas,
  validateAccountRefs,
  validateEnvelopeRefs,
  validateAmountSign,
  runInvariantCheck,
  txSpendPairs,
  txConsumptionPairs,
} from '../js/engine.js';

describe('computeEnvelopeBalances with malformed amounts', () => {
  it('skips expense with null amount instead of treating as 0', () => {
    const txs = [
      { type: 'expense', envelope_id: 'food', amount: 10 },
      { type: 'expense', envelope_id: 'food', amount: null },
      { type: 'expense', envelope_id: 'food', amount: 'abc' },
      { type: 'expense', envelope_id: 'food', amount: undefined },
    ];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('food')).toBe(-10);
  });

  it('skips envelope_transfer with non-finite amount', () => {
    const txs = [
      { type: 'envelope_transfer', from_envelope_id: 'a', to_envelope_id: 'b', amount: Infinity },
      { type: 'envelope_transfer', from_envelope_id: 'a', to_envelope_id: 'b', amount: 5 },
    ];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('a')).toBe(-5);
    expect(bal.get('b')).toBe(5);
  });

  it('skips adjustment with invalid amount', () => {
    const txs = [
      { type: 'adjustment', target: 'envelope', target_id: 'x', amount: 3 },
      { type: 'adjustment', target: 'envelope', target_id: 'x', amount: 'bogus' },
    ];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('x')).toBe(3);
  });

  it('skips fill lines with invalid amounts', () => {
    const txs = [
      { type: 'fill', lines: [
        { envelope_id: 'a', amount: 10 },
        { envelope_id: 'b', amount: null },
        { envelope_id: 'c', amount: 'NaN' },
      ]},
    ];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('a')).toBe(10);
    expect(bal.has('b')).toBe(false);
    expect(bal.has('c')).toBe(false);
  });
});

describe('computeAccountBalances with malformed amounts', () => {
  it('skips income with invalid amount', () => {
    const accounts = [{ id: 'bank', initialBalance: 100 }];
    const txs = [
      { type: 'income', account: 'bank', amount: 50 },
      { type: 'income', account: 'bank', amount: null },
    ];
    expect(computeAccountBalances(accounts, txs).get('bank')).toBe(150);
  });

  it('skips fill line when computing source_account debit', () => {
    const accounts = [{ id: 'bank', initialBalance: 100 }];
    const txs = [
      { type: 'fill', source: 'new_income', source_account: 'bank',
        lines: [{ envelope_id: 'a', amount: 10 }, { envelope_id: 'b', amount: 'bad' }] },
    ];
    expect(computeAccountBalances(accounts, txs).get('bank')).toBe(90);
  });
});

describe('aggregateSpendingByEnvelope with malformed amounts', () => {
  it('skips expenses with invalid amounts', () => {
    const envelopes = [{ id: 'food', category: 'Needs', name: 'Food' }];
    const txs = [
      { type: 'expense', date: '2026-01-05', envelope_id: 'food', amount: 10 },
      { type: 'expense', date: '2026-01-06', envelope_id: 'food', amount: 'abc' },
      { type: 'expense', date: '2026-01-07', envelope_id: 'food', amount: null },
      { type: 'expense', date: '2026-01-08', envelope_id: 'food', amount: Infinity },
      { type: 'expense', date: '2026-01-09', envelope_id: 'food', amount: 5 },
    ];
    const rows = aggregateSpendingByEnvelope(txs, envelopes);
    const food = rows.find(r => r.label === 'Needs · Food');
    expect(food.value).toBe(15);
  });
});

describe('aggregateIncomeVsSpending with malformed amounts', () => {
  it('skips income and expenses with invalid amounts', () => {
    // §2.1 — the expense rows carry an envelope now: spend is measured per
    // envelope, so an unenveloped expense contributes nothing by design (see
    // the dedicated test in tests/engine/spend-rule.test.js). This test is
    // about malformed AMOUNTS, so it keeps its rows countable.
    const txs = [
      { type: 'income',  date: '2026-01-05', amount: 100 },
      { type: 'income',  date: '2026-01-06', amount: 'bad' },
      { type: 'income',  date: '2026-01-07', amount: NaN },
      { type: 'expense', date: '2026-01-08', envelope_id: 'food', amount: 20 },
      { type: 'expense', date: '2026-01-09', envelope_id: 'food', amount: null },
      { type: 'expense', date: '2026-01-10', envelope_id: 'food', amount: {} },
    ];
    const { series } = aggregateIncomeVsSpending(txs);
    const income   = series.find(s => s.name === 'Income').points[0].value;
    const spending = series.find(s => s.name === 'Spending').points[0].value;
    expect(income).toBe(100);
    expect(spending).toBe(20);
  });
});

describe('expense splits', () => {
  it('debits each split envelope by its line amount; ignores envelope_id when splits present', () => {
    const txs = [{
      type: 'expense',
      envelope_id: 'ignored',
      envelope_splits: [
        { envelope_id: 'food', amount: 60 },
        { envelope_id: 'house', amount: 40 },
      ],
      amount: 100,
    }];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('food')).toBe(-60);
    expect(bal.get('house')).toBe(-40);
    expect(bal.has('ignored')).toBe(false);
  });

  it('skips invalid split lines', () => {
    const txs = [{
      type: 'expense',
      envelope_splits: [
        { envelope_id: 'a', amount: 10 },
        { envelope_id: 'b', amount: 'bad' },
        { envelope_id: null, amount: 5 },
      ],
      amount: 15,
    }];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('a')).toBe(-10);
    expect(bal.has('b')).toBe(false);
  });

  it('account still debits by total amount once', () => {
    const accounts = [{ id: 'bank', initialBalance: 100 }];
    const txs = [{
      type: 'expense',
      account: 'bank',
      amount: 30,
      envelope_splits: [
        { envelope_id: 'a', amount: 20 },
        { envelope_id: 'b', amount: 10 },
      ],
    }];
    expect(computeAccountBalances(accounts, txs).get('bank')).toBe(70);
  });

  it('treats negative split lines as credits to the envelope', () => {
    // Real case: 57.71 expense booked as 60.96 to one envelope and a -3.25
    // refund/correction to another. Account is debited 57.71 net.
    const accounts = [{ id: 'amex', initialBalance: 0 }];
    const txs = [{
      type: 'expense',
      account: 'amex',
      amount: 57.71,
      envelope_splits: [
        { envelope_id: 'misc', amount: -3.25 },
        { envelope_id: 'pirkko', amount: 60.96 },
      ],
    }];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('misc')).toBeCloseTo(3.25, 2);
    expect(bal.get('pirkko')).toBeCloseTo(-60.96, 2);
    expect(computeAccountBalances(accounts, txs).get('amex')).toBeCloseTo(-57.71, 2);
  });

  it('aggregateSpendingByEnvelope expands splits across envelopes', () => {
    const envelopes = [
      { id: 'food', category: 'Needs', name: 'Food' },
      { id: 'house', category: 'Needs', name: 'House' },
    ];
    const txs = [
      { type: 'expense', date: '2026-01-05', amount: 100,
        envelope_splits: [
          { envelope_id: 'food', amount: 60 },
          { envelope_id: 'house', amount: 40 },
        ] },
    ];
    const rows = aggregateSpendingByEnvelope(txs, envelopes);
    const food = rows.find(r => r.label === 'Needs · Food');
    const house = rows.find(r => r.label === 'Needs · House');
    expect(food.value).toBe(60);
    expect(house.value).toBe(40);
  });
});

describe('budget items with kind=income', () => {
  const envelopes = [{ id: 'food', name: 'Food', category: 'Needs' }];
  const accounts  = [{ id: 'bank', name: 'Bank', initialBalance: 0 }];

  it('buildExpenseCalendar skips income items', () => {
    const items = [
      { envelope_id: 'food', kind: 'expense', default_amount: -50,
        monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
      { envelope_id: null, kind: 'income', default_amount: 2000,
        monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
    ];
    const cal = buildExpenseCalendar(items);
    expect(cal.get('food')[1]).toBe(50);
    expect(cal.size).toBe(1);
  });

  it('investment dividend items partition with income, not budget', () => {
    const items = [
      { envelope_id: 'food', kind: 'expense', default_amount: -50,
        monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                            Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
        extra_buffer: 0, include: true },
      { envelope_id: null, kind: 'income', default_amount: 2000,
        monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                            Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
        extra_buffer: 0, include: true },
      { envelope_id: null, kind: 'investment_transfer', direction: 'dividend',
        symbol: 'VOO', default_amount: 25,
        monthly_schedule: { Mar: true, Jun: true, Sep: true, Dec: true },
        extra_buffer: 0, include: true },
      { envelope_id: 'food', kind: 'investment_transfer', direction: 'buy',
        symbol: 'VOO', default_amount: -500,
        monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                            Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
        extra_buffer: 0, include: true },
    ];
    const totals = computeAnnualTotals(items);
    // Income side: 12 × 2000 + 4 × 25 = 24100
    expect(totals.income).toBe(24100);
    // Budget side: 12 × 50 (food expense) + 12 × 500 (DCA buy) = 6600
    expect(totals.budget).toBe(6600);
  });

  it('buildExpenseCalendar skips dividend items (income-flavoured)', () => {
    const items = [
      { envelope_id: 'food', kind: 'expense', default_amount: -50,
        monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
      { envelope_id: null, kind: 'investment_transfer', direction: 'dividend',
        symbol: 'VOO', default_amount: 25,
        monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
    ];
    const cal = buildExpenseCalendar(items);
    expect(cal.get('food')[1]).toBe(50);
    expect(cal.size).toBe(1); // dividend doesn't allocate to an envelope
  });

  it('aggregateBudgetAllocation skips income items', () => {
    const items = [
      { envelope_id: 'food', kind: 'expense', default_amount: -50,
        monthly_schedule: { Jan: true, Feb: true }, include: true },
      { envelope_id: null, kind: 'income', default_amount: 2000,
        monthly_schedule: { Jan: true }, include: true },
    ];
    const rows = aggregateBudgetAllocation(envelopes, items);
    expect(rows).toEqual([{ key: 'food', label: 'Needs · Food', value: 100 }]);
  });

  it('materializeDueBudgetItems emits income tx on payment_day when kind=income', () => {
    const items = [{
      id: 'salary', kind: 'income', envelope_id: null,
      as_schedule: true, account_id: 'bank',
      payment_day: 15,
      default_amount: 2000,
      monthly_schedule: { Jan: true, Feb: true },
      include: true,
      as_schedule_since: '2026-01-01',
      description: 'Salary',
    }];
    const today = new Date('2026-02-20T12:00:00');
    let n = 0;
    const { newTxs } = materializeDueBudgetItems(items, accounts, envelopes, [], today, () => `t${++n}`);
    expect(newTxs.length).toBe(2);
    for (const tx of newTxs) {
      expect(tx.type).toBe('income');
      expect(tx.amount).toBe(2000);
      expect(tx.account).toBe('bank');
      expect(tx.envelope_id).toBe(null);
      expect(tx.from_budget).toMatch(/^salary:/);
    }
  });

  it('no longer emits a companion fill for an income item carrying template_id', () => {
    // The income→template link is gone: templates carry their own calendar,
    // which keeps firing in a month whose income is zero instead of being
    // taken down with the paycheck. A stale `template_id` left on an item
    // must therefore do nothing at all rather than quietly double-allocate
    // alongside the template's own schedule.
    const templates = [{
      id: 'tpl1', name: 'Split',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 500 }],
    }];
    const items = [{
      id: 'salary', kind: 'income', envelope_id: null,
      as_schedule: true, account_id: 'bank', payment_day: 15,
      default_amount: 2000,
      monthly_schedule: { Jan: true },
      include: true, as_schedule_since: '2026-01-01',
      template_id: 'tpl1', description: 'Salary',
    }];
    const today = new Date('2026-01-20T12:00:00');
    let n = 0;
    const { newTxs } = materializeDueBudgetItems(
      items, accounts, envelopes, [], today, () => `t${++n}`, templates,
    );
    expect(newTxs.map(t => t.type)).toEqual(['income']);
    expect(newTxs[0].amount).toBe(2000);
    // The income lands in unallocated, undistributed.
    expect(computeEnvelopeBalances(newTxs).size).toBe(0);
    expect(computeAccountBalances(accounts, newTxs).get('bank')).toBe(2000);
  });
  it('materializeDueBudgetItems skips occurrences listed in tombstones', () => {
    const items = [{
      id: 'salary', kind: 'income', envelope_id: null,
      as_schedule: true, account_id: 'bank', payment_day: 15,
      default_amount: 2000,
      monthly_schedule: { Jan: true, Feb: true },
      include: true, as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-02-20T12:00:00');
    let n = 0;
    // Simulates the user deleting January's materialised income tx — its
    // from_budget key is in tombstones, so it must NOT be re-created.
    const tombstones = ['salary:2026-01'];
    const { newTxs } = materializeDueBudgetItems(
      items, accounts, envelopes, [], today, () => `t${++n}`, [], 'FI', tombstones,
    );
    expect(newTxs.length).toBe(1);
    expect(newTxs[0].from_budget).toBe('salary:2026-02');
  });

  it('materializeDueBudgetItems is idempotent on re-run', () => {
    const items = [{
      id: 'salary', kind: 'income', envelope_id: null,
      as_schedule: true, account_id: 'bank', payment_day: 15,
      default_amount: 2000,
      monthly_schedule: { Jan: true },
      include: true, as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-01-20T12:00:00');
    let n = 0;
    const first = materializeDueBudgetItems(items, accounts, envelopes, [], today, () => `t${++n}`);
    expect(first.newTxs.length).toBe(1);
    const second = materializeDueBudgetItems(items, accounts, envelopes, first.newTxs, today, () => `t${++n}`);
    expect(second.newTxs.length).toBe(0);
  });

  it('materializeDueBudgetItems emits investment_transfer buy when kind=investment_transfer', () => {
    const accts = [
      { id: 'bank', name: 'Bank' },
      { id: 'broker', name: 'Broker', type: 'investment' },
    ];
    const envs = [{ id: 'invest', name: 'Investing', category: 'Save' }];
    const items = [{
      id: 'dca', kind: 'investment_transfer',
      envelope_id: 'invest',
      account_id: 'bank',
      investment_account_id: 'broker',
      symbol: 'VOO',
      as_schedule: true, payment_day: 1,
      default_amount: -500,
      monthly_schedule: { Jan: true, Feb: true },
      include: true, as_schedule_since: '2026-01-01',
      description: 'Monthly DCA',
    }];
    const today = new Date('2026-02-05T12:00:00');
    let n = 0;
    const { newTxs } = materializeDueBudgetItems(items, accts, envs, [], today, () => `t${++n}`);
    expect(newTxs.length).toBe(2);
    for (const tx of newTxs) {
      expect(tx.type).toBe('investment_transfer');
      expect(tx.direction).toBe('buy');
      expect(tx.amount).toBe(500);
      expect(tx.from_account).toBe('bank');
      expect(tx.to_account).toBe('broker');
      expect(tx.envelope_id).toBe('invest');
      expect(tx.symbol).toBe('VOO');
      expect(tx.from_budget).toMatch(/^dca:/);
    }
  });

  it('forecastScheduledTransactions emits investment_transfer rows for future months', () => {
    const accts = [
      { id: 'bank', name: 'Bank' },
      { id: 'broker', name: 'Broker', type: 'investment' },
    ];
    const envs = [{ id: 'invest', name: 'Investing' }];
    const items = [{
      id: 'dca', kind: 'investment_transfer',
      envelope_id: 'invest',
      account_id: 'bank',
      investment_account_id: 'broker',
      symbol: 'VOO',
      as_schedule: true, payment_day: 1,
      default_amount: -500,
      monthly_schedule: { Jan: true, Feb: true, Mar: true },
      include: true, as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-01-15T12:00:00');
    const out = forecastScheduledTransactions(items, accts, envs, today, '2026-03-31');
    expect(out.length).toBe(2); // Feb 1, Mar 1 (Jan already passed)
    for (const row of out) {
      expect(row.type).toBe('investment_transfer');
      expect(row.direction).toBe('buy');
      expect(row.amount).toBe(500);
      expect(row.from_account).toBe('bank');
      expect(row.to_account).toBe('broker');
      expect(row.envelope_id).toBe('invest');
      expect(row.symbol).toBe('VOO');
      expect(row.is_forecast).toBe(true);
      expect(row.account).toBeUndefined();
    }
  });

  it('materializeDueBudgetItems emits dividend tx when investment item has direction=dividend', () => {
    const accts = [
      { id: 'bank', name: 'Bank' },
      { id: 'broker', name: 'Broker', type: 'investment' },
    ];
    const envs = [{ id: 'invest', name: 'Investing' }];
    // Dividend item: cash lands on `bank`, paid by holdings on `broker`.
    // Envelope is null (lands in unallocated, like income).
    const items = [{
      id: 'voo-div', kind: 'investment_transfer', direction: 'dividend',
      envelope_id: null,
      account_id: 'bank',
      investment_account_id: 'broker',
      symbol: 'VOO',
      as_schedule: true, payment_day: 15,
      default_amount: 25,
      monthly_schedule: { Mar: true, Jun: true, Sep: true, Dec: true },
      include: true, as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-04-20T12:00:00');
    let n = 0;
    const { newTxs } = materializeDueBudgetItems(items, accts, envs, [], today, () => `t${++n}`);
    expect(newTxs.length).toBe(1); // March, the only quarter end before April 20
    const tx = newTxs[0];
    expect(tx.type).toBe('investment_transfer');
    expect(tx.direction).toBe('dividend');
    expect(tx.amount).toBe(25);
    // Dividend is income-shape: from = investment account, to = cash.
    expect(tx.from_account).toBe('broker');
    expect(tx.to_account).toBe('bank');
    expect(tx.envelope_id).toBe(null);
    expect(tx.symbol).toBe('VOO');
  });

  it('forecastScheduledTransactions emits dividend forecasts with correct from/to', () => {
    const accts = [
      { id: 'bank', name: 'Bank' },
      { id: 'broker', name: 'Broker', type: 'investment' },
    ];
    const envs = [];
    const items = [{
      id: 'voo-div', kind: 'investment_transfer', direction: 'dividend',
      envelope_id: null,
      account_id: 'bank',
      investment_account_id: 'broker',
      symbol: 'VOO',
      as_schedule: true, payment_day: 15,
      default_amount: 25,
      monthly_schedule: { Mar: true, Jun: true, Sep: true, Dec: true },
      include: true, as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-01-20T12:00:00');
    const out = forecastScheduledTransactions(items, accts, envs, today, '2026-12-31');
    expect(out.length).toBe(4);
    for (const row of out) {
      expect(row.type).toBe('investment_transfer');
      expect(row.direction).toBe('dividend');
      expect(row.from_account).toBe('broker');
      expect(row.to_account).toBe('bank');
      expect(row.amount).toBe(25);
      expect(row.is_forecast).toBe(true);
    }
  });

  it('investment_transfer kind is skipped when investment_account is missing or matches cash', () => {
    const accts = [{ id: 'bank', name: 'Bank' }];
    const envs = [{ id: 'invest', name: 'Investing' }];
    const noInv = [{
      id: 'dca', kind: 'investment_transfer', envelope_id: 'invest',
      account_id: 'bank', investment_account_id: null,
      as_schedule: true, payment_day: 1, default_amount: -500,
      monthly_schedule: { Jan: true }, include: true,
      as_schedule_since: '2026-01-01',
    }];
    const same = [{
      ...noInv[0],
      investment_account_id: 'bank',
    }];
    const today = new Date('2026-02-05T12:00:00');
    expect(materializeDueBudgetItems(noInv, accts, envs, [], today).newTxs).toEqual([]);
    expect(materializeDueBudgetItems(same, accts, envs, [], today).newTxs).toEqual([]);
  });
});

describe('aggregateSpendingByMonth with malformed amounts', () => {
  it('skips expenses with invalid amounts', () => {
    // §2.1 — see the note on the incomeVsSpending sibling: spend is per
    // envelope, so these rows carry one. The subject is malformed amounts.
    const txs = [
      { type: 'expense', date: '2026-02-01', envelope_id: 'food', amount: 30 },
      { type: 'expense', date: '2026-02-02', envelope_id: 'food', amount: 'oops' },
      { type: 'expense', date: '2026-02-03', envelope_id: 'food', amount: undefined },
      { type: 'expense', date: '2026-02-04', envelope_id: 'food', amount: 1e13 },
      { type: 'expense', date: '2026-02-05', envelope_id: 'food', amount: 7 },
    ];
    const rows = aggregateSpendingByMonth(txs);
    expect(rows).toEqual([{ key: '2026-02', label: '2026-02', value: 37 }]);
  });
});

describe('extra_buffer as balance floor', () => {
  it('buildExpenseCalendar does not add buffer as virtual monthly expense', () => {
    const items = [
      { envelope_id: 'e', kind: 'expense', default_amount: 0,
        monthly_schedule: {}, extra_buffer: 1200, include: true },
    ];
    const cal = buildExpenseCalendar(items);
    // Buffer must not inflate monthly spend — all 12 months should be 0.
    const arr = cal.get('e') || new Array(13).fill(0);
    for (let i = 1; i <= 12; i++) expect(arr[i]).toBe(0);
  });

  it('calcDepositAndRequired adds buffer to req without changing D', () => {
    const eRoll = new Array(13).fill(0);
    for (let i = 1; i <= 12; i++) eRoll[i] = 100;
    const { D: D0, req: req0 } = calcDepositAndRequired(eRoll, 0);
    const { D: D1, req: req1 } = calcDepositAndRequired(eRoll, 500);
    expect(D1).toBe(D0);
    expect(req1).toBe(Math.round((req0 + 500) * 100) / 100);
  });

  it('computeBufferByEnvelope sums buffers per envelope, skips income/excluded', () => {
    const items = [
      { envelope_id: 'a', kind: 'expense', extra_buffer: 100, include: true },
      { envelope_id: 'a', kind: 'expense', extra_buffer: 50,  include: true },
      { envelope_id: 'a', kind: 'expense', extra_buffer: 999, include: false },
      { envelope_id: null, kind: 'income',  extra_buffer: 77, include: true },
      { envelope_id: 'b', kind: 'expense', extra_buffer: 0,   include: true },
    ];
    const map = computeBufferByEnvelope(items);
    expect(map.get('a')).toBe(150);
    expect(map.has('b')).toBe(false);
  });

  it('computeMonthlyEmergencyAmount excludes buffer', () => {
    const items = [
      { envelope_id: 'food', kind: 'expense', default_amount: 100,
        monthly_schedule: { Jan: true }, extra_buffer: 1200,
        include: true, include_in_emergency_budget: true },
    ];
    expect(computeMonthlyEmergencyAmount(items, 1)).toBe(100);
    expect(computeMonthlyEmergencyAmount(items, 2)).toBe(0);
  });

  it('runMonthlyReview: pure-buffer envelope has D=0 and req=buffer', () => {
    const envelopes = [{ id: 'rain', name: 'Rainy day', category: 'Safety' }];
    const items = [
      { envelope_id: 'rain', kind: 'expense', default_amount: 0,
        monthly_schedule: {}, extra_buffer: 1200, include: true },
    ];
    const balances = new Map([['rain', 2000]]);
    // The clock is a required parameter now; this test used to lean on the
    // default and so asserted against whatever day it happened to run on.
    const rows = runMonthlyReview(envelopes, items, balances, [], '2026-04', new Date(2026, 3, 15));
    const row = rows.find(r => r.envelope_id === 'rain');
    expect(row).toBeTruthy();
    expect(row.D).toBe(0);
    expect(row.required).toBe(1200);
    expect(row.surplus).toBe(800); // 2000 balance − 1200 floor
  });

  it('runMonthlyReview: future-dated tx not double-counted when caller passes as-of-today balances', () => {
    // Today = 2026-05-13. Envelope has €2 300 sitting in it today (from a
    // past fill) and a future-dated real expense of €2 300 on May 25.
    // Compute the as-of-today balance map (the contract the review page
    // must satisfy) and run the review for May 2026.
    const envelopes = [{ id: 'int', name: 'Interior', category: 'Home' }];
    const items = [
      { envelope_id: 'int', kind: 'expense', default_amount: -250,
        monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true,
          Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
        extra_buffer: 0, include: true },
    ];
    const txs = [
      { id: 't1', type: 'income', date: '2026-01-15', envelope_id: 'int',
        account: 'a1', amount: 2300, status: 'posted' },
      { id: 't2', type: 'expense', date: '2026-05-25', envelope_id: 'int',
        account: 'a1', amount: 2300, status: 'posted' },
    ];
    const today = new Date('2026-05-13T12:00:00');
    const balances = computeEnvelopeBalances(txs, { asOf: today });

    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-05', today);
    const row = rows.find(r => r.envelope_id === 'int');
    expect(row).toBeTruthy();
    // As-of-today: the €2300 income posted, the €2300 May 25 expense hasn't.
    expect(row.balance).toBeCloseTo(2300, 2);
    expect(row.actual).toBeCloseTo(0, 2);          // no May posted-and-past expenses
    expect(row.scheduled).toBeCloseTo(2300, 2);    // the May 25 future expense
    // `planned` is the monthly plan (€250) bumped by the booked future
    // €2300 via `_bookedFutureExtrasByEnvelope` → €2550. With balance
    // €2300 and remaining = max(2300, 2550 − 0) = 2550, projected = 2300 −
    // 2550 = −250 (the monthly-plan shortfall is real; the future expense
    // itself is fully covered).
    expect(row.planned).toBeCloseTo(2550, 2);
    expect(row.projected).toBeCloseTo(-250, 2);
  });

  it('runMonthlyReview: passing the budget-view balance double-counts (negative case, documents the contract)', () => {
    // Same scenario as above but the caller wrongly passes the budget
    // view (which already deducts future tx). This is exactly the bug
    // the review page had before the asOf fix. Asserting the broken
    // numbers here pins the contract: callers MUST pass as-of-today.
    const envelopes = [{ id: 'int', name: 'Interior', category: 'Home' }];
    const items = [
      { envelope_id: 'int', kind: 'expense', default_amount: -250,
        monthly_schedule: { May: true }, extra_buffer: 0, include: true },
    ];
    const txs = [
      { id: 't1', type: 'income', date: '2026-01-15', envelope_id: 'int',
        account: 'a1', amount: 2300, status: 'posted' },
      { id: 't2', type: 'expense', date: '2026-05-25', envelope_id: 'int',
        account: 'a1', amount: 2300, status: 'posted' },
    ];
    const today = new Date('2026-05-13T12:00:00');
    const budgetView = computeEnvelopeBalances(txs); // wrong view

    const rows = runMonthlyReview(envelopes, items, budgetView, txs, '2026-05', today);
    const row = rows.find(r => r.envelope_id === 'int');
    expect(row.balance).toBeCloseTo(0, 2);        // future expense already deducted
    expect(row.scheduled).toBeCloseTo(2300, 2);
    // projected = 0 − max(2300, 2550) = −2550 — exactly the value the
    // user reported in the Interior row before the asOf fix.
    expect(row.projected).toBeCloseTo(-2550, 2);
  });
});

describe('dynamic fill templates', () => {
  const envelopes = [
    { id: 'food', name: 'Food', category: 'Needs' },
    { id: 'rent', name: 'Rent', category: 'Needs' },
  ];

  describe('annualByEnvelope', () => {
    it('sums multiple items under the same envelope', () => {
      const items = [
        { id: 'a', envelope_id: 'food', kind: 'expense', default_amount: 50,
          monthly_schedule: { Jan: true, Feb: true }, extra_buffer: 0, include: true },
        { id: 'b', envelope_id: 'food', kind: 'expense', default_amount: 20,
          monthly_schedule: { Jan: true }, extra_buffer: 100, include: true },
      ];
      const map = annualByEnvelope(items);
      // a: 50+50 = 100; b: 20 + 100 buffer = 120; total 220
      expect(map.get('food')).toBe(220);
    });

    it('skips include=false and income items', () => {
      const items = [
        { id: 'a', envelope_id: 'food', kind: 'expense', default_amount: 50,
          monthly_schedule: { Jan: true }, extra_buffer: 0, include: false },
        { id: 'b', envelope_id: 'food', kind: 'income', default_amount: 999,
          monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
        { id: 'c', envelope_id: 'food', kind: 'expense', default_amount: 10,
          monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
      ];
      expect(annualByEnvelope(items).get('food')).toBe(10);
    });

    it('skips items without envelope_id', () => {
      const items = [
        { id: 'a', envelope_id: null, kind: 'expense', default_amount: 50,
          monthly_schedule: { Jan: true }, extra_buffer: 0, include: true },
      ];
      expect(annualByEnvelope(items).size).toBe(0);
    });
  });

  describe('computeDynamicTemplateLines', () => {
    const items = [
      // food: 12 × 60 = 720 annual
      { id: 'a', envelope_id: 'food', kind: 'expense', default_amount: 60,
        monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                            Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
        extra_buffer: 0, include: true },
      // rent: 12 × 120 = 1440 annual
      { id: 'b', envelope_id: 'rent', kind: 'expense', default_amount: 120,
        monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                            Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
        extra_buffer: 0, include: true },
    ];

    it('returns [] for manual templates', () => {
      const tpl = { id: 't', kind: 'manual', lines: [{ envelope_id: 'food', amount: 10, mode: 'add' }] };
      expect(computeDynamicTemplateLines(tpl, items)).toEqual([]);
    });

    it('computes monthly = annual / 12 × percent for each assignment', () => {
      const tpl = { id: 't', kind: 'dynamic', assignments: [
        { envelope_id: 'food', mode: 'add', percent: 100 },
        { envelope_id: 'rent', mode: 'set', percent: 50 },
      ]};
      const lines = computeDynamicTemplateLines(tpl, items);
      expect(lines).toEqual([
        { envelope_id: 'food', mode: 'add', amount: 60 },   // 720/12 × 1.0
        { envelope_id: 'rent', mode: 'set', amount: 60 },   // 1440/12 × 0.5
      ]);
    });

    it('skips assignments whose envelope has zero annual planned', () => {
      const tpl = { id: 't', kind: 'dynamic', assignments: [
        { envelope_id: 'missing', mode: 'add', percent: 100 },
        { envelope_id: 'food', mode: 'add', percent: 100 },
      ]};
      const lines = computeDynamicTemplateLines(tpl, items);
      expect(lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: 60 }]);
    });

    it('defaults percent to 100 when missing', () => {
      const tpl = { id: 't', kind: 'dynamic', assignments: [
        { envelope_id: 'food', mode: 'add' },
      ]};
      expect(computeDynamicTemplateLines(tpl, items)[0].amount).toBe(60);
    });

    // Regression: extra_buffer is a one-off balance FLOOR, not recurring spend.
    // Including it in the fill base overfunded the envelope by buffer/12 every
    // single month, and double-counted against calcDepositAndRequired, which
    // already adds the buffer to the required reserve separately.
    it('excludes extra_buffer from the fill amount', () => {
      const buffered = [
        { id: 'c', envelope_id: 'food', kind: 'expense', default_amount: 60,
          monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                              Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
          extra_buffer: 354.40, include: true },
      ];
      const tpl = { id: 't', kind: 'dynamic', assignments: [
        { envelope_id: 'food', mode: 'add', percent: 100 },
      ]};
      // 720/12 = 60 — NOT (720 + 354.40)/12 = 89.53
      expect(computeDynamicTemplateLines(tpl, buffered)[0].amount).toBe(60);
    });

    it('scales a buffered envelope by percent without leaking the buffer', () => {
      const buffered = [
        { id: 'd', envelope_id: 'rent', kind: 'expense', default_amount: 120,
          monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                              Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
          extra_buffer: 1200, include: true },
      ];
      const tpl = { id: 't', kind: 'dynamic', assignments: [
        { envelope_id: 'rent', mode: 'add', percent: 50 },
      ]};
      expect(computeDynamicTemplateLines(tpl, buffered)[0].amount).toBe(60);
    });

    it('resolveTemplateLines dispatches on kind', () => {
      const manual = { id: 'm', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'add', amount: 7 }] };
      expect(resolveTemplateLines(manual, items)).toEqual(manual.lines);
      const dyn = { id: 'd', kind: 'dynamic', assignments: [{ envelope_id: 'food', mode: 'add', percent: 100 }] };
      expect(resolveTemplateLines(dyn, items)[0].amount).toBe(60);
    });
  });

  describe('materializeDueTemplateFills with dynamic template', () => {
    function buildItems(foodDefault) {
      return [
        { id: 'salary', kind: 'income', envelope_id: null,
          as_schedule: true, account_id: 'bank', payment_day: 15,
          default_amount: 2000,
          monthly_schedule: { Jan: true },
          include: true, as_schedule_since: '2026-01-01',
          template_id: 'dyn1', description: 'Salary' },
        { id: 'groceries', envelope_id: 'food', kind: 'expense',
          default_amount: foodDefault,
          monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
                              Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
          extra_buffer: 0, include: true },
      ];
    }

    it('fill lines are recomputed from the current budget at generation time', () => {
      // The template's own schedule drives this now, not an income occurrence.
      // What matters is unchanged: a dynamic template snapshots whatever the
      // budget says at the moment the fill is generated, so an envelope whose
      // plan grew gets the larger share on the next run without anyone
      // editing the template.
      const templates = [{
        id: 'dyn1', name: 'Auto', kind: 'dynamic',
        assignments: [{ envelope_id: 'food', mode: 'add', percent: 100 }],
        schedule: {
          enabled: true, payment_day: 15,
          months: { Jan: true }, since: '2026-01-01',
        },
      }];
      const today = new Date('2026-01-20T12:00:00');

      // Run 1: food monthly 100 → annual 1200, monthly share 100.
      let n = 0;
      const r1 = materializeDueTemplateFills(
        templates, buildItems(100), envelopes, [], today, () => `t${++n}`,
      );
      const fill1 = r1.newTxs.find(t => t.type === 'fill');
      expect(fill1).toBeTruthy();
      expect(fill1.lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: 100 }]);
      expect(fill1.template_id).toBe('dyn1');

      // Run 2 (clean state): food monthly 250 → annual 3000, monthly share 250.
      let n2 = 0;
      const r2 = materializeDueTemplateFills(
        templates, buildItems(250), envelopes, [], today, () => `u${++n2}`,
      );
      const fill2 = r2.newTxs.find(t => t.type === 'fill');
      expect(fill2.lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: 250 }]);
    });
  });
});

describe('computeEnvelopeBalances chronological iteration', () => {
  it('applies a later-array set-mode fill at the right point in time so an earlier-array future expense is not wiped out', () => {
    // Reproduces a real-world bug: a future-dated expense was entered
    // first, then a later onboarding/reset "set" fill landed earlier in
    // calendar time. Array-order iteration would let the set wipe the
    // future expense; date-order iteration preserves it.
    const txs = [
      { id: 'futureExpense', type: 'expense', date: '2026-05-25', envelope_id: 'home', amount: 2300 },
      { id: 'setFill',       type: 'fill',    date: '2026-04-30',
        lines: [{ envelope_id: 'home', mode: 'set', amount: 500 }] },
      { id: 'topUp',         type: 'fill',    date: '2026-05-01',
        lines: [{ envelope_id: 'home', mode: 'add', amount: 1800 }] },
    ];
    const bal = computeEnvelopeBalances(txs);
    expect(bal.get('home')).toBe(0);
  });

  it('agrees with computeEnvelopeRunningBalances on the final balance', () => {
    const txs = [
      { id: 'futureExpense', type: 'expense', date: '2026-05-25', envelope_id: 'home', amount: 2300 },
      { id: 'setFill',       type: 'fill',    date: '2026-04-30',
        lines: [{ envelope_id: 'home', mode: 'set', amount: 500 }] },
      { id: 'topUp',         type: 'fill',    date: '2026-05-01',
        lines: [{ envelope_id: 'home', mode: 'add', amount: 1800 }] },
    ];
    const running = computeEnvelopeRunningBalances(txs, 'home');
    const lastTxId = 'futureExpense';
    expect(running.get(lastTxId)).toBe(computeEnvelopeBalances(txs).get('home'));
  });
});

describe('computeEnvelopeRunningBalances', () => {
  it('returns empty map when no envelopeId given', () => {
    expect(computeEnvelopeRunningBalances([{ id: 'a', type: 'expense', envelope_id: 'food', amount: 5, date: '2024-01-01' }], null).size).toBe(0);
  });

  it('walks transactions chronologically and emits cumulative balance per touching tx', () => {
    const txs = [
      { id: 'fill1', type: 'fill', date: '2024-01-01', lines: [{ envelope_id: 'food', mode: 'set', amount: 100 }] },
      { id: 'exp1',  type: 'expense', date: '2024-01-05', envelope_id: 'food', amount: 30 },
      { id: 'exp2',  type: 'expense', date: '2024-01-10', envelope_id: 'rent', amount: 500 },
      { id: 'inc1',  type: 'income',  date: '2024-01-15', envelope_id: 'food', amount: 20 },
    ];
    const m = computeEnvelopeRunningBalances(txs, 'food');
    expect(m.get('fill1')).toBe(100);
    expect(m.get('exp1')).toBe(70);
    expect(m.has('exp2')).toBe(false); // doesn't touch food
    expect(m.get('inc1')).toBe(90);
  });

  it('handles envelope_transfer in both directions', () => {
    const txs = [
      { id: 'a', type: 'fill', date: '2024-01-01', lines: [{ envelope_id: 'food', mode: 'set', amount: 50 }] },
      { id: 'b', type: 'envelope_transfer', date: '2024-01-02', from_envelope_id: 'food', to_envelope_id: 'rent', amount: 10 },
      { id: 'c', type: 'envelope_transfer', date: '2024-01-03', from_envelope_id: 'rent', to_envelope_id: 'food', amount: 5 },
    ];
    const m = computeEnvelopeRunningBalances(txs, 'food');
    expect(m.get('b')).toBe(40);
    expect(m.get('c')).toBe(45);
  });

  it('handles expense splits affecting the envelope', () => {
    const txs = [
      { id: 'fill', type: 'fill', date: '2024-01-01', lines: [{ envelope_id: 'food', mode: 'set', amount: 100 }] },
      { id: 'split', type: 'expense', date: '2024-01-02', envelope_splits: [
        { envelope_id: 'food', amount: 25 },
        { envelope_id: 'rent', amount: 75 },
      ]},
    ];
    const m = computeEnvelopeRunningBalances(txs, 'food');
    expect(m.get('split')).toBe(75);
  });

  it('uses original-array index as tiebreaker on shared dates', () => {
    const txs = [
      { id: 'a', type: 'fill', date: '2024-01-01', lines: [{ envelope_id: 'food', mode: 'set', amount: 50 }] },
      { id: 'b', type: 'expense', date: '2024-01-05', envelope_id: 'food', amount: 10 },
      { id: 'c', type: 'expense', date: '2024-01-05', envelope_id: 'food', amount: 5 },
    ];
    const m = computeEnvelopeRunningBalances(txs, 'food');
    expect(m.get('b')).toBe(40);
    expect(m.get('c')).toBe(35);
  });
});

describe('computeAccountRunningBalances', () => {
  const accounts = [{ id: 'cash', initialBalance: 100 }];

  it('returns empty map when no accountId given', () => {
    expect(computeAccountRunningBalances(accounts, [{ id: 'a', type: 'expense', account: 'cash', amount: 5, date: '2024-01-01' }], null).size).toBe(0);
  });

  it('seeds from initialBalance and walks chronologically', () => {
    const txs = [
      { id: 'exp1', type: 'expense', date: '2024-01-05', account: 'cash', amount: 30 },
      { id: 'inc1', type: 'income',  date: '2024-01-10', account: 'cash', amount: 20 },
      { id: 'exp2', type: 'expense', date: '2024-01-15', account: 'other', amount: 99 },
    ];
    const m = computeAccountRunningBalances(accounts, txs, 'cash');
    expect(m.get('exp1')).toBe(70);
    expect(m.get('inc1')).toBe(90);
    expect(m.has('exp2')).toBe(false);
  });

  it('handles account_transfer in both directions', () => {
    const accs = [{ id: 'a', initialBalance: 100 }, { id: 'b', initialBalance: 0 }];
    const txs = [
      { id: 't1', type: 'account_transfer', date: '2024-01-01', from_account: 'a', to_account: 'b', amount: 30 },
      { id: 't2', type: 'account_transfer', date: '2024-01-02', from_account: 'b', to_account: 'a', amount: 5 },
    ];
    expect(computeAccountRunningBalances(accs, txs, 'a').get('t1')).toBe(70);
    expect(computeAccountRunningBalances(accs, txs, 'a').get('t2')).toBe(75);
    expect(computeAccountRunningBalances(accs, txs, 'b').get('t1')).toBe(30);
    expect(computeAccountRunningBalances(accs, txs, 'b').get('t2')).toBe(25);
  });

  it('uses original-array index as tiebreaker on shared dates', () => {
    const txs = [
      { id: 'a', type: 'expense', date: '2024-01-05', account: 'cash', amount: 10 },
      { id: 'b', type: 'expense', date: '2024-01-05', account: 'cash', amount: 5 },
    ];
    const m = computeAccountRunningBalances(accounts, txs, 'cash');
    expect(m.get('a')).toBe(90);
    expect(m.get('b')).toBe(85);
  });

  it('walks the full input regardless of date filter (caller does the filtering)', () => {
    // Even if a date filter is applied to the displayed rows, the running
    // balance should reflect cumulative state from the start. The function
    // walks every tx it is handed.
    const txs = [
      { id: 'old', type: 'expense', date: '2023-12-01', account: 'cash', amount: 10 },
      { id: 'new', type: 'expense', date: '2024-01-15', account: 'cash', amount: 20 },
    ];
    const m = computeAccountRunningBalances(accounts, txs, 'cash');
    expect(m.get('old')).toBe(90);
    expect(m.get('new')).toBe(70);
  });
});

describe('computeEmergencyFundRequirement', () => {
  const monthlySched = (amt) => ({
    Jan: amt, Feb: amt, Mar: amt, Apr: amt, May: amt, Jun: amt,
    Jul: amt, Aug: amt, Sep: amt, Oct: amt, Nov: amt, Dec: amt,
  });

  it('returns null when no emergency envelope is configured', () => {
    expect(computeEmergencyFundRequirement({
      envelopes: [], budgetItems: [], transactions: [],
      month: '2024-06', meta: {},
    })).toBeNull();
  });

  it('formula: max(0, monthly × duration − sumOtherBalance) + buffer', () => {
    // Two essential items: rent (food envelope), groceries (food envelope).
    // No other envelopes hold credit toward essentials, no buffer.
    const envelopes = [{ id: 'ef', name: 'Emergency', category: 'saving' }];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 600, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
      {
        id: 'b2', envelope_id: 'ef',
        description: 'Groceries', default_amount: 400, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions: [],
      month: '2024-06',
      meta: { emergency_envelope_id: 'ef', emergency_duration_months: 6 },
    });
    expect(calc.monthlyEssentials).toBe(1000);
    expect(calc.duration).toBe(6);
    expect(calc.subtotal).toBe(6000);
    expect(calc.buffer).toBe(0);
    expect(calc.required).toBeGreaterThanOrEqual(0);
    expect(calc.items).toHaveLength(2);
    expect(calc.items[0].monthlyAmount).toBe(600);
    expect(calc.items[1].monthlyAmount).toBe(400);
  });

  it('caps the credit so required never goes below zero', () => {
    // Tiny essentials, huge balance in another eligible envelope → credit
    // exceeds subtotal. required collapses to 0 + buffer.
    const envelopes = [
      { id: 'ef', name: 'Emergency', category: 'saving' },
      { id: 'food', name: 'Food', category: 'food' },
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'food',
        description: 'Rent', default_amount: 100, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    // Stuff 50,000 into food (massive credit toward the 600 target)
    const transactions = [
      { id: 't1', type: 'fill', date: '2024-01-01',
        lines: [{ envelope_id: 'food', mode: 'set', amount: 50000 }] },
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions,
      month: '2024-06',
      meta: { emergency_envelope_id: 'ef', emergency_duration_months: 6 },
    });
    expect(calc.subtotal).toBe(600);
    expect(calc.required).toBe(0);
  });

  it('adds the emergency envelope buffer on top of net needed', () => {
    const envelopes = [{ id: 'ef', name: 'Emergency', category: 'saving' }];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 100, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 250,
      },
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions: [],
      month: '2024-06',
      meta: { emergency_envelope_id: 'ef', emergency_duration_months: 3 },
    });
    expect(calc.buffer).toBe(250);
    // monthly essentials (100) × 3 + buffer (250). Food projected goes against
    // the same envelope (ef) so it doesn't count toward credit.
    expect(calc.subtotal).toBe(300);
    // No "other" eligible envelope, so contributors stays empty.
    expect(calc.contributors).toHaveLength(0);
    expect(calc.required).toBe(300 + 250);
  });

  it('"all" mode includes envelopes without include_in_emergency_budget', () => {
    // Essentials live on the emergency envelope. Two unrelated envelopes hold
    // money. In "flagged" mode they don't count; in "all" they do.
    const envelopes = [
      { id: 'ef',    name: 'Emergency', category: 'saving' },
      { id: 'food',  name: 'Food',      category: 'food'   },
      { id: 'travel',name: 'Travel',    category: 'leisure'},
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 1000, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [
          { envelope_id: 'food',   mode: 'set', amount: 100 },
          { envelope_id: 'travel', mode: 'set', amount: 50  },
        ]},
    ];
    const baseMeta = { emergency_envelope_id: 'ef', emergency_duration_months: 6 };
    const flagged = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: { ...baseMeta, emergency_credit_source: 'flagged' },
    });
    const all = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: { ...baseMeta, emergency_credit_source: 'all' },
    });
    expect(flagged.creditMode).toBe('flagged');
    expect(flagged.sumOtherBalance).toBe(0);
    expect(flagged.contributors).toHaveLength(0);
    expect(all.creditMode).toBe('all');
    expect(all.sumOtherBalance).toBe(150);
    expect(all.contributors.map(c => c.envelope_id).sort()).toEqual(['food', 'travel']);
    // The required figure must drop by exactly the credit difference.
    expect(flagged.required - all.required).toBe(150);
  });

  it('clamps negative projected balances per envelope (does not reduce credit)', () => {
    // Two unrelated envelopes: one with +100 projected, one over-spent (-40).
    // The negative envelope must contribute 0, not -40.
    const envelopes = [
      { id: 'ef',    name: 'Emergency', category: 'saving' },
      { id: 'food',  name: 'Food',      category: 'food'   },
      { id: 'travel',name: 'Travel',    category: 'leisure'},
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 1000, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [
          { envelope_id: 'food',   mode: 'set', amount: 100 },
          { envelope_id: 'travel', mode: 'set', amount: 0   },
        ]},
      // Travel goes negative via an over-spent expense
      { id: 'e1', type: 'expense', date: '2024-01-15',
        envelope_id: 'travel', amount: 40 },
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: {
        emergency_envelope_id: 'ef', emergency_duration_months: 6,
        emergency_credit_source: 'all',
      },
    });
    expect(calc.sumOtherBalance).toBe(100);
    const travel = calc.contributors.find(c => c.envelope_id === 'travel');
    expect(travel).toBeDefined();
    expect(travel.clamped).toBe(true);
    expect(travel.contribution).toBe(0);
    expect(travel.balance).toBeLessThan(0);
  });

  it('excludes the emergency envelope itself in "all" mode', () => {
    const envelopes = [
      { id: 'ef',   name: 'Emergency', category: 'saving' },
      { id: 'food', name: 'Food',      category: 'food'   },
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 100, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [
          { envelope_id: 'ef',   mode: 'set', amount: 9999 },
          { envelope_id: 'food', mode: 'set', amount: 100  },
        ]},
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: {
        emergency_envelope_id: 'ef', emergency_duration_months: 6,
        emergency_credit_source: 'all',
      },
    });
    expect(calc.contributors.find(c => c.envelope_id === 'ef')).toBeUndefined();
    expect(calc.sumOtherBalance).toBe(100);
  });

  it('defaults to "flagged" when meta.emergency_credit_source is absent', () => {
    const envelopes = [
      { id: 'ef',   name: 'Emergency', category: 'saving' },
      { id: 'food', name: 'Food',      category: 'food'   },
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 100, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [{ envelope_id: 'food', mode: 'set', amount: 200 }]},
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: { emergency_envelope_id: 'ef', emergency_duration_months: 6 }, // no credit-source
    });
    expect(calc.creditMode).toBe('flagged');
    expect(calc.sumOtherBalance).toBe(0);
  });

  it('excludes archived envelopes from credit in both modes', () => {
    const envelopes = [
      { id: 'ef',     name: 'Emergency', category: 'saving' },
      { id: 'food',   name: 'Food',      category: 'food'   },
      { id: 'travel', name: 'Travel',    category: 'leisure', archived: true },
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 1000, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [
          { envelope_id: 'food',   mode: 'set', amount: 100 },
          { envelope_id: 'travel', mode: 'set', amount: 999 }, // archived — must not count
        ]},
    ];
    const calcAll = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: {
        emergency_envelope_id: 'ef', emergency_duration_months: 6,
        emergency_credit_source: 'all',
      },
    });
    expect(calcAll.contributors.find(c => c.envelope_id === 'travel')).toBeUndefined();
    expect(calcAll.sumOtherBalance).toBe(100);
  });

  it('excludes deleted envelopes (no envelope object exists)', () => {
    // 'ghost' envelope id appears on a transaction but isn't in envelopes[].
    const envelopes = [
      { id: 'ef',   name: 'Emergency', category: 'saving' },
      { id: 'food', name: 'Food',      category: 'food'   },
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 1000, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [
          { envelope_id: 'food',  mode: 'set', amount: 100 },
          { envelope_id: 'ghost', mode: 'set', amount: 500 }, // deleted envelope
        ]},
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: {
        emergency_envelope_id: 'ef', emergency_duration_months: 6,
        emergency_credit_source: 'all',
      },
    });
    expect(calc.contributors.find(c => c.envelope_id === 'ghost')).toBeUndefined();
    expect(calc.sumOtherBalance).toBe(100);
  });

  it('does not flag a projected balance that rounds to €0 as negative', () => {
    const envelopes = [
      { id: 'ef',   name: 'Emergency', category: 'saving' },
      { id: 'tiny', name: 'Tiny',      category: 'food'   },
    ];
    const budgetItems = [
      {
        id: 'b1', envelope_id: 'ef',
        description: 'Rent', default_amount: 1000, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    // Set Tiny to a tiny negative that rounds to €0,00 (half-cent tolerance).
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-01-01',
        lines: [{ envelope_id: 'tiny', mode: 'set', amount: -0.001 }]},
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: {
        emergency_envelope_id: 'ef', emergency_duration_months: 6,
        emergency_credit_source: 'all',
      },
    });
    const tiny = calc.contributors.find(c => c.envelope_id === 'tiny');
    expect(tiny).toBeDefined();
    expect(tiny.clamped).toBe(false);
  });

  it('credits the current envelope balance, ignoring this month\'s planned spending', () => {
    // Regression: previously the credit used the post-month projected
    // balance, so an envelope with €800 today and €800 planned to be spent
    // this month showed up as €0 covered. The full €800 should count —
    // in an emergency the planned spending can be paused.
    const envelopes = [
      { id: 'ef',        name: 'Emergency', category: 'saving' },
      { id: 'groceries', name: 'Groceries', category: 'food'   },
    ];
    const budgetItems = [
      {
        id: 'b-rent', envelope_id: 'ef',
        description: 'Rent', default_amount: 1000, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
      {
        id: 'b-grocer', envelope_id: 'groceries',
        description: 'Groceries', default_amount: 800, monthly_schedule: monthlySched(true),
        include: true, include_in_emergency_budget: true, extra_buffer: 0,
      },
    ];
    // Groceries currently holds €800. No spending yet this month.
    const transactions = [
      { id: 'f1', type: 'fill', date: '2024-06-01',
        lines: [{ envelope_id: 'groceries', mode: 'set', amount: 800 }] },
    ];
    const calc = computeEmergencyFundRequirement({
      envelopes, budgetItems, transactions, month: '2024-06',
      meta: { emergency_envelope_id: 'ef', emergency_duration_months: 6 },
    });
    const groceries = calc.contributors.find(c => c.envelope_id === 'groceries');
    expect(groceries).toBeDefined();
    expect(groceries.balance).toBe(800);
    expect(groceries.contribution).toBe(800);
    expect(calc.sumOtherBalance).toBe(800);
  });
});

describe('computeEnvelopeUpcomingDeltas', () => {
  const envs = [{ id: 'ins', name: 'Insurance', category: 'Finance' }];
  const accts = [{ id: 'bank', name: 'Bank', initialBalance: 1000 }];

  it('counts a scheduled forecast within the current month against the envelope', () => {
    // Today = May 13. Budget item bills €11.21 on the 15th of every month.
    // No real future tx. Forecast for May 15 should appear in the delta.
    const items = [{
      id: 'aig', kind: 'expense', envelope_id: 'ins',
      account_id: 'bank', include: true, as_schedule: true,
      payment_day: 15, default_amount: -11.21,
      monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
        Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
      as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-05-13T12:00:00');
    const deltas = computeEnvelopeUpcomingDeltas([], items, accts, envs, today, 'FI');
    expect(deltas.get('ins')).toBeCloseTo(-11.21, 2);
  });

  it('caps forecast horizon at end of current month — a June occurrence is excluded', () => {
    // Today = May 13. Item bills on the 10th of June only — outside May.
    const items = [{
      id: 'tap', kind: 'expense', envelope_id: 'ins',
      account_id: 'bank', include: true, as_schedule: true,
      payment_day: 10, default_amount: -128.72,
      monthly_schedule: { Jun: true },
      as_schedule_since: '2026-01-01',
    }];
    const today = new Date('2026-05-13T12:00:00');
    const deltas = computeEnvelopeUpcomingDeltas([], items, accts, envs, today, 'FI');
    expect(deltas.has('ins')).toBe(false);
  });

  it('adds all future-dated real tx (any date) on top of EOM forecasts', () => {
    // Today = May 13. May 15 forecast -€11.21 + a real Jul 1 future tx -€200.
    // Both should appear in the delta even though Jul is past the forecast cap.
    const items = [{
      id: 'aig', kind: 'expense', envelope_id: 'ins',
      account_id: 'bank', include: true, as_schedule: true,
      payment_day: 15, default_amount: -11.21,
      monthly_schedule: { May: true },
      as_schedule_since: '2026-01-01',
    }];
    const realFuture = [{
      id: 'r1', type: 'expense', date: '2026-07-01',
      envelope_id: 'ins', account: 'bank', amount: 200, status: 'posted',
    }];
    const today = new Date('2026-05-13T12:00:00');
    const deltas = computeEnvelopeUpcomingDeltas(realFuture, items, accts, envs, today, 'FI');
    expect(deltas.get('ins')).toBeCloseTo(-211.21, 2);
  });

  it('dedups forecasts whose budget-item occurrence is already posted as a real tx', () => {
    // Today = May 13. May 15 forecast would normally appear, but a real tx
    // already exists tagged `from_budget: aig:2026-05` — drop the forecast.
    const items = [{
      id: 'aig', kind: 'expense', envelope_id: 'ins',
      account_id: 'bank', include: true, as_schedule: true,
      payment_day: 15, default_amount: -11.21,
      monthly_schedule: { May: true },
      as_schedule_since: '2026-01-01',
    }];
    const txs = [{
      id: 'r1', type: 'expense', date: '2026-05-15',
      envelope_id: 'ins', account: 'bank', amount: 11.21, status: 'posted',
      from_budget: 'aig:2026-05',
    }];
    const today = new Date('2026-05-13T12:00:00');
    const deltas = computeEnvelopeUpcomingDeltas(txs, items, accts, envs, today, 'FI');
    // The real May 15 tx is future-dated, so its delta IS counted, but the
    // forecast must not double-count it.
    expect(deltas.get('ins')).toBeCloseTo(-11.21, 2);
  });
});

describe('investment_transfer transactions', () => {
  const accounts = [
    { id: 'bank',   name: 'Bank',   type: 'bank',       initialBalance: 1000 },
    { id: 'broker', name: 'Broker', type: 'investment', initialBalance: 0 },
  ];
  const tx = {
    type: 'investment_transfer',
    date: '2026-04-15',
    amount: 250,
    from_account: 'bank',
    to_account: 'broker',
    envelope_id: 'investing',
  };

  it('debits the source envelope like an expense from that envelope', () => {
    const bal = computeEnvelopeBalances([tx]);
    expect(bal.get('investing')).toBe(-250);
  });

  it('debits source account and credits investment account', () => {
    const bal = computeAccountBalances(accounts, [tx]);
    expect(bal.get('bank')).toBe(750);
    expect(bal.get('broker')).toBe(250);
  });

  // §2.1 — these two used to assert the BUY leg was excluded from the reports,
  // which is exactly the four-way inconsistency the remediation closes. The
  // envelopes meter and the monthly review have always counted an investment
  // buy as spend from the envelope it is charged to (txEnvelopeSpend,
  // balances.js:296), and the test directly above asserts the same thing about
  // the balance: `computeEnvelopeBalances([tx])` is -250. The reports now agree
  // with both. On the owner's budget this is 74 rows across 21 months.
  // Owner decision 2026-09-23 (ux-review U5): savings and investments are not
  // spending. The buy still spends its envelope (txSpendPairs, the envelope
  // meters), but the Spending totals leave it out and Saving carries it.
  it('leaves the buy leg out of spending by envelope', () => {
    const expense = { type: 'expense', envelope_id: 'food', account: 'bank',
                      date: '2026-04-15', amount: 50 };
    const byEnv = aggregateSpendingByEnvelope([tx, expense],
      [{ id: 'food', name: 'Food', category: 'Living' },
       { id: 'investing', name: 'Investing', category: 'Savings' }]);
    expect(byEnv.find(r => r.key === 'investing')).toBeUndefined();
    expect(byEnv.find(r => r.key === 'food').value).toBe(50);
  });

  it('leaves the buy leg out of monthly spending totals', () => {
    const expense = { type: 'expense', envelope_id: 'food', account: 'bank',
                      date: '2026-04-15', amount: 50 };
    const byMonth = aggregateSpendingByMonth([tx, expense]);
    expect(byMonth[0].value).toBe(50); // and it MATCHES byEnvelope
  });

  it('reports a buy funded from the bank as saving and not as spending', () => {
    const { series } = aggregateIncomeVsSpending([tx], accounts);
    const val = (name) => series.find(x => x.name === name).points[0].value;
    expect(val('Spending')).toBe(0);
    expect(val('Saving')).toBe(250);
  });

  it('still counts the buy leg as spend from its envelope for the meters', () => {
    expect(txSpendPairs(tx)).toEqual([['investing', 250]]);
    expect(txConsumptionPairs(tx)).toEqual([]);
  });

  it('does not count the sell or dividend leg', () => {
    // txEnvelopeSpend's set is closed: sells and dividends return money to the
    // envelope, so counting them as spend would be the same category error as
    // counting a fill.
    const sell = { ...tx, direction: 'sell', from_account: 'broker', to_account: 'bank' };
    const div  = { ...tx, direction: 'dividend', from_account: 'broker', to_account: 'bank' };
    expect(aggregateSpendingByMonth([sell, div])).toEqual([]);
  });

  it('keeps unallocated stable when accounts include investment account', () => {
    const before = computeUnallocated(
      computeAccountBalances(accounts, []),
      computeEnvelopeBalances([
        { type: 'income', amount: 250, account: 'bank', envelope_id: 'investing', date: '2026-04-01' },
      ]),
      accounts,
    );
    const after = computeUnallocated(
      computeAccountBalances(accounts, [tx]),
      computeEnvelopeBalances([
        { type: 'income', amount: 250, account: 'bank', envelope_id: 'investing', date: '2026-04-01' },
        tx,
      ]),
      accounts,
    );
    expect(after).toBeCloseTo(before, 2);
  });

  it('adjustment on investment account updates its balance only', () => {
    const adj = { type: 'adjustment', target: 'account', target_id: 'broker',
                  amount: 35, date: '2026-04-30' };
    const bal = computeAccountBalances(accounts, [tx, adj]);
    expect(bal.get('broker')).toBe(285);
    expect(bal.get('bank')).toBe(750);
    const env = computeEnvelopeBalances([tx, adj]);
    expect(env.get('investing')).toBe(-250);
  });

  it('contributes to envelope running balance', () => {
    const txs = [
      { id: 'i1', type: 'income', amount: 500, account: 'bank',
        envelope_id: 'investing', date: '2026-04-01' },
      { ...tx, id: 'i2' },
    ];
    const running = computeEnvelopeRunningBalances(txs, 'investing');
    expect(running.get('i1')).toBe(500);
    expect(running.get('i2')).toBe(250);
  });

  it('buy with fee: both accounts move by full cash amount, fee absorbed by envelope', () => {
    const buy = { ...tx, fee: 1, direction: 'buy' };
    const acct = computeAccountBalances(accounts, [buy]);
    expect(acct.get('bank')).toBe(750);          // -250
    expect(acct.get('broker')).toBe(250);        // +250 (full cash, fee not subtracted)
    const env = computeEnvelopeBalances([buy]);
    expect(env.get('investing')).toBe(-250);     // envelope absorbs the fee via `amount`
  });

  it('sell with fee: both accounts move by net cash amount, envelope credited', () => {
    const sell = {
      type: 'investment_transfer',
      date: '2026-04-20',
      amount: 200,
      fee: 2,
      direction: 'sell',
      from_account: 'broker',
      to_account: 'bank',
      envelope_id: 'investing',
    };
    const seedAccounts = [
      { id: 'bank',   name: 'Bank',   type: 'bank',       initialBalance: 0 },
      { id: 'broker', name: 'Broker', type: 'investment', initialBalance: 500 },
    ];
    const acct = computeAccountBalances(seedAccounts, [sell]);
    expect(acct.get('broker')).toBe(300);   // 500 - 200 (fee not added back)
    expect(acct.get('bank')).toBe(200);     // 0 + 200
    const env = computeEnvelopeBalances([sell]);
    expect(env.get('investing')).toBe(200); // sell credits the envelope
  });

  it('round-trip buy then sell at unchanged price leaves fee residual on investment account', () => {
    const buy = {
      type: 'investment_transfer', date: '2026-04-01', amount: 100, fee: 1,
      direction: 'buy', from_account: 'bank', to_account: 'broker', envelope_id: 'investing',
    };
    const sell = {
      type: 'investment_transfer', date: '2026-04-10', amount: 98, fee: 1,
      direction: 'sell', from_account: 'broker', to_account: 'bank', envelope_id: 'investing',
    };
    const acct = computeAccountBalances(accounts, [buy, sell]);
    // Bank: 1000 - 100 + 98 = 998 (lost 2 to fees)
    expect(acct.get('bank')).toBe(998);
    // Broker: 0 + 100 - 98 = 2 (residual = total fees paid through this account)
    expect(acct.get('broker')).toBe(2);
    const env = computeEnvelopeBalances([buy, sell]);
    // Envelope: -100 + 98 = -2 (reflects total fees deducted from budget)
    expect(env.get('investing')).toBe(-2);
  });

  it('missing direction defaults to buy (legacy compatibility)', () => {
    // No `direction` field — old rows from before this change.
    const legacy = { ...tx };
    delete legacy.direction;
    const acct = computeAccountBalances(accounts, [legacy]);
    expect(acct.get('bank')).toBe(750);
    expect(acct.get('broker')).toBe(250);
    const env = computeEnvelopeBalances([legacy]);
    expect(env.get('investing')).toBe(-250);
  });

  it('malformed fee is treated as zero', () => {
    const txs = [
      { ...tx, fee: 'bogus' },
      { ...tx, fee: null },
      { ...tx, fee: NaN },
      { ...tx, fee: undefined },
    ];
    for (const x of txs) {
      const acct = computeAccountBalances(accounts, [x]);
      expect(acct.get('broker')).toBe(250);
    }
  });

  it('sell direction in computeEnvelopeRunningBalances credits the envelope', () => {
    const txs = [
      { id: 'b', type: 'investment_transfer', date: '2026-04-01', amount: 100,
        direction: 'buy', from_account: 'bank', to_account: 'broker', envelope_id: 'investing' },
      { id: 's', type: 'investment_transfer', date: '2026-04-10', amount: 60,
        direction: 'sell', from_account: 'broker', to_account: 'bank', envelope_id: 'investing' },
    ];
    const running = computeEnvelopeRunningBalances(txs, 'investing');
    expect(running.get('b')).toBe(-100);
    expect(running.get('s')).toBe(-40); // -100 + 60
  });
});

describe('computeAnnualInterest', () => {
  it.each([[9999.99, 100], [10000, 200], [10000.01, 200], [20000, 600]])(
    'uses an exclusive cap for the full balance %s', (balance, expected) => {
      expect(computeAnnualInterest(balance, [{ upTo: 10000, rate: 1 }, { upTo: 20000, rate: 2 }, { rate: 3 }], 'full-balance')).toBe(expected);
    });

  it('supports decreasing and zero full-balance rates and a finite final cap', () => {
    expect(computeAnnualInterest(15000, [{ upTo: 10000, rate: 3 }, { rate: 1 }], 'full-balance')).toBe(150);
    expect(computeAnnualInterest(10000, [{ upTo: 10000, rate: 3 }, { rate: 0 }], 'full-balance')).toBe(0);
    expect(computeAnnualInterest(10000, [{ upTo: 10000, rate: 3 }], 'full-balance')).toBe(0);
    expect(computeAnnualInterest(-1, [{ rate: 3 }], 'full-balance')).toBe(0);
    expect(computeAnnualInterest(15000, [{ upTo: 10000, rate: 1 }, { rate: 2 }], 'progressive')).toBe(200);
  });

  it('flat single-tier rate', () => {
    expect(computeAnnualInterest(1000, [{ rate: 2 }])).toBe(20);
  });

  it('staggered tiers split the balance correctly', () => {
    // 1% on first 5000, 2% on next 5000, 0.5% above
    const tiers = [
      { upTo: 5000, rate: 1 },
      { upTo: 10000, rate: 2 },
      { rate: 0.5 },
    ];
    // €15000: 5000*1% + 5000*2% + 5000*0.5% = 50 + 100 + 25 = 175
    expect(computeAnnualInterest(15000, tiers)).toBe(175);
    // €3000 falls entirely into the first tier: 30
    expect(computeAnnualInterest(3000, tiers)).toBe(30);
    // €7500 splits: 5000*1% + 2500*2% = 50 + 50 = 100
    expect(computeAnnualInterest(7500, tiers)).toBe(100);
  });

  it('returns 0 when tiers are empty or balance is non-positive', () => {
    expect(computeAnnualInterest(1000, [])).toBe(0);
    expect(computeAnnualInterest(1000, null)).toBe(0);
    expect(computeAnnualInterest(0, [{ rate: 1 }])).toBe(0);
    expect(computeAnnualInterest(-500, [{ rate: 1 }])).toBe(0);
  });

  it('skips malformed tiers but uses valid ones', () => {
    const tiers = [
      { upTo: 1000, rate: 'bogus' },           // skipped
      { upTo: 2000, rate: 1 },                 // valid: covers 1000-2000
      null,                                    // skipped
      { rate: 2 },                             // valid: covers 2000+
    ];
    // €3000: 1000-2000 at 1% = 10; 2000-3000 at 2% = 20 → 30
    // (0-1000 skipped because that tier has invalid rate)
    expect(computeAnnualInterest(3000, tiers)).toBe(30);
  });

  it('upTo of null/Infinity is treated as catch-all', () => {
    expect(computeAnnualInterest(50000, [{ upTo: null, rate: 1 }])).toBe(500);
    expect(computeAnnualInterest(50000, [{ upTo: Infinity, rate: 1 }])).toBe(500);
  });
});

describe('validateAccountRefs', () => {
  const accountIds = new Set(['cash', 'savings', 'card', 'broker']);

  it('passes when all referenced accounts exist', () => {
    const tx = { type: 'expense', account: 'cash', amount: 10 };
    expect(validateAccountRefs(tx, accountIds)).toEqual([]);
  });

  it('flags an unknown expense account', () => {
    const tx = { type: 'expense', account: 'ghost', amount: 10 };
    const problems = validateAccountRefs(tx, accountIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('unknownAccount');
    expect(problems[0].params).toEqual({ field: 'account', id: 'ghost' });
    expect(problems[0].message).toContain('ghost');
  });

  it('checks both sides of an account_transfer', () => {
    const tx = { type: 'account_transfer', from_account: 'cash', to_account: 'gone' };
    const problems = validateAccountRefs(tx, accountIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('unknownAccount');
    expect(problems[0].params).toEqual({ field: 'to_account', id: 'gone' });
  });

  it('skips from_account check on dividend (paying account is informational)', () => {
    const tx = { type: 'investment_transfer', direction: 'dividend',
                 from_account: 'extbank', to_account: 'broker', amount: 5 };
    expect(validateAccountRefs(tx, accountIds)).toEqual([]);
  });

  it('checks source_account on new_income fills', () => {
    const tx = { type: 'fill', source: 'new_income', source_account: 'phantom', lines: [] };
    const problems = validateAccountRefs(tx, accountIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].params).toEqual({ field: 'source_account', id: 'phantom' });
  });

  it('checks target_id on account adjustments', () => {
    const tx = { type: 'adjustment', target: 'account', target_id: 'phantom', amount: -5 };
    const problems = validateAccountRefs(tx, accountIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('unknownAccount');
    expect(problems[0].params.id).toBe('phantom');
    expect(problems[0].params.field).toContain('target_id');
  });

  it('checks an income row\'s interest_of (the loan given its interest is on)', () => {
    expect(validateAccountRefs({ type: 'income', account: 'cash', interest_of: 'savings', amount: 5 }, accountIds)).toEqual([]);
    const problems = validateAccountRefs({ type: 'income', account: 'cash', interest_of: 'gone', amount: 5 }, accountIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('unknownAccount');
    expect(problems[0].params).toEqual({ field: 'interest_of', id: 'gone' });
  });

  it('accepts an array as the second arg', () => {
    expect(validateAccountRefs({ type: 'expense', account: 'cash' }, ['cash'])).toEqual([]);
  });
});

describe('validateEnvelopeRefs', () => {
  const envelopeIds = new Set(['food', 'rent', 'fun']);

  it('passes when all envelope refs resolve', () => {
    const tx = { type: 'expense', envelope_id: 'food', amount: 10 };
    expect(validateEnvelopeRefs(tx, envelopeIds)).toEqual([]);
  });

  it('accepts __none__ as the explicit "no envelope" sentinel', () => {
    const tx = { type: 'expense', envelope_id: '__none__', amount: 10 };
    expect(validateEnvelopeRefs(tx, envelopeIds)).toEqual([]);
  });

  it('walks expense splits when present', () => {
    const tx = { type: 'expense', envelope_splits: [
      { envelope_id: 'food', amount: 5 },
      { envelope_id: 'ghost', amount: 5 },
    ] };
    const problems = validateEnvelopeRefs(tx, envelopeIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('unknownEnvelope');
    expect(problems[0].params.id).toBe('ghost');
  });

  it('checks both legs of an envelope_transfer', () => {
    const tx = { type: 'envelope_transfer', from_envelope_id: 'food', to_envelope_id: 'ghost' };
    const problems = validateEnvelopeRefs(tx, envelopeIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].params).toEqual({ field: 'to_envelope_id', id: 'ghost' });
  });

  it('checks each fill line', () => {
    const tx = { type: 'fill', lines: [
      { envelope_id: 'food', amount: 1 },
      { envelope_id: 'ghost', amount: 1 },
    ] };
    const problems = validateEnvelopeRefs(tx, envelopeIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('unknownEnvelope');
    expect(problems[0].params.id).toBe('ghost');
  });

  it('checks target_id on envelope adjustments', () => {
    const tx = { type: 'adjustment', target: 'envelope', target_id: 'ghost', amount: 5 };
    const problems = validateEnvelopeRefs(tx, envelopeIds);
    expect(problems).toHaveLength(1);
    expect(problems[0].params.id).toBe('ghost');
    expect(problems[0].params.field).toContain('target_id');
  });
});

describe('validateAmountSign', () => {
  it('accepts a positive expense', () => {
    expect(validateAmountSign({ type: 'expense', amount: 10 })).toEqual([]);
  });

  it('flags a negative expense (sign convention violation)', () => {
    const problems = validateAmountSign({ type: 'expense', amount: -10 });
    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('negativeAmount');
    expect(problems[0].params).toEqual({ amount: -10, type: 'expense' });
    expect(problems[0].message).toContain('negative amount');
  });

  it('accepts a negative adjustment (sign is meaningful)', () => {
    expect(validateAmountSign({ type: 'adjustment', amount: -5 })).toEqual([]);
  });

  it('skips when amount is null/undefined (fill rows store on lines)', () => {
    expect(validateAmountSign({ type: 'fill', amount: null })).toEqual([]);
    expect(validateAmountSign({ type: 'fill' })).toEqual([]);
  });

  it('skips when amount is non-numeric', () => {
    expect(validateAmountSign({ type: 'expense', amount: 'abc' })).toEqual([]);
  });
});

describe('runInvariantCheck', () => {
  const state = {
    accounts: [{ id: 'cash' }, { id: 'savings' }],
    envelopes: [{ id: 'food' }, { id: 'rent' }],
    // Dates are part of being clean: `validateTxDate` flags a missing one,
    // because every date comparison in the engine is a lexicographic string
    // compare and an absent date sorts before everything and buckets nowhere.
    transactions: [
      { id: 't1', type: 'expense', date: '2026-08-06', account: 'cash', envelope_id: 'food', amount: 10 },
      { id: 't2', type: 'expense', date: '2026-08-07', account: 'cash', envelope_id: 'rent', amount: 20 },
    ],
  };

  it('returns zero problems when state is clean', () => {
    const out = runInvariantCheck(state);
    expect(out.totalProblems).toBe(0);
    expect(out.byCategory).toEqual({
      splits: 0, accountRefs: 0, envelopeRefs: 0, signs: 0, duplicateKeys: 0,
      dates: 0, selfTransfers: 0, duplicateIds: 0, staleKeys: 0, coercions: 0,
      conservation: 0, unknownTypes: 0, itemLinks: 0, reconciled: 0, clearedScheduled: 0,
    });
    expect(out.problems).toEqual([]);
  });

  it('reports an income row whose interest_of names no account', () => {
    const out = runInvariantCheck({
      ...state,
      transactions: [{ id: 'int', type: 'income', date: '2026-08-06', account: 'cash', envelope_id: null, interest_of: 'gone-loan', amount: 5 }],
    });
    expect(out.byCategory.accountRefs).toBe(1);
    expect(out.problems).toEqual([expect.objectContaining({ id: 'int', category: 'accountRefs', code: 'unknownAccount', params: { field: 'interest_of', id: 'gone-loan' } })]);
  });

  it('accumulates counts per category', () => {
    const dirty = {
      ...state,
      transactions: [
        { id: 'bad-acct', type: 'expense', date: '2026-08-06', account: 'phantom', envelope_id: 'food', amount: 10 },
        { id: 'bad-env', type: 'expense', date: '2026-08-06', account: 'cash', envelope_id: 'phantom', amount: 5 },
        { id: 'bad-sign', type: 'expense', date: '2026-08-06', account: 'cash', envelope_id: 'food', amount: -5 },
        { id: 'bad-split', type: 'expense', date: '2026-08-06', account: 'cash', amount: 10,
          envelope_splits: [{ envelope_id: 'food', amount: 7 }] }, // sum mismatch
      ],
    };
    const out = runInvariantCheck(dirty);
    expect(out.byCategory.accountRefs).toBe(1);
    expect(out.byCategory.envelopeRefs).toBe(1);
    expect(out.byCategory.signs).toBe(1);
    expect(out.byCategory.splits).toBe(1);
    expect(out.totalProblems).toBeGreaterThanOrEqual(4);
    // Each problem entry carries the offending tx id, a category tag, a
    // structured code, params for interpolation, and a fallback message.
    expect(out.problems.every((p) => p.id && p.category && p.code && p.params && p.message)).toBe(true);
    const codesByCategory = new Map();
    for (const p of out.problems) codesByCategory.set(p.category, p.code);
    expect(codesByCategory.get('accountRefs')).toBe('unknownAccount');
    expect(codesByCategory.get('envelopeRefs')).toBe('unknownEnvelope');
    expect(codesByCategory.get('signs')).toBe('negativeAmount');
    expect(codesByCategory.get('splits')).toBe('splitSumMismatch');
  });

  it('caps the problems list at 50 entries', () => {
    const dirty = {
      accounts: [{ id: 'cash' }],
      envelopes: [{ id: 'food' }],
      transactions: Array.from({ length: 200 }, (_, i) => ({
        id: `t${i}`, type: 'expense', account: 'phantom', envelope_id: 'food', amount: 1,
      })),
    };
    const out = runInvariantCheck(dirty);
    expect(out.byCategory.accountRefs).toBe(200);
    expect(out.problems.length).toBe(50);
  });

  it('skips ref checks when the corresponding array is missing', () => {
    const noAccounts = { ...state, accounts: null };
    const out = runInvariantCheck(noAccounts);
    expect(out.byCategory.accountRefs).toBe(0);
    expect(out.byCategory.envelopeRefs).toBe(0); // envelopes still present so check ran
  });
});
