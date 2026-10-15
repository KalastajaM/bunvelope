// The closing-balance check is the one moment where a slipped-through
// duplicate is cheap to catch: right after the import that created it, with
// the statement still in front of you.
//
// It compares on the BANK's terms — posted rows only, dated on or before the
// statement's last day — because a scheduled row or a transaction entered for
// next week has not reached the bank and cannot be part of a figure the bank
// printed.

import { describe, it, expect } from 'vitest';
import { checkStatementBalance, statementEndDate } from '../js/import/statement-balance.js';

const ACCOUNTS = [{ id: 'cash', name: 'Checking', type: 'bank', initialBalance: 1000 }];

const expense = (id, date, amount, over = {}) => ({
  id, type: 'expense', date, amount, account: 'cash', status: 'posted', ...over,
});

const check = (over = {}) => checkStatementBalance({
  accounts: ACCOUNTS,
  transactions: [],
  accountId: 'cash',
  statementBalance: 900,
  rows: [{ date: '2026-08-06' }],
  ...over,
});

describe('statementEndDate', () => {
  it('takes the latest date in the imported rows', () => {
    expect(statementEndDate([
      { date: '2026-08-02' }, { date: '2026-08-19' }, { date: '2026-08-11' },
    ])).toBe('2026-08-19');
  });

  it('accepts Date objects, which is what the CSV parser produces', () => {
    expect(statementEndDate([{ date: new Date(2026, 7, 19) }])).toBe('2026-08-19');
  });

  it('ignores unusable dates rather than letting them win', () => {
    expect(statementEndDate([{ date: '2026-08-06' }, { date: 'later' }, { date: null }]))
      .toBe('2026-08-06');
  });

  it('returns null when nothing is usable', () => {
    expect(statementEndDate([])).toBeNull();
    expect(statementEndDate([{ date: '' }])).toBeNull();
    expect(statementEndDate(null)).toBeNull();
  });
});

describe('checkStatementBalance', () => {
  it('reports a match when the ledger agrees with the statement', () => {
    const out = check({ transactions: [expense('t1', '2026-08-05', 100)] });
    expect(out.matches).toBe(true);
    expect(out.actual).toBe(900);
    expect(out.difference).toBe(0);
  });

  it('names the gap when a row was imported twice', () => {
    // The duplicate drains the ledger 100 below what the bank shows.
    const out = check({
      transactions: [expense('t1', '2026-08-05', 100), expense('t2', '2026-08-05', 100)],
    });
    expect(out.matches).toBe(false);
    expect(out.actual).toBe(800);
    expect(out.difference).toBe(100); // statement holds 100 more than the ledger
  });

  it('catches the re-dated duplicate this exists for', () => {
    // Same payment, pending on the 5th and booked on the 8th — far enough
    // apart that a careless import keeps both.
    const out = check({
      transactions: [
        expense('pending', '2026-08-05', 60, { payee: 'Shop' }),
        expense('booked', '2026-08-08', 60, { payee: 'Shop' }),
      ],
      statementBalance: 940,
      rows: [{ date: '2026-08-08' }],
    });
    expect(out.matches).toBe(false);
    expect(out.difference).toBe(60);
  });

  it('ignores transactions dated after the statement', () => {
    // Entered for next week; the bank has never heard of it.
    const out = check({
      transactions: [expense('t1', '2026-08-05', 100), expense('future', '2026-09-01', 500)],
    });
    expect(out.matches).toBe(true);
  });

  it('ignores scheduled rows, which have not happened at the bank', () => {
    const out = check({
      transactions: [
        expense('t1', '2026-08-05', 100),
        expense('sched', '2026-08-04', 250, { status: 'scheduled' }),
      ],
    });
    expect(out.matches).toBe(true);
  });

  it('skips silently when there is nothing to compare', () => {
    expect(check({ accountId: '' })).toBeNull();
    expect(check({ statementBalance: NaN })).toBeNull();
    expect(check({ statementBalance: null })).toBeNull();
    expect(check({ rows: [] })).toBeNull();
  });

  it('handles a negative statement balance, as on a credit card', () => {
    const cards = [{ id: 'cash', name: 'Card', type: 'credit', initialBalance: 0 }];
    const out = check({
      accounts: cards,
      transactions: [expense('t1', '2026-08-05', 250)],
      statementBalance: -250,
    });
    expect(out.matches).toBe(true);
  });

  it('reports the as-of date it compared on', () => {
    const out = check({ rows: [{ date: '2026-08-06' }, { date: '2026-08-19' }] });
    expect(out.asOf).toBe('2026-08-19');
  });
});
