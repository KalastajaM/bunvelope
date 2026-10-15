// tests/core-query-loan-preview.test.js — `loan.preview`, the plan editor's
// loan summary as a query: the repayment schedule of a draft loan payment,
// typed field by field from the form, on its loan account.
//
// The editor's composition is copied from js/pages/budget-plan-editor.js
// verbatim below (L769-787 `draftLoanItem`, L799-802 the schedule, L803-822
// what the summary and the calculated amount read), with the form's controls
// → a plain `form` object, `state` → the fixture and `appNow()` → NOW. The
// query gets the draft's fields the schedule reads (what the editor sends) and
// must answer exactly the figures the editor reads off the schedule.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { loanSchedule } from '../js/engine/loan-schedule.js';
import { parseAmountInput } from '../js/ui/amount-input.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'loan.preview', input, ctxAt(now));
const pad = n => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI' },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 5000 },
    // 100,000 at 3 % (30/360), as tests/page-budget-plan-editor.test.js.
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360' },
    // Actual days, a rate change ahead.
    { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -12000, interestRates: [{ from: '2020-01-01', rate: 5 }, { from: '2027-03-01', rate: 6.5 }] },
    // No rate at all: the item's legacy rate.
    { id: 'fam', name: 'Family loan', type: 'loan', initialBalance: -3000 },
    // Nothing owed.
    { id: 'done', name: 'Paid loan', type: 'loan', initialBalance: 0 },
  ],
  envelopes: [{ id: 'rent', name: 'Rent', category: 'Housing' }],
  budgetItems: [],
  envelopeTemplates: [],
  transactions: [
    // Paid in August by the item (its key), lowering what is owed today.
    { id: 'p1', type: 'debt_payment', date: '2026-08-05', amount: 1000, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent',
      from_budget: 'mortgage:2026-08', status: 'posted' },
    // This month's car payment already paid: the schedule skips its key.
    { id: 'p2', type: 'debt_payment', date: '2026-09-10', amount: 300, from_account: 'chk', to_account: 'car', envelope_id: 'rent',
      from_budget: 'car-item:2026-09', status: 'posted' },
    // A forecast row is never real.
    { id: 'f1', type: 'debt_payment', date: '2026-09-01', amount: 5000, from_account: 'chk', to_account: 'mtg', is_forecast: true },
  ],
  ...extra,
});

const storedLoan = (over = {}) => ({
  id: 'mortgage', kind: 'loan_payment', envelope_id: 'rent', description: 'Mortgage', default_amount: -1000,
  extra_buffer: 0, include: true, monthly_schedule: every(), payment_day: 5, as_schedule: true,
  account_id: 'chk', to_account_id: 'mtg', as_schedule_since: '2026-10-01', schedule_day_type: 'exact', ...over,
});
// The editor's blank item (budget-plan-editor.js L44-52).
const NEW_ITEM = {
  id: '', envelope_id: '', description: null,
  default_amount: 0, extra_buffer: 0, include: true,
  monthly_schedule: {}, payment_day: 0,
  stress_category: null, stress_cut_pct: 0,
  include_in_emergency_budget: false,
  as_schedule: false, account_id: null, as_schedule_since: null,
  schedule_day_type: 'exact', kind: 'expense',
  investment_account_id: null, symbol: null, to_account_id: null,
};

// The form as it stands, from a stored item (what the editor fills in).
const formOf = (item, over = {}) => ({
  account: item.account_id || '', toAcct: item.to_account_id || '',
  amount: String(Math.abs(item.default_amount ?? 0)), fee: item.loan_fee != null ? String(item.loan_fee) : '',
  method: ['fixed_payment', 'annuity', 'equal_principal'].includes(item.loan_method) ? item.loan_method : 'fixed_payment',
  end: item.loan_end || '', payDay: String(item.payment_day ?? 0), dayType: item.schedule_day_type || 'exact',
  schedule: { ...(item.monthly_schedule || {}) }, ...over,
});

// ── The editor's composition, copied from js/pages/budget-plan-editor.js ───
function editorPreview(state, item, form, now) {
  const todayYmd = () => ymd(now);
  // L769-787
  function draftLoanItem() {
    return {
      ...item,
      id: item.id || 'draft',
      kind: 'loan_payment',
      account_id: form.account || item.account_id,
      to_account_id: form.toAcct,
      default_amount: -(parseAmountInput(form.amount) || 0),
      loan_fee: Number(form.fee) > 0 ? Number(form.fee) : undefined,
      loan_method: form.method,
      loan_end: form.end || undefined,
      payment_day: parseInt(form.payDay) || 0,
      schedule_day_type: form.dayType || 'exact',
      monthly_schedule: form.schedule,
      as_schedule: true,
      as_schedule_since: item.as_schedule_since || todayYmd(),
    };
  }
  const loan = (state.accounts || []).find(a => a.id === form.toAcct);
  // L799-802
  const s = loanSchedule({
    item: draftLoanItem(), loan, transactions: state.transactions, today: now,
    country: state.meta?.country ?? 'FI',
  });
  // What L803-822 read: rows[0].payment, ends, payoffDate, totalInterest,
  // the last row's monthKey, owedAtEnd, owedNow.
  return {
    firstPayment: s.rows.length ? s.rows[0].payment : null,
    ends: s.ends,
    payoffDate: s.payoffDate,
    totalInterest: round2(s.totalInterest),
    owedAtEnd: round2(s.owedAtEnd),
    owedNow: round2(s.owedNow),
    lastMonth: s.rows.length ? s.rows[s.rows.length - 1].monthKey : null,
  };
}

// What the editor sends: the draft's fields the schedule reads.
function previewInputOf(item, form, now = NOW) {
  return {
    item: {
      id: item.id || undefined,
      default_amount: -(parseAmountInput(form.amount) || 0),
      loan_fee: Number(form.fee) > 0 ? Number(form.fee) : undefined,
      loan_method: form.method,
      loan_end: form.end || undefined,
      payment_day: parseInt(form.payDay) || 0,
      schedule_day_type: form.dayType || 'exact',
      monthly_schedule: form.schedule,
      as_schedule_since: item.as_schedule_since || ymd(now),
      as_schedule_until: item.as_schedule_until,
      start_month: item.start_month,
      end_month: item.end_month,
      skipped_occurrences: item.skipped_occurrences,
      loan_rate: item.loan_rate,
    },
    loan: form.toAcct,
    date: ymd(now),
  };
}

function check(d, item, form, now = NOW) {
  const r = ask(JSON.parse(JSON.stringify(previewInputOf(item, form, now))), d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  expect(r.value).toEqual(editorPreview(d, item, form, now));
  expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  return r.value;
}

describe('loan.preview: the editor\'s loan summary', () => {
  it('a fixed payment that pays the loan off: when, and the interest it costs', () => {
    const d = data();
    const v = check(d, storedLoan(), formOf(storedLoan()));
    expect(v.ends).toBe('repaid');
    expect(v.payoffDate).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(v.totalInterest).toBeGreaterThan(0);
    // August's payment is on a row: owed now is 99,000.
    expect(v.owedNow).toBe(99000);
  });

  it('a fixed payment that does not cover the interest is never repaid', () => {
    const d = data();
    const v = check(d, storedLoan(), formOf(storedLoan(), { amount: '200' }));
    expect(v.ends).toBe('not_repaid');
  });

  it('an annuity calculates the payment from the end month', () => {
    const d = data({ transactions: [] });
    const item = storedLoan();
    const v = check(d, item, formOf(item, { method: 'annuity', end: '2051-09' }));
    // tests/page-budget-plan-editor.test.js: the editor fills in 474.21.
    expect(v.firstPayment).toBe(474.21);
    expect(v.ends).toBe('repaid');
    expect(v.payoffDate.slice(0, 7)).toBe('2051-09');
  });

  it('equal principal: what is owed over the months left, plus the interest', () => {
    const d = data({ transactions: [] });
    const item = storedLoan({ loan_method: 'equal_principal', loan_end: '2051-09' });
    const v = check(d, item, formOf(item));
    expect(v.firstPayment).toBe(583.33);
  });

  it('a calculated method without an end month is read as a fixed payment', () => {
    const d = data();
    check(d, storedLoan(), formOf(storedLoan(), { method: 'annuity', end: '' }));
  });

  it('a plan that stops first (a legacy until) leaves money owed at its last month', () => {
    const d = data();
    const item = storedLoan({ as_schedule_until: '2028-06-30' });
    const v = check(d, item, formOf(item));
    expect(v.ends).toBe('plan_ends');
    expect(v.lastMonth).toBe('2028-06');
    expect(v.owedAtEnd).toBeGreaterThan(0);
  });

  it('an end month, a fee, a working-day shift, a skipped month and the item\'s own legacy rate', () => {
    const d = data();
    const item = storedLoan({
      id: 'fam-item', to_account_id: 'fam', default_amount: -150, loan_fee: 2.5, loan_rate: 4,
      schedule_day_type: 'next_work_day', payment_day: 31, skipped_occurrences: ['2026-12'], end_month: '2027-12',
    });
    const v = check(d, item, formOf(item));
    expect(v.firstPayment).toBe(150);
    check(d, item, formOf(item, { fee: '0' }));
  });

  it('a payment already on a row this month is not owed again; the rate changes ahead apply', () => {
    const d = data();
    const item = storedLoan({ id: 'car-item', to_account_id: 'car', default_amount: -300, as_schedule_since: '2026-01-01', payment_day: 10 });
    const v = check(d, item, formOf(item));
    expect(v.owedNow).toBe(11700);
  });

  it('a payment due earlier this month and not yet posted is still owed', () => {
    const d = data({ transactions: [] });
    const item = storedLoan({ as_schedule_since: '2026-01-01', payment_day: 5 });
    const v = check(d, item, formOf(item));
    expect(v.firstPayment).toBe(1000);
  });

  it('custom month amounts, and a formula typed into the amount field', () => {
    const d = data();
    const item = storedLoan();
    check(d, item, formOf(item, { amount: '1000/3', schedule: { ...every(), Dec: 2000, Jul: 500.5 } }));
  });

  it('nothing owed: no payments', () => {
    const d = data();
    const item = storedLoan({ to_account_id: 'done' });
    const v = check(d, item, formOf(item));
    expect(v).toMatchObject({ ends: 'no_payments', owedNow: 0, firstPayment: null, lastMonth: null });
  });

  it('a new item without an id (the editor\'s blank item switched to a loan payment)', () => {
    const d = data();
    const form = { ...formOf(NEW_ITEM), account: 'chk', toAcct: 'mtg', amount: '1200', payDay: '15', schedule: every() };
    const v = check(d, NEW_ITEM, form);
    expect(v.ends).toBe('repaid');
    check(d, NEW_ITEM, { ...form, method: 'annuity', end: '2040-12' });
    check(d, NEW_ITEM, { ...form, method: 'equal_principal', end: '2040-12' });
  });

  it('the date is today for the schedule', () => {
    const d = data();
    check(d, storedLoan(), formOf(storedLoan()), at(2027, 2, 3));
  });

  it('null and undefined draft fields are skipped: they answer as the fields left out', () => {
    const d = data();
    const form = formOf(storedLoan());
    const base = previewInputOf(storedLoan(), form);
    for (const k of ['loan_fee', 'loan_end', 'loan_rate', 'as_schedule_until', 'start_month', 'end_month', 'skipped_occurrences']) delete base.item[k];
    const withNulls = structuredClone(base);
    Object.assign(withNulls.item, {
      loan_fee: null, loan_end: null, loan_rate: null, as_schedule_until: null, start_month: null, end_month: null,
    });
    const withUndefined = { ...base, item: { ...base.item, loan_fee: undefined, loan_end: undefined, loan_rate: undefined,
      as_schedule_until: undefined, start_month: undefined, end_month: undefined, skipped_occurrences: undefined } };
    const plain = ask(JSON.parse(JSON.stringify(base)), d);
    expect(plain.ok, JSON.stringify(plain.error)).toBe(true);
    const nulls = ask(JSON.parse(JSON.stringify(withNulls)), d);
    expect(nulls.ok, JSON.stringify(nulls.error)).toBe(true);
    expect(nulls.value).toEqual(plain.value);
    const undef = ask(withUndefined, d);
    expect(undef.ok, JSON.stringify(undef.error)).toBe(true);
    expect(undef.value).toEqual(plain.value);
  });

  it('refuses a loan that does not exist and a field the schedule does not read', () => {
    const d = data();
    const unknown = ask({ item: { default_amount: -100 }, loan: 'nope' }, d);
    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe('bad_input');
    const extra = ask({ item: { default_amount: -100, description: 'x' }, loan: 'mtg' }, d);
    expect(extra.ok).toBe(false);
    expect(extra.error.code).toBe('bad_input');
  });
});
