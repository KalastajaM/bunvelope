// tests/engine/reports-ranges.test.js — date-range boundary semantics for the
// reports aggregators ({ from, to } is inclusive on both ends, either side may
// be null for open-ended), plus first coverage for aggregateEnvelopeBalances.

import { describe, it, expect } from 'vitest';
import {
  aggregateSpendingByEnvelope,
  aggregatePayeeSpending,
  aggregateIncomeVsSpending,
  aggregateSpendingByMonth,
  aggregateSavingByMonth,
  aggregateEnvelopeBalances,
} from '../../js/engine/reports.js';

const envelopes = [
  { id: 'food', name: 'Food', category: 'Living' },
  { id: 'fun', name: 'Fun', category: 'Leisure' },
];

// One expense per day around the range edges [2026-03-10 .. 2026-03-20].
const edgeTxs = [
  { id: 'before', type: 'expense', envelope_id: 'food', payee: 'A', amount: 1, date: '2026-03-09' },
  { id: 'on-from', type: 'expense', envelope_id: 'food', payee: 'A', amount: 2, date: '2026-03-10' },
  { id: 'inside', type: 'expense', envelope_id: 'food', payee: 'A', amount: 4, date: '2026-03-15' },
  { id: 'on-to', type: 'expense', envelope_id: 'food', payee: 'A', amount: 8, date: '2026-03-20' },
  { id: 'after', type: 'expense', envelope_id: 'food', payee: 'A', amount: 16, date: '2026-03-21' },
];
const range = { from: '2026-03-10', to: '2026-03-20' };
// Inclusive on both ends: 2 + 4 + 8.
const EXPECTED_IN_RANGE = 14;

describe('reports aggregators: range boundaries are inclusive', () => {
  it('aggregateSpendingByEnvelope', () => {
    const rows = aggregateSpendingByEnvelope(edgeTxs, envelopes, range);
    expect(rows).toEqual([{ key: 'food', label: 'Living · Food', value: EXPECTED_IN_RANGE }]);
  });

  it('aggregatePayeeSpending', () => {
    const rows = aggregatePayeeSpending(edgeTxs, range);
    expect(rows).toEqual([{ key: 'A', label: 'A', value: EXPECTED_IN_RANGE }]);
  });

  it('aggregateSpendingByMonth', () => {
    const rows = aggregateSpendingByMonth(edgeTxs, range);
    expect(rows).toEqual([{ key: '2026-03', label: '2026-03', value: EXPECTED_IN_RANGE }]);
  });

  it('aggregateIncomeVsSpending', () => {
    const withIncome = [
      ...edgeTxs,
      { id: 'inc-in', type: 'income', account: 'bank', amount: 100, date: '2026-03-10' },
      { id: 'inc-out', type: 'income', account: 'bank', amount: 900, date: '2026-03-21' },
    ];
    const { series, months } = aggregateIncomeVsSpending(withIncome, [], range);
    expect(months).toEqual(['2026-03']);
    expect(series.find(s => s.name === 'Income').points).toEqual([{ label: '2026-03', value: 100 }]);
    expect(series.find(s => s.name === 'Spending').points).toEqual([{ label: '2026-03', value: EXPECTED_IN_RANGE }]);
  });

  it('open-ended ranges: null from / null to / empty range object', () => {
    const total = 1 + 2 + 4 + 8 + 16;
    expect(aggregatePayeeSpending(edgeTxs, {})[0].value).toBe(total);
    expect(aggregatePayeeSpending(edgeTxs, { from: null, to: '2026-03-10' })[0].value).toBe(1 + 2);
    expect(aggregatePayeeSpending(edgeTxs, { from: '2026-03-20', to: null })[0].value).toBe(8 + 16);
  });
});

describe('saving classification: account_transfer and investment_transfer', () => {
  const accounts = [
    { id: 'checking', type: 'checking' },
    { id: 'savings-a', type: 'savings' },
    { id: 'savings-b', type: 'savings' },
    { id: 'invest', type: 'investment' },
    { id: 'pension', type: 'investment', pensionInsurance: true },
  ];

  it('counts a transfer into a savings account', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 50, date: '2026-01-05' },
    ];
    const rows = aggregateSavingByMonth(txs, accounts);
    expect(rows).toEqual([{ key: '2026-01', label: '2026-01', value: 50 }]);
  });

  it('excludes a transfer between two savings accounts, in both directions', () => {
    // Not net-new and not a withdrawal — the money never crosses the boundary.
    const txs = [
      { type: 'account_transfer', from_account: 'savings-a', to_account: 'savings-b', amount: 50, date: '2026-01-05' },
      { type: 'account_transfer', from_account: 'savings-b', to_account: 'savings-a', amount: 70, date: '2026-01-06' },
    ];
    expect(aggregateSavingByMonth(txs, accounts)).toEqual([]);
  });

  // §2.2 — this used to assert `[]`, which is the defect: a withdrawal read
  // as if it had never happened, so the saving series could never go down.
  it('counts a withdrawal out of savings as negative saving', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'savings-a', to_account: 'checking', amount: 50, date: '2026-01-05' },
    ];
    expect(aggregateSavingByMonth(txs, accounts))
      .toEqual([{ key: '2026-01', label: '2026-01', value: -50 }]);
  });

  it('a month whose deposits and withdrawals cancel stays a point, not a gap', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'checking',  to_account: 'savings-a', amount: 50, date: '2026-01-05' },
      { type: 'account_transfer', from_account: 'savings-a', to_account: 'checking',  amount: 50, date: '2026-01-20' },
    ];
    expect(aggregateSavingByMonth(txs, accounts))
      .toEqual([{ key: '2026-01', label: '2026-01', value: 0 }]);
  });

  it('nets deposits against withdrawals within a month', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'checking',  to_account: 'savings-a', amount: 200, date: '2026-02-01' },
      { type: 'account_transfer', from_account: 'savings-a', to_account: 'checking',  amount: 300, date: '2026-02-14' },
    ];
    expect(aggregateSavingByMonth(txs, accounts))
      .toEqual([{ key: '2026-02', label: '2026-02', value: -100 }]);
  });

  it('the withdrawal arm reaches the incomeVsSpending Saving series too', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'savings-a', to_account: 'checking', amount: 80, date: '2026-01-05' },
    ];
    const { series } = aggregateIncomeVsSpending(txs, accounts);
    expect(series.find(s => s.name === 'Saving').points)
      .toEqual([{ label: '2026-01', value: -80 }]);
  });

  it('counts investment_transfer on the default/buy leg, including pension', () => {
    const txs = [
      { type: 'investment_transfer', to_account: 'invest', amount: 30, date: '2026-01-05' },
      { type: 'investment_transfer', direction: 'buy', to_account: 'pension', amount: 20, date: '2026-01-06' },
    ];
    const rows = aggregateSavingByMonth(txs, accounts);
    expect(rows).toEqual([{ key: '2026-01', label: '2026-01', value: 50 }]);
  });

  it('excludes dividend and adjust legs of investment_transfer (growth, not saving)', () => {
    const txs = [
      { type: 'investment_transfer', direction: 'dividend', from_account: 'invest', to_account: 'checking', amount: 10, date: '2026-01-06' },
      { type: 'investment_transfer', direction: 'dividend', from_account: 'invest', to_account: 'savings-a', amount: 10, date: '2026-01-06' },
      { type: 'investment_transfer', direction: 'adjust', to_account: 'invest', amount: 5, date: '2026-01-07' },
    ];
    expect(aggregateSavingByMonth(txs, accounts)).toEqual([]);
  });

  it('aggregateIncomeVsSpending reports saving as its own series', () => {
    const txs = [
      { type: 'income', amount: 1000, date: '2026-01-05' },
      { type: 'expense', amount: 100, date: '2026-01-05' },
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 50, date: '2026-01-05' },
      { type: 'investment_transfer', to_account: 'pension', amount: 25, date: '2026-01-05' },
    ];
    const { series } = aggregateIncomeVsSpending(txs, accounts);
    expect(series.find(s => s.name === 'Saving').points).toEqual([{ label: '2026-01', value: 75 }]);
  });

  // QA 2026-09-23 #6 — only `savings` accounts were savings destinations, so
  // moving cash into a brokerage or pension account read as zero saving, even
  // though this module's own docs define saving as "money moved to
  // savings/investment/pension accounts".
  it('counts a transfer into an investment or pension account as saving', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'checking', to_account: 'invest', amount: 100, date: '2026-01-05' },
      { type: 'account_transfer', from_account: 'checking', to_account: 'pension', amount: 40, date: '2026-01-06' },
    ];
    expect(aggregateSavingByMonth(txs, accounts))
      .toEqual([{ key: '2026-01', label: '2026-01', value: 140 }]);
    const { series } = aggregateIncomeVsSpending(txs, accounts);
    expect(series.find(s => s.name === 'Saving').points).toEqual([{ label: '2026-01', value: 140 }]);
  });

  it('counts cash taken out of an investment account as a withdrawal', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'invest', to_account: 'checking', amount: 60, date: '2026-01-05' },
    ];
    expect(aggregateSavingByMonth(txs, accounts))
      .toEqual([{ key: '2026-01', label: '2026-01', value: -60 }]);
  });

  it('a transfer between savings and investment accounts is not net-new', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'savings-a', to_account: 'invest', amount: 500, date: '2026-01-05' },
      { type: 'account_transfer', from_account: 'pension', to_account: 'savings-b', amount: 70, date: '2026-01-06' },
    ];
    expect(aggregateSavingByMonth(txs, accounts)).toEqual([]);
  });

  // 2026-09-24 — owner-approved rule: saving is net money crossing from
  // non-saving accounts INTO the saving class (savings + investment), minus
  // money crossing back out. A buy used to count unconditionally, so cash
  // moved checking → savings (counted) and then spent on a buy from savings
  // (counted again) was saving twice.
  describe('boundary rule: only money crossing into/out of the saving class counts', () => {
    const sumSaving = txs => aggregateSavingByMonth(txs, accounts)
      .reduce((s, r) => s + r.value, 0);

    it('checking → savings 1000 then a 1000 buy paid from savings is 1000 saving, not 2000', () => {
      const txs = [
        { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 1000, date: '2026-01-05' },
        { type: 'investment_transfer', direction: 'buy', from_account: 'savings-a', to_account: 'invest', amount: 1000, date: '2026-02-05' },
      ];
      expect(sumSaving(txs)).toBe(1000);
      // The buy month is not a point at all: nothing crossed the boundary.
      expect(aggregateSavingByMonth(txs, accounts).map(r => r.label)).toEqual(['2026-01']);
    });

    it('a buy paid from checking is saving', () => {
      const txs = [
        { type: 'investment_transfer', direction: 'buy', from_account: 'checking', to_account: 'invest', amount: 500, date: '2026-01-05' },
      ];
      expect(aggregateSavingByMonth(txs, accounts))
        .toEqual([{ key: '2026-01', label: '2026-01', value: 500 }]);
    });

    it('a buy paid from an investment account\'s own cash is not saving', () => {
      const txs = [
        { type: 'account_transfer', from_account: 'checking', to_account: 'invest', amount: 400, date: '2026-01-05' },
        { type: 'investment_transfer', direction: 'buy', from_account: 'invest', to_account: 'pension', amount: 400, date: '2026-01-06' },
      ];
      expect(sumSaving(txs)).toBe(400);
    });

    it('a sell paid into checking is a withdrawal', () => {
      const txs = [
        { type: 'investment_transfer', direction: 'sell', from_account: 'invest', to_account: 'checking', amount: 300, date: '2026-01-05' },
      ];
      expect(aggregateSavingByMonth(txs, accounts))
        .toEqual([{ key: '2026-01', label: '2026-01', value: -300 }]);
    });

    it('a sell paid into savings is not a withdrawal', () => {
      const txs = [
        { type: 'investment_transfer', direction: 'sell', from_account: 'invest', to_account: 'savings-a', amount: 300, date: '2026-01-05' },
      ];
      expect(aggregateSavingByMonth(txs, accounts)).toEqual([]);
    });

    it('a savings → investment transfer is zero', () => {
      const txs = [
        { type: 'account_transfer', from_account: 'savings-a', to_account: 'invest', amount: 250, date: '2026-01-05' },
      ];
      expect(aggregateSavingByMonth(txs, accounts)).toEqual([]);
    });

    it('a debt payment funded from savings is a withdrawal; from checking it is nothing', () => {
      const withCard = [...accounts, { id: 'card', type: 'credit_card' }];
      const txs = [
        { type: 'debt_payment', from_account: 'savings-a', to_account: 'card', amount: 90, date: '2026-01-05' },
        { type: 'debt_payment', from_account: 'checking', to_account: 'card', amount: 40, date: '2026-01-06' },
      ];
      expect(aggregateSavingByMonth(txs, withCard))
        .toEqual([{ key: '2026-01', label: '2026-01', value: -90 }]);
    });

    it('income into or an expense out of a savings account is not saving', () => {
      const txs = [
        { type: 'income', account: 'savings-a', amount: 12, date: '2026-01-05' },
        { type: 'expense', account: 'savings-a', amount: 7, date: '2026-01-06' },
      ];
      expect(aggregateSavingByMonth(txs, accounts)).toEqual([]);
    });

    it('the incomeVsSpending Saving series applies the same rule', () => {
      const txs = [
        { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 1000, date: '2026-01-05' },
        { type: 'investment_transfer', direction: 'buy', from_account: 'savings-a', to_account: 'invest', amount: 1000, date: '2026-01-06' },
        { type: 'investment_transfer', direction: 'sell', from_account: 'invest', to_account: 'checking', amount: 300, date: '2026-01-07' },
      ];
      const { series } = aggregateIncomeVsSpending(txs, accounts);
      expect(series.find(s => s.name === 'Saving').points).toEqual([{ label: '2026-01', value: 700 }]);
    });
  });

  it('aggregateSavingByMonth respects inclusive range boundaries', () => {
    const txs = [
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 1, date: '2026-03-09' },
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 2, date: '2026-03-10' },
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 4, date: '2026-03-15' },
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 8, date: '2026-03-20' },
      { type: 'account_transfer', from_account: 'checking', to_account: 'savings-a', amount: 16, date: '2026-03-21' },
    ];
    const rows = aggregateSavingByMonth(txs, accounts, { from: '2026-03-10', to: '2026-03-20' });
    expect(rows).toEqual([{ key: '2026-03', label: '2026-03', value: 2 + 4 + 8 }]);
  });
});

describe('aggregateEnvelopeBalances', () => {
  const txs = [
    { id: 'f1', type: 'fill', date: '2026-01-01',
      lines: [
        { envelope_id: 'food', mode: 'add', amount: 100 },
        { envelope_id: 'fun', mode: 'add', amount: 20 },
      ] },
    // Overspend fun into the negative.
    { id: 'e1', type: 'expense', envelope_id: 'fun', amount: 170, date: '2026-01-10' },
    // Expense on an envelope that no longer exists.
    { id: 'e2', type: 'expense', envelope_id: 'gone', amount: 5, date: '2026-01-11' },
  ];

  it('labels, keeps negatives, and sorts by absolute value', () => {
    const rows = aggregateEnvelopeBalances(envelopes, txs);
    expect(rows).toEqual([
      { key: 'fun', label: 'Leisure · Fun', value: -150 },
      { key: 'food', label: 'Living · Food', value: 100 },
      { key: 'gone', label: '(Unknown)', value: -5 },
    ]);
  });

  it('truncates to topN', () => {
    const rows = aggregateEnvelopeBalances(envelopes, txs, 2);
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.key)).toEqual(['fun', 'food']);
  });
});

// §2.1 follow-up — the income branch's amount guard used to gate the whole
// loop, so a row with an unreadable top-level `amount` fell out of the
// spending series as well, splits and all.
describe('aggregateIncomeVsSpending — one guard per series', () => {
  it('still counts a split expense whose top-level amount is unreadable', () => {
    const rows = [{
      id: 'x', type: 'expense', date: '2026-03-04', amount: null, status: 'posted',
      envelope_splits: [
        { envelope_id: 'e1', amount: 60 },
        { envelope_id: 'e2', amount: 40 },
      ],
    }];
    const { series } = aggregateIncomeVsSpending(rows, [], { from: '2026-03-01', to: '2026-03-31' });
    const spending = series.find(s => s.name === 'Spending');
    expect(spending.points).toEqual([{ label: '2026-03', value: 100 }]);
  });
});
