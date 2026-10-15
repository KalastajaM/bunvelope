// tests/core-budget-item-dates.test.js — budgetItem.create / .update take an
// optional start_month and end_month ('YYYY-MM', inclusive).
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const salary = {
  id: 'income-item', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0,
  include: true, monthly_schedule: everyMonth(), payment_day: 25, as_schedule: true, account_id: 'chk',
  as_schedule_since: '2026-01-01', as_schedule_until: '2026-10-31', schedule_day_type: 'exact',
};
const car = {
  id: 'car-item', kind: 'loan_payment', envelope_id: 'groc', description: 'Car loan', default_amount: -300, include: true,
  monthly_schedule: everyMonth(), payment_day: 5, as_schedule: true, account_id: 'chk', to_account_id: 'carloan',
  as_schedule_since: '2026-01-01', schedule_day_type: 'exact',
};
const data = () => ({
  meta: {},
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank' }, { id: 'carloan', name: 'Car loan', type: 'loan' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }],
  budgetItems: [salary, car],
  envelopeTemplates: [],
  transactions: [],
});
const run = (name, input) => runCommand(registry, data(), name, input, ctx());
const created = (r) => r.value.changes.budgetItems.at(-1);
const item = (r, id) => r.value.changes.budgetItems.find(it => it.id === id);

describe('budgetItem.create with dates', () => {
  const base = { kind: 'expense', envelope_id: 'groc', default_amount: -100, monthly_schedule: everyMonth() };

  it('stores both months', () => {
    const r = run('budgetItem.create', { ...base, start_month: '2026-10', end_month: '2026-12' });
    expect(r.ok).toBe(true);
    expect(created(r)).toMatchObject({ start_month: '2026-10', end_month: '2026-12' });
  });

  it('refuses an end before the start', () => {
    const r = run('budgetItem.create', { ...base, start_month: '2026-10', end_month: '2026-09' });
    expect(r.ok).toBe(false);
    expect(r.error.params.errors.map(e => e.path)).toContain('end_month');
  });

  it('refuses a malformed month', () => {
    for (const bad of ['2026-13', 'Oct', '2026-1']) {
      const r = run('budgetItem.create', { ...base, start_month: bad });
      expect(r.ok, bad).toBe(false);
    }
  });

  it('stores an empty month as null', () => {
    const r = run('budgetItem.create', { ...base, start_month: '', end_month: null });
    expect(r.ok).toBe(true);
    expect(created(r).start_month).toBe(null);
    expect(created(r).end_month).toBe(null);
  });
});

describe('budgetItem.update with dates', () => {
  it('writing end_month replaces the legacy as_schedule_until', () => {
    const r = run('budgetItem.update', { id: 'income-item', fields: { end_month: '2026-10' } });
    expect(r.ok).toBe(true);
    expect(item(r, 'income-item').end_month).toBe('2026-10');
    expect(item(r, 'income-item')).not.toHaveProperty('as_schedule_until');
  });

  it('clears an end month with null', () => {
    const r = run('budgetItem.update', { id: 'income-item', fields: { end_month: null } });
    expect(item(r, 'income-item').end_month).toBe(null);
  });

  it('checks the order against the stored start month', () => {
    const r = run('budgetItem.update', { id: 'income-item', fields: { start_month: '2027-01', end_month: '2026-12' } });
    expect(r.ok).toBe(false);
  });

  it('stores no dates on a loan payment', () => {
    const r = run('budgetItem.update', { id: 'car-item', fields: { kind: 'loan_payment', end_month: '2027-01' } });
    expect(r.ok).toBe(true);
    expect(item(r, 'car-item')).not.toHaveProperty('end_month');
    expect(item(r, 'car-item')).not.toHaveProperty('start_month');
  });
});
