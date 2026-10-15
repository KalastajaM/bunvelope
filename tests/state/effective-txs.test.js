// §2.7 — the Monthly Review built its transaction list from
// forecastScheduledTransactions and forecastAllFills only. The first gates on
// `item.as_schedule`, so a plan item that is included in the budget but not
// flagged for auto-posting contributed NOTHING to the review's `scheduled`
// column and nothing to the roll-forward that projects a future month.
//
// v1 has the right function — forecastPlannedExpenses — and it is wired into
// the lens, so the Envelopes and Transactions pages have always seen these
// rows. The Review page just never called it.
//
// §4.6 — this list was a closure over `state` inside review.js, which is why
// the omission survived: nothing could assert what it contained without
// driving a browser. It is a pure function now.
import { describe, it, expect } from 'vitest';
import { forecastRowsFor, buildEffectiveTxList } from '../../js/core/effective-txs.js';

const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
const ENVELOPES = [{ id: 'rent', name: 'Rent' }, { id: 'food', name: 'Food' }];

// Auto-posted: Bunvelope writes this row itself.
const AUTO_ITEM = {
  id: 'bi-rent', envelope_id: 'rent', description: 'Rent', kind: 'expense',
  default_amount: 800, include: true, payment_day: 20,
  monthly_schedule: { ...ALL_MONTHS }, as_schedule: true, account_id: 'a1',
};
// Planned but recorded by hand — 23 of the owner's 67 included items are this.
const HAND_ITEM = {
  id: 'bi-food', envelope_id: 'food', description: 'Food', kind: 'expense',
  default_amount: 400, include: true, payment_day: 25,
  monthly_schedule: { ...ALL_MONTHS }, as_schedule: false,
};

const base = extra => ({
  transactions: [],
  budgetItems: [AUTO_ITEM, HAND_ITEM],
  envelopeTemplates: [],
  accounts: ACCOUNTS,
  envelopes: ENVELOPES,
  today: new Date(2026, 3, 1),
  endStr: '2026-04-30',
  fromStr: '2026-04-01',
  ...extra,
});

const envelopesIn = rows => new Set(rows.map(r => r.envelope_id));

describe('the review’s effective transaction list', () => {
  it('includes BOTH an auto-posted and a hand-recorded plan item', () => {
    // The plan's pinned assertion.
    const rows = forecastRowsFor(base());
    expect(envelopesIn(rows)).toEqual(new Set(['rent', 'food']));
  });

  it('omitted the hand-recorded item when only the scheduled forecaster ran', () => {
    // The defect, reproduced: drop the item that auto-posts and the list is
    // empty, because the hand-recorded one was never anybody's job.
    const rows = forecastRowsFor(base({ budgetItems: [HAND_ITEM] }));
    expect(rows.length).toBeGreaterThan(0);
    expect(envelopesIn(rows)).toEqual(new Set(['food']));
  });

  it('does not double up when an item is flipped to as_schedule', () => {
    // forecastPlannedExpenses ids its rows `planned:${item.id}:${monthKey}`
    // but keys them `${item.id}:${monthKey}` — deliberately the key the
    // materialiser would write — so the two sources dedupe against each other
    // rather than both charging the month.
    const both = { ...HAND_ITEM, as_schedule: true, account_id: 'a1' };
    const rows = forecastRowsFor(base({ budgetItems: [both] }));
    const foodRows = rows.filter(r => r.envelope_id === 'food');
    expect(foodRows).toHaveLength(1);
  });

  it('drops a forecast whose occurrence is already posted', () => {
    const rows = forecastRowsFor(base({
      transactions: [{
        id: 't1', type: 'expense', date: '2026-04-25', status: 'posted',
        amount: 400, envelope_id: 'food', account: 'a1',
        // The dedup key is `${item.id}:${monthKey}` — the id carries a
        // `planned:` prefix, the KEY deliberately does not, because it must
        // match what the materialiser would write.
        from_budget: 'bi-food:2026-04',
      }],
    }));
    expect(envelopesIn(rows)).toEqual(new Set(['rent']));
  });

  it('keeps rows inside the window and drops the rest', () => {
    const rows = forecastRowsFor(base({ endStr: '2026-06-30', fromStr: null }));
    expect(rows.every(r => r.date <= '2026-06-30')).toBe(true);
    // Three months of both items, minus April's already-passed days.
    expect(rows.length).toBeGreaterThan(4);

    const aprilOnly = forecastRowsFor(base());
    expect(aprilOnly.every(r => r.date >= '2026-04-01' && r.date <= '2026-04-30')).toBe(true);
  });

  it('returns the original array identity when there is nothing to add', () => {
    // The balance memoiser is keyed on the array, so a needless copy costs a
    // full recompute.
    const transactions = [];
    const out = buildEffectiveTxList(base({ budgetItems: [], transactions }));
    expect(out).toBe(transactions);
  });

  it('appends rather than mutating when there is', () => {
    const transactions = [{ id: 'r1', type: 'expense', date: '2026-04-02', amount: 5, account: 'a1' }];
    const out = buildEffectiveTxList(base({ transactions }));
    expect(out).not.toBe(transactions);
    expect(transactions).toHaveLength(1);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe(transactions[0]);
  });

  // 2026-09-24 — an occurrence the user deleted is tombstoned in
  // `meta.scheduledTombstones` so the materialiser never writes it again. The
  // Forecast lens and the envelope projection honoured that; this list did
  // not, so the deleted bill came back as a scheduled row on the review.
  it('skips an occurrence the user deleted (tombstoned)', () => {
    const rows = forecastRowsFor(base({ tombstones: ['bi-rent:2026-04'] }));
    expect(envelopesIn(rows)).toEqual(new Set(['food']));
  });

  it('a tombstone for another month leaves this month alone', () => {
    const rows = forecastRowsFor(base({ tombstones: ['bi-rent:2026-03', 42, null, ''] }));
    expect(envelopesIn(rows)).toEqual(new Set(['rent', 'food']));
  });

  it('skips an excluded item entirely', () => {
    const rows = forecastRowsFor(base({
      budgetItems: [{ ...HAND_ITEM, include: false }],
    }));
    expect(rows).toHaveLength(0);
  });
});

// A payment typed in ahead was counted twice on the Review page: once as
// itself in `scheduled`, once as the forecast row the key dedup could not
// match (a hand payment carries no from_budget key). Both bill sources are
// netted now, as in the envelope projection.
describe('payments entered ahead are not counted twice', () => {
  const RENT_PLANNED = { ...AUTO_ITEM, id: 'bi-rent', as_schedule: false, payment_day: 3, default_amount: 800 };
  const april = (txs, items = [RENT_PLANNED, HAND_ITEM]) => forecastRowsFor(base({ transactions: txs, budgetItems: items }));
  const rentRows = rows => rows.filter(r => r.envelope_id === 'rent');
  const pay = (id, envelope_id, date, amount, extra = {}) => ({
    id, type: 'expense', date, amount, envelope_id, account: 'a1', status: 'posted', ...extra,
  });

  it('a planned bill typed in ahead drops its forecast row', () => {
    expect(rentRows(april([]))).toHaveLength(1);
    expect(rentRows(april([pay('r', 'rent', '2026-04-03', 800)]))).toHaveLength(0);
  });

  it('paid a few days early, in the month before, too', () => {
    expect(rentRows(april([pay('r', 'rent', '2026-03-29', 800)]))).toHaveLength(0);
  });

  it('an auto-posted bill paid by hand at the exact amount drops its row', () => {
    expect(rentRows(april([], [AUTO_ITEM, HAND_ITEM]))).toHaveLength(1);
    expect(rentRows(april([pay('r', 'rent', '2026-04-18', 800)], [AUTO_ITEM, HAND_ITEM]))).toHaveLength(0);
  });

  it('each envelope nets against its own spend only', () => {
    // Same-day planned rows in two envelopes; only Food spent. Rent keeps its row.
    const sameDay = { ...RENT_PLANNED, payment_day: 25 };
    const rows = april([pay('f', 'food', '2026-04-24', 400)], [sameDay, HAND_ITEM]);
    expect(rows.filter(r => r.is_planned).map(r => r.envelope_id)).toEqual(['rent']);
  });

  it('nothing entered ahead: the same rows as before', () => {
    expect(april([]).map(r => [r.envelope_id, r.date, r.amount])).toEqual([
      ['rent', '2026-04-03', 800], ['food', '2026-04-25', 400],
    ]);
  });
});

describe('the Review figures for rent typed in ahead', async () => {
  const { runMonthlyReview, rollForwardEnvelopeBalances } = await import('../../js/engine/monthly-review.js');
  const { computeEnvelopeBalances } = await import('../../js/engine/balances.js');
  const RENT = { ...AUTO_ITEM, as_schedule: false, payment_day: 3, default_amount: -800 };
  const TODAY = new Date(2026, 3, 1);
  const txs = [
    { id: 'f', type: 'fill', date: '2026-03-31', status: 'posted', lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }] },
    { id: 'r', type: 'expense', date: '2026-04-03', amount: 800, envelope_id: 'rent', account: 'a1', status: 'posted' },
  ];
  const effective = (endStr, fromStr = null) => buildEffectiveTxList({
    transactions: txs, budgetItems: [RENT], envelopeTemplates: [], accounts: ACCOUNTS,
    envelopes: ENVELOPES, today: TODAY, endStr, fromStr,
  });
  const balances = computeEnvelopeBalances(txs, { asOf: TODAY });

  it('April schedules one rent, and the envelope ends the month at zero', () => {
    const row = runMonthlyReview(ENVELOPES, [RENT], balances, effective('2026-04-30', '2026-04-01'), '2026-04', TODAY)
      .find(r => r.envelope_id === 'rent');
    expect(row.scheduled).toBe(800);
    expect(row.projected).toBe(0);
  });

  it('rolling forward to June does not carry a second rent', () => {
    const rolled = rollForwardEnvelopeBalances(ENVELOPES, [RENT], balances, effective('2026-06-30'), '2026-06', TODAY);
    // April: 800 − 800 + deposit 800; May: 800 − 800 + 800.
    expect(rolled.get('rent')).toBe(800);
  });
});
