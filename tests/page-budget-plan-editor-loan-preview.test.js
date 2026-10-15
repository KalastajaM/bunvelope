// @vitest-environment jsdom
// Budget Plan item editor, the loan preview: the summary line and the amount a
// calculated method fills in, pinned against the editor's old composition
// copied verbatim from js/pages/budget-plan-editor.js (L769-787
// `draftLoanItem` from the form, L788-822 `refreshLoanPreview` over
// loanSchedule), for a fixed payment, an annuity, equal principal, a plan
// that stops first, a loan with nothing owed and a new item without an id.
// And the editor asks `loan.preview` on the same events as before, with the
// draft's fields typed one by one.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openBudgetItemEditor } from '../js/pages/budget-plan-editor.js';
import { collectScheduleFromCells } from '../js/pages/budget-plan-cells.js';
import { parseAmountInput } from '../js/ui/amount-input.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { loanSchedule } from '../js/engine/loan-schedule.js';
import { state, session, resetState, mountHosts, setValue, FIXED_NOW } from './_fakes/pageApp.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
const el = (id) => sheet().querySelector(`#${id}`);
const kindBtn = (key) => [...sheet().querySelectorAll('.tx-type-btn')].find(b => b.textContent === t(key));
const querySpy = vi.spyOn(session, 'query');
const previewAsks = () => querySpy.mock.calls.filter(([name]) => name === 'loan.preview').map(([, input]) => input);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const mtg = { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360' };
const car = { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -12000, interestRates: [{ from: '2020-01-01', rate: 5 }, { from: '2027-03-01', rate: 6.5 }] };
const done = { id: 'done', name: 'Paid loan', type: 'loan', initialBalance: 0 };
const loanItem = (over = {}) => ({
  id: 'mortgage', kind: 'loan_payment', envelope_id: 'rent', description: 'Mortgage', default_amount: -1000,
  extra_buffer: 0, include: true, monthly_schedule: everyMonth(), payment_day: 5, as_schedule: true,
  account_id: 'chk', to_account_id: 'mtg', as_schedule_since: '2026-10-01', schedule_day_type: 'exact', ...over,
});

let container;
const open = (idx) => openBudgetItemEditor(container, idx, { rerenderTable: vi.fn() });

// ── The editor's old composition, copied from js/pages/budget-plan-editor.js ─
// `item` is the item the editor opened on (the blank one for a new item).
function oldPreview(item) {
  const amtIn = el('bp-f-amount'), accountSel = el('bp-f-account'), toAcctSel = el('bp-f-to-account');
  const loanFeeIn = el('bp-f-loan-fee'), loanMethodSel = el('bp-f-loan-method'), loanEndIn = el('bp-f-loan-end');
  const payDayIn = el('bp-f-payment-day'), dayTypeSel = el('bp-f-day-type');
  const mcells = () => sheet().querySelectorAll('.bp-mcell');
  const todayYmd = () => '2026-09-15';
  function draftLoanItem() {
    return {
      ...item,
      id: item.id || 'draft',
      kind: 'loan_payment',
      account_id: accountSel.value || item.account_id,
      to_account_id: toAcctSel.value,
      default_amount: -(parseAmountInput(amtIn.value) || 0),
      loan_fee: Number(loanFeeIn.value) > 0 ? Number(loanFeeIn.value) : undefined,
      loan_method: loanMethodSel.value,
      loan_end: loanEndIn.value || undefined,
      payment_day: parseInt(payDayIn.value) || 0,
      schedule_day_type: dayTypeSel.value || 'exact',
      monthly_schedule: collectScheduleFromCells(mcells()),
      as_schedule: true,
      as_schedule_since: item.as_schedule_since || todayYmd(),
    };
  }
  const calculated = loanMethodSel.value !== 'fixed_payment';
  const loan = (state.accounts || []).find(a => a.id === toAcctSel.value);
  if (!loan || (calculated && !loanEndIn.value)) {
    return { summary: calculated ? t('budgetPlan.loanEndRequired') : '', amount: amtIn.value };
  }
  const s = loanSchedule({
    item: draftLoanItem(), loan, transactions: state.transactions, today: FIXED_NOW,
    country: state.meta?.country ?? 'FI',
  });
  const amount = calculated && s.rows.length ? s.rows[0].payment.toFixed(2) : amtIn.value;
  let summary;
  if (s.ends === 'repaid' && s.payoffDate) {
    summary = t('budgetPlan.loanPaidOff')(fmtMonthLang(s.payoffDate.slice(0, 7)), fmt(s.totalInterest));
  } else if (s.ends === 'not_repaid') {
    summary = t('budgetPlan.loanNotRepaid');
  } else if (s.ends === 'plan_ends') {
    const last = s.rows[s.rows.length - 1];
    summary = t('budgetPlan.loanPlanEnds')(fmtMonthLang(last.monthKey), fmt(s.owedAtEnd));
  } else {
    summary = s.owedNow > 0 ? '' : t('budgetPlan.loanNothingOwed');
  }
  return { summary, amount };
}

function expectAsBefore(item) {
  const want = oldPreview(item);
  expect(el('bp-f-loan-summary').textContent).toBe(want.summary);
  expect(el('bp-f-amount').value).toBe(want.amount);
  return want;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState();
  state.accounts = [...state.accounts, mtg, car, done];
  state.envelopes = [...state.envelopes];
  state.transactions = [
    { id: 'p1', type: 'debt_payment', date: '2026-08-05', amount: 1000, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent',
      from_budget: 'mortgage:2026-08', status: 'posted' },
  ];
  mountHosts();
  container = document.createElement('div');
  document.getElementById('app-root').append(container);
  querySpy.mockClear();
});

describe('the loan preview as before', () => {
  it('a fixed payment: the payoff, then an amount too small, then a larger one and a fee', () => {
    const item = loanItem();
    state.budgetItems = [item];
    open(0);
    expect(expectAsBefore(item).summary).toMatch(/^Paid off by /);
    setValue(el('bp-f-amount'), '200', ['input']);
    expect(expectAsBefore(item).summary).toBe(t('budgetPlan.loanNotRepaid'));
    setValue(el('bp-f-amount'), '1500', ['input']);
    expectAsBefore(item);
    setValue(el('bp-f-loan-fee'), '4.5', ['input']);
    expectAsBefore(item);
    setValue(el('bp-f-payment-day'), '31');
    setValue(el('bp-f-day-type'), 'next_work_day');
    expectAsBefore(item);
  });

  it('an annuity: the end month is asked for, then the payment is filled in', () => {
    const item = loanItem();
    state.budgetItems = [item];
    open(0);
    setValue(el('bp-f-loan-method'), 'annuity');
    expect(expectAsBefore(item).summary).toBe(t('budgetPlan.loanEndRequired'));
    setValue(el('bp-f-loan-end'), '2051-09');
    expect(el('bp-f-amount').readOnly).toBe(true);
    expectAsBefore(item);
    setValue(el('bp-f-loan-end'), '2036-03');
    expectAsBefore(item);
  });

  it('equal principal, opened as stored', () => {
    const item = loanItem({ loan_method: 'equal_principal', loan_end: '2051-09' });
    state.budgetItems = [item];
    open(0);
    expect(el('bp-f-amount').value).not.toBe('1000');
    expectAsBefore(item);
  });

  it('a plan that stops first (a legacy until) leaves money owed', () => {
    const item = loanItem({ as_schedule_until: '2028-06-30', loan_rate: 9, skipped_occurrences: ['2026-12'] });
    state.budgetItems = [item];
    open(0);
    expect(expectAsBefore(item).summary).toMatch(/still owed/);
  });

  it('another loan, then one with nothing owed', () => {
    const item = loanItem();
    state.budgetItems = [item];
    open(0);
    setValue(el('bp-f-to-account'), 'car');
    expectAsBefore(item);
    setValue(el('bp-f-to-account'), 'done');
    expect(expectAsBefore(item).summary).toBe(t('budgetPlan.loanNothingOwed'));
  });

  it('a new item without an id', () => {
    open(-1);
    kindBtn('budgetPlan.kindLoan').click();
    const blank = {
      id: '', envelope_id: '', description: null,
      default_amount: 0, extra_buffer: 0, include: true,
      monthly_schedule: everyMonth(), payment_day: 0,
      stress_category: null, stress_cut_pct: 0,
      include_in_emergency_budget: false,
      as_schedule: false, account_id: null, as_schedule_since: null,
      schedule_day_type: 'exact', kind: 'loan_payment',
      investment_account_id: null, symbol: null, to_account_id: null,
    };
    setValue(el('bp-f-account'), 'chk');
    setValue(el('bp-f-to-account'), 'mtg');
    setValue(el('bp-f-amount'), '1200', ['input']);
    expectAsBefore(blank);
    // Every month is ticked on a new item; paid on the 20th.
    expect(collectScheduleFromCells(sheet().querySelectorAll('.bp-mcell'))).toEqual(everyMonth());
    setValue(el('bp-f-payment-day'), '20');
    expect(expectAsBefore(blank).summary).toMatch(/^Paid off by /);
    setValue(el('bp-f-loan-method'), 'annuity');
    setValue(el('bp-f-loan-end'), '2040-12');
    expect(expectAsBefore(blank).amount).not.toBe('1200');
    setValue(el('bp-f-loan-method'), 'equal_principal');
    expectAsBefore(blank);
  });
});

describe('the editor asks loan.preview', () => {
  it('with the draft\'s fields, the loan and today, on each event', () => {
    const item = loanItem({ as_schedule_until: '2030-12-31', loan_rate: 9, skipped_occurrences: ['2026-12'] });
    state.budgetItems = [item];
    open(0);
    expect(previewAsks().at(-1)).toEqual({
      item: {
        id: 'mortgage', default_amount: -1000, loan_method: 'fixed_payment', payment_day: 5, schedule_day_type: 'exact',
        monthly_schedule: everyMonth(), as_schedule_since: '2026-10-01', as_schedule_until: '2030-12-31',
        skipped_occurrences: ['2026-12'], loan_rate: 9,
      },
      loan: 'mtg',
      date: '2026-09-15',
    });
    querySpy.mockClear();
    setValue(el('bp-f-amount'), '1100', ['input']);
    setValue(el('bp-f-loan-fee'), '3', ['input']);
    expect(previewAsks()).toHaveLength(2);
    expect(previewAsks()[1].item).toMatchObject({ default_amount: -1100, loan_fee: 3 });
  });

  it('a new item goes without an id', () => {
    open(-1);
    kindBtn('budgetPlan.kindLoan').click();
    setValue(el('bp-f-to-account'), 'mtg');
    querySpy.mockClear();
    setValue(el('bp-f-amount'), '1200', ['input']);
    const [input] = previewAsks();
    expect(input.item).not.toHaveProperty('id');
    expect(input.item.as_schedule_since).toBe('2026-09-15');
    expect(input.loan).toBe('mtg');
  });

  it('no loan picked, or a calculated method without its end month: nothing is asked', () => {
    open(-1);
    kindBtn('budgetPlan.kindLoan').click();
    querySpy.mockClear();
    setValue(el('bp-f-amount'), '1200', ['input']);
    setValue(el('bp-f-to-account'), 'mtg');
    setValue(el('bp-f-loan-method'), 'annuity');
    expect(previewAsks()).toHaveLength(1);
  });
});
