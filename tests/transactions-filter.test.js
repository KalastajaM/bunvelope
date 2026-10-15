import { filterAndSort } from '../js/core/transactions-filter.js';
import { describe, it, expect } from 'vitest';
import { pendingFilterFields, openAtTodayIndex, realIsoDate, datePreset, filterKey } from '../js/pages/transactions-filter.js';

const DEFAULT_UI = {
  search: '', envelope: '', account: '', type: 'all', status: 'all',
  dateFrom: '', dateTo: '',
};

function mk(overrides = {}) {
  return {
    id: overrides.id ?? 't1',
    type: overrides.type ?? 'expense',
    envelope_id: overrides.envelope_id,
    account: overrides.account ?? 'bank',
    payee: overrides.payee ?? 'Aldi',
    note: overrides.note,
    amount: overrides.amount ?? 10,
    date: overrides.date ?? '2026-04-01',
    cleared: overrides.cleared,
    status: overrides.status,
    from_account: overrides.from_account,
    to_account: overrides.to_account,
    envelope_splits: overrides.envelope_splits,
    lines: overrides.lines,
    from_envelope_id: overrides.from_envelope_id,
    to_envelope_id: overrides.to_envelope_id,
    target: overrides.target,
    target_id: overrides.target_id,
    source: overrides.source,
    source_account: overrides.source_account,
    flagged: overrides.flagged,
  };
}

describe('filterAndSort', () => {
  it('sorts results date desc', () => {
    const txs = [mk({ id: 'a', date: '2026-01-01' }), mk({ id: 'b', date: '2026-03-01' }), mk({ id: 'c', date: '2026-02-01' })];
    const out = filterAndSort(txs, DEFAULT_UI);
    expect(out.map(t => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('same-date txs use input-index desc as tiebreaker', () => {
    // Critical for the running-balance display: engine.js walks txs in
    // index-asc order, so the display must invert that order. Reading the
    // visible list bottom-to-top must match the running-balance walk.
    const txs = [
      mk({ id: 'a', date: '2026-04-01' }),
      mk({ id: 'b', date: '2026-04-01' }),
      mk({ id: 'c', date: '2026-04-01' }),
    ];
    const out = filterAndSort(txs, DEFAULT_UI).map(t => t.id);
    expect(out).toEqual(['c', 'b', 'a']);
  });

  it('filters by envelope id', () => {
    const txs = [mk({ id: 'a', envelope_id: 'food' }), mk({ id: 'b', envelope_id: 'fun' })];
    expect(filterAndSort(txs, { ...DEFAULT_UI, envelope: 'food' }).map(t => t.id)).toEqual(['a']);
  });

  it('filters by type', () => {
    const txs = [mk({ id: 'a', type: 'expense' }), mk({ id: 'b', type: 'income' })];
    expect(filterAndSort(txs, { ...DEFAULT_UI, type: 'income' }).map(t => t.id)).toEqual(['b']);
  });

  it('filters by cleared status', () => {
    const txs = [mk({ id: 'a', cleared: true }), mk({ id: 'b', cleared: false }), mk({ id: 'c' })];
    expect(filterAndSort(txs, { ...DEFAULT_UI, status: 'cleared' }).map(t => t.id)).toEqual(['a']);
    expect(filterAndSort(txs, { ...DEFAULT_UI, status: 'uncleared' }).map(t => t.id).sort()).toEqual(['b', 'c']);
  });

  it('scheduled status filter matches tx.status', () => {
    const txs = [mk({ id: 'a', status: 'scheduled' }), mk({ id: 'b' })];
    expect(filterAndSort(txs, { ...DEFAULT_UI, status: 'scheduled' }).map(t => t.id)).toEqual(['a']);
  });

  it('account filter matches account, from_account, or to_account', () => {
    const txs = [
      mk({ id: 'a', account: 'bank' }),
      mk({ id: 'b', type: 'account_transfer', from_account: 'bank', to_account: 'cash' }),
      mk({ id: 'c', type: 'account_transfer', from_account: 'visa', to_account: 'bank' }),
      mk({ id: 'd', account: 'visa' }),
    ];
    const out = filterAndSort(txs, { ...DEFAULT_UI, account: 'bank' }).map(t => t.id).sort();
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('search matches payee case-insensitively', () => {
    const txs = [mk({ id: 'a', payee: 'Aldi' }), mk({ id: 'b', payee: 'Lidl' }), mk({ id: 'c', payee: 'aldi-express' })];
    const out = filterAndSort(txs, { ...DEFAULT_UI, search: 'aldi' }).map(t => t.id).sort();
    expect(out).toEqual(['a', 'c']);
  });

  it('#tag token matches transactions whose note has that hashtag exactly', () => {
    const txs = [
      mk({ id: 'a', note: 'lunch #trip' }),
      mk({ id: 'b', note: 'no tag here' }),
      mk({ id: 'c', note: '#trip dinner' }),
      mk({ id: 'd', note: '#tripoli' }),
    ];
    expect(filterAndSort(txs, { ...DEFAULT_UI, search: '#trip' }).map(t => t.id).sort())
      .toEqual(['a', 'c']);
  });

  it('#tag matching is case-insensitive', () => {
    const txs = [mk({ id: 'a', note: '#Paris' }), mk({ id: 'b', note: '#paris' })];
    expect(filterAndSort(txs, { ...DEFAULT_UI, search: '#PARIS' }).map(t => t.id).sort())
      .toEqual(['a', 'b']);
  });

  it('combines #tag with text and amount tokens (all must match)', () => {
    const txs = [
      mk({ id: 'a', payee: 'Aldi', note: '#trip lunch', amount: 30 }),
      mk({ id: 'b', payee: 'Aldi', note: '#trip lunch', amount: 5 }),
      mk({ id: 'c', payee: 'Lidl', note: '#trip lunch', amount: 30 }),
    ];
    const ui = { ...DEFAULT_UI, search: '#trip aldi >10' };
    expect(filterAndSort(txs, ui).map(t => t.id)).toEqual(['a']);
  });

  it('a quoted phrase is one plain-text token, even with a number or a #', () => {
    const txs = [
      mk({ id: 'a', payee: 'ALEPA 123' }),
      mk({ id: 'b', payee: 'Kahvila #1' }),
      mk({ id: 'c', payee: 'PAYPAL *STEAM 4029357733' }),
      mk({ id: 'd', payee: 'Somewhere else' }),
    ];
    expect(filterAndSort(txs, { ...DEFAULT_UI, search: '"ALEPA 123"' }).map(t => t.id)).toEqual(['a']);
    expect(filterAndSort(txs, { ...DEFAULT_UI, search: '"Kahvila #1"' }).map(t => t.id)).toEqual(['b']);
    expect(filterAndSort(txs, { ...DEFAULT_UI, search: '"paypal *steam 4029357733"' }).map(t => t.id)).toEqual(['c']);
  });

  it('a quoted phrase combines with an unquoted amount token', () => {
    const txs = [
      mk({ id: 'a', payee: 'ALEPA 123', amount: 30 }),
      mk({ id: 'b', payee: 'ALEPA 123', amount: 5 }),
      mk({ id: 'c', payee: 'Other', amount: 30 }),
    ];
    const out = filterAndSort(txs, { ...DEFAULT_UI, search: '"ALEPA 123" >10' }).map(t => t.id);
    expect(out).toEqual(['a']);
  });

  it('an unterminated quote treats the rest of the string as the phrase', () => {
    const txs = [mk({ id: 'a', payee: 'ALEPA 123' }), mk({ id: 'b', payee: 'Other' })];
    expect(filterAndSort(txs, { ...DEFAULT_UI, search: '"ALEPA 123' }).map(t => t.id)).toEqual(['a']);
  });

  it('unquoted search behaviour is unchanged (text, #tag, amount tokens)', () => {
    const txs = [
      mk({ id: 'a', payee: 'Aldi', note: '#trip lunch', amount: 30 }),
      mk({ id: 'b', payee: 'Aldi', note: '#trip lunch', amount: 5 }),
      mk({ id: 'c', payee: 'Lidl', note: '#trip lunch', amount: 30 }),
    ];
    const ui = { ...DEFAULT_UI, search: '#trip aldi >10' };
    expect(filterAndSort(txs, ui).map(t => t.id)).toEqual(['a']);
  });

  it('dateFrom/dateTo inclusive bounds', () => {
    const txs = [
      mk({ id: 'a', date: '2026-01-01' }),
      mk({ id: 'b', date: '2026-02-15' }),
      mk({ id: 'c', date: '2026-03-31' }),
    ];
    const out = filterAndSort(txs, { ...DEFAULT_UI, dateFrom: '2026-02-01', dateTo: '2026-03-31' }).map(t => t.id);
    expect(out.sort()).toEqual(['b', 'c']);
  });

  describe('account filter — fill from new income & account adjustments', () => {
    it('includes a fill funded from the filtered account', () => {
      const txs = [
        mk({ id: 'fill-from-bank', type: 'fill', account: 'no-acct',
             source: 'new_income', source_account: 'bank',
             lines: [{ envelope_id: 'food', amount: 100 }] }),
        mk({ id: 'fill-from-other', type: 'fill', account: 'no-acct',
             source: 'new_income', source_account: 'visa',
             lines: [{ envelope_id: 'food', amount: 100 }] }),
        mk({ id: 'fill-no-source', type: 'fill', account: 'no-acct',
             lines: [{ envelope_id: 'food', amount: 100 }] }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, account: 'bank' }).map(t => t.id)).toEqual(['fill-from-bank']);
    });

    it('includes adjustment targeting the filtered account; excludes envelope-targeted', () => {
      const txs = [
        mk({ id: 'adj-acc',   type: 'adjustment', account: 'no-acct', target: 'account',  target_id: 'bank', amount: -3 }),
        mk({ id: 'adj-env',   type: 'adjustment', account: 'no-acct', target: 'envelope', target_id: 'bank', amount: -3 }),
        mk({ id: 'adj-other', type: 'adjustment', account: 'no-acct', target: 'account',  target_id: 'visa', amount:  1 }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, account: 'bank' }).map(t => t.id)).toEqual(['adj-acc']);
    });
  });

  describe('envelope filter — non-expense types', () => {
    it('includes a fill whose lines reference the envelope', () => {
      const txs = [
        mk({ id: 'fill-hit', type: 'fill', lines: [{ envelope_id: 'food', amount: 200, mode: 'add' }] }),
        mk({ id: 'fill-miss', type: 'fill', lines: [{ envelope_id: 'fun', amount: 50, mode: 'add' }] }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, envelope: 'food' }).map(t => t.id)).toEqual(['fill-hit']);
    });

    it('includes envelope_transfer when from or to matches; excludes when neither does', () => {
      const txs = [
        mk({ id: 'tx-out', type: 'envelope_transfer', from_envelope_id: 'food', to_envelope_id: 'fun', amount: 30 }),
        mk({ id: 'tx-in',  type: 'envelope_transfer', from_envelope_id: 'fun',  to_envelope_id: 'food', amount: 40 }),
        mk({ id: 'tx-other', type: 'envelope_transfer', from_envelope_id: 'a',  to_envelope_id: 'b', amount: 10 }),
      ];
      const out = filterAndSort(txs, { ...DEFAULT_UI, envelope: 'food' }).map(t => t.id).sort();
      expect(out).toEqual(['tx-in', 'tx-out']);
    });

    it('includes envelope-targeted adjustment; excludes account-targeted', () => {
      const txs = [
        mk({ id: 'adj-env', type: 'adjustment', target: 'envelope', target_id: 'food', amount: -5 }),
        mk({ id: 'adj-acc', type: 'adjustment', target: 'account',  target_id: 'food', amount: -5 }),
        mk({ id: 'adj-other', type: 'adjustment', target: 'envelope', target_id: 'fun', amount: 1 }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, envelope: 'food' }).map(t => t.id)).toEqual(['adj-env']);
    });

    it('does not match the __none__ pseudo-envelope through any channel', () => {
      const txs = [
        mk({ id: 'a', envelope_id: '__none__' }),
        mk({ id: 'b', type: 'fill', lines: [{ envelope_id: '__none__', amount: 10 }] }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, envelope: '__none__' })).toEqual([]);
    });

    it('__noenvelope__ filter matches uncategorized expense/debt rows only', () => {
      const txs = [
        mk({ id: 'unset',     type: 'expense',      envelope_id: undefined, date: '2026-04-01' }),
        mk({ id: 'sentinel',  type: 'expense',      envelope_id: '__none__', date: '2026-04-02' }),
        mk({ id: 'debt',      type: 'debt_payment', envelope_id: undefined, date: '2026-04-03' }),
        mk({ id: 'has-env',   type: 'expense',      envelope_id: 'food',    date: '2026-04-04' }),
        mk({ id: 'income',    type: 'income',       envelope_id: undefined, date: '2026-04-05' }),
        mk({ id: 'transfer',  type: 'account_transfer', envelope_id: undefined, date: '2026-04-06' }),
      ];
      const out = filterAndSort(txs, { ...DEFAULT_UI, envelope: '__noenvelope__' }).map(t => t.id);
      expect(out.sort()).toEqual(['debt', 'sentinel', 'unset']);
    });

    it('__noenvelope__ excludes split transactions even with no top-level envelope_id', () => {
      const txs = [
        mk({ id: 'split',  type: 'expense', envelope_id: undefined,
             envelope_splits: [
               { envelope_id: 'food', amount: 5 },
               { envelope_id: 'fun',  amount: 3 },
             ] }),
        mk({ id: 'split-with-none', type: 'expense', envelope_id: undefined,
             envelope_splits: [{ envelope_id: '__none__', amount: 5 }] }),
        mk({ id: 'unset', type: 'expense', envelope_id: undefined }),
      ];
      // `split` has real envelopes via splits → excluded.
      // `split-with-none` only has the __none__ sentinel in splits → still uncategorized.
      // `unset` has nothing → uncategorized.
      const out = filterAndSort(txs, { ...DEFAULT_UI, envelope: '__noenvelope__' }).map(t => t.id);
      expect(out.sort()).toEqual(['split-with-none', 'unset']);
    });

    it('specific envelope filter matches a transaction with that envelope in its splits', () => {
      const txs = [
        mk({ id: 'split-hit', type: 'expense', envelope_id: undefined,
             envelope_splits: [
               { envelope_id: 'food', amount: 5 },
               { envelope_id: 'fun',  amount: 3 },
             ] }),
        mk({ id: 'split-miss', type: 'expense', envelope_id: undefined,
             envelope_splits: [{ envelope_id: 'fun', amount: 5 }] }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, envelope: 'food' }).map(t => t.id)).toEqual(['split-hit']);
    });
  });

  it('combines multiple filters (AND semantics)', () => {
    const txs = [
      mk({ id: 'a', type: 'expense', envelope_id: 'food', payee: 'Aldi' }),
      mk({ id: 'b', type: 'expense', envelope_id: 'food', payee: 'Lidl' }),
      mk({ id: 'c', type: 'income',  envelope_id: 'food', payee: 'Aldi' }),
    ];
    const ui = { ...DEFAULT_UI, type: 'expense', envelope: 'food', search: 'aldi' };
    expect(filterAndSort(txs, ui).map(t => t.id)).toEqual(['a']);
  });

  describe('flagged filter', () => {
    it('keeps everything when flagged is unset or "all"', () => {
      const txs = [
        mk({ id: 'a', flagged: true, date: '2026-04-02' }),
        mk({ id: 'b',                date: '2026-04-01' }),
      ];
      expect(filterAndSort(txs, DEFAULT_UI).map(t => t.id)).toEqual(['a', 'b']);
      expect(filterAndSort(txs, { ...DEFAULT_UI, flagged: 'all' }).map(t => t.id)).toEqual(['a', 'b']);
    });

    it('drops unflagged rows when flagged="only"', () => {
      const txs = [
        mk({ id: 'a', flagged: true,  date: '2026-04-02' }),
        mk({ id: 'b', flagged: false, date: '2026-04-03' }),
        mk({ id: 'c',                 date: '2026-04-04' }),
      ];
      expect(filterAndSort(txs, { ...DEFAULT_UI, flagged: 'only' }).map(t => t.id)).toEqual(['a']);
    });
  });
});

describe('pendingFilterFields', () => {
  const none = { search: '', envelope: '', account: '', type: 'all', dateFrom: '', dateTo: '' };

  it('defaults when nothing is pending', () => {
    expect(pendingFilterFields(null)).toEqual(none);
  });

  it('reads the string forms: envelope id, account:, month:', () => {
    expect(pendingFilterFields('env-1')).toEqual({ ...none, envelope: 'env-1' });
    expect(pendingFilterFields('account:acc-9')).toEqual({ ...none, account: 'acc-9' });
    expect(pendingFilterFields('month:2026-02')).toEqual({ ...none, dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  });

  it('reads the structured form, including a search for a payee click-through', () => {
    expect(pendingFilterFields({ search: 'Lidl', dateFrom: '2026-01-01', dateTo: '2026-09-27' }))
      .toEqual({ ...none, search: 'Lidl', dateFrom: '2026-01-01', dateTo: '2026-09-27' });
    expect(pendingFilterFields({ envelope: 'e', account: 'a', type: 'expense' }))
      .toEqual({ ...none, envelope: 'e', account: 'a', type: 'expense' });
  });
});

describe('realIsoDate', () => {
  it('keeps a real calendar day written YYYY-MM-DD', () => {
    expect(realIsoDate('2026-09-15')).toBe('2026-09-15');
    expect(realIsoDate('2024-02-29')).toBe('2024-02-29');
  });

  it('drops anything else: an impossible day, another format, a non-string', () => {
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-9-15', '15/09/2026', 'soon', ' 2026-09-15', '', null, undefined, 20260915]) {
      expect(realIsoDate(bad)).toBe('');
    }
  });
});

describe('openAtTodayIndex', () => {
  const items = [
    { kind: 'header', date: '2027-05-30' }, { kind: 'row' },
    { kind: 'header', date: '2027-02-28' }, { kind: 'row' },
    { kind: 'header', date: '2026-09-28' }, { kind: 'row' },
    { kind: 'header', date: '2026-09-01' }, { kind: 'row' },
  ];
  const TODAY = '2026-09-30';

  it('opens at the latest day on or before today, skipping future rows', () => {
    expect(openAtTodayIndex(items, DEFAULT_UI, TODAY)).toBe(4);
  });

  it('opens at today itself when today has rows', () => {
    const withToday = [...items.slice(0, 4), { kind: 'header', date: TODAY }, { kind: 'row' }, ...items.slice(4)];
    expect(openAtTodayIndex(withToday, DEFAULT_UI, TODAY)).toBe(4);
  });

  it('still opens at today when the list is narrowed to one account or envelope', () => {
    expect(openAtTodayIndex(items, { ...DEFAULT_UI, account: 'bank' }, TODAY)).toBe(4);
    expect(openAtTodayIndex(items, { ...DEFAULT_UI, envelope: 'food' }, TODAY)).toBe(4);
  });

  it('opens at the top for a search or a date range', () => {
    expect(openAtTodayIndex(items, { ...DEFAULT_UI, search: 'aldi' }, TODAY)).toBe(-1);
    expect(openAtTodayIndex(items, { ...DEFAULT_UI, dateFrom: '2027-01-01' }, TODAY)).toBe(-1);
    expect(openAtTodayIndex(items, { ...DEFAULT_UI, dateTo: '2027-12-31' }, TODAY)).toBe(-1);
  });

  it('stays at the top when every row is in the future', () => {
    expect(openAtTodayIndex(items.slice(0, 4), DEFAULT_UI, TODAY)).toBe(-1);
  });
});

describe('datePreset (UX 2026-10-05)', () => {
  const today = new Date(2026, 9, 5, 15, 0, 0); // 5 Oct 2026, local

  it('"This month" covers the whole calendar month, not just up to today', () => {
    expect(datePreset('thisMonth', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(datePreset('thisMonth', new Date(2026, 1, 10))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(datePreset('thisMonth', new Date(2028, 1, 29))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(datePreset('thisMonth', new Date(2026, 11, 31, 23, 59))).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('the other presets are unchanged', () => {
    expect(datePreset('last7', today)).toEqual({ from: '2026-09-29', to: '2026-10-05' });
    expect(datePreset('lastMonth', today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(datePreset('ytd', today)).toEqual({ from: '2026-01-01', to: '2026-10-05' });
  });
});

describe('filterKey (UX 2026-10-05)', () => {
  const base = { search: '', envelope: '', account: '', type: 'all', status: 'all', flagged: 'all', dateFrom: '', dateTo: '', showScheduled: false };

  it('is the same for the same filters and changes with any of them', () => {
    expect(filterKey({ ...base, selectMode: true })).toBe(filterKey(base));
    for (const [k, v] of Object.entries({ search: 'x', envelope: 'food', account: 'chk', type: 'expense',
      status: 'cleared', flagged: 'only', dateFrom: '2026-01-01', dateTo: '2026-01-31', showScheduled: true })) {
      expect(filterKey({ ...base, [k]: v })).not.toBe(filterKey(base));
    }
  });
});
