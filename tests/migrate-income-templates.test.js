// Conversion of the income→template link onto the template's own schedule.
//
// This runs once against real budget data and rewrites `from_budget` on
// already-posted fills, so the cases that matter are the ones where getting it
// wrong is silent: months that should not start filling, and posted
// allocations the template materialiser would otherwise re-post on top of.

import { describe, it, expect } from 'vitest';
import { convertIncomeLinkedTemplates } from '../js/core/migrate-income-templates.js';
import { materializeDueTemplateFills } from '../js/engine/scheduling.js';

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const template = (over = {}) => ({ id: 'tpl1', name: 'Salary Split', kind: 'manual', lines: [], ...over });
const income = (over = {}) => ({
  id: 'inc1', kind: 'income', as_schedule: true, template_id: 'tpl1',
  account_id: 'a1', payment_day: 25, default_amount: 2000,
  monthly_schedule: { ...allMonths }, ...over,
});

describe('convertIncomeLinkedTemplates', () => {
  it('is a no-op with nothing linked, returning inputs by identity', () => {
    const budgetItems = [income({ template_id: null })];
    const envelopeTemplates = [template()];
    const transactions = [];
    const out = convertIncomeLinkedTemplates({ budgetItems, envelopeTemplates, transactions });
    expect(out.changed).toBe(false);
    expect(out.budgetItems).toBe(budgetItems);
    expect(out.envelopeTemplates).toBe(envelopeTemplates);
    expect(out.transactions).toBe(transactions);
  });

  it('moves the calendar onto the template and clears the link', () => {
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income({
        schedule_day_type: 'prev_work_day',
        as_schedule_since: '2026-01-01',
        as_schedule_until: '2027-12-31',
        skipped_occurrences: ['2026-07'],
      })],
      envelopeTemplates: [template()],
      transactions: [],
    });
    expect(out.changed).toBe(true);
    expect(out.budgetItems[0].template_id).toBeNull();

    const sched = out.envelopeTemplates[0].schedule;
    expect(sched.enabled).toBe(true);
    expect(sched.payment_day).toBe(25);
    expect(sched.day_type).toBe('prev_work_day');
    expect(sched.since).toBe('2026-01-01');
    expect(sched.until).toBe('2027-12-31');
    expect(sched.skipped).toEqual(['2026-07']);
    expect(Object.values(sched.months).every(Boolean)).toBe(true);
  });

  it('leaves zero-amount months OFF, so nothing starts filling that does not today', () => {
    // The whole point of preserving rather than fixing during conversion: a
    // month with no income produces no fill now, and must not begin to.
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income({ monthly_schedule: { ...allMonths, Jul: 0, Aug: false } })],
      envelopeTemplates: [template()],
      transactions: [],
    });
    const months = out.envelopeTemplates[0].schedule.months;
    expect(months.Jul).toBe(false);
    expect(months.Aug).toBe(false);
    expect(months.Jun).toBe(true);
  });

  it('reads a per-month amount override rather than assuming default_amount', () => {
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income({ default_amount: 0, monthly_schedule: { ...allMonths, Mar: 1500 } })],
      envelopeTemplates: [template()],
      transactions: [],
    });
    const months = out.envelopeTemplates[0].schedule.months;
    // default_amount 0 means every `true` month resolves to nothing...
    expect(months.Jan).toBe(false);
    // ...except the one carrying its own number.
    expect(months.Mar).toBe(true);
  });

  it('rewrites from_budget on posted fills so they are not re-posted', () => {
    // The silent double-allocation: the template materialiser looks for
    // `tpl:<id>:<month>` and would find no record of what already landed.
    const posted = [
      { id: 't1', type: 'income', from_budget: 'inc1:2026-08' },
      { id: 't2', type: 'fill', from_budget: 'inc1:2026-08:fill' },
      { id: 't3', type: 'fill', from_budget: 'inc1:2026-07:fill' },
      { id: 't4', type: 'fill', from_budget: 'other:2026-08:fill' },
      { id: 't5', type: 'fill' },
    ];
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income()], envelopeTemplates: [template()], transactions: posted,
    });
    const byId = Object.fromEntries(out.transactions.map(t => [t.id, t]));
    expect(byId.t2.from_budget).toBe('tpl:tpl1:2026-08');
    expect(byId.t3.from_budget).toBe('tpl:tpl1:2026-07');
    // The income leg keeps its own key, and other items are untouched.
    expect(byId.t1.from_budget).toBe('inc1:2026-08');
    expect(byId.t4.from_budget).toBe('other:2026-08:fill');
    expect(byId.t5.from_budget).toBeUndefined();
  });

  it('is idempotent — a second pass over converted data changes nothing', () => {
    const first = convertIncomeLinkedTemplates({
      budgetItems: [income()],
      envelopeTemplates: [template()],
      transactions: [{ id: 't2', type: 'fill', from_budget: 'inc1:2026-08:fill' }],
    });
    const second = convertIncomeLinkedTemplates(first);
    expect(second.changed).toBe(false);
    expect(second.transactions).toBe(first.transactions);
    expect(second.envelopeTemplates).toBe(first.envelopeTemplates);
  });

  it('keeps a schedule someone set deliberately, and says so', () => {
    const deliberate = { enabled: true, payment_day: 1, months: { ...allMonths } };
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income({ payment_day: 25 })],
      envelopeTemplates: [template({ schedule: deliberate })],
      transactions: [],
    });
    expect(out.envelopeTemplates[0].schedule.payment_day).toBe(1);
    expect(out.budgetItems[0].template_id).toBeNull();
    expect(out.notes).toContainEqual({
      kind: 'kept-existing-schedule', itemId: 'inc1', templateId: 'tpl1',
    });
  });

  it('reports when two income items share one template — a calendar it cannot hold', () => {
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income(), income({ id: 'inc2', payment_day: 15 })],
      envelopeTemplates: [template()],
      transactions: [],
    });
    expect(out.envelopeTemplates[0].schedule.payment_day).toBe(25); // first wins
    expect(out.notes).toContainEqual({
      kind: 'shared-template', itemId: 'inc2', templateId: 'tpl1', keptItemId: 'inc1',
    });
    // Both links still go: leaving one behind would break allocation outright
    // once the income-linked runtime is gone.
    expect(out.budgetItems.every(i => i.template_id === null)).toBe(true);
  });

  describe('does not backfill months the income link never allocated', () => {
    // Salary scheduled since 2025-01; the template was linked in 2026-06, so
    // only 2026-06 onwards ever carried a fill. The user deleted the 2026-07
    // fill (tombstoned). Converting must post nothing for past months.
    const months = [];
    for (let y = 2025, m = 1; y < 2026 || m <= 8; m++) {
      if (m > 12) { m = 1; y++; }
      months.push(`${y}-${String(m).padStart(2, '0')}`);
    }
    const incomeRows = months.map(mk => ({
      id: `i-${mk}`, type: 'income', amount: 2000, date: `${mk}-25`, status: 'posted', account: 'a1', from_budget: `inc1:${mk}`,
    }));
    const fills = ['2026-06', '2026-08'].map(mk => ({
      id: `f-${mk}`, type: 'fill', date: `${mk}-25`, status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'e1', amount: 100, mode: 'add' }], from_budget: `inc1:${mk}:fill`,
    }));
    const input = () => ({
      budgetItems: [income({ as_schedule_since: '2025-01-01' })],
      envelopeTemplates: [template({ lines: [{ envelope_id: 'e1', amount: 100, mode: 'add' }] })],
      transactions: [...incomeRows, ...fills],
      meta: { schemaVersion: 8, scheduledTombstones: ['inc1:2026-07:fill', 'other:2026-07'] },
    });

    it('starts the schedule after the last month the income item posted', () => {
      const out = convertIncomeLinkedTemplates(input());
      expect(out.envelopeTemplates[0].schedule.since).toBe('2026-09-01');
    });

    it('maps tombstoned fill keys to the template key format', () => {
      const out = convertIncomeLinkedTemplates(input());
      expect(out.meta.scheduledTombstones).toEqual(['tpl:tpl1:2026-07', 'other:2026-07']);
    });

    it('the template materialiser then posts nothing retroactively', () => {
      const out = convertIncomeLinkedTemplates(input());
      const { newTxs } = materializeDueTemplateFills(
        out.envelopeTemplates, out.budgetItems, [{ id: 'e1', name: 'Food' }],
        out.transactions, new Date(2026, 8, 23), () => 'new', 'FI', out.meta.scheduledTombstones,
      );
      expect(newTxs).toEqual([]);
    });

    it('keeps the income item\'s own since when nothing has posted yet', () => {
      const out = convertIncomeLinkedTemplates({ ...input(), transactions: [], meta: undefined });
      expect(out.envelopeTemplates[0].schedule.since).toBe('2025-01-01');
      expect(out.meta).toBeUndefined();
    });
  });

  it('clears a dangling link to a template that no longer exists', () => {
    const out = convertIncomeLinkedTemplates({
      budgetItems: [income({ template_id: 'gone' })],
      envelopeTemplates: [template()],
      transactions: [],
    });
    expect(out.budgetItems[0].template_id).toBeNull();
    expect(out.notes).toContainEqual({
      kind: 'missing-template', itemId: 'inc1', templateId: 'gone',
    });
  });
});
