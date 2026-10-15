// @vitest-environment jsdom
// A loan account's repayment plan on the Accounts page: which plan item pays
// it (loanRepayment), the payoff line on its card, and the schedule panel.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({ ...(await importOriginal()), saveAccounts: vi.fn(async () => {}) }));

import { loanPayoffLine, openLoanScheduleSheet } from '../js/ui/loan-schedule-sheet.js';
import { loanRepayment } from '../js/engine/loan-schedule.js';
import { render } from '../js/pages/accounts.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';
import { state, resetState, mountHosts, flush, FIXED_NOW } from './_fakes/pageApp.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = Object.fromEntries(MONTHS.map(m => [m, true]));
const mtg = { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }] };
const item = (over = {}) => ({
  id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
  default_amount: -474.21, monthly_schedule: everyMonth, payment_day: 5, as_schedule: true, as_schedule_since: '2026-10-01',
  include: true, schedule_day_type: 'exact', loan_method: 'annuity', loan_end: '2051-09', ...over,
});
const ctx = (budgetItems) => ({ budgetItems, transactions: [], today: new Date(FIXED_NOW) });

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState();
  state.accounts = [...state.accounts, mtg];
  mountHosts();
});

describe('loanRepayment', () => {
  it('finds the one enabled scheduled item that pays the loan, with its schedule', () => {
    const r = loanRepayment(mtg, ctx([item(), item({ id: 'off', include: false })]));
    expect(r.status).toBe('ok');
    expect(r.schedule.payoffDate).toBe('2051-09-05');
    expect(loanPayoffLine(r)).toBe(t('loanSchedule.paidOffBy')(fmtMonthLang('2051-09')));
  });

  it('says so when no item pays it, or more than one does', () => {
    expect(loanRepayment(mtg, ctx([])).status).toBe('none');
    expect(loanPayoffLine(loanRepayment(mtg, ctx([])))).toBe(t('loanSchedule.noPlan'));
    const shared = loanRepayment(mtg, ctx([item(), item({ id: 'second' })]));
    expect(shared).toEqual({ status: 'shared', count: 2 });
    expect(loanPayoffLine(shared)).toBe(t('loanSchedule.shared'));
  });
});

describe('the schedule panel', () => {
  it('lists every payment under its year, with the totals', () => {
    openLoanScheduleSheet(mtg, loanRepayment(mtg, ctx([item()])));
    const sheet = document.querySelector('#sheet-host .sheet');
    expect(sheet.textContent).toContain(t('loanSchedule.titleFor')('Mortgage'));
    expect(sheet.textContent).toContain(t('budgetPlan.loanMethodAnnuity'));
    const years = [...sheet.querySelectorAll('tr.loan-schedule-year th')].map(th => th.textContent);
    expect(years[0]).toBe('2026');
    expect(years.at(-1)).toBe('2051');
    const payments = sheet.querySelectorAll('tbody tr:not(.loan-schedule-year)');
    expect(payments).toHaveLength(300);
    // No other costs on this item, so no column for them.
    expect([...sheet.querySelectorAll('thead th')].map(th => th.textContent)).not.toContain(t('loanSchedule.colFee'));
  });
});

describe('the loan account card', () => {
  it('shows the payoff and opens the schedule', async () => {
    state.budgetItems = [item()];
    await render(document.getElementById('app-root'));
    const card = document.querySelector('[data-acc-id="mtg"]');
    expect(card.textContent).toContain(t('loanSchedule.paidOffBy')(fmtMonthLang('2051-09')));
    card.querySelector(`button[aria-label="${t('loanSchedule.title')}"]`).click();
    await flush();
    expect(document.querySelector('#sheet-host .sheet .loan-schedule-table')).not.toBeNull();
  });

  it('has no schedule button without a plan item', async () => {
    await render(document.getElementById('app-root'));
    const card = document.querySelector('[data-acc-id="mtg"]');
    expect(card.textContent).toContain(t('loanSchedule.noPlan'));
    expect(card.querySelector(`button[aria-label="${t('loanSchedule.title')}"]`)).toBeNull();
  });
});
