// `from_budget` links a transaction to one scheduled occurrence, and nothing
// revisits it when the transaction's DATE changes. Both edit paths preserve
// the key while replacing the date: converting a forecast row stamps the key
// from `forecast_month_key`, and editing a real row spreads `...tx` over a new
// `date`. Re-date a materialized bill far enough and the key names a month the
// transaction has nothing to do with.
//
// Nothing noticed. The forecast trusts the key absolutely — it dedups the
// occurrence the key names, and excludes the row from the settling pool
// BECAUSE it carries a key — so the occurrence the transaction actually pays
// is forecast on top of it and the bill is counted twice.
//
// The threshold is `LINK_DAY_WINDOW`, deliberately not a new constant. It is
// already the app's definition of how far a payment may land from its due date
// and still be the same money. A due date sits somewhere inside the keyed
// month, so a payment settling it must fall within ten days of that month.
// Outside that, no occurrence in the month could be matched by the app's own
// rule, whatever the key claims.

import { describe, it, expect } from 'vitest';
import { validateFromBudgetLink, repointFromBudgetMonth, runInvariantCheck } from '../../js/engine.js';

const tx = (from_budget, date, extra = {}) => ({
  id: 't1', type: 'expense', date, amount: 183.6,
  envelope_id: 'metsa', account: 'a1', from_budget, ...extra,
});

const codes = t => validateFromBudgetLink(t).map(p => p.code);

describe('validateFromBudgetLink', () => {
  it('flags the reported case — an October row carrying an August key', () => {
    const problems = validateFromBudgetLink(tx('home-property-taxes-item:2026-08', '2026-10-06'));

    expect(problems).toHaveLength(1);
    expect(problems[0].code).toBe('staleFromBudgetLink');
    expect(problems[0].params).toMatchObject({ month: '2026-08', date: '2026-10-06', days: 36 });
  });

  it('accepts a row inside the month its key names', () => {
    expect(codes(tx('bi:2026-08', '2026-08-17'))).toEqual([]);
    expect(codes(tx('bi:2026-08', '2026-08-01'))).toEqual([]);
    expect(codes(tx('bi:2026-08', '2026-08-31'))).toEqual([]);
  });

  it('accepts a bill paid a few days either side of its month', () => {
    // Paid early, or slipping past month end — both ordinary, both linkable.
    expect(codes(tx('bi:2026-08', '2026-09-05'))).toEqual([]);
    expect(codes(tx('bi:2026-08', '2026-07-25'))).toEqual([]);
  });

  it('holds the boundary exactly at the match window after the month', () => {
    // Ten days past Aug 31: still linkable. Eleven is not.
    expect(codes(tx('bi:2026-08', '2026-09-10'))).toEqual([]);
    expect(codes(tx('bi:2026-08', '2026-09-11'))).toEqual(['staleFromBudgetLink']);
  });

  it('accepts a row dated before its month, however early: paid ahead of time', () => {
    // "Post now" on a forecast occurrence dates the row today and keeps its
    // key (owner decision 2026-10-05): the December bill paid on 5 October.
    expect(codes(tx('bi:2026-08', '2026-07-22'))).toEqual([]);
    expect(codes(tx('bi:2026-08', '2026-07-21'))).toEqual([]);
    expect(codes(tx('bi:2026-12', '2026-10-05'))).toEqual([]);
    expect(codes(tx('bi:2027-03', '2026-10-05'))).toEqual([]);
    expect(codes(tx('income-item:2026-12:fill', '2026-10-05'))).toEqual([]);
    // The day before the 1st, across a year boundary too.
    expect(codes(tx('bi:2027-01', '2026-12-31'))).toEqual([]);
  });

  it('reads the month out of every key shape the app emits', () => {
    // A fill leg appends a suffix, rollovers and template fills prepend a
    // namespace — the month is not always the last segment.
    expect(codes(tx('income-item:2026-04:fill', '2026-04-30'))).toEqual([]);
    expect(codes(tx('rollover:living-groceries:2026-03', '2026-03-31'))).toEqual([]);
    expect(codes(tx('tpl:tpl-metsa:2026-01', '2026-01-01'))).toEqual([]);
    // ...and still flags them when the date has wandered.
    expect(codes(tx('income-item:2026-04:fill', '2026-08-30'))).toEqual(['staleFromBudgetLink']);
  });

  it('says nothing about rows it cannot judge', () => {
    expect(codes(tx(undefined, '2026-10-06'))).toEqual([]);
    expect(codes(tx('', '2026-10-06'))).toEqual([]);
    expect(codes(tx('no-month-here', '2026-10-06'))).toEqual([]);
    expect(codes(tx('bi:2026-13', '2026-10-06'))).toEqual([]);
    // A broken date is `validateTxDate`'s problem, not this one's.
    expect(codes(tx('bi:2026-08', 'not-a-date'))).toEqual([]);
    expect(codes(tx('bi:2026-08', undefined))).toEqual([]);
    expect(validateFromBudgetLink(null)).toEqual([]);
  });
});

describe('runInvariantCheck reports stale links', () => {
  const clean = tx('bi:2026-08', '2026-08-17');
  const stale = tx('bi-tax:2026-08', '2026-10-06', { id: 't-stale' });

  it('counts them in their own category', () => {
    const report = runInvariantCheck({
      accounts: [{ id: 'a1' }], envelopes: [{ id: 'metsa' }],
      transactions: [clean, stale],
    });

    expect(report.byCategory.staleKeys).toBe(1);
    const p = report.problems.find(x => x.category === 'staleKeys');
    expect(p.id).toBe('t-stale');
    expect(p.message).toContain('2026-08');
  });

  it('stays quiet about a row paid early', () => {
    const early = tx('bi:2026-12', '2026-10-05', { id: 't-early' });
    const report = runInvariantCheck({
      accounts: [{ id: 'a1' }], envelopes: [{ id: 'metsa' }],
      transactions: [early],
    });
    expect(report.byCategory.staleKeys).toBe(0);
  });

  it('stays quiet when every link sits near its month', () => {
    const report = runInvariantCheck({
      accounts: [{ id: 'a1' }], envelopes: [{ id: 'metsa' }],
      transactions: [clean],
    });

    expect(report.byCategory.staleKeys).toBe(0);
    expect(report.problems.filter(p => p.category === 'staleKeys')).toEqual([]);
  });

  it('is independent of the duplicate-key check', () => {
    // Two rows sharing one key, both far from its month: two separate
    // complaints about the same rows, because they are separate faults.
    const twin = { ...stale, id: 't-twin' };
    const report = runInvariantCheck({
      accounts: [{ id: 'a1' }], envelopes: [{ id: 'metsa' }],
      transactions: [stale, twin],
    });

    expect(report.byCategory.staleKeys).toBe(2);
    expect(report.byCategory.duplicateKeys).toBeGreaterThan(0);
  });
});

describe('repointFromBudgetMonth', () => {
  it('rewrites the month segment, whatever the key shape', () => {
    expect(repointFromBudgetMonth('bi-tax:2026-08', '2026-10')).toBe('bi-tax:2026-10');
    expect(repointFromBudgetMonth('income-item:2026-04:fill', '2026-08'))
      .toBe('income-item:2026-08:fill');
    expect(repointFromBudgetMonth('rollover:living-groceries:2026-03', '2026-05'))
      .toBe('rollover:living-groceries:2026-05');
    expect(repointFromBudgetMonth('tpl:tpl-metsa:2026-01', '2026-02'))
      .toBe('tpl:tpl-metsa:2026-02');
  });

  it('refuses a key with no month, or a month that is not one', () => {
    expect(repointFromBudgetMonth('no-month-here', '2026-10')).toBeNull();
    expect(repointFromBudgetMonth('', '2026-10')).toBeNull();
    expect(repointFromBudgetMonth('bi:2026-08', 'October')).toBeNull();
    expect(repointFromBudgetMonth('bi:2026-08', '2026-13')).toBeNull();
  });

  it('produces a key the validator is happy with', () => {
    const key = repointFromBudgetMonth('bi-tax:2026-08', '2026-10');
    expect(validateFromBudgetLink(tx(key, '2026-10-06'))).toEqual([]);
  });
});

describe('the badge total counts every category', () => {
  it('counts a stale link, not just the categories named when it was written', () => {
    // `totalProblems` gates the status-bar badge. It used to be a hand-written
    // sum, so a new category was silently worth zero to it.
    const report = runInvariantCheck({
      accounts: [{ id: 'a1' }], envelopes: [{ id: 'metsa' }],
      transactions: [tx('bi-tax:2026-08', '2026-10-06')],
    });

    expect(report.byCategory.staleKeys).toBe(1);
    expect(report.totalProblems).toBe(1);
  });

  it('keeps the total equal to the sum of its categories', () => {
    const report = runInvariantCheck({
      accounts: [{ id: 'a1' }], envelopes: [{ id: 'metsa' }],
      transactions: [
        tx('bi-tax:2026-08', '2026-10-06', { id: 'a' }),
        tx('bi:2026-05', 'not-a-date', { id: 'b' }),
        tx(null, '2026-05-04', { id: 'c', envelope_id: 'ghost' }),
      ],
    });

    const summed = Object.values(report.byCategory).reduce((n, v) => n + v, 0);
    expect(report.totalProblems).toBe(summed);
    expect(report.totalProblems).toBeGreaterThan(0);
  });
});
