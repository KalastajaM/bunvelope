// Reports chart extras: per-envelope balance history, the trailing 12-month
// average, and the saved-prefs validation for the Reports controls.
import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeBalanceHistory, computeEnvelopeBalanceHistoryByEnvelope,
  trailingWindowStart, trailingMonthlyAverage,
} from '../js/engine.js';
import {
  MAX_PICKED_ENVELOPES, readEnvelopePicks, picksToSave, readTopNPrefs, sortEnvelopeRows, envelopeCount,
} from '../js/pages/reports-prefs.js';
import { averageWindowEnd } from '../js/core/queries/reports-cashflow.js';

describe('computeEnvelopeBalanceHistoryByEnvelope', () => {
  const txs = [
    { type: 'income', date: '2026-01-15', amount: 200, envelope_id: 'savings', status: 'posted' },
    { type: 'expense', date: '2026-02-10', amount: 50, envelope_id: 'savings', status: 'posted' },
    { type: 'income', date: '2026-03-05', amount: 80, envelope_id: 'food', status: 'posted' },
  ];
  const ref = new Date(2026, 3, 25); // 25 Apr 2026, local

  it('gives month-end balances per requested envelope, oldest first', () => {
    const out = computeEnvelopeBalanceHistoryByEnvelope(txs, 3, ref, ['savings', 'food']);
    expect(out.months).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(out.byId.get('savings').map(p => p.value)).toEqual([150, 150, 150]);
    expect(out.byId.get('food').map(p => p.value)).toEqual([0, 80, 80]);
    expect(out.byId.get('food')[1]).toEqual({ label: '2026-03', value: 80 });
  });

  it('agrees with the total history on the same months', () => {
    const total = computeEnvelopeBalanceHistory(txs, 3, ref);
    const each = computeEnvelopeBalanceHistoryByEnvelope(txs, 3, ref, ['savings', 'food']);
    expect(each.months).toEqual(total.months);
    total.totals.forEach((p, i) => {
      expect(each.byId.get('savings')[i].value + each.byId.get('food')[i].value).toBeCloseTo(p.value, 2);
    });
  });

  it('returns zeros for an unknown envelope and needs a clock', () => {
    expect(computeEnvelopeBalanceHistoryByEnvelope(txs, 2, ref, ['nope']).byId.get('nope').map(p => p.value)).toEqual([0, 0]);
    expect(() => computeEnvelopeBalanceHistoryByEnvelope(txs, 2, undefined, ['savings'])).toThrow();
  });
});

describe('trailingWindowStart / trailingMonthlyAverage', () => {
  it('counts back across a year boundary', () => {
    expect(trailingWindowStart('2026-02', 12)).toBe('2025-03');
    expect(trailingWindowStart('2026-12', 12)).toBe('2026-01');
    expect(trailingWindowStart('2026-03', 1)).toBe('2026-03');
  });

  const pts = [
    { label: '2025-12', value: 999 },
    { label: '2026-01', value: 100 },
    { label: '2026-03', value: 200 },
  ];

  it('averages over calendar months in the window, a missing month counting as zero', () => {
    expect(trailingMonthlyAverage(pts, '2026-03', 3)).toBe(100); // (100 + 0 + 200) / 3
  });

  it('starts the window no earlier than the first month with data', () => {
    expect(trailingMonthlyAverage(pts, '2026-03', 3, '2026-02')).toBe(100); // (0 + 200) / 2
    expect(trailingMonthlyAverage(pts, '2026-03', 12, '2026-01')).toBe(100); // (100 + 0 + 200) / 3
  });

  it('is null with nothing to average', () => {
    expect(trailingMonthlyAverage([], '2026-03', 12)).toBeNull();
    expect(trailingMonthlyAverage(pts, '2026-03', 12, '2026-06')).toBeNull();
    expect(trailingMonthlyAverage([{ label: '2024-01', value: 5 }], '2026-03', 12)).toBeNull();
  });
});

describe('reports prefs', () => {
  const envs = [
    { id: 'a', name: 'A', category: 'X' }, { id: 'b', name: 'B', category: 'X' },
    { id: 'old', name: 'Old', category: 'X', archived: true },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, name: `E${i}`, category: 'Y' })),
  ];

  it('keeps only existing, active, unique string ids, at most six', () => {
    expect(readEnvelopePicks({ envelopes: ['b', 'a', 'b', 'old', 'gone', 7] }, envs)).toEqual(['b', 'a']);
    expect(readEnvelopePicks({ envelopes: envs.map(e => e.id) }, envs)).toHaveLength(MAX_PICKED_ENVELOPES);
    expect(readEnvelopePicks({ envelopes: 'a' }, envs)).toEqual([]);
    expect(readEnvelopePicks({}, envs)).toEqual([]);
  });

  it('keeps a page-excluded envelope\'s pick when the picker is applied without it', () => {
    // 'b' is picked but currently excluded on the page, so the picker never
    // offered it; applying ['e1', 'a'] must not drop it for good.
    expect(picksToSave(['b', 'a'], ['e1', 'a'], new Set(['b']))).toEqual(['e1', 'a', 'b']);
    // A pick that is not excluded and was unticked is really dropped.
    expect(picksToSave(['b', 'a'], ['e1'], new Set())).toEqual(['e1']);
    expect(picksToSave(undefined, ['a'], new Set(['b']))).toEqual(['a']);
  });

  it('ends the average window at the last complete month when the period runs to today', () => {
    expect(averageWindowEnd(undefined, '2026-09-28')).toEqual({ endYm: '2026-08', endIso: '2026-08-31' });
    expect(averageWindowEnd('2026-09-28', '2026-09-28')).toEqual({ endYm: '2026-08', endIso: '2026-08-31' });
    expect(averageWindowEnd('2026-12-31', '2026-09-28')).toEqual({ endYm: '2026-08', endIso: '2026-08-31' });
    expect(averageWindowEnd(null, '2026-03-01')).toEqual({ endYm: '2026-02', endIso: '2026-02-28' });
    expect(averageWindowEnd(undefined, '2026-01-15')).toEqual({ endYm: '2025-12', endIso: '2025-12-31' });
  });

  it('ends the average window at a period end before today', () => {
    expect(averageWindowEnd('2026-06-30', '2026-09-28')).toEqual({ endYm: '2026-06', endIso: '2026-06-30' });
    expect(averageWindowEnd('2026-06-15', '2026-09-28')).toEqual({ endYm: '2026-06', endIso: '2026-06-15' });
  });

  it('reads top-N and sort with safe defaults', () => {
    expect(readTopNPrefs({})).toEqual({ topN: 12, sort: 'amount' });
    expect(readTopNPrefs({ topN: 5, sort: 'name' })).toEqual({ topN: 5, sort: 'name' });
    expect(readTopNPrefs({ topN: 0 })).toEqual({ topN: 0, sort: 'amount' });
    expect(readTopNPrefs({ topN: 7, sort: 'evil' })).toEqual({ topN: 12, sort: 'amount' });
    expect(readTopNPrefs({ topN: '5' })).toEqual({ topN: 12, sort: 'amount' });
  });

  it('sorts by name with Other last, or leaves amount order alone', () => {
    const rows = [
      { key: 'b', label: 'Beta', value: 30 }, { key: 'a', label: 'alpha', value: 20 },
      { key: null, label: 'Other (3)', value: 99 }, { key: 'c', label: 'Gamma', value: 10 },
    ];
    expect(sortEnvelopeRows(rows, 'name').map(r => r.label)).toEqual(['alpha', 'Beta', 'Gamma', 'Other (3)']);
    expect(sortEnvelopeRows(rows, 'amount')).toEqual(rows);
    expect(sortEnvelopeRows(rows, 'name')).not.toBe(rows);
    expect(sortEnvelopeRows(rows, 'amount')).not.toBe(rows);
  });

  it('counts envelopes: keyed rows plus the number folded into other', () => {
    const rows = [{ key: 'a', label: 'alpha', value: 20 }, { key: 'b', label: 'Beta', value: 30 }];
    expect(envelopeCount({ rows, other: { count: 3, value: 99 } })).toBe(5);
    expect(envelopeCount({ rows: rows.slice(0, 1), other: null })).toBe(1);
    expect(envelopeCount({ rows: [], other: null })).toBe(0);
    // A row with no envelope ("(Unknown)", key null) is not an envelope.
    expect(envelopeCount({ rows: [{ key: null, label: '(Unknown)', value: 5 }, ...rows], other: null })).toBe(2);
  });
});
