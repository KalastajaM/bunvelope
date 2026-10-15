// tests/core-budget-item-commands.test.js — budgetItem.create, .update,
// .delete, .skipOccurrence, .unskipOccurrence and the internal .loanUpkeep:
// the plan-item editor's save rules through the command pipeline.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import { loanPlanUpdates } from '../js/engine/loan-schedule.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const rent = {
  id: 'rent-item', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -900, extra_buffer: 0,
  include: true, include_in_emergency_budget: true, payment_day: 1, stress_category: 'A', stress_cut_pct: 0.1,
  stress_cut_pcts: { mild: 0.1 }, monthly_schedule: everyMonth(), as_schedule: true, account_id: 'chk',
  as_schedule_since: '2026-01-01', schedule_day_type: 'exact', investment_account_id: null, symbol: null, to_account_id: null,
  skipped_occurrences: ['2026-03'], as_schedule_until: '2027-12-31', template_id: 'legacy', funding_style: 'bill',
};
const salary = { id: 'income-item', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: everyMonth(), payment_day: 25, as_schedule: false, account_id: null, as_schedule_since: null, schedule_day_type: 'exact' };
const car = {
  id: 'car-item', kind: 'loan_payment', envelope_id: 'rent', description: 'Car loan', default_amount: -300, include: true, monthly_schedule: everyMonth(),
  payment_day: 5, as_schedule: true, account_id: 'chk', to_account_id: 'carloan', loan_fee: 5, loan_method: 'annuity', loan_end: '2028-12',
  loan_paid_off: '2026-01-01', loan_months_off: { Nov: true }, loan_rate: 4, as_schedule_since: '2026-01-01', schedule_day_type: 'exact',
  stress_category: null, stress_cut_pct: 0, include_in_emergency_budget: false, extra_buffer: 0, investment_account_id: null, symbol: null,
};

const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 100 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 0 },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 },
    { id: 'carloan', name: 'Car loan', type: 'loan', initialBalance: -1000 },
  ],
  envelopes: [{ id: 'rent', name: 'Rent' }, { id: 'groc', name: 'Groceries' }],
  budgetItems: [rent, salary, car],
  envelopeTemplates: [],
  transactions: [],
  ...extra,
});

// Every successful run is checked twice over: the same input on the same
// frozen data gives the same diff, and that diff applied reproduces the changes.
function run(name, input, d = data()) {
  const r = runCommand(registry, d, name, input, ctx());
  if (r.ok) {
    const again = runCommand(registry, d, name, input, ctx());
    expect(again.value.diff).toEqual(r.value.diff);
    const applied = applyDiff(d, r.value.diff);
    expect(applied.ok).toBe(true);
    for (const [kind, rows] of Object.entries(applied.value)) expect(rows).toEqual(r.value.changes[kind]);
  }
  return r;
}
const itemOf = (r, id) => r.value.changes.budgetItems.find(it => it.id === id);

describe('budgetItem.create', () => {
  it('stores a new expense as the editor does, and returns the id', () => {
    const r = run('budgetItem.create', { envelope_id: 'groc', description: '  Food ', default_amount: 400 });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'groc-item' });
    expect(r.value.changes.budgetItems.slice(0, -1)).toEqual(data().budgetItems);
    expect(r.value.changes.budgetItems.at(-1)).toEqual({
      id: 'groc-item', kind: 'expense', envelope_id: 'groc', description: 'Food', default_amount: -400, extra_buffer: 0, include: true,
      monthly_schedule: everyMonth(), payment_day: 0, stress_category: null, stress_cut_pct: 0, include_in_emergency_budget: false,
      as_schedule: false, account_id: null, as_schedule_since: null, schedule_day_type: 'exact',
      investment_account_id: null, symbol: null, direction: null, to_account_id: null, start_month: null, end_month: null,
    });
  });

  it('stores income and a dividend positive, and a transfer without an envelope, whatever sign is given', () => {
    const inc = run('budgetItem.create', { kind: 'income', default_amount: -500 });
    expect(inc.value.value).toEqual({ id: 'income-item-2' });
    expect(inc.value.changes.budgetItems.at(-1)).toMatchObject({ kind: 'income', default_amount: 500, include_in_emergency_budget: false });
    const div = run('budgetItem.create', { kind: 'investment_transfer', direction: 'dividend', symbol: ' vwce ', investment_account_id: 'inv', default_amount: -20 });
    expect(div.value.value).toEqual({ id: 'dividend-vwce-item' });
    expect(div.value.changes.budgetItems.at(-1)).toMatchObject({ default_amount: 20, symbol: 'VWCE', direction: 'dividend', investment_account_id: 'inv', envelope_id: null });
    const tr = run('budgetItem.create', { kind: 'account_transfer', default_amount: 50, account_id: 'chk', to_account_id: 'sav', payment_day: 3 });
    expect(tr.value.value).toEqual({ id: 'transfer-item' });
    expect(tr.value.changes.budgetItems.at(-1)).toMatchObject({ default_amount: -50, envelope_id: null, extra_buffer: 0, as_schedule: true, account_id: 'chk', to_account_id: 'sav' });
  });

  it('stamps as_schedule_since from the ctx date for a scheduled item', () => {
    const r = run('budgetItem.create', { envelope_id: 'groc', default_amount: 10, as_schedule: true, account_id: 'chk', payment_day: 7 });
    expect(r.value.changes.budgetItems.at(-1)).toMatchObject({ as_schedule: true, as_schedule_since: '2026-10-02', account_id: 'chk' });
  });

  it('refuses an unknown kind through the schema', () => {
    const r = run('budgetItem.create', { kind: 'gift', envelope_id: 'groc', default_amount: 5 });
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors[0].path).toBe('kind');
  });

  it('refuses what the editor refuses, with the field path', () => {
    const missing = run('budgetItem.create', { default_amount: 5 });
    expect(missing.ok).toBe(true);
    expect(missing.value.changes.budgetItems.at(-1)).toMatchObject({ kind: 'expense', envelope_id: null, default_amount: -5 });
    expect(run('budgetItem.create', { envelope_id: 'groc' }).error.params.errors[0]).toEqual({ path: 'default_amount', message: 'must not be zero' });
    expect(run('budgetItem.create', { envelope_id: 'groc', default_amount: 1e12 }).error.code).toBe('bad_input');
    expect(run('budgetItem.create', { envelope_id: 'nope', default_amount: 5 }).error.code).toBe('bad_input');
    const sched = run('budgetItem.create', { envelope_id: 'groc', default_amount: 5, as_schedule: true });
    expect(sched.error.params.errors.map(e => e.path)).toEqual(['account_id', 'payment_day']);
  });
});

describe('budgetItem.create and .update: active months', () => {
  const noMonths = { path: 'monthly_schedule', message: 'needs at least one active month while the item is included' };
  it('a given schedule is stored as given', () => {
    const r = run('budgetItem.create', { envelope_id: 'groc', default_amount: 40, monthly_schedule: { Mar: true, Jun: 55 } });
    expect(r.value.changes.budgetItems.at(-1).monthly_schedule).toEqual({ Mar: true, Jun: 55 });
  });
  it('refuses an included item with no active month, and takes an excluded one', () => {
    const r = run('budgetItem.create', { envelope_id: 'groc', default_amount: 40, monthly_schedule: {} });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors).toContainEqual(noMonths);
    const off = run('budgetItem.create', { envelope_id: 'groc', default_amount: 40, monthly_schedule: {}, include: false });
    expect(off.ok).toBe(true);
    expect(off.value.changes.budgetItems.at(-1)).toMatchObject({ include: false, monthly_schedule: {} });
  });
  it('refuses an update that switches the last month off, or includes an item with none', () => {
    const r = run('budgetItem.update', { id: 'rent-item', fields: { monthly_schedule: {} } });
    expect(r.ok).toBe(false);
    expect(r.error.params.errors).toContainEqual({ ...noMonths, path: 'fields.monthly_schedule' });
    const parked = { ...salary, id: 'parked', include: false, monthly_schedule: {} };
    const d = data({ budgetItems: [rent, salary, car, parked] });
    const inc = run('budgetItem.update', { id: 'parked', fields: { include: true } }, d);
    expect(inc.ok).toBe(false);
    // The stored excluded item with no months stays editable.
    const edit = run('budgetItem.update', { id: 'parked', fields: { description: 'Bonus', default_amount: 50 } }, d);
    expect(edit.ok).toBe(true);
    expect(itemOf(edit, 'parked')).toMatchObject({ description: 'Bonus', include: false, monthly_schedule: {} });
  });
});

describe('budgetItem.update', () => {
  it('a single-field update touches only that field', () => {
    const r = run('budgetItem.update', { id: 'rent-item', fields: { description: ' Flat ' } });
    expect(itemOf(r, 'rent-item')).toEqual({ ...rent, description: 'Flat' });
    expect(r.value.value).toEqual({ id: 'rent-item' });
    expect(r.value.changes.budgetItems.filter(it => it.id !== 'rent-item')).toEqual([salary, car]);
    const amt = run('budgetItem.update', { id: 'rent-item', fields: { default_amount: 950 } });
    expect(itemOf(amt, 'rent-item').default_amount).toBe(-950);
    const inc = run('budgetItem.update', { id: 'income-item', fields: { default_amount: -3100 } });
    expect(itemOf(inc, 'income-item').default_amount).toBe(3100);
  });

  it('keeps the unrendered fields through a full kind-bearing update', () => {
    const r = run('budgetItem.update', { id: 'rent-item', fields: { kind: 'expense', description: 'Rent 2' } });
    expect(itemOf(r, 'rent-item')).toMatchObject({
      skipped_occurrences: ['2026-03'], as_schedule_until: '2027-12-31', template_id: 'legacy', description: 'Rent 2',
      as_schedule_since: '2026-01-01',
    });
    const loan = run('budgetItem.update', { id: 'car-item', fields: { kind: 'loan_payment', description: 'Car' } });
    expect(itemOf(loan, 'car-item')).toMatchObject({ loan_paid_off: '2026-01-01', description: 'Car' });
    expect(itemOf(loan, 'car-item')).not.toHaveProperty('loan_rate');
  });

  it('a kind change sweeps the loan fields and the fields that no longer apply', () => {
    const r = run('budgetItem.update', { id: 'car-item', fields: { kind: 'expense' } });
    const out = itemOf(r, 'car-item');
    for (const k of ['loan_fee', 'loan_method', 'loan_end', 'loan_paid_off', 'loan_months_off', 'loan_rate']) expect(out).not.toHaveProperty(k);
    expect(out).toMatchObject({ kind: 'expense', to_account_id: null, envelope_id: 'rent' });
    expect(out).not.toHaveProperty('funding_style');
    const toIncome = run('budgetItem.update', { id: 'rent-item', fields: { kind: 'income' } });
    expect(itemOf(toIncome, 'rent-item')).toMatchObject({
      kind: 'income', default_amount: 900, include_in_emergency_budget: false, as_schedule_since: '2026-10-02',
    });
    expect(itemOf(toIncome, 'rent-item')).not.toHaveProperty('funding_style');
  });

  it('stamps as_schedule_since when include or as_schedule change, not otherwise', () => {
    const off = run('budgetItem.update', { id: 'rent-item', fields: { include: false } });
    expect(itemOf(off, 'rent-item')).toMatchObject({ include: false, as_schedule_since: '2026-01-01' });
    const reOn = run('budgetItem.update', { id: 'rent-item', fields: { include: true } }, data({ budgetItems: [{ ...rent, include: false }, salary, car] }));
    expect(itemOf(reOn, 'rent-item').as_schedule_since).toBe('2026-10-02');
    const unsched = run('budgetItem.update', { id: 'rent-item', fields: { as_schedule: false } });
    expect(itemOf(unsched, 'rent-item')).toMatchObject({ as_schedule: false, as_schedule_since: null, schedule_day_type: 'exact' });
  });

  it('a no-op update is ok and changes nothing', () => {
    for (const fields of [{}, { description: 'Rent' }, { default_amount: -900 }]) {
      const r = run('budgetItem.update', { id: 'rent-item', fields });
      expect(r.ok).toBe(true);
      expect(r.value.changes).toEqual({});
      expect(r.value.diff).toEqual({});
    }
  });

  it('refuses an invalid result with fields.-prefixed paths, and an unknown id or kind', () => {
    const zero = run('budgetItem.update', { id: 'rent-item', fields: { default_amount: 0 } });
    expect(zero.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'fields.default_amount', message: 'must not be zero' }] } });
    const noEnv = run('budgetItem.update', { id: 'rent-item', fields: { envelope_id: null } });
    expect(noEnv.ok).toBe(true);
    expect(itemOf(noEnv, 'rent-item').envelope_id).toBeNull();
    expect(run('budgetItem.update', { id: 'ghost', fields: {} }).error.code).toBe('bad_input');
    expect(run('budgetItem.update', { id: 'rent-item', fields: { kind: 'gift' } }).error.params.errors[0].path).toBe('fields.kind');
  });
});

describe('budgetItem.update on a stored item that already breaks a rule', () => {
  const zero = { ...rent, id: 'zero-item', default_amount: 0 };
  const dangling = { ...rent, id: 'dangling-item', envelope_id: 'gone' };
  const d = () => data({ budgetItems: [zero, dangling, salary] });

  it('a zero-amount item accepts an include toggle and a description edit', () => {
    const off = run('budgetItem.update', { id: 'zero-item', fields: { include: false } }, d());
    expect(off.ok).toBe(true);
    expect(itemOf(off, 'zero-item')).toEqual({ ...zero, include: false });
    const desc = run('budgetItem.update', { id: 'zero-item', fields: { description: 'x' } }, d());
    expect(itemOf(desc, 'zero-item')).toEqual({ ...zero, description: 'x' });
    const again = run('budgetItem.update', { id: 'zero-item', fields: { default_amount: 0 } }, d());
    expect(again.ok).toBe(true);
    expect(again.value.changes).toEqual({});
  });

  it('a dangling-reference item accepts an include toggle but refuses a new bad reference', () => {
    expect(run('budgetItem.update', { id: 'dangling-item', fields: { include: false } }, d()).ok).toBe(true);
    const moved = run('budgetItem.update', { id: 'dangling-item', fields: { envelope_id: 'other' } }, d());
    expect(moved.error.params.errors).toEqual([{ path: 'fields.envelope_id', message: 'no envelope with id "other"' }]);
    const acct = run('budgetItem.update', { id: 'dangling-item', fields: { account_id: 'nope' } }, d());
    expect(acct.error.params.errors).toEqual([{ path: 'fields.account_id', message: 'no account with id "nope"' }]);
    expect(run('budgetItem.update', { id: 'dangling-item', fields: { envelope_id: 'groc' } }, d()).ok).toBe(true);
  });

  it('still refuses an error the change adds, naming only the new one', () => {
    const r = run('budgetItem.update', { id: 'zero-item', fields: { kind: 'account_transfer' } }, d());
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors).toEqual([{ path: 'fields.to_account_id', message: 'is required' }]);
  });
});

describe('budgetItem.delete', () => {
  it('removes the item and nothing else', () => {
    const r = run('budgetItem.delete', { id: 'income-item' });
    expect(r.value.changes.budgetItems).toEqual([rent, car]);
    expect(r.value.value).toEqual({ id: 'income-item' });
    expect(run('budgetItem.delete', { id: 'ghost' }).error.code).toBe('bad_input');
  });
});

describe('budgetItem.skipOccurrence / unskipOccurrence', () => {
  it('adds a month as a copy, and refuses one already skipped', () => {
    const r = run('budgetItem.skipOccurrence', { id: 'rent-item', month: '2026-11' });
    expect(itemOf(r, 'rent-item').skipped_occurrences).toEqual(['2026-03', '2026-11']);
    expect(rent.skipped_occurrences).toEqual(['2026-03']);
    expect(r.value.value).toEqual({ id: 'rent-item', month: '2026-11' });
    const again = run('budgetItem.skipOccurrence', { id: 'rent-item', month: '2026-03' });
    expect(again.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'month', message: 'that month is already skipped' }] } });
    expect(run('budgetItem.skipOccurrence', { id: 'income-item', month: '2026-11' }).ok).toBe(true);
  });

  it('removes a month, and refuses one not skipped', () => {
    const r = run('budgetItem.unskipOccurrence', { id: 'rent-item', month: '2026-03' });
    expect(itemOf(r, 'rent-item')).not.toHaveProperty('skipped_occurrences');
    const none = run('budgetItem.unskipOccurrence', { id: 'rent-item', month: '2026-04' });
    expect(none.error.params.errors[0]).toEqual({ path: 'month', message: 'that month is not skipped' });
  });

  it('round-trips: skip then unskip leaves the item as it was', () => {
    const skipped = run('budgetItem.skipOccurrence', { id: 'income-item', month: '2026-12' });
    const back = run('budgetItem.unskipOccurrence', { id: 'income-item', month: '2026-12' }, deepFreeze({ ...data(), ...skipped.value.changes }));
    expect(back.value.changes.budgetItems).toEqual(data().budgetItems);
    const keep = run('budgetItem.skipOccurrence', { id: 'rent-item', month: '2026-04' });
    const keepBack = run('budgetItem.unskipOccurrence', { id: 'rent-item', month: '2026-04' }, deepFreeze({ ...data(), ...keep.value.changes }));
    expect(keepBack.value.changes.budgetItems).toEqual(data().budgetItems);
  });

  it('refuses a malformed month', () => {
    for (const month of ['2026-13', '2026-1', 'March', '2026-00']) {
      expect(run('budgetItem.skipOccurrence', { id: 'rent-item', month }).error.params.errors[0].path).toBe('month');
      expect(run('budgetItem.unskipOccurrence', { id: 'rent-item', month }).error.params.errors[0].path).toBe('month');
    }
  });
});

describe('budgetItem.loanUpkeep', () => {
  // A repaid loan (its debt is paid in full) and a calculated annuity still owing.
  const mtg = { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -5000 };
  const auto = { id: 'auto', name: 'Auto', type: 'loan', initialBalance: -12000, interestRates: [{ from: '2025-01-01', rate: 5 }], loanStart: '2025-01-01' };
  const mortgage = {
    id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
    default_amount: -1000, monthly_schedule: everyMonth(), payment_day: 5, as_schedule: true, include: true, schedule_day_type: 'exact',
  };
  const annuity = {
    id: 'auto-item', kind: 'loan_payment', description: 'Auto', envelope_id: 'rent', account_id: 'chk', to_account_id: 'auto',
    default_amount: -1, monthly_schedule: everyMonth(), payment_day: 8, as_schedule: true, include: true, schedule_day_type: 'exact',
    loan_method: 'annuity', loan_end: '2028-12',
  };
  const mtg2 = { id: 'mtg2', name: 'Student loan', type: 'loan', initialBalance: -800 };
  const student = { ...mortgage, id: 'student-item', description: null, to_account_id: 'mtg2', default_amount: -100 };
  // The second repaid item comes first, so the repaid list is shown to follow item order.
  const fixture = () => data({
    accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }, mtg, mtg2, auto],
    budgetItems: [student, mortgage, rent, annuity],
    transactions: [
      { id: 'p', type: 'debt_payment', date: '2026-09-05', amount: 5000, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent', status: 'posted' },
      { id: 'p2', type: 'debt_payment', date: '2026-08-20', amount: 800, from_account: 'chk', to_account: 'mtg2', envelope_id: 'rent', status: 'posted' },
    ],
  });

  it('is internal, so it is listed only on request', () => {
    expect(registry.list().map(e => e.name)).not.toContain('budgetItem.loanUpkeep');
    expect(registry.list({ includeInternal: true }).map(e => e.name)).toContain('budgetItem.loanUpkeep');
  });

  it('matches what runLoanPlanUpkeep composes today: replace the updated items by id', () => {
    const d = fixture();
    const updates = loanPlanUpdates({ budgetItems: d.budgetItems, accounts: d.accounts, transactions: d.transactions, today: NOW, country: 'FI' });
    expect(updates.map(u => [u.item.id, u.reason])).toEqual([['student-item', 'repaid'], ['mortgage', 'repaid'], ['auto-item', 'plan']]);
    const byId = new Map(updates.map(u => [u.item.id, u.item]));
    const expected = d.budgetItems.map(it => (byId.has(it.id) ? byId.get(it.id) : it));

    const r = run('budgetItem.loanUpkeep', {}, d);
    expect(r.ok).toBe(true);
    expect(r.value.changes.budgetItems).toEqual(expected);
    expect(itemOf(r, 'mortgage')).toMatchObject({ include: false, loan_paid_off: '2026-09-05' });
    expect(itemOf(r, 'auto-item').default_amount).not.toBe(-1);
    expect(itemOf(r, 'rent-item')).toBe(rent);
    expect(itemOf(r, 'student-item')).toMatchObject({ include: false, loan_paid_off: '2026-08-20' });
    // In item order, which drives the order of the repaid toasts.
    expect(r.value.value).toEqual({
      updated: 3,
      repaid: [
        { id: 'student-item', description: null, toAccountId: 'mtg2' },
        { id: 'mortgage', description: 'Home loan', toAccountId: 'mtg' },
      ],
    });
  });

  it('takes the working-day country from meta.country (default FI)', () => {
    // 26 Nov 2026 is Thanksgiving: a US working-day shift moves this payment, an FI one does not.
    const now = new Date(2026, 10, 1);
    const cx = () => makeCtx({ now, newId: () => 'x' });
    const equalPrincipal = {
      ...annuity, id: 'ep-item', payment_day: 26, schedule_day_type: 'prev_work_day', loan_method: 'equal_principal', loan_end: '2027-01',
    };
    const base = { accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }, { ...auto, interestDayCount: 'act/365' }], budgetItems: [equalPrincipal] };
    const direct = (country) => loanPlanUpdates({ ...base, transactions: [], today: now, country })[0].item;
    expect(direct('US').default_amount).not.toBe(direct('FI').default_amount);
    const fi = runCommand(registry, data({ ...base, meta: {} }), 'budgetItem.loanUpkeep', {}, cx());
    const us = runCommand(registry, data({ ...base, meta: { country: 'US' } }), 'budgetItem.loanUpkeep', {}, cx());
    expect(fi.value.changes.budgetItems).toEqual([direct('FI')]);
    expect(us.value.changes.budgetItems).toEqual([direct('US')]);
  });

  it('is a no-op once applied: ok, no changes', () => {
    const first = run('budgetItem.loanUpkeep', {}, fixture());
    const r = run('budgetItem.loanUpkeep', {}, deepFreeze({ ...fixture(), ...first.value.changes }));
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ updated: 0, repaid: [] });
    expect(r.value.changes).toEqual({});
    expect(r.value.diff).toEqual({});
  });

  it('rejects any input', () => {
    expect(run('budgetItem.loanUpkeep', { x: 1 }, fixture()).error.code).toBe('bad_input');
  });
});
