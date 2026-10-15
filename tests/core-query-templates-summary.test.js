import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const months = Object.fromEntries(MONTHS.map(m => [m, true]));
const schedule = (over = {}) => ({ enabled: true, payment_day: 25, day_type: 'exact', since: '2026-01-01', months, ...over });
const template = (over = {}) => ({ id: 'payday', name: 'Payday', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'add', amount: 60 }], schedule: schedule(), ...over });
function freeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); }
  return o;
}
const data = (over = {}) => freeze({
  meta: { country: 'FI' }, accounts: [], envelopes: [{ id: 'food' }, { id: 'old', archived: true }],
  transactions: [], budgetItems: [], envelopeTemplates: [template()], ...over,
});
const ctx = () => makeCtx({ now: new Date(2026, 8, 15, 12), newId: () => { throw new Error('query must not allocate IDs'); } });
const ask = (d, input = {}) => runQuery(registry, d, 'templates.summary', input, ctx());
const row = (d, input) => {
  const r = ask(d, input);
  expect(r.ok).toBe(true);
  expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  return r.value.templates[0];
};

describe('templates.summary', () => {
  it('reports manual lines and their absolute total, not a set-target delta', () => {
    const d = data({ envelopeTemplates: [template({ lines: [
      { envelope_id: 'food', mode: 'set', amount: 350 },
      { envelope_id: 'old', mode: 'add', amount: -40 },
      { envelope_id: 'gone', mode: 'add', amount: 1.234 },
    ] })] });
    const before = JSON.stringify(d);
    const result = row(d);
    expect(result).toEqual({
      id: 'payday', lineCount: 3, total: 391.23,
      resolvedLines: [
        { envelope_id: 'food', mode: 'set', amount: 350 },
        { envelope_id: 'old', mode: 'add', amount: -40 },
        { envelope_id: 'gone', mode: 'add', amount: 1.23 },
      ],
      nextPending: { date: '2026-09-25', monthKey: '2026-09' },
    });
    result.resolvedLines[0].amount = 0;
    expect(JSON.stringify(d)).toBe(before);
  });

  it('resolves dynamic assignments from the dated plan, retaining stored assignment count', () => {
    const item = (id, envelope, amount, over = {}) => ({ id, envelope_id: envelope, kind: 'expense', include: true, default_amount: -amount, monthly_schedule: months, ...over });
    const d = data({
      budgetItems: [
        item('base', 'food', 100), item('ended', 'food', 999, { end_month: '2026-08' }),
        item('future', 'food', 60, { start_month: '2027-03' }),
        item('paused', 'food', 999, { include: false }), item('archived', 'old', 10),
      ],
      envelopeTemplates: [template({ kind: 'dynamic', lines: undefined, assignments: [
        { envelope_id: 'food', mode: 'set', percent: 50 },
        { envelope_id: 'old', percent: 100 }, { envelope_id: 'gone', percent: 100 },
      ] })],
    });
    const answer = row(d);
    // Six months of the future 60/month plan = 30/month over the dated year.
    expect(answer.resolvedLines).toEqual([
      { envelope_id: 'food', mode: 'set', amount: 65 },
      { envelope_id: 'old', mode: 'add', amount: 10 },
    ]);
    expect(answer.lineCount).toBe(3);
    expect(answer.total).toBe(75);
    expect(row(d, { date: '2027-03-01' }).resolvedLines[0].amount).toBe(80);
  });

  it('skips posted, tombstoned and skipped occurrences and ignores unrelated keys', () => {
    const d = data({
      transactions: [{ id: 'posted', from_budget: 'tpl:payday:2026-09' }],
      meta: { scheduledTombstones: ['tpl:payday:2026-10', 'tpl:other:2026-12'] },
      envelopeTemplates: [template({ schedule: schedule({ skipped: ['2026-11'] }) })],
    });
    expect(row(d).nextPending).toEqual({ date: '2026-12-25', monthKey: '2026-12' });
  });

  it('finds an annual occurrence beyond the old two-month card horizon', () => {
    expect(row(data({ envelopeTemplates: [template({ schedule: schedule({ payment_day: 5, months: { Sep: true } }) })] })).nextPending)
      .toEqual({ date: '2027-09-05', monthKey: '2027-09' });
  });

  it('retains an October occurrence paid in November and its original month key', () => {
    const d = data({ envelopeTemplates: [template({ schedule: schedule({ payment_day: 31, day_type: 'next_work_day' }) })] });
    expect(row(d, { date: '2026-11-01' }).nextPending).toEqual({ date: '2026-11-02', monthKey: '2026-10' });
  });

  it('retains a January occurrence paid in December by a previous-work-day rule', () => {
    const d = data({ envelopeTemplates: [template({ schedule: schedule({ payment_day: 1, day_type: 'prev_work_day', since: '2027-01-01', months: { Jan: true } }) })] });
    expect(row(d, { date: '2026-12-30' }).nextPending).toEqual({ date: '2026-12-31', monthKey: '2027-01' });
  });

  it('uses the budget country for the payment date', () => {
    const templates = [template({ schedule: schedule({ payment_day: 6, day_type: 'next_work_day', since: '2027-01-01', months: { Jan: true } }) })];
    expect(row(data({ envelopeTemplates: templates }), { date: '2026-12-31' }).nextPending.date).toBe('2027-01-07');
    expect(row(data({ meta: { country: 'US' }, envelopeTemplates: templates }), { date: '2026-12-31' }).nextPending.date).toBe('2027-01-06');
  });

  it.each([
    { schedule: undefined }, { schedule: schedule({ enabled: false }) },
    { schedule: schedule({ until: '2026-08-31' }) }, { lines: [] },
    { lines: [{ envelope_id: 'old', mode: 'add', amount: 10 }] },
    { schedule: schedule({ since: '2028-01-01' }) },
  ])('returns null when there is no eligible future fill in the search window: %j', over => {
    expect(row(data({ envelopeTemplates: [template(over)] })).nextPending).toBeNull();
  });

  it('returns selected templates in stored order and rejects unknown IDs or invalid dates', () => {
    const d = data({ envelopeTemplates: [template(), template({ id: 'second' })] });
    expect(ask(d, { templates: ['second', 'payday'] }).value.templates.map(t => t.id)).toEqual(['payday', 'second']);
    expect(ask(d, { templates: ['second'] }).value.templates.map(t => t.id)).toEqual(['second']);
    expect(ask(d, { templates: [] }).value.templates).toEqual([]);
    expect(ask(data({ envelopeTemplates: [] })).value.templates).toEqual([]);
    expect(ask(d, { templates: ['missing'] }).error.code).toBe('bad_input');
    expect(ask(d, { date: '2026-02-30' }).error.code).toBe('bad_input');
  });
});
