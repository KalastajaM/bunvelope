import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { runMonthlyReview } from '../js/engine/monthly-review.js';

const months = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));
function fixture() {
  const lines = [{ envelope_id: 'groc', mode: 'add', amount: 300 }, { envelope_id: 'food', mode: 'add', amount: 150 }];
  return {
    meta: {}, accounts: [],
    envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'food', name: 'Food & Drinks' }],
    budgetItems: ['groc', 'food'].map((id, i) => ({
      id: `${id}-plan`, envelope_id: id, kind: 'expense', include: true,
      default_amount: i ? -300 : -600, monthly_schedule: months,
    })),
    envelopeTemplates: [1, 15].map(day => ({
      id: `fill-${day}`, name: `Fill ${day}`, kind: 'manual', lines,
      schedule: { enabled: true, payment_day: day, day_type: 'exact', since: '2026-10-01', months },
    })),
    transactions: [{ id: 'first', type: 'fill', status: 'posted', date: '2026-10-01', from_budget: 'tpl:fill-1:2026-10', lines }],
  };
}
function review(data, month = '2026-10', now = new Date(2026, 9, 6, 12)) {
  const result = runQuery(registry, data, 'review.month', { month }, makeCtx({ now, newId: () => 'unused' }));
  expect(result.ok).toBe(true);
  return Object.fromEntries(result.value.rows.map(row => [row.envelope_id, row]));
}

describe('review.month includes both monthly fill templates', () => {
  it('credits the remaining fill and keeps fills out of spending', () => {
    const rows = review(fixture());
    for (const id of ['groc', 'food']) {
      expect(rows[id]).toMatchObject({ projected: 0, need: 0, actual: 0 });
    }
    expect(rows.groc.balance).toBe(300);
    expect(rows.food.balance).toBe(150);
  });

  it('resolves two dynamic templates funding half of the monthly plan each', () => {
    const data = fixture();
    data.envelopeTemplates = data.envelopeTemplates.map(template => ({
      ...template, kind: 'dynamic', lines: [],
      assignments: ['groc', 'food'].map(envelope_id => ({ envelope_id, percent: 50, mode: 'add' })),
    }));
    expect(review(data).groc).toMatchObject({ projected: 0, need: 0 });
    expect(review(data).food).toMatchObject({ projected: 0, need: 0 });
  });

  it('includes a future-dated stored fill once instead of also generating it', () => {
    const data = fixture();
    data.transactions.push({ ...data.transactions[0], id: 'second', date: '2026-10-15', from_budget: 'tpl:fill-15:2026-10' });
    expect(review(data).groc).toMatchObject({ balance: 300, projected: 0, need: 0 });
    expect(review(data, '2026-10', new Date(2026, 9, 15, 12)).groc)
      .toMatchObject({ balance: 600, projected: 0, need: 0 });
  });

  it('does not count the second occurrence twice once posted early', () => {
    const data = fixture();
    data.transactions.push({ ...data.transactions[0], id: 'second', date: '2026-10-06', from_budget: 'tpl:fill-15:2026-10' });
    expect(review(data).groc).toMatchObject({ balance: 600, projected: 0, need: 0 });
  });

  it('does not anticipate deleted or disabled fills', () => {
    const data = fixture();
    data.meta.scheduledTombstones = ['tpl:fill-15:2026-10'];
    expect(review(data).groc.need).toBe(300);
    delete data.meta.scheduledTombstones;
    data.envelopeTemplates[1].schedule.enabled = false;
    expect(review(data).food.need).toBe(150);
  });

  it('counts both fills before either is posted, including an empty opening balance', () => {
    const data = fixture();
    data.transactions = [];
    // Both occurrences are still ahead of this clock.
    data.envelopeTemplates[0].schedule.payment_day = 7;
    expect(review(data).groc).toMatchObject({ balance: 0, projected: 0, need: 0 });
  });

  it('does not add an assumed monthly deposit on top of next month’s templates', () => {
    const rows = review(fixture(), '2026-11');
    expect(rows.groc).toMatchObject({ balance: 0, projected: 0, need: 0 });
    expect(rows.food).toMatchObject({ balance: 0, projected: 0, need: 0 });
  });

  it('deducts a source envelope’s outgoing fill', () => {
    const data = fixture();
    data.envelopes.push({ id: 'source', name: 'Source' });
    data.envelopeTemplates[1].schedule.source_envelope_id = 'source';
    data.envelopeTemplates[1].schedule.source_since = '2026-10-01';
    expect(review(data).source).toMatchObject({ projected: -450, need: 450 });
  });

  it('preserves a genuine reserve requirement after the fills cover spending', () => {
    const data = fixture();
    data.budgetItems[0].extra_buffer = 50;
    expect(review(data).groc).toMatchObject({ projected: 0, required: 50, need: 50 });
  });
});

it('walks Set fills in date order, using the balance after earlier spending', () => {
  const txs = [
    { type: 'expense', date: '2026-10-20', envelope_id: 'groc', amount: 20 },
    { type: 'fill', date: '2026-10-15', lines: [{ envelope_id: 'groc', mode: 'set', amount: 150 }] },
    { type: 'expense', date: '2026-10-10', envelope_id: 'groc', amount: 10 },
  ];
  const row = runMonthlyReview([{ id: 'groc', name: 'Groceries' }], [], new Map([['groc', 100]]), txs, '2026-10', new Date(2026, 9, 6))[0];
  expect(row.projected).toBe(130);
});
