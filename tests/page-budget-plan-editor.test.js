// @vitest-environment jsdom
// Budget Plan item editor: the plan item each kind of save produces, the
// validation that stops a bad one, delete with Undo, and failures that leave
// the plan alone. Drives the real js/pages/budget-plan-editor.js, which
// dispatches budgetItem.create / update / delete through the real browser
// session (tests/_fakes/pageApp.js); the session's write (writeBatch) is the
// fake that records what would be written. The page's repaint callback
// (rerenderTable) is injected, exactly as the page does.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

// jsdom has no scrollIntoView; the envelope combobox scrolls its active option.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

import { openBudgetItemEditor } from '../js/pages/budget-plan-editor.js';
import { collectScheduleFromCells } from '../js/pages/budget-plan-cells.js';
import { t } from '../js/ui/i18n.js';
import {
  state, runDueScheduled, writeBatch, resetState, mountHosts, flush, setValue, sheetIsOpen, toastTexts,
} from './_fakes/pageApp.js';
import { oldEditorItem } from './_fakes/oldEditorItem.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
const el = (id) => sheet().querySelector(`#${id}`);
const headerBtn = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const saveBtn = () => headerBtn(t('common.save'));
const kindBtn = (key) => [...sheet().querySelectorAll('.tx-type-btn')].find(b => b.textContent === t(key));
const topOverlay = () => [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')].at(-1);
const errorText = () => sheet().querySelector('.has-error .field-hint')?.textContent || [...sheet().querySelectorAll('div')].find(d => d.style.color === 'var(--danger-text)')?.textContent || '';
const monthCells = () => [...sheet().querySelectorAll('.bp-mcell')];

// The plan items the session last wrote.
const written = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'budget-items.json')?.data;
const toastButton = () => document.querySelector('#toast-host .toast-action');

let container, rerenderTable, groceries, salary;

const open = (idx) => openBudgetItemEditor(container, idx, { rerenderTable });

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState();
  groceries = {
    id: 'food-item', kind: 'expense', envelope_id: 'food', description: 'Groceries',
    default_amount: -80, extra_buffer: 0, include: true, monthly_schedule: { Jan: true, Feb: 30 },
    payment_day: 0, as_schedule: false, account_id: null, as_schedule_since: null, schedule_day_type: 'exact',
  };
  salary = {
    id: 'income-item', kind: 'income', envelope_id: null, description: 'Salary',
    default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: { Jan: true },
    payment_day: 25, as_schedule: false, account_id: null, as_schedule_since: null, schedule_day_type: 'exact',
  };
  state.budgetItems = [groceries, salary];
  mountHosts();
  container = document.createElement('div');
  document.getElementById('app-root').append(container);
  rerenderTable = vi.fn();
  runDueScheduled.mockClear();
});

describe('new expense item', () => {
  it('selects Unallocated explicitly, saves null, and reopens that selection', async () => {
    open(-1);
    setValue(el('bp-f-amount'), '120', ['input']);
    const search = el('bp-f-envelope-search');
    search.dispatchEvent(new Event('focus'));
    search.value = t('addTx.unallocated');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const option = [...sheet().querySelectorAll('.combo-opt')].find(li => li.textContent === t('addTx.unallocated'));
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    saveBtn().click();
    await flush();
    expect(written().at(-1)).toMatchObject({ kind: 'expense', envelope_id: null, default_amount: -120 });
    mountHosts();
    open(state.budgetItems.length - 1);
    expect(el('bp-f-envelope').selectedOptions[0].textContent).toBe(t('addTx.unallocated'));
  });

  it('needs an envelope: the empty pick blocks the save', async () => {
    const before = state.budgetItems;
    open(-1);
    setValue(el('bp-f-amount'), '120', ['input']);
    expect(el('bp-f-envelope').value).toBe('');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.budgetItems).toBe(before);
    expect(sheetIsOpen()).toBe(true);
    // Said on the form, with focus on the envelope picker's search input.
    expect(errorText()).toBe(t('budgetPlan.errEnvelopeRequired'));
    expect(document.activeElement).toBe(el('bp-f-envelope-search'));
  });

  it('the envelope picker is the searchable combobox, labelled by the field', () => {
    open(-1);
    const search = el('bp-f-envelope-search');
    expect(search.getAttribute('role')).toBe('combobox');
    expect(el('bp-f-envelope').hidden).toBe(true);
    expect(sheet().querySelector('label[for="bp-f-envelope-search"]').textContent).toBe(t('addTx.envelope'));
    search.dispatchEvent(new Event('focus'));
    search.value = 'fu';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const opt = [...sheet().querySelectorAll('.combo-opt')].find(li => li.textContent === 'Fun');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(el('bp-f-envelope').value).toBe('fun');
  });

  it('actions sit in the fixed header outside the scrolling form; the optional account hint is not an error', () => {
    open(-1);
    expect(sheet().querySelector('form .sheet-footer-actions')).toBeNull();
    const end = sheet().firstElementChild;
    expect(sheet().querySelector('form').contains(saveBtn())).toBe(false);
    expect([...end.querySelectorAll('button')].map(b => b.textContent)).toEqual([t('common.cancel'), t('common.save')]);
    expect(saveBtn().classList.contains('btn-sm')).toBe(false);
    const hint = [...sheet().querySelectorAll('.field-hint')].find(h => h.textContent === t('budgetPlan.plannedAccountHint'));
    expect(hint.classList.contains('field-hint--info')).toBe(true);
  });

  it('stores an expense as a negative default amount and appends without mutating', async () => {
    const before = state.budgetItems;
    open(-1);
    setValue(el('bp-f-envelope'), 'fun');
    setValue(el('bp-f-amount'), '120', ['input']);
    setValue(el('bp-f-description'), '  Cinema  ');
    saveBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(written()).toEqual(state.budgetItems);
    expect(state.budgetItems).not.toBe(before);
    expect(before).toEqual([groceries, salary]);
    expect(state.budgetItems).toHaveLength(3);
    expect(state.budgetItems.slice(0, 2)).toEqual([groceries, salary]);
    const item = state.budgetItems[2];
    expect(item).toMatchObject({
      kind: 'expense', envelope_id: 'fun', description: 'Cinema',
      default_amount: -120, include: true, as_schedule: false, account_id: null,
    });
    expect(item.id).toBe('fun-item');
    expect(new Set(state.budgetItems.map(i => i.id)).size).toBe(3);
    expect(rerenderTable).toHaveBeenCalledWith(container);
    expect(sheetIsOpen()).toBe(false);
    // A planned (unscheduled) item posts nothing.
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('starts with every month on and stores the months left on', async () => {
    open(-1);
    expect(monthCells()).toHaveLength(12);
    expect(monthCells().every(c => c.classList.contains('active'))).toBe(true);
    setValue(el('bp-f-envelope'), 'fun');
    setValue(el('bp-f-amount'), '10', ['input']);
    monthCells().find(c => c.dataset.mon === 'Mar').click();
    monthCells().find(c => c.dataset.mon === 'Apr').click();
    saveBtn().click();
    await flush();
    expect(Object.keys(state.budgetItems[2].monthly_schedule)).toEqual(
      ['Jan', 'Feb', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  it('refuses an included item with every month off, and saves it once excluded', async () => {
    open(-1);
    setValue(el('bp-f-envelope'), 'fun');
    setValue(el('bp-f-amount'), '10', ['input']);
    monthCells().forEach(c => c.click());
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.errNoMonths'));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);

    const includeToggle = [...sheet().querySelectorAll('.toggle')]
      .find(tg => tg.parentElement.textContent.includes(t('budgetPlan.includeBudget')));
    includeToggle.click();
    saveBtn().click();
    await flush();
    expect(state.budgetItems[2]).toMatchObject({ include: false, monthly_schedule: {} });
  });

  it('a scheduled item needs an account and a payment day, then posts due items', async () => {
    open(-1);
    setValue(el('bp-f-envelope'), 'fun');
    setValue(el('bp-f-amount'), '15', ['input']);
    const scheduleToggle = [...sheet().querySelectorAll('.toggle')]
      .find(tg => tg.parentElement.textContent.includes(t('budgetPlan.postAsScheduled')));
    scheduleToggle.click();
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.errPickAccount'));

    setValue(el('bp-f-account'), 'chk');
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.errPaymentDay'));
    expect(writeBatch).not.toHaveBeenCalled();

    setValue(el('bp-f-payment-day'), '12');
    saveBtn().click();
    await flush();
    expect(state.budgetItems[2]).toMatchObject({
      as_schedule: true, account_id: 'chk', payment_day: 12, default_amount: -15,
      // Switching scheduling on restarts the schedule today (fixed 15 Sep 2026).
      as_schedule_since: '2026-09-15',
    });
    expect(runDueScheduled).toHaveBeenCalledTimes(1);
  });
});

describe('income item', () => {
  it('needs no envelope and stores a positive amount', async () => {
    open(-1);
    kindBtn('budgetPlan.kindIncome').click();
    setValue(el('bp-f-amount'), '2500', ['input']);
    saveBtn().click();
    await flush();
    const item = state.budgetItems[2];
    expect(item).toMatchObject({ kind: 'income', envelope_id: null, default_amount: 2500, include_in_emergency_budget: false });
    expect(item.id).toBe('income-item-2');
  });
});

describe('account transfer item', () => {
  it('needs two different accounts, always posts as scheduled and has no envelope', async () => {
    open(-1);
    kindBtn('budgetPlan.kindTransfer').click();
    expect(el('bp-f-account').getAttribute('aria-required')).toBe('true');
    expect(el('bp-f-to-account').getAttribute('aria-required')).toBe('true');
    expect(el('bp-f-envelope-search').getAttribute('aria-required')).toBe('false');
    setValue(el('bp-f-amount'), '200', ['input']);
    setValue(el('bp-f-payment-day'), '1');
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.transferAccountsRequired'));

    // The destination picker offers everything but the chosen source, so the
    // same account cannot be picked on both sides at all.
    setValue(el('bp-f-account'), 'chk');
    expect([...el('bp-f-to-account').options].map(o => o.value)).not.toContain('chk');
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.transferAccountsRequired'));
    expect(writeBatch).not.toHaveBeenCalled();

    setValue(el('bp-f-to-account'), 'sav');
    saveBtn().click();
    await flush();
    expect(state.budgetItems[2]).toMatchObject({
      kind: 'account_transfer', envelope_id: null, account_id: 'chk', to_account_id: 'sav',
      as_schedule: true, payment_day: 1, default_amount: -200, extra_buffer: 0, stress_category: null,
    });
  });
});

describe('target-balance transfer editor', () => {
  it('previews and saves a zero target, hides fixed amounts, and reopens the saved rule', async () => {
    open(-1);
    kindBtn('budgetPlan.kindTransfer').click();
    setValue(el('bp-f-transfer-mode'), 'target_balance');
    setValue(el('bp-f-target-balance'), '0', ['input']);
    setValue(el('bp-f-payment-day'), '25');
    setValue(el('bp-f-account'), 'chk');
    setValue(el('bp-f-to-account'), 'sav');
    expect(el('bp-f-amount').disabled).toBe(true);
    expect(el('bp-transfer-preview').textContent).toContain('Estimated transfer');
    // Amount labels toggle the month off instead of opening a fixed override.
    monthCells()[0].querySelector('.bp-mcell-amt').click();
    expect(monthCells()[0].classList.contains('active')).toBe(false);
    expect(monthCells()[0].querySelector('input')).toBeNull();
    saveBtn().click(); await flush();
    expect(state.budgetItems.at(-1)).toMatchObject({ transfer_mode: 'target_balance', target_balance: 0, default_amount: 0 });
    mountHosts(); open(state.budgetItems.length - 1);
    expect(el('bp-f-transfer-mode').value).toBe('target_balance');
    expect(el('bp-f-target-balance').value).toBe('0');
    expect(headerBtn(t('budgetPlan.topUpNow')).hidden).toBe(false);
  });
});

describe('loan payment item', () => {
  it('is offered only once a loan account exists', () => {
    open(-1);
    expect(kindBtn('budgetPlan.kindLoan')).toBeUndefined();
  });

  it('pays a loan from an envelope with other costs, always scheduled, no stress cut', async () => {
    state.accounts = [...state.accounts, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000 }];
    open(-1);
    kindBtn('budgetPlan.kindLoan').click();
    // The loan picker lists loans only.
    expect([...el('bp-f-to-account').options].map(o => o.value).filter(Boolean)).toEqual(['mtg']);
    setValue(el('bp-f-envelope'), 'rent');
    setValue(el('bp-f-amount'), '900', ['input']);
    setValue(el('bp-f-payment-day'), '5');
    setValue(el('bp-f-account'), 'chk');
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.loanAccountRequired'));

    setValue(el('bp-f-to-account'), 'mtg');
    setValue(el('bp-f-loan-fee'), '4.5', ['input']);
    saveBtn().click();
    await flush();
    expect(state.budgetItems[2]).toMatchObject({
      kind: 'loan_payment', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg', loan_fee: 4.5,
      as_schedule: true, payment_day: 5, default_amount: -900, stress_category: null,
    });
    // The rate comes from the loan account now.
    expect(state.budgetItems[2]).not.toHaveProperty('loan_rate');
  });
});

describe('loan repayment method', () => {
  // 15 Sep 2026 (the fake clock): 100,000 at 3 %, first payment 5 Oct.
  const mtg = { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000, interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360' };
  const everyMonth = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));
  const loanItem = (over = {}) => ({
    id: 'mortgage', kind: 'loan_payment', envelope_id: 'rent', description: 'Mortgage', default_amount: -1000,
    extra_buffer: 0, include: true, monthly_schedule: everyMonth, payment_day: 5, as_schedule: true,
    account_id: 'chk', to_account_id: 'mtg', as_schedule_since: '2026-10-01', schedule_day_type: 'exact', ...over,
  });
  beforeEach(() => { state.accounts = [...state.accounts, mtg]; });
  const summary = () => el('bp-f-loan-summary').textContent;

  it('a fixed payment shows when it pays the loan off, and keeps its typed amount', () => {
    state.budgetItems = [loanItem()];
    open(0);
    expect(el('bp-f-loan-method').value).toBe('fixed_payment');
    expect(el('bp-f-amount').readOnly).toBe(false);
    expect(summary()).toMatch(/^Paid off by /);
    setValue(el('bp-f-amount'), '200', ['input']);
    expect(summary()).toBe(t('budgetPlan.loanNotRepaid'));
  });

  it('an annuity calculates the payment from the end month and saves both', async () => {
    state.budgetItems = [loanItem()];
    open(0);
    setValue(el('bp-f-loan-method'), 'annuity');
    expect(summary()).toBe(t('budgetPlan.loanEndRequired'));
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.loanEndRequired'));

    setValue(el('bp-f-loan-end'), '2051-09');
    expect(el('bp-f-amount').readOnly).toBe(true);
    expect(el('bp-f-amount').value).toBe('474.21');
    expect(summary()).toContain('2051');
    saveBtn().click();
    await flush();
    expect(state.budgetItems[0]).toMatchObject({ loan_method: 'annuity', loan_end: '2051-09', default_amount: -474.21 });
  });

  it('switching back to a fixed payment drops the method and the end month', async () => {
    state.budgetItems = [loanItem({ loan_method: 'equal_principal', loan_end: '2051-09' })];
    open(0);
    expect(el('bp-f-amount').value).toBe('583.33');
    setValue(el('bp-f-loan-method'), 'fixed_payment');
    setValue(el('bp-f-amount'), '900', ['input']);
    saveBtn().click();
    await flush();
    expect(state.budgetItems[0]).not.toHaveProperty('loan_method');
    expect(state.budgetItems[0]).not.toHaveProperty('loan_end');
    expect(state.budgetItems[0].default_amount).toBe(-900);
  });
});

describe('edit an existing item', () => {
  it('shows an expense as a positive amount and saves it back negative', async () => {
    open(0);
    expect(el('bp-f-amount').value).toBe('80');
    setValue(el('bp-f-amount'), '95.5', ['input']);
    saveBtn().click();
    await flush();
    expect(state.budgetItems).toHaveLength(2);
    expect(state.budgetItems[0]).toMatchObject({ id: 'food-item', default_amount: -95.5, envelope_id: 'food' });
    // The untouched row is the same object; the edited one is a new one.
    expect(state.budgetItems[1]).toBe(salary);
    expect(state.budgetItems[0]).not.toBe(groceries);
    expect(groceries.default_amount).toBe(-80);
    expect(state.budgetItems[0].monthly_schedule).toEqual({ Jan: true, Feb: 30 });
  });

  it('a failed write leaves the plan as it was, says so and keeps the editor open', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const before = state.budgetItems;
    open(0);
    setValue(el('bp-f-amount'), '99', ['input']);
    saveBtn().click();
    await flush();
    expect(state.budgetItems).toBe(before);
    expect(state.budgetItems).toEqual([groceries, salary]);
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(sheetIsOpen()).toBe(true);
    expect(rerenderTable).not.toHaveBeenCalled();
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('a refusal on a field the page has an error for is shown on that field', async () => {
    open(0);
    await flush(); // the sheet has taken focus, as it has long before a click
    setValue(el('bp-f-envelope'), 'fun');
    // The envelope went away after the sheet opened (another tab, say): the
    // command refuses the reference, and the envelope field says so.
    state.envelopes = state.envelopes.filter(e => e.id !== 'fun');
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('budgetPlan.errEnvelopeRequired'));
    expect(document.activeElement).toBe(el('bp-f-envelope-search'));
    expect(toastTexts()).toEqual([]);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.budgetItems).toEqual([groceries, salary]);
    expect(sheetIsOpen()).toBe(true);
  });

  it('saves an item carrying a legacy whole-percent cut (the guest example budget)', async () => {
    // Stored as 15 (meaning the engine's clamped 100 %) with a category the
    // form has no option for: the form shows no category, so no cut.
    state.budgetItems = [{ ...groceries, stress_category: 'food', stress_cut_pct: 15 }, salary];
    open(0);
    setValue(el('bp-f-amount'), '85', ['input']);
    saveBtn().click();
    await flush();
    expect(toastTexts()).toEqual([]);
    expect(sheetIsOpen()).toBe(false);
    expect(state.budgetItems[0]).toMatchObject({ default_amount: -85, stress_category: null, stress_cut_pct: 0 });
  });

  it('shows a negative buffer beside the field', async () => {
    open(0);
    setValue(el('bp-f-buffer'), '-1', ['input']);
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('common.bufferInvalid'));
    expect(document.activeElement).toBe(el('bp-f-buffer'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a zero amount is reported on its field and changes nothing', async () => {
    const before = state.budgetItems;
    open(0);
    setValue(el('bp-f-amount'), '0', ['input']);
    saveBtn().click();
    await flush();
    expect(errorText()).toBe(t('common.amountInvalid'));
    expect(document.activeElement).toBe(el('bp-f-amount'));
    expect(toastTexts()).toEqual([]);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.budgetItems).toBe(before);
    expect(sheetIsOpen()).toBe(true);
  });

  it('a second submit while the first is in flight saves once', async () => {
    open(0);
    setValue(el('bp-f-amount'), '81', ['input']);
    // Submitted twice back to back (Enter mashing): the second is ignored.
    const form = sheet().querySelector('form');
    form.requestSubmit();
    form.requestSubmit();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });
});

describe('delete', () => {
  it('confirms, writes the list without just that item, and offers Undo', async () => {
    open(0);
    headerBtn(t('common.delete')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    topOverlay().querySelector('.btn-accent').click();
    await flush();
    expect(state.budgetItems).toEqual([salary]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(written()).toEqual([salary]);
    expect(rerenderTable).toHaveBeenCalledWith(container);
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toContain(t('budgetPlan.deletedToast'));
  });

  it('Undo puts the item back where it was', async () => {
    open(0);
    headerBtn(t('common.delete')).click();
    await flush();
    topOverlay().querySelector('.btn-accent').click();
    await flush();
    toastButton().click();
    await flush();
    expect(state.budgetItems).toEqual([groceries, salary]);
    expect(written()).toEqual([groceries, salary]);
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('a failed write keeps the item, says so and keeps the editor open', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    const before = state.budgetItems;
    open(0);
    headerBtn(t('common.delete')).click();
    await flush();
    topOverlay().querySelector('.btn-accent').click();
    await flush();
    await flush();
    expect(state.budgetItems).toBe(before);
    expect(state.budgetItems).toEqual([groceries, salary]);
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(toastTexts()).not.toContain(t('budgetPlan.deletedToast'));
    expect(rerenderTable).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('cancelling the confirmation deletes nothing', async () => {
    open(0);
    headerBtn(t('common.delete')).click();
    await flush();
    topOverlay().querySelector('.btn-ghost').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.budgetItems).toEqual([groceries, salary]);
  });
});

describe('fill % style', () => {
  const styleBtn = (key) => [...sheet().querySelectorAll('.tx-type-btn')].find(b => b.textContent === t(key));
  const saved = () => state.budgetItems.find(it => it.id === 'food-item');

  it('shows the default (a seasonal item is a bill) and saves nothing unless clicked', async () => {
    open(0);
    expect(styleBtn('budgetPlan.fundingBill').getAttribute('aria-pressed')).toBe('true');
    expect(styleBtn('budgetPlan.fundingSpending').getAttribute('aria-pressed')).toBe('false');
    saveBtn().click();
    await flush();
    expect(saved().funding_style).toBeUndefined();
  });

  it('a click is saved', async () => {
    open(0);
    styleBtn('budgetPlan.fundingSpending').click();
    expect(styleBtn('budgetPlan.fundingSpending').getAttribute('aria-pressed')).toBe('true');
    saveBtn().click();
    await flush();
    expect(saved().funding_style).toBe('spending');
  });

  it('is hidden for income', () => {
    open(1);
    expect(styleBtn('budgetPlan.fundingBill').closest('.field').style.display).toBe('none');
  });
});

describe('fields the form does not show', () => {
  it('survive a save: skipped months, the schedule end date (as its end month), the fill % style', async () => {
    state.budgetItems = [{
      ...groceries,
      skipped_occurrences: ['2026-11'],
      as_schedule_until: '2027-06-30',
      funding_style: 'spending',
    }, salary];
    open(0);
    setValue(el('bp-f-amount'), '90', ['input']);
    saveBtn().click();
    await flush();
    const saved = state.budgetItems.find(it => it.id === 'food-item');
    expect(saved).toMatchObject({
      default_amount: -90,
      skipped_occurrences: ['2026-11'],
      // Until opened on the legacy end date, and the end month replaces it.
      end_month: '2027-06',
      funding_style: 'spending',
    });
    expect(saved).not.toHaveProperty('as_schedule_until');
  });

  it('a fill % style is dropped when the item stops being an expense', async () => {
    state.budgetItems = [{ ...groceries, funding_style: 'spending' }, salary];
    open(0);
    [...sheet().querySelectorAll('.tx-type-btn')].find(b => b.textContent === t('budgetPlan.kindIncome')).click();
    saveBtn().click();
    await flush();
    const saved = state.budgetItems.find(it => it.id === 'food-item');
    expect(saved.kind).toBe('income');
    expect(saved.funding_style).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Each kind stores exactly what the editor stored before it dispatched
// commands: the old save (tests/_fakes/oldEditorItem.js) run on the same form
// values is the reference for what the session wrote.
describe('the stored item equals the old editor save', () => {
  const TODAY = '2026-09-15'; // the fake clock
  const json = (x) => JSON.parse(JSON.stringify(x));
  // The editor's new item, before the form.
  const NEW_ITEM = {
    id: '', envelope_id: '', description: null, default_amount: 0, extra_buffer: 0, include: true,
    monthly_schedule: {}, payment_day: 0, stress_category: null, stress_cut_pct: 0,
    include_in_emergency_budget: false, as_schedule: false, account_id: null, as_schedule_since: null,
    schedule_day_type: 'exact', kind: 'expense', investment_account_id: null, symbol: null, to_account_id: null,
    start_month: null, end_month: null,
  };
  const brk = { id: 'brk', name: 'Broker', type: 'investment', initialBalance: 0 };
  const mtg = {
    id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000,
    interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360',
  };
  const loan = () => ({
    id: 'mortgage-item', kind: 'loan_payment', envelope_id: 'rent', description: 'Mortgage', default_amount: -500,
    extra_buffer: 0, include: true, as_schedule: true, account_id: 'chk', to_account_id: 'mtg', payment_day: 15,
    as_schedule_since: '2025-01-01', schedule_day_type: 'exact', loan_fee: 2.5, funding_style: 'bill',
    monthly_schedule: { Jan: true, Feb: true, Oct: true, Nov: false, Dec: false },
    loan_months_off: { Nov: true, Dec: true }, loan_paid_off: '2026-09-30', skipped_occurrences: ['2026-05'],
  });
  const toggleFor = (key) => [...sheet().querySelectorAll('.toggle')]
    .find(tg => tg.parentElement.textContent.includes(t(key)));
  const cell = (mon) => monthCells().find(c => c.dataset.mon === mon);
  const formFromDom = (extra = {}) => ({
    kind: el('bp-f-kind').value, env: el('bp-f-envelope').value, desc: el('bp-f-description').value,
    amt: el('bp-f-amount').value, buffer: el('bp-f-buffer').value, include: el('bp-f-include').checked,
    emergency: el('bp-f-emergency').checked, payDay: el('bp-f-payment-day').value, stress: el('bp-f-stress-cat').value,
    months: collectScheduleFromCells(monthCells()), asSchedule: el('bp-f-as-schedule').checked,
    account: el('bp-f-account').value, dayType: el('bp-f-day-type').value, invAcct: el('bp-f-investment-account').value,
    symbol: el('bp-f-symbol').value, invDir: el('bp-f-inv-direction').value, toAcct: el('bp-f-to-account').value,
    loanFee: el('bp-f-loan-fee').value, loanMethod: el('bp-f-loan-method').value, loanEnd: el('bp-f-loan-end').value,
    startMonth: el('bp-f-start-month').value, endMonth: el('bp-f-end-month').value,
    ...extra,
  });

  const CASES = [
    ['an existing expense, scheduled, with unrendered fields and a legacy rate', {
      setup: () => {
        state.budgetItems = [{
          ...groceries, stress_category: 'D', stress_cut_pct: 0.2, extra_buffer: 20, include_in_emergency_budget: true,
          loan_rate: 3, skipped_occurrences: ['2026-03'], as_schedule_until: '2027-01-01', template_id: 'old-tpl',
          funding_style: 'spending',
        }, salary];
        return 0;
      },
      drive: () => {
        setValue(el('bp-f-description'), '  Food & drink ');
        setValue(el('bp-f-amount'), '350', ['input']);
        setValue(el('bp-f-buffer'), '25', ['input']);
        setValue(el('bp-f-stress-cat'), 'C', ['change']);
        toggleFor('budgetPlan.postAsScheduled').click();
        setValue(el('bp-f-account'), 'chk', ['change']);
        setValue(el('bp-f-payment-day'), '5');
        setValue(el('bp-f-day-type'), 'next_work_day', ['change']);
        kindBtn('budgetPlan.fundingBill').click();
      },
      extra: { fundingStyle: 'bill' },
    }],
    ['a new income with an account, unscheduled', {
      setup: () => -1,
      drive: () => {
        kindBtn('budgetPlan.kindIncome').click();
        setValue(el('bp-f-amount'), '2500', ['input']);
        setValue(el('bp-f-account'), 'chk', ['change']);
        setValue(el('bp-f-stress-cat'), 'B', ['change']);
      },
    }],
    ['an income switched off', {
      setup: () => 1,
      drive: () => { toggleFor('budgetPlan.includeBudget').click(); },
    }],
    ['a new investment buy, scheduled', {
      setup: () => { state.accounts = [...state.accounts, brk]; return -1; },
      drive: () => {
        kindBtn('budgetPlan.kindInvestment').click();
        setValue(el('bp-f-envelope'), 'fun');
        setValue(el('bp-f-amount'), '100', ['input']);
        setValue(el('bp-f-investment-account'), 'brk');
        setValue(el('bp-f-symbol'), ' vwce ');
        setValue(el('bp-f-stress-cat'), 'E', ['change']);
        toggleFor('budgetPlan.postAsScheduled').click();
        setValue(el('bp-f-account'), 'chk', ['change']);
        setValue(el('bp-f-payment-day'), '3');
      },
    }],
    ['a new dividend', {
      setup: () => { state.accounts = [...state.accounts, brk]; return -1; },
      drive: () => {
        kindBtn('budgetPlan.kindInvestment').click();
        setValue(el('bp-f-inv-direction'), 'dividend', ['change']);
        // The envelope select stays required for any investment.
        setValue(el('bp-f-envelope'), 'fun');
        setValue(el('bp-f-amount'), '12', ['input']);
        setValue(el('bp-f-investment-account'), 'brk');
        setValue(el('bp-f-symbol'), ' vwce ');
      },
    }],
    ['an expense turned into an account transfer', {
      setup: () => 0,
      drive: () => {
        kindBtn('budgetPlan.kindTransfer').click();
        setValue(el('bp-f-account'), 'chk', ['change']);
        setValue(el('bp-f-to-account'), 'sav', ['change']);
        setValue(el('bp-f-payment-day'), '1');
      },
    }],
    ['a loan payment turned annuity, a month switched back on', {
      setup: () => { state.accounts = [...state.accounts, mtg]; state.budgetItems = [loan(), salary]; return 0; },
      drive: () => {
        cell('Nov').click();
        setValue(el('bp-f-loan-fee'), '2.75', ['input']);
        setValue(el('bp-f-loan-method'), 'annuity', ['change']);
        setValue(el('bp-f-loan-end'), '2031-01', ['change']);
      },
    }],
    ['a loan payment turned into an expense', {
      setup: () => { state.accounts = [...state.accounts, mtg]; state.budgetItems = [loan(), salary]; return 0; },
      drive: () => {
        kindBtn('budgetPlan.kindExpense').click();
        setValue(el('bp-f-amount'), '480', ['input']);
      },
    }],
  ];

  it.each(CASES)('%s', async (_label, { setup, drive, extra }) => {
    const idx = setup();
    const isNew = idx === -1;
    const items = state.budgetItems;
    const base = isNew ? NEW_ITEM : items[idx];
    open(idx);
    drive();
    const expected = oldEditorItem(base, formFromDom(extra), { isNew, items, today: TODAY });
    saveBtn().click();
    await flush();
    expect(errorText()).toBe('');
    expect(toastTexts()).toEqual([]);
    expect(sheetIsOpen()).toBe(false);
    const stored = state.budgetItems.find(it => it.id === expected.id);
    expect(json(stored)).toEqual(json(expected));
    expect(state.budgetItems).toHaveLength(isNew ? items.length + 1 : items.length);
    expect(written()).toEqual(state.budgetItems);
  });

  it('covers every kind', () => {
    const kinds = new Set();
    for (const [, { setup, drive }] of CASES) {
      resetState();
      mountHosts();
      state.budgetItems = [groceries, salary];
      open(setup());
      drive();
      kinds.add(el('bp-f-kind').value);
    }
    expect(kinds).toEqual(new Set(['expense', 'income', 'investment_transfer', 'account_transfer', 'loan_payment']));
  });
});

describe('active from / until', () => {
  const cell = (mon) => monthCells().find(c => c.dataset.mon === mon);
  const activeRow = () => el('bp-f-start-month')?.closest('.bp-active-row');
  const yearly = () => sheet().querySelector('#bp-total-yearly').textContent;

  it('shows two empty month pickers for an expense', () => {
    open(0);
    expect(el('bp-f-start-month').type).toBe('month');
    expect(el('bp-f-end-month').type).toBe('month');
    expect(el('bp-f-start-month').value).toBe('');
    expect(el('bp-f-end-month').value).toBe('');
    expect(activeRow().style.display).not.toBe('none');
  });

  it('is hidden for a loan payment', () => {
    state.accounts = [...state.accounts, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -1000 }];
    state.budgetItems = [...state.budgetItems, {
      id: 'mtg-item', kind: 'loan_payment', envelope_id: 'food', default_amount: -500, extra_buffer: 0, include: true,
      monthly_schedule: { Jan: true }, payment_day: 5, as_schedule: true, account_id: 'chk', to_account_id: 'mtg',
      as_schedule_since: '2026-01-01', schedule_day_type: 'exact',
    }];
    open(2);
    expect(activeRow().style.display).toBe('none');
  });

  it('opens Until on a legacy end date', () => {
    state.budgetItems = [{ ...salary, as_schedule_until: '2026-10-31' }, groceries];
    open(0);
    expect(el('bp-f-end-month').value).toBe('2026-10');
  });

  it('saves both months, and the end month replaces the legacy end date', async () => {
    state.budgetItems = [{ ...salary, as_schedule_until: '2026-10-31' }, groceries];
    open(0);
    setValue(el('bp-f-start-month'), '2026-01', ['change']);
    setValue(el('bp-f-end-month'), '2026-12', ['change']);
    saveBtn().click();
    await flush();
    const saved = state.budgetItems.find(it => it.id === 'income-item');
    expect(saved).toMatchObject({ start_month: '2026-01', end_month: '2026-12' });
    expect(saved).not.toHaveProperty('as_schedule_until');
  });

  it('refuses an Until before From and keeps the sheet open', async () => {
    open(0);
    setValue(el('bp-f-start-month'), '2026-10', ['change']);
    setValue(el('bp-f-end-month'), '2026-09', ['change']);
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
    expect(errorText()).toBe(t('budgetPlan.activeOrder'));
  });

  it('counts only the months inside the dates in the yearly total', () => {
    // The fake clock is 15 Sep 2026: Jan and Feb fall in 2027.
    open(0); // groceries: Jan 80, Feb 30
    expect(yearly()).toContain('110');
    setValue(el('bp-f-start-month'), '2027-02', ['change']);
    expect(yearly()).toContain('30');
    expect(yearly()).not.toContain('110');
    setValue(el('bp-f-start-month'), '', ['change']);
    setValue(el('bp-f-end-month'), '2026-12', ['change']);
    expect(yearly()).not.toMatch(/[1-9]/);
  });

  it('dims the months outside the dates and leaves them out of the quarter totals', () => {
    open(0); // groceries: Jan 80, Feb 30; the fake clock is 15 Sep 2026
    const q1 = () => sheet().querySelector('.bp-qtotal[data-q="Q1"]').textContent;
    expect(q1()).toContain('110');
    setValue(el('bp-f-end-month'), '2026-12', ['change']);
    expect(cell('Jan').classList.contains('bp-mcell--outside')).toBe(true);
    expect(cell('Mar').classList.contains('bp-mcell--outside')).toBe(false); // not ticked
    expect(q1()).toBe('—');
    setValue(el('bp-f-end-month'), '', ['change']);
    expect(cell('Jan').classList.contains('bp-mcell--outside')).toBe(false);
    expect(q1()).toContain('110');
  });
});
