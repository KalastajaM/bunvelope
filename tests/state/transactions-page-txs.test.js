// The Transactions page's row set: real transactions plus, when "show
// scheduled" is on, the forecast occurrences for a bounded window, deduped.
//
// This was `buildEffectiveTxList`, a closure over `state` inside
// js/pages/transactions.js, so nothing could assert what the list contained
// without driving a browser (BACKLOG 2026-08-25). That is how it missed
// `meta.scheduledTombstones`: an occurrence the user deleted stayed deleted in
// the Forecast lens and the envelope projection, but came back on this list
// as an upcoming row.
import { describe, it, expect } from 'vitest';
import { transactionsPageTxList } from '../../js/core/effective-txs.js';

const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
const ENVELOPES = [{ id: 'rent', name: 'Rent' }, { id: 'food', name: 'Food' }, { id: 'fun', name: 'Fun' }];

const AUTO_ITEM = {
  id: 'bi-rent', envelope_id: 'rent', description: 'Rent', kind: 'expense',
  default_amount: 800, include: true, payment_day: 20,
  monthly_schedule: { ...ALL_MONTHS }, as_schedule: true, account_id: 'a1',
};
// Planned but hand-recorded: the Transactions list has never shown these
// (only the Forecast lens and the review do), and the extraction keeps it so.
const HAND_ITEM = {
  id: 'bi-food', envelope_id: 'food', description: 'Food', kind: 'expense',
  default_amount: 400, include: true, payment_day: 25,
  monthly_schedule: { ...ALL_MONTHS }, as_schedule: false,
};
const TEMPLATE = {
  id: 'tpl1', name: 'Mid-month', kind: 'manual',
  lines: [{ envelope_id: 'fun', mode: 'add', amount: 50 }],
  schedule: { enabled: true, payment_day: 15, day_type: 'exact', since: '2026-01-01', months: { ...ALL_MONTHS } },
};

const base = extra => ({
  transactions: [],
  budgetItems: [AUTO_ITEM, HAND_ITEM],
  envelopeTemplates: [TEMPLATE],
  accounts: ACCOUNTS,
  envelopes: ENVELOPES,
  today: new Date(2026, 3, 1),
  showScheduled: true,
  dateFrom: null,
  dateTo: null,
  country: 'FI',
  tombstones: [],
  ...extra,
});

const forecastRows = out => out.filter(r => r.is_forecast);
const keysOf = out => forecastRows(out).map(r => `${r.type}:${r.date}`).sort();

describe('transactionsPageTxList', () => {
  it('returns the real transactions unchanged when "show scheduled" is off', () => {
    const transactions = [{ id: 'r1', type: 'expense', date: '2026-04-02', amount: 5, account: 'a1' }];
    const out = transactionsPageTxList(base({ transactions, showScheduled: false }));
    expect(out).toBe(transactions);
  });

  it('shows the next 30 days of scheduled bills and template fills, not planned spend', () => {
    const out = transactionsPageTxList(base());
    expect(keysOf(out)).toEqual(['expense:2026-04-20', 'fill:2026-04-15']);
  });

  it('hides a scheduled occurrence the user deleted (tombstoned)', () => {
    const out = transactionsPageTxList(base({ tombstones: ['bi-rent:2026-04'] }));
    expect(keysOf(out)).toEqual(['fill:2026-04-15']);
  });

  it('hides a template fill the user deleted, using the tpl: key format', () => {
    const out = transactionsPageTxList(base({ tombstones: ['tpl:tpl1:2026-04'] }));
    expect(keysOf(out)).toEqual(['expense:2026-04-20']);
  });

  it('ignores malformed tombstone entries', () => {
    const out = transactionsPageTxList(base({ tombstones: [null, 7, '', 'bi-rent:2026-03'] }));
    expect(keysOf(out)).toEqual(['expense:2026-04-20', 'fill:2026-04-15']);
  });

  it('drops an occurrence already materialised as a real row', () => {
    const real = {
      id: 't1', type: 'expense', date: '2026-04-20', status: 'posted', amount: 800,
      envelope_id: 'rent', account: 'a1', from_budget: 'bi-rent:2026-04',
    };
    const out = transactionsPageTxList(base({ transactions: [real] }));
    expect(keysOf(out)).toEqual(['fill:2026-04-15']);
    expect(out[0]).toBe(real);
  });

  it('widens the window to an explicit date filter and flags past occurrences overdue', () => {
    const out = transactionsPageTxList(base({
      dateFrom: '2026-03-01', dateTo: '2026-05-31', envelopeTemplates: [],
    }));
    const rent = forecastRows(out).filter(r => r.envelope_id === 'rent');
    expect(rent.map(r => r.date)).toEqual(['2026-03-20', '2026-04-20', '2026-05-20']);
    expect(rent.map(r => !!r.is_overdue)).toEqual([true, false, false]);
  });

  it('a tombstone also hides an overdue occurrence', () => {
    const out = transactionsPageTxList(base({
      dateFrom: '2026-03-01', envelopeTemplates: [], tombstones: ['bi-rent:2026-03'],
    }));
    expect(forecastRows(out).map(r => r.date)).toEqual(['2026-04-20']);
  });
});
