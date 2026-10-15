// tests/engine/history-tz.test.js — pin the month-boundary behavior of
// computeEnvelopeBalanceHistory across timezones.
//
// tx.date is a YYYY-MM-DD string. `new Date('YYYY-MM-DD')` parses as UTC
// midnight, while the end-of-month cutoff is built from local components —
// in UTC-negative zones that lands a first-of-month transaction in the
// *previous* month's end-of-month bucket. The engine convention
// (balances.js filterTxs) is lexicographic string comparison, which is
// timezone-free; this suite locks computeEnvelopeBalanceHistory to it.
//
// TZ must be set before any Date use in this process; Node ≥13 re-reads
// process.env.TZ on change, and vitest's per-file isolation keeps the
// override from leaking into other test files.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';
import { computeEnvelopeBalanceHistory } from '../../js/engine/history.js';

describe('computeEnvelopeBalanceHistory month boundaries (UTC-negative zone)', () => {
  it('keeps a first-of-month transaction out of the previous month bucket', () => {
    const txs = [
      { type: 'expense', envelope_id: 'food', amount: 40, date: '2026-01-10' },
      { type: 'expense', envelope_id: 'food', amount: 60, date: '2026-02-01' },
    ];
    // refDate mid-February local time; two months → Jan and Feb buckets.
    const { months, totals } = computeEnvelopeBalanceHistory(txs, 2, new Date(2026, 1, 15));
    expect(months).toEqual(['2026-01', '2026-02']);
    // January must contain only the Jan 10 expense; before the fix the
    // Feb 1 row (UTC midnight = Jan 31 16:00 in Los Angeles) leaked in.
    expect(totals[0]).toEqual({ label: '2026-01', value: -40 });
    expect(totals[1]).toEqual({ label: '2026-02', value: -100 });
  });

  it('includes a last-of-month transaction in its own month bucket', () => {
    const txs = [
      { type: 'expense', envelope_id: 'food', amount: 25, date: '2026-01-31' },
    ];
    const { totals } = computeEnvelopeBalanceHistory(txs, 2, new Date(2026, 1, 15));
    expect(totals[0]).toEqual({ label: '2026-01', value: -25 });
    expect(totals[1]).toEqual({ label: '2026-02', value: -25 });
  });

  it('still includes undated transactions in every bucket', () => {
    const txs = [
      { type: 'expense', envelope_id: 'food', amount: 10, date: undefined },
    ];
    const { totals } = computeEnvelopeBalanceHistory(txs, 1, new Date(2026, 1, 15));
    expect(totals[0].value).toBe(-10);
  });
});
