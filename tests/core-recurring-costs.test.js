import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery, runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { recurringLeadDays } from '../js/core/recurring-review.js';
const ctx = makeCtx({ now: new Date(2026, 9, 7, 12), newId: () => 'new' });
const every = Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => [m, true]));
const item = (extra = {}) => ({ id: 'music', kind: 'expense', description: 'Music', default_amount: -10, include: true, as_schedule: true, account_id: 'bank', payment_day: 15, monthly_schedule: every, ...extra });
const data = (items = [item()], extra = {}) => ({ meta: {}, accounts: [{ id: 'bank', type: 'checking', name: 'Bank' }], envelopes: [], envelopeTemplates: [], transactions: [], budgetItems: items, ...extra });
function query(d) { const r = runQuery(registry, d, 'recurring.costs', {}, ctx); expect(r.ok).toBe(true); return r.value; }
describe('recurring costs', () => {
  it('distinguishes annual payments from monthly equivalents and excludes buffers and non-expenses', () => {
    const r = query(data([item({ monthly_schedule: { Nov: true }, default_amount: -120, extra_buffer: 500 }), item({ id: 'income', kind: 'income' }), item({ id: 'transfer', kind: 'account_transfer' }), item({ id: 'manual', as_schedule: false })]));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ annual: 120, monthly: 10, next: { date: '2026-11-15', amount: 120 } });
    expect(r.totals).toMatchObject({ annual: 120, monthly: 10 });
  });
  it('honours dates, pauses, skipped months and custom prices without changing the source', () => {
    const d = data([item({ end_month: '2026-12', skipped_occurrences: ['2026-11'], monthly_schedule: { Oct: true, Nov: true, Dec: 25 } }), item({ id: 'paused', include: false }), item({ id: 'ended', end_month: '2026-09' }), item({ id: 'future', start_month: '2027-09' })]);
    const before = structuredClone(d);
    const r = query(d);
    expect(r.items.map(it => [it.status, it.annual])).toEqual([['active',35],['paused',0],['ended',0],['upcoming',10]]);
    expect(d).toEqual(before);
  });
  it('does not offer paid or deleted occurrences as the next payment', () => {
    const r = query(data([item()], { meta: { scheduledTombstones: ['music:2026-11'] }, transactions: [{ from_budget: 'music:2026-10' }] }));
    expect(r.items[0].next.date).toBe('2026-12-15');
    expect(r.totals.annual).toBe(110);
  });
  it('flags overdue and upcoming deadlines, but not paused and ended items', () => {
    const reminders = { review_on: '2026-10-01', cancel_by: '2026-11-06', renews_on: '2026-12-01' };
    const r = query(data([item({ recurring_review: reminders }), item({ id: 'paused', include: false, recurring_review: reminders })]));
    expect(r.items[0].reminders.map(r => r.due)).toEqual([true,true,false]);
    expect(r.totals.attention).toBe(1);
  });
  it('uses the shared bank-day adjustment', () => {
    const r = query(data([item({ payment_day: 10, schedule_day_type: 'next_work_day' })]));
    expect(r.items[0].next.date).toBe('2026-10-12');
  });
  it('persists and clears reminder metadata through the existing command without altering payments', () => {
    const d = data();
    const r = runCommand(registry, d, 'budgetItem.update', { id: 'music', fields: { recurring_review: { review_on: '2026-10-20', notes: 'Compare providers' } } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value.after.budgetItems[0]).toEqual({ ...d.budgetItems[0], recurring_review: { review_on: '2026-10-20', notes: 'Compare providers' } });
    const clear = runCommand(registry, r.value.after, 'budgetItem.update', { id: 'music', fields: { recurring_review: null } }, ctx);
    expect(clear.ok).toBe(true);
    expect(query(clear.value.after).items[0].reminders).toEqual([]);
    const bad = runCommand(registry, d, 'budgetItem.update', { id: 'music', fields: { recurring_review: { review_on: '2026-02-30' } } }, ctx);
    expect(bad.ok).toBe(false);
  });
});

describe('recurring tracking controls', () => {
  const at = date => makeCtx({ now: new Date(...date), newId: () => 'new' });
  const costsAt = (d, date) => runQuery(registry, d, 'recurring.costs', {}, at(date)).value;

  it('starts a renewal reminder exactly the chosen number of calendar days before it', () => {
    const d = data([item({ recurring_review: { renews_on: '2026-12-31', reminder_days: 30 } })]);
    expect(costsAt(d, [2026, 10, 30, 12]).items[0]).toMatchObject({ attention: false, reminders: [{ remindFrom: '2026-12-01', due: false }] });
    expect(costsAt(d, [2026, 11, 1, 12]).items[0].attention).toBe(true);
    expect(costsAt(d, [2026, 11, 31, 12]).items[0].attention).toBe(true);
  });

  it('supports same-day reminders, DST, year boundaries and leap days', () => {
    for (const [date, days, from] of [
      ['2026-12-31', 0, '2026-12-31'],
      ['2027-01-05', 10, '2026-12-26'],
      ['2026-03-30', 2, '2026-03-28'],
      ['2026-10-26', 2, '2026-10-24'],
      ['2028-03-01', 1, '2028-02-29'],
    ]) {
      const r = query(data([item({ recurring_review: { renews_on: date, reminder_days: days } })]));
      expect(r.items[0].reminders[0].remindFrom).toBe(from);
    }
  });

  it('uses the lead time for cancellation and end dates, but Review on is exact', () => {
    const r = query(data([item({ end_month: '2026-12', recurring_review: { review_on: '2026-10-08', cancel_by: '2026-10-10', reminder_days: 10 } })]));
    expect(r.items[0].reminders).toEqual([
      { kind: 'cancel_by', date: '2026-10-10', remindFrom: '2026-09-30', due: true },
      { kind: 'review_on', date: '2026-10-08', remindFrom: '2026-10-08', due: false },
      { kind: 'ends_on', date: '2026-12-31', remindFrom: '2026-12-21', due: false },
    ]);
  });

  it('uses an explicit agreement end date ahead of the plan end', () => {
    const r = query(data([item({ end_month: '2026-12', recurring_review: { ends_on: '2026-11-15' } })]));
    expect(r.items[0].reminders[0]).toMatchObject({ date: '2026-11-15', remindFrom: '2026-10-01' });
  });

  it('hides reminders and tracked costs while keeping the schedule and metadata for unhide', () => {
    const d = data([item({ recurring_review: { hidden: true, category: ' Streaming ', review_on: '2026-10-01', notes: 'Keep me' } })]);
    const r = query(d);
    expect(r.items[0]).toMatchObject({ annual: 120, monthly: 10, hidden: true, category: 'Streaming', notes: 'Keep me', reminders: [], attention: false });
    expect(r.totals).toEqual({ annual: 0, monthly: 0, attention: 0, tracked: 0, hidden: 1 });
    const restored = runCommand(registry, d, 'budgetItem.update', { id: 'music', fields: { recurring_review: { ...d.budgetItems[0].recurring_review, hidden: false } } }, ctx);
    expect(restored.ok).toBe(true);
    expect(restored.value.after.budgetItems[0]).toMatchObject({ as_schedule: true, include: true, monthly_schedule: every });
    expect(query(restored.value.after).totals).toEqual({ annual: 120, monthly: 10, attention: 1, tracked: 1, hidden: 0 });
  });

  it('validates reminder lead times and accepts category/visibility through the command', () => {
    for (const days of [-1, 0.5, 3651, '30']) {
      const r = runCommand(registry, data(), 'budgetItem.update', { id: 'music', fields: { recurring_review: { reminder_days: days } } }, ctx);
      expect(r.ok).toBe(false);
    }
    const r = runCommand(registry, data(), 'budgetItem.update', { id: 'music', fields: { recurring_review: { reminder_days: 0, hidden: true, category: 'Insurance', ends_on: '2026-12-31' } } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.value.after.budgetItems[0].recurring_review).toEqual({ reminder_days: 0, hidden: true, category: 'Insurance', ends_on: '2026-12-31' });
  });
});

describe('linked recurring reminders', () => {
  it('produces one reminder from the earlier cancellation deadline, ignoring a legacy review date', () => {
    const review = { linked_reminder: true, renews_on: '2026-12-31', cancel_by: '2026-11-30', reminder_days: 30, review_on: '2026-09-01' };
    const d = data([item({ end_month: '2027-12', recurring_review: review })]);
    const saved = runCommand(registry, d, 'budgetItem.update', { id: 'music', fields: { recurring_review: review } }, ctx);
    expect(saved.ok).toBe(true);
    expect(query(saved.value.after).items[0].reminders).toEqual([
      { kind: 'cancel_by', date: '2026-11-30', remindFrom: '2026-10-31', due: false },
    ]);
  });
  it('uses one explicit end or fallback date and preserves standalone legacy reminders', () => {
    for (const [review, expected] of [
      [{ ends_on: '2026-12-31', reminder_days: 0 }, { kind: 'ends_on', date: '2026-12-31', remindFrom: '2026-12-31', due: false }],
      [{ renews_on: '2026-12-31', cancel_by: '2027-01-02' }, { kind: 'renews_on', date: '2026-12-31', remindFrom: '2026-11-16', due: false }],
      [{ review_on: '2026-10-01' }, { kind: 'review_on', date: '2026-10-01', remindFrom: '2026-10-01', due: true }],
    ]) {
      expect(query(data([item({ recurring_review: { ...review, linked_reminder: true } })])).items[0].reminders).toEqual([expected]);
    }
    expect(query(data([item({ end_month: '2026-12', recurring_review: { linked_reminder: true } })])).items[0].reminders).toHaveLength(1);
  });
  it.each([
    ['2026-03-30', '2026-03-28', 2],
    ['2026-10-26', '2026-10-24', 2],
    ['2028-03-01', '2028-02-29', 1],
    ['2027-01-05', '2026-12-26', 10],
    ['2026-12-31', '2026-12-31', 0],
  ])('converts dates into calendar lead days: %s and %s', (deadline, reminder, days) => {
    expect(recurringLeadDays(deadline, reminder)).toBe(days);
  });
});

describe('continuous agreement tracking', () => {
  it('records start/continuous metadata without changing payments, and ignores all deadline fallbacks', () => {
    const d = data([item({ end_month: '2026-12' })]);
    const baseline = query(d).items[0];
    const saved = runCommand(registry, d, 'budgetItem.update', { id: 'music', fields: { recurring_review: {
      starts_on: '2025-01-15', continuous: true, linked_reminder: true,
      renews_on: '2026-11-01', ends_on: '2026-12-01', cancel_by: '2026-10-01',
    } } }, ctx);
    expect(saved.ok).toBe(true);
    const result = query(saved.value.after).items[0];
    expect(result).toMatchObject({ startsOn: '2025-01-15', continuous: true, reminders: [], annual: baseline.annual, next: baseline.next });
    const review = saved.value.after.budgetItems[0].recurring_review;
    review.review_on = '2026-10-07';
    expect(query(saved.value.after).items[0].reminders).toEqual([{ kind: 'review_on', date: '2026-10-07', remindFrom: '2026-10-07', due: true }]);
  });
});

describe('recurring category totals', () => {
  it('groups case-insensitively and excludes hidden costs, rounding monthly totals after summing', () => {
    const result = query(data([
      item({ monthly_schedule: { Nov: true }, default_amount: -1, recurring_review: { category: ' Streaming ' } }),
      item({ id: 'second', monthly_schedule: { Nov: true }, default_amount: -1, recurring_review: { category: 'streaming' } }),
      item({ id: 'hidden', recurring_review: { category: 'Streaming', hidden: true } }),
      item({ id: 'uncategorized', default_amount: -20 }),
      item({ id: 'hiddenOnly', recurring_review: { category: 'Insurance', hidden: true } }),
    ]));
    expect(result.categories).toEqual([
      { key: JSON.stringify('streaming'), category: 'Streaming', annual: 2, monthly: 0.17 },
      { key: 'null', category: null, annual: 240, monthly: 20 },
      { key: JSON.stringify('insurance'), category: 'Insurance', annual: 0, monthly: 0 },
    ]);
    expect(result.totals.annual).toBe(242);
  });
});

describe('recurring account and envelope views', () => {
  it('joins payment accounts and envelopes by ID, totals every view without hidden items, and separates Unallocated', () => {
    const d = data([
      item({ id: 'a', account_id: 'bank', envelope_id: 'home', recurring_review: { renews_on: '2027-01-01' } }),
      item({ id: 'b', default_amount: -20, account_id: 'other', envelope_id: 'bills', recurring_review: { renews_on: '2026-12-01' } }),
      item({ id: 'c', default_amount: -30, account_id: null, envelope_id: null }),
      item({ id: 'd', default_amount: -40, envelope_id: 'misc', recurring_review: { continuous: true, renews_on: '2026-01-01' } }),
      item({ id: 'hidden', default_amount: -100, envelope_id: 'home', recurring_review: { hidden: true } }),
    ], {
      accounts: [{ id: 'bank', name: 'Same name' }, { id: 'other', name: 'Same name', archived: true }],
      envelopes: [{ id: 'home', name: 'Home', category: 'Housing' }, { id: 'bills', name: 'Bills', category: 'housing' }, { id: 'misc', name: 'Misc' }],
    });
    const r = query(d);
    expect(r.groups.account.map(g => [g.key, g.annual])).toEqual([[JSON.stringify('bank'), 600], [JSON.stringify('other'), 240], ['null', 360]]);
    expect(r.groups.envelope.map(g => [g.label, g.annual])).toEqual([['Home', 120], ['Bills', 240], [null, 360], ['Misc', 480]]);
    expect(r.groups.envelopeCategory.map(g => [g.key, g.annual])).toEqual([[JSON.stringify('housing'), 360], ['unallocated', 360], ['null', 480]]);
    expect(r.groups.none).toMatchObject([{ key: 'all', annual: 1200, monthly: 100 }]);
    expect(r.items[0]).toMatchObject({ accountId: 'bank', accountName: 'Same name', envelopeId: 'home', envelopeCategory: 'Housing', renewsOn: '2027-01-01' });
    expect(r.items[3].renewsOn).toBeNull();
  });
});

describe('default recurring reminder interval', () => {
  it('uses 45 days only when an interval has not been saved', () => {
    for (const [saved, expectedDays, expectedDate] of [
      [undefined, 45, '2026-11-16'], [30, 30, '2026-12-01'], [0, 0, '2026-12-31'],
    ]) {
      const review = { linked_reminder: true, renews_on: '2026-12-31' };
      if (saved !== undefined) review.reminder_days = saved;
      const r = query(data([item({ recurring_review: review })])).items[0];
      expect(r.reminderDays).toBe(expectedDays);
      expect(r.reminders[0].remindFrom).toBe(expectedDate);
    }
  });
});
