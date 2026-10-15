// @vitest-environment jsdom
// Edit transaction sheet: what an edit, a type change, a delete and a forecast
// post write back to the ledger. Drives the real js/pages/edit-tx.js. The page
// dispatches through the session (the real browser session over the fake state
// in _fakes/pageApp.js), so the tests assert on state.transactions once the
// dispatch has settled and on writeBatch, the storage boundary.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// jsdom does not implement scrolling used by focused validation comboboxes.
Element.prototype.scrollIntoView = () => {};

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
// Reopening a closed month and the payee rule write meta through the meta
// queue; the fake queue applies the patch to the fake state without touching
// storage.
vi.mock('../js/state/meta-writes.js', async () => ({
  ...(await vi.importActual('../js/state/meta-writes.js')),
  updateMeta: (await import('./_fakes/pageApp.js')).updateMetaFake,
}));

import { openEditTx } from '../js/pages/edit-tx.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';
import {
  state, writeBatch, navigate, resetState, mountHosts, flush, setValue, sheetIsOpen,
  session, FIXED_NOW, toastTexts,
} from './_fakes/pageApp.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
const form = () => document.querySelector('#sheet-host form');
const input = (name) => form().querySelector(`input[name="${name}"]`);
const actionBtn = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const saveBtn = () => actionBtn(t('addTx.save'));
const typeBtn = (v) => form().querySelector(`.tx-type-btn[data-value="${v}"]`);
const fieldSelect = (labelText) => {
  const wrap = [...form().querySelectorAll('.field')].find(f => f.querySelector(':scope > label')?.textContent === labelText);
  return wrap?.querySelector('select');
};
const topOverlay = () => [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')].at(-1);
const dialogOk = () => topOverlay().querySelector('.btn-accent');
const toasts = () => [...document.querySelectorAll('#toast-host .toast')].map(el => el.textContent);

// What the session stamps on a row it changes: the injected clock, not wall time.
const AT = FIXED_NOW.toISOString();
const written = () => state.transactions;
// The transactions file of the last storage write.
const lastWrite = () => writeBatch.mock.calls.at(-1)[1].find(i => i.filename === 'transactions.json').data;
const byId = (id) => written().find(x => x.id === id);

const other = { id: 'other', type: 'expense', date: '2026-09-02', payee: 'Other', amount: 9, envelope_id: 'fun', account: 'chk', status: 'posted' };
let expense;

beforeEach(() => {
  expense = {
    id: 'e1', type: 'expense', date: '2026-09-03', payee: 'Shop', amount: 20,
    envelope_id: 'food', account: 'chk', note: 'weekly', status: 'posted',
    created_at: '2026-09-03T08:00:00.000Z', modified_at: '2026-09-03T08:00:00.000Z',
  };
  resetState({ transactions: [other, expense] });
  mountHosts();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
});

describe('edit an expense', () => {
  it('its actions sit in the fixed header: Delete and Reverse left, Cancel and Save at the end, regular size', () => {
    openEditTx(expense);
    const title = sheet().querySelector('[id^="sheet-title-"]');
    expect(title.querySelector('button')).toBeNull();
    const footer = sheet().querySelector('.sheet-header .sheet-footer-actions');
    expect(footer).not.toBeNull();
    expect(footer.closest('.sheet-body')).toBeNull();
    const labels = (sel) => [...footer.querySelectorAll(`${sel} button`)].map(b => b.textContent);
    expect(labels('.sheet-footer-actions-start')).toEqual([t('editTx.delete'), t('reversal.title')]);
    expect(labels('.sheet-footer-actions-end')).toEqual([t('addTx.cancel'), t('addTx.save')]);
    expect([...footer.querySelectorAll('button')].some(b => b.classList.contains('btn-sm'))).toBe(false);
  });

  it('Cancel in the header closes an untouched sheet', async () => {
    openEditTx(expense);
    actionBtn(t('addTx.cancel')).click();
    await flush();
    expect(document.querySelector('#sheet-host .sheet-overlay[data-sheet-open]')).toBeNull();
  });

  it('pre-fills the form from the transaction', () => {
    openEditTx(expense);
    expect(input('payee').value).toBe('Shop');
    expect(input('amount').value).toBe('20');
    expect(input('date').value).toBe('2026-09-03');
    expect(input('note').value).toBe('weekly');
    expect(input('note').closest('details').open).toBe(true);
    expect(form().querySelector('.split-env').value).toBe('food');
  });

  it('replaces only the edited row, keeping unedited fields and created_at', async () => {
    openEditTx(expense);
    setValue(input('payee'), ' Market ');
    setValue(input('amount'), '25.5');
    setValue(input('date'), '2026-09-04');
    setValue(form().querySelector('.split-env'), 'fun');
    saveBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(lastWrite()).toEqual(written());
    expect(written()).toHaveLength(2);
    expect(byId('other')).toEqual(other);
    expect(byId('e1')).toMatchObject({
      id: 'e1', type: 'expense', payee: 'Market', amount: 25.5, date: '2026-09-04',
      envelope_id: 'fun', account: 'chk', note: 'weekly', status: 'posted',
      created_at: '2026-09-03T08:00:00.000Z',
    });
    expect(byId('e1').modified_at).toBe(AT);
    expect(sheetIsOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('transactions');
    expect(toasts()).toContain(t('editTx.saved'));
  });

  it('does not mutate the previous ledger array or its rows', async () => {
    const before = state.transactions;
    const beforeRow = { ...expense };
    openEditTx(expense);
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(written()).not.toBe(before);
    expect(before).toEqual([other, beforeRow]);
  });

  it('rejects an amount of zero without writing', async () => {
    openEditTx(expense);
    setValue(input('amount'), '0');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('common.amountInvalid'));
    expect(sheetIsOpen()).toBe(true);
  });

  it('a double-click on Save writes once', async () => {
    openEditTx(expense);
    setValue(input('amount'), '21');
    saveBtn().click();
    saveBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('splitting: lowering the first line fills the new empty line with the rest (UX 2026-10-05)', () => {
    openEditTx(expense);
    form().querySelector('.split-add').click();
    const rows = [...form().querySelectorAll('.split-row')];
    expect(rows[1].querySelector('.split-amt').value).toBe('');
    setValue(rows[0].querySelector('.split-amt'), '12', ['input']);
    expect(rows[1].querySelector('.split-amt').value).toBe('8.00');
  });

  it('turns a single-envelope expense into splits that must add up', async () => {
    openEditTx(expense);
    form().querySelector('.split-add').click();
    let rows = [...form().querySelectorAll('.split-row')];
    expect(rows).toHaveLength(2);
    setValue(rows[0].querySelector('.split-amt'), '12');
    rows = [...form().querySelectorAll('.split-row')];
    setValue(rows[1].querySelector('.split-env'), 'fun');
    setValue(rows[1].querySelector('.split-amt'), '8');
    // Raising the total to 25 leaves 12 + 8 short of it: refused with a toast.
    setValue(input('amount'), '25');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint').textContent).toContain(t('editTx.splitSumMismatch').split('{sum}')[0]);

    setValue(input('amount'), '20');
    saveBtn().click();
    await flush();
    expect(byId('e1').envelope_id).toBeNull();
    expect(byId('e1').envelope_splits).toEqual([
      { envelope_id: 'food', amount: 12 },
      { envelope_id: 'fun', amount: 8 },
    ]);
    expect(byId('e1').amount).toBe(20);
  });

  it('choosing "No envelope" stores the deliberate __none__ value, not null', async () => {
    openEditTx(expense);
    setValue(form().querySelector('.split-env'), '__none__');
    saveBtn().click();
    await flush();
    expect(byId('e1').envelope_id).toBe('__none__');
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('a legacy row with a stray field of another type is saved without it', async () => {
    const legacy = { ...expense, id: 'g1', from_account: 'sav' };
    state.transactions = [legacy];
    openEditTx(legacy);
    setValue(input('amount'), '21');
    saveBtn().click();
    await flush();
    expect(byId('g1')).toMatchObject({ amount: 21, account: 'chk', envelope_id: 'food' });
    expect(byId('g1')).not.toHaveProperty('from_account');
    expect(toasts()).toContain(t('editTx.saved'));
  });

  it('collapsing splits back to one envelope drops envelope_splits', async () => {
    const split = { ...expense, id: 's1', envelope_id: null, envelope_splits: [
      { envelope_id: 'food', amount: 12 }, { envelope_id: 'fun', amount: 8 },
    ] };
    state.transactions = [split];
    openEditTx(split);
    const rows = [...form().querySelectorAll('.split-row')];
    expect(rows).toHaveLength(2);
    rows[1].querySelector('.split-rm').click();
    setValue(form().querySelector('.split-env'), 'rent');
    saveBtn().click();
    await flush();
    expect(byId('s1').envelope_splits).toBeUndefined();
    expect(byId('s1').envelope_id).toBe('rent');
  });
});

describe('change type', () => {
  it('expense to account transfer drops account and envelope, and needs two different accounts', async () => {
    openEditTx(expense);
    typeBtn('account_transfer').click();
    const fromSel = fieldSelect(t('editTx.fromAccount'));
    const toSel = fieldSelect(t('editTx.toAccount'));
    // The current account seeds both sides: same account is refused.
    expect(fromSel.value).toBe('chk');
    expect(toSel.value).toBe('chk');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('editTx.accountsSameError'));

    setValue(toSel, 'sav');
    saveBtn().click();
    await flush();
    const saved = byId('e1');
    expect(saved).toMatchObject({ type: 'account_transfer', from_account: 'chk', to_account: 'sav', amount: 20 });
    expect(saved.account).toBeUndefined();
    expect(saved.envelope_id).toBeUndefined();
    expect(saved.envelope_splits).toBeUndefined();
  });

  it('expense to income moves the envelope into the credit envelope', async () => {
    openEditTx(expense);
    typeBtn('income').click();
    setValue(fieldSelect(t('addTx.incomeEnvelope')), 'rent');
    saveBtn().click();
    await flush();
    expect(byId('e1')).toMatchObject({ type: 'income', envelope_id: 'rent', account: 'chk', amount: 20 });
  });
});

describe('change type strips the old type', () => {
  it('expense to account transfer drops every expense field, including the plan item and splits', async () => {
    const rich = { ...expense, id: 'r1', budget_item_id: 'item1', envelope_id: 'food' };
    state.transactions = [rich];
    openEditTx(rich);
    typeBtn('account_transfer').click();
    setValue(fieldSelect(t('editTx.toAccount')), 'sav');
    saveBtn().click();
    await flush();
    const saved = byId('r1');
    expect(saved).toMatchObject({ type: 'account_transfer', from_account: 'chk', to_account: 'sav', amount: 20, note: 'weekly', created_at: '2026-09-03T08:00:00.000Z', modified_at: AT });
    for (const f of ['account', 'envelope_id', 'envelope_splits', 'budget_item_id']) expect(saved).not.toHaveProperty(f);
  });

  it('income to expense drops nothing it still needs', async () => {
    const inc = { id: 'i1', type: 'income', date: '2026-09-05', payee: 'Pay', amount: 100, envelope_id: 'rent', account: 'chk', status: 'posted' };
    state.transactions = [inc];
    openEditTx(inc);
    typeBtn('expense').click();
    saveBtn().click();
    await flush();
    expect(byId('i1')).toMatchObject({ type: 'expense', account: 'chk', envelope_id: 'rent', amount: 100 });
  });

  it('editing loan-given interest keeps its interest_of link; a type change drops it', async () => {
    state.accounts = [...state.accounts, { id: 'lg', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0 }];
    const inc = { id: 'i1', type: 'income', date: '2026-09-05', payee: 'Sam', amount: 25, envelope_id: null, account: 'chk', interest_of: 'lg', status: 'posted' };
    state.transactions = [inc];
    openEditTx(inc);
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(byId('i1')).toMatchObject({ type: 'income', amount: 30, interest_of: 'lg' });
    openEditTx(byId('i1'));
    typeBtn('expense').click();
    saveBtn().click();
    await flush();
    expect(byId('i1').type).toBe('expense');
    expect(byId('i1')).not.toHaveProperty('interest_of');
  });
});

describe('interest on a loan given (income)', () => {
  const lg = { id: 'lg', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0 };
  const picker = () => form().querySelector('select[id^="etx-interest-of-"]');
  const inc = (over = {}) => ({ id: 'i1', type: 'income', date: '2026-09-05', payee: 'Sam', amount: 25, envelope_id: null, account: 'chk', status: 'posted', ...over });

  it('without a loan given there is no picker', () => {
    state.transactions = [inc()];
    openEditTx(inc());
    expect(picker()).toBeNull();
  });

  it('links plain income to a loan given through transaction.amend', async () => {
    state.accounts = [...state.accounts, lg];
    state.transactions = [inc()];
    const spy = vi.spyOn(session, 'dispatch');
    openEditTx(inc());
    expect(picker().closest('.field').style.display).toBe('');
    expect(picker().value).toBe('');
    setValue(picker(), 'lg', ['change']);
    saveBtn().click();
    await flush();
    expect(spy.mock.calls.find(c => c[0] === 'transaction.amend' && !c[2]?.dryRun)[1]).toMatchObject({ id: 'i1', interestOf: 'lg' });
    expect(byId('i1').interest_of).toBe('lg');
    spy.mockRestore();
  });

  it('clears the link when set back to none; an unchanged link is not sent', async () => {
    state.accounts = [...state.accounts, lg];
    state.transactions = [inc({ interest_of: 'lg' })];
    const spy = vi.spyOn(session, 'dispatch');
    openEditTx(inc({ interest_of: 'lg' }));
    expect(picker().value).toBe('lg');
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(spy.mock.calls.filter(c => c[0] === 'transaction.amend').every(c => !Object.hasOwn(c[1], 'interestOf'))).toBe(true);
    openEditTx(byId('i1'));
    setValue(picker(), '', ['change']);
    saveBtn().click();
    await flush();
    expect(byId('i1')).not.toHaveProperty('interest_of');
    spy.mockRestore();
  });

  it('is hidden for other types', () => {
    state.accounts = [...state.accounts, lg];
    openEditTx(expense);
    expect(picker().closest('.field').style.display).toBe('none');
  });
});

describe('change type from a split expense', () => {
  it('to income leaves no envelope_splits behind', async () => {
    const split = { ...expense, id: 's1', envelope_id: null, envelope_splits: [
      { envelope_id: 'food', amount: 12 }, { envelope_id: 'fun', amount: 8 },
    ] };
    state.transactions = [split];
    openEditTx(split);
    typeBtn('income').click();
    saveBtn().click();
    await flush();
    expect(byId('s1').type).toBe('income');
    expect(byId('s1').envelope_splits).toBeUndefined();
    expect(byId('s1').envelope_id).toBeNull();
  });
});

describe('edit an adjustment', () => {
  it('keeps the signed amount', async () => {
    const adj = { id: 'a1', type: 'adjustment', target: 'account', target_id: 'chk', date: '2026-09-06', amount: -12.34, note: 'fee' };
    state.transactions = [adj];
    openEditTx(adj);
    expect(input('amount').value).toBe('-12.34');
    setValue(input('amount'), '-15');
    saveBtn().click();
    await flush();
    expect(byId('a1')).toMatchObject({ type: 'adjustment', target: 'account', target_id: 'chk', amount: -15, note: 'fee' });
  });
});

describe('edit an envelope transfer', () => {
  it('maps the Unallocated sentinel to null and refuses the same envelope on both sides', async () => {
    const et = { id: 'et1', type: 'envelope_transfer', date: '2026-09-07', payee: 'Move', amount: 40, from_envelope_id: 'food', to_envelope_id: null };
    state.transactions = [et];
    openEditTx(et);
    expect(fieldSelect(t('addTx.toEnvelope')).value).toBe('__unallocated__');
    setValue(fieldSelect(t('addTx.toEnvelope')), 'food');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('editTx.envTransferSameError'));

    setValue(fieldSelect(t('addTx.fromEnvelope')), '__unallocated__');
    saveBtn().click();
    await flush();
    expect(byId('et1')).toMatchObject({ from_envelope_id: null, to_envelope_id: 'food', amount: 40 });
  });
});

describe('delete', () => {
  it('asks first, then removes only that row, and Undo restores the previous ledger', async () => {
    const before = state.transactions;
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    // The confirmation is up; nothing is written until it is accepted.
    expect(writeBatch).not.toHaveBeenCalled();
    dialogOk().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(written()).toEqual([other]);
    expect(sheetIsOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('transactions');

    document.querySelector('#toast-host .toast-action').click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(written()).toEqual(before);
    expect(toasts()).toContain(t('common.restored'));
  });

  it('Undo puts back only the deleted row, keeping a row added since', async () => {
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    const late = { ...other, id: 'late' };
    state.transactions = [...state.transactions, late];

    document.querySelector('#toast-host .toast-action').click();
    await flush();
    expect(written().map(x => x.id).sort()).toEqual(['e1', 'late', 'other']);
    expect(byId('e1')).toEqual(expense);
    expect(byId('late')).toEqual(late);
  });

  it('Undo after a budget switch writes nothing', async () => {
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    state.budgetFolder = { name: 'budget-B' };
    state.transactions = [];

    document.querySelector('#toast-host .toast-action').click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toEqual([]);
    expect(toasts().some(x => x.includes(t('coreError.undoBudgetChanged')))).toBe(true);
  });

  it('cancelling the confirmation keeps the transaction', async () => {
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    topOverlay().querySelector('.btn-ghost').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(written()).toHaveLength(2);
  });

  it('a row posted from a plan item leaves a tombstone in meta; Undo removes it again', async () => {
    const linked = { ...expense, id: 'l1', from_budget: 'b1:2026-09' };
    state.transactions = [other, linked];
    // A real budget's meta always carries its schema version, which the commit checks demand of a meta change.
    state.meta = { schemaVersion: 8 };
    openEditTx(linked);
    actionBtn(t('editTx.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(written()).toEqual([other]);
    expect(state.meta.scheduledTombstones).toEqual(['b1:2026-09']);

    document.querySelector('#toast-host .toast-action').click();
    await flush();
    expect(written().map(x => x.id).sort()).toEqual(['l1', 'other']);
    expect(state.meta.scheduledTombstones ?? []).not.toContain('b1:2026-09');
  });

  it('a row without a plan link writes no tombstone', async () => {
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.meta.scheduledTombstones).toBeUndefined();
  });

  it('a refused delete is toasted and the row stays', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(written()).toHaveLength(2);
    expect(toasts().some(m => m.startsWith(t('editTx.saveFailed')) && m.includes('disk full'))).toBe(true);
  });
});

describe('stale scheduled link', () => {
  // A row materialised from a budget item carries `from_budget: item:month`.
  // Moving it into another month would leave the old month's occurrence
  // looking unposted, so the sheet offers to move the link along.
  const linked = () => ({ ...expense, id: 'l1', from_budget: 'b1:2026-08', date: '2026-08-20' });

  it('relinks to the new month when the user accepts', async () => {
    const tx = linked();
    state.transactions = [tx];
    openEditTx(tx);
    setValue(input('date'), '2026-09-20');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    dialogOk().click();
    await flush();
    expect(byId('l1').from_budget).toBe('b1:2026-09');
    expect(byId('l1').date).toBe('2026-09-20');
  });

  it('keeps the old link when the user declines', async () => {
    const tx = linked();
    state.transactions = [tx];
    openEditTx(tx);
    setValue(input('date'), '2026-09-20');
    saveBtn().click();
    await flush();
    topOverlay().querySelector('.btn-ghost').click();
    await flush();
    expect(byId('l1').from_budget).toBe('b1:2026-08');
  });

  it('does not offer to relink onto a month another row already claims', async () => {
    const tx = linked();
    const claimed = { ...other, id: 'c1', from_budget: 'b1:2026-09' };
    state.transactions = [tx, claimed];
    openEditTx(tx);
    setValue(input('date'), '2026-09-20');
    saveBtn().click();
    await flush();
    // Only an acknowledgement is shown; accepting it keeps the old key.
    dialogOk().click();
    await flush();
    expect(byId('l1').from_budget).toBe('b1:2026-08');
    expect(byId('c1').from_budget).toBe('b1:2026-09');
  });
});

describe('post a forecast occurrence', () => {
  const forecast = (over = {}) => ({
    id: 'forecast:b1:2026-09', is_forecast: true, type: 'expense', date: '2026-09-25', payee: 'Rent',
    amount: 800, envelope_id: 'rent', account: 'chk', forecast_budget_item_id: 'b1', forecast_month_key: '2026-09',
    ...over,
  });

  it('its actions sit in the fixed header: Skip on the left, Cancel and Post now at the end', () => {
    openEditTx(forecast());
    const footer = sheet().querySelector('.sheet-header .sheet-footer-actions');
    const labels = (sel) => [...footer.querySelectorAll(`${sel} button`)].map(b => b.textContent);
    expect(labels('.sheet-footer-actions-start')).toEqual([t('transactions.skipOccurrence')]);
    expect(labels('.sheet-footer-actions-end')).toEqual([t('addTx.cancel'), t('transactions.postNow')]);
  });

  it('writes a real posted transaction linked to the budget item and month', async () => {
    const fc = forecast();
    openEditTx(fc);
    setValue(input('amount'), '810');
    actionBtn(t('transactions.postNow')).click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(written()).toHaveLength(3);
    const real = written().at(-1);
    expect(real).toMatchObject({
      // Posted before its date (FIXED_NOW is 15 Sep): paid today.
      type: 'expense', amount: 810, date: '2026-09-15', payee: 'Rent',
      envelope_id: 'rent', account: 'chk', from_budget: 'b1:2026-09',
      created_at: AT, modified_at: AT,
    });
    expect(real.status).toBe('posted');
    expect(real.id).not.toBe(fc.id);
    expect(real.is_forecast).toBeUndefined();
    expect(written().some(x => x.id === fc.id)).toBe(false);
    expect(sheetIsOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('transactions');
    expect(toasts()).toContain(t('editTx.saved'));
  });

  it('posts an occurrence months ahead as paid today, keeping its key, with no relink question', async () => {
    const fc = forecast({ id: 'forecast:b1:2026-12', date: '2026-12-25', forecast_month_key: '2026-12' });
    openEditTx(fc);
    expect(input('date').value).toBe('2026-09-15');
    actionBtn(t('transactions.postNow')).click();
    await flush();
    // Written without answering any dialog: no relink question was asked.
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(written().at(-1)).toMatchObject({ date: '2026-09-15', from_budget: 'b1:2026-12', status: 'posted' });
    expect(sheetIsOpen()).toBe(false);
  });

  it('an occurrence already due keeps its own date', async () => {
    const fc = forecast({ id: 'forecast:b1:2026-09', date: '2026-09-03' });
    openEditTx(fc);
    expect(input('date').value).toBe('2026-09-03');
    actionBtn(t('transactions.postNow')).click();
    await flush();
    expect(written().at(-1)).toMatchObject({ date: '2026-09-03', from_budget: 'b1:2026-09' });
  });

  it('posts an account transfer without an envelope', async () => {
    const fc = forecast({ type: 'account_transfer', payee: 'Save', envelope_id: undefined, account: undefined, from_account: 'chk', to_account: 'sav' });
    openEditTx(fc);
    actionBtn(t('transactions.postNow')).click();
    await flush();
    const real = written().at(-1);
    expect(real).toMatchObject({ type: 'account_transfer', from_account: 'chk', to_account: 'sav', amount: 800, from_budget: 'b1:2026-09' });
    expect(real).not.toHaveProperty('envelope_id');
    expect(real).not.toHaveProperty('account');
  });

  it('posts an income into its envelope and keeps the forecast note', async () => {
    const fc = forecast({ type: 'income', payee: 'Salary', amount: 3000, envelope_id: 'rent', note: 'monthly' });
    openEditTx(fc);
    actionBtn(t('transactions.postNow')).click();
    await flush();
    expect(written().at(-1)).toMatchObject({ type: 'income', payee: 'Salary', amount: 3000, account: 'chk', note: 'monthly', from_budget: 'b1:2026-09' });
  });

  it('refuses an account transfer between the same account without writing', async () => {
    const fc = forecast({ type: 'account_transfer', envelope_id: undefined, account: undefined, from_account: 'chk', to_account: 'chk' });
    openEditTx(fc);
    actionBtn(t('transactions.postNow')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('editTx.accountsSameError'));
  });

  it('a refused write is toasted and the sheet stays open', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    openEditTx(forecast());
    actionBtn(t('transactions.postNow')).click();
    await flush();
    expect(written()).toHaveLength(2);
    expect(sheetIsOpen()).toBe(true);
    expect(toasts().some(m => m.startsWith(t('editTx.saveFailed')) && m.includes('disk full'))).toBe(true);
  });
});

describe('skip a forecast occurrence', () => {
  const forecast = () => ({
    id: 'forecast:b1:2026-09', is_forecast: true, type: 'expense', date: '2026-09-25', payee: 'Rent',
    amount: 800, envelope_id: 'rent', account: 'chk', forecast_budget_item_id: 'b1', forecast_month_key: '2026-09',
  });
  const item = (over = {}) => ({ id: 'b1', kind: 'expense', envelope_id: 'rent', default_amount: -800, include: true, ...over });
  const skip = async () => {
    actionBtn(t('transactions.skipOccurrence')).click();
    await flush();
    dialogOk().click();
    await flush();
  };

  it('dispatches budgetItem.skipOccurrence with the item and month, then closes and navigates', async () => {
    state.budgetItems = [item()];
    const spy = vi.spyOn(session, 'dispatch');
    openEditTx(forecast());
    await skip();
    expect(spy).toHaveBeenCalledWith('budgetItem.skipOccurrence', { id: 'b1', month: '2026-09' }, undefined);
    expect(state.budgetItems.find(b => b.id === 'b1').skipped_occurrences).toEqual(['2026-09']);
    expect(sheetIsOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('transactions');
    spy.mockRestore();
  });

  it('the confirm names the month in words; the toast says what was skipped and offers Undo', async () => {
    state.budgetItems = [item()];
    openEditTx(forecast());
    actionBtn(t('transactions.skipOccurrence')).click();
    await flush();
    const dialogText = topOverlay().textContent;
    expect(dialogText).toContain(fmtMonthLang('2026-09'));
    expect(dialogText).not.toContain('2026-09\u2019s');
    dialogOk().click();
    await flush();
    expect(toastTexts().some(m => m.includes(t('transactions.skipped')('Rent', fmtMonthLang('2026-09'))))).toBe(true);
    document.querySelector('#toast-host .toast-action').click();
    await flush();
    expect(state.budgetItems.find(b => b.id === 'b1').skipped_occurrences ?? []).toEqual([]);
  });

  it('keeps the months skipped earlier', async () => {
    state.budgetItems = [item({ skipped_occurrences: ['2026-08'] })];
    openEditTx(forecast());
    await skip();
    expect(state.budgetItems[0].skipped_occurrences).toEqual(['2026-08', '2026-09']);
  });

  it('an already-skipped month is a no-op: nothing dispatched, the sheet closes', async () => {
    const skipped = item({ skipped_occurrences: ['2026-09'] });
    state.budgetItems = [skipped];
    const spy = vi.spyOn(session, 'dispatch');
    openEditTx(forecast());
    await skip();
    expect(spy).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.budgetItems[0]).toBe(skipped);
    expect(sheetIsOpen()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('transactions');
    spy.mockRestore();
  });

  it('a failed write leaves the item as it was, toasts and keeps the sheet open', async () => {
    const before = [item()];
    state.budgetItems = before;
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    openEditTx(forecast());
    await skip();
    expect(state.budgetItems).toBe(before);
    expect(state.budgetItems[0].skipped_occurrences).toBeUndefined();
    expect(sheetIsOpen()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(toasts().some(m => m.includes('disk full'))).toBe(true);
  });
});

describe('a stored scheduled row', () => {
  const postBtn = () => actionBtn(t('transactions.postNow'));

  it('a cleared-but-scheduled row says so and posts on its own date', async () => {
    const stuck = { ...expense, status: 'scheduled', cleared: true };
    state.transactions = [other, stuck];
    openEditTx(stuck);
    expect(form().textContent).toContain(t('editTx.scheduledClearedNote'));
    postBtn().click();
    await flush();
    expect(byId('e1')).toMatchObject({ status: 'posted', cleared: true, date: '2026-09-03' });
  });

  it('a row scheduled for a later day posts as of today', async () => {
    const ahead = { ...expense, date: '2026-09-20', status: 'scheduled' };
    state.transactions = [other, ahead];
    openEditTx(ahead);
    expect(form().textContent).toContain(t('editTx.scheduledNote'));
    postBtn().click();
    await flush();
    expect(byId('e1')).toMatchObject({ status: 'posted', date: '2026-09-15' });
  });

  it('a posted row has no Post now', () => {
    openEditTx(expense);
    expect(postBtn()).toBeUndefined();
  });
});

describe('reconciled with the bank (soft lock)', () => {
  beforeEach(() => {
    expense = { ...expense, cleared: true };
    state.transactions = [other, expense];
    state.accounts = state.accounts.map(a => a.id === 'chk'
      ? { ...a, lastReconciledAt: '2026-09-30', lastReconciledBalance: 0 }
      : a);
  });

  it('says so in the sheet and asks before an amount change; Cancel writes nothing', async () => {
    openEditTx(expense);
    expect(form().textContent).toContain(t('reconciledRow.sheetNote')('Sep 30, 2026').slice(0, 20));
    setValue(input('amount'), '21');
    saveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('reconciledRow.editAnyway'));
    topOverlay().querySelector('.btn-ghost').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('"Edit anyway" saves', async () => {
    openEditTx(expense);
    setValue(input('amount'), '21');
    saveBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(byId('e1').amount).toBe(21);
  });

  it('lets an edit that leaves the balance alone through without asking', async () => {
    openEditTx(expense);
    setValue(input('payee'), 'Market');
    saveBtn().click();
    await flush();
    expect(byId('e1').payee).toBe('Market');
  });

  it('asks before the delete confirmation', async () => {
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    expect(topOverlay().textContent).toContain(t('reconciledRow.editAnyway'));
  });

  it('shows no note for a row after the reconcile date', () => {
    const oct = { ...expense, date: '2026-10-03' };
    state.transactions = [oct];
    openEditTx(oct);
    expect(form().textContent).not.toContain(t('reconciledRow.title'));
    expect(form().querySelectorAll('.closed-month-note')).toHaveLength(0);
  });
});

describe('closed month (soft lock)', () => {
  beforeEach(() => { state.meta = { closed_months: ['2026-09'] }; });

  it('says so in the sheet and asks before saving; Cancel writes nothing', async () => {
    openEditTx(expense);
    expect(form().textContent).toContain(t('closedPeriod.sheetNote'));
    setValue(input('amount'), '21');
    saveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.editAnyway'));
    topOverlay().querySelector('.btn-ghost').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('"Edit anyway" saves', async () => {
    openEditTx(expense);
    setValue(input('amount'), '21');
    saveBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(byId('e1').amount).toBe(21);
  });

  it('moving a row INTO a closed month asks too', async () => {
    const oct = { ...expense, date: '2026-10-03' };
    state.transactions = [oct];
    openEditTx(oct);
    expect(form().textContent).not.toContain(t('closedPeriod.sheetNote'));
    setValue(input('date'), '2026-09-30');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(topOverlay().textContent).toContain(t('closedPeriod.editAnyway'));
  });

  it('asks before the delete confirmation', async () => {
    openEditTx(expense);
    actionBtn(t('editTx.delete')).click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.editAnyway'));
    dialogOk().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    dialogOk().click();
    await flush();
    expect(written()).toEqual([other]);
  });

  it('an open month saves without asking', async () => {
    state.meta = { closed_months: ['2026-08'] };
    openEditTx(expense);
    setValue(input('amount'), '22');
    saveBtn().click();
    await flush();
    expect(byId('e1').amount).toBe(22);
  });
});

describe('closed automatically (Settings)', () => {
  // FIXED_NOW is 15 Sep 2026: with one month, August stays open, July closes.
  const july = () => ({ ...expense, id: 'j', date: '2026-07-20' });

  it('a July row asks; an August row does not', async () => {
    state.meta = { auto_close_after_months: 1 };
    const row = july();
    state.transactions = [row];
    openEditTx(row);
    expect(form().textContent).toContain(t('closedPeriod.sheetNote'));
    setValue(input('amount'), '21');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(topOverlay().textContent).toContain(t('closedPeriod.editAnyway'));
  });

  it('Reopen in the sheet writes the exception, and saving then does not ask', async () => {
    state.meta = { schemaVersion: 8, auto_close_after_months: 1 };
    const row = july();
    state.transactions = [row];
    const spy = vi.spyOn(session, 'dispatch');
    spy.mockClear();
    openEditTx(row);
    [...form().querySelectorAll('.closed-month-note button')][0].click();
    await flush();
    dialogOk().click();
    await flush();
    expect(spy).toHaveBeenCalledWith('month.reopen', { month: '2026-07' }, undefined);
    expect(state.meta.reopened_months).toEqual(['2026-07']);
    expect(toastTexts()).toContain(t('closedPeriod.reopened')(fmtMonthLang('2026-07')));
    expect(form().querySelector('.closed-month-note')).toBeNull();
    setValue(input('amount'), '22');
    saveBtn().click();
    await flush();
    expect(written()[0].amount).toBe(22);
    spy.mockRestore();
  });

  it('a refused reopen leaves the note and says so', async () => {
    state.meta = { schemaVersion: 8, auto_close_after_months: 1 };
    const row = july();
    state.transactions = [row];
    openEditTx(row);
    [...form().querySelectorAll('.closed-month-note button')][0].click();
    await flush();
    // Another tab reopened it already: the command finds the month not closed.
    state.meta = { schemaVersion: 8, auto_close_after_months: 1, reopened_months: ['2026-07'] };
    dialogOk().click();
    await flush();
    expect(form().querySelector('.closed-month-note')).not.toBeNull();
    expect(toastTexts()).toContain(t('review.closeFailed'));
  });
});

describe('the stored row of an edit, per editable type', () => {
  // The edited row is the old row with the edited field changed and modified_at
  // stamped by the session clock; nothing else moves. (Adjustment and envelope
  // transfer edits used to leave modified_at alone; they are stamped now.)
  const stamps = { created_at: '2026-09-01T08:00:00.000Z', modified_at: '2026-09-01T08:00:00.000Z' };
  const edit = async (row, change) => {
    state.accounts = [...state.accounts, { id: 'brk', name: 'Brokerage', type: 'investment', initialBalance: 0 }];
    state.transactions = [row];
    openEditTx(row);
    change();
    saveBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    return state.transactions[0];
  };

  it('expense', async () => {
    const saved = await edit(expense, () => setValue(input('payee'), 'Market'));
    expect(saved).toEqual({ ...expense, payee: 'Market', modified_at: AT });
  });

  it('income', async () => {
    const inc = { id: 'i1', type: 'income', date: '2026-09-05', payee: 'Pay', amount: 100, envelope_id: 'rent', account: 'chk', note: null, status: 'posted', ...stamps };
    const saved = await edit(inc, () => setValue(input('payee'), 'Employer'));
    expect(saved).toEqual({ ...inc, payee: 'Employer', modified_at: AT });
  });

  it('account transfer', async () => {
    const tr = { id: 'tr1', type: 'account_transfer', date: '2026-09-05', payee: 'Save', amount: 60, from_account: 'chk', to_account: 'sav', note: null, status: 'posted', ...stamps };
    const saved = await edit(tr, () => setValue(input('payee'), 'Save more'));
    expect(saved).toEqual({ ...tr, payee: 'Save more', modified_at: AT });
  });

  it('investment buy keeps fee, units, price per unit and symbol', async () => {
    const buy = {
      id: 'v1', type: 'investment_transfer', direction: 'buy', date: '2026-09-05', payee: 'Broker', amount: 100,
      from_account: 'chk', to_account: 'brk', envelope_id: 'fun', fee: 1.5, units: 2.5, pricePerUnit: 40, symbol: 'ABC',
      note: null, status: 'posted', ...stamps,
    };
    const saved = await edit(buy, () => setValue(input('payee'), 'Broker 2'));
    expect(saved).toEqual({ ...buy, payee: 'Broker 2', modified_at: AT });
  });

  it('investment dividend', async () => {
    const div = {
      id: 'd1', type: 'investment_transfer', direction: 'dividend', date: '2026-09-05', payee: 'Broker', amount: 12,
      from_account: 'brk', to_account: 'chk', envelope_id: null, symbol: 'ABC', note: null, status: 'posted', ...stamps,
    };
    const saved = await edit(div, () => setValue(input('payee'), 'Broker 2'));
    expect(saved).toEqual({ ...div, payee: 'Broker 2', modified_at: AT });
  });

  it('adjustment: amount, date, note and target', async () => {
    const adj = { id: 'a1', type: 'adjustment', target: 'account', target_id: 'chk', date: '2026-09-06', amount: -12.34, note: 'fee', ...stamps };
    const saved = await edit(adj, () => {
      setValue(input('amount'), '-15');
      setValue(input('note'), '');
    });
    expect(saved).toEqual({ ...adj, amount: -15, note: null, modified_at: AT });
  });

  it('envelope transfer: a blank payee keeps the old one', async () => {
    const et = { id: 'et1', type: 'envelope_transfer', date: '2026-09-07', payee: 'Move', amount: 40, from_envelope_id: 'food', to_envelope_id: null, note: null, ...stamps };
    const saved = await edit(et, () => {
      setValue(input('payee'), '');
      setValue(input('amount'), '45');
    });
    expect(saved).toEqual({ ...et, amount: 45, modified_at: AT });
  });

  it('envelope transfer: with no payee at all, the default is filled in by the page', async () => {
    const et = { id: 'et2', type: 'envelope_transfer', date: '2026-09-07', amount: 40, from_envelope_id: 'food', to_envelope_id: null, ...stamps };
    const saved = await edit(et, () => setValue(input('amount'), '41'));
    expect(saved).toMatchObject({ payee: t('addTx.payeeEnvelopeTransfer'), amount: 41, from_envelope_id: 'food', to_envelope_id: null });
  });
});

describe('edit an investment transfer', () => {
  const brokerage = { id: 'brk', name: 'Brokerage', type: 'investment', initialBalance: 0 };
  const dirBtn = (label) => [...[...form().querySelectorAll('.field')]
    .find(f => f.querySelector(':scope > label')?.textContent === t('addTx.investmentDirection')).querySelectorAll('button')]
    .find(b => b.textContent === label);
  const old = (over = {}) => ({
    id: 'old1', type: 'investment_transfer', direction: 'buy', date: '2026-08-01', payee: 'Broker X', amount: 100,
    from_account: 'chk', to_account: 'brk', envelope_id: 'fun', note: null,
    created_at: '2026-08-01T00:00:00.000Z', modified_at: '2026-08-01T00:00:00.000Z', ...over,
  });
  const target = (over = {}) => old({ id: 'v1', date: '2026-09-01', amount: 50, ...over });

  beforeEach(() => {
    state.accounts = [...state.accounts, brokerage];
  });

  it('a sell without units is refused beside the field and nothing is written', async () => {
    const row = target();
    state.transactions = [row];
    openEditTx(row);
    dirBtn(t('addTx.investmentSell')).click();
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('editTx.sellNeedsUnits'));
  });

  it('a dividend needs a symbol', async () => {
    const row = target();
    state.transactions = [row];
    openEditTx(row);
    dirBtn(t('addTx.investmentDividend')).click();
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('editTx.symbolRequired'));
  });

  it('a buy needs an envelope', async () => {
    const row = target({ envelope_id: null });
    state.transactions = [row];
    openEditTx(row);
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('.has-error .field-hint')?.textContent).toBe(t('editTx.envelopeRequired'));
  });

  it('switching a buy to a dividend drops fee, units and price', async () => {
    const row = target({ symbol: 'ABC', fee: 1, units: 2, pricePerUnit: 24.5 });
    state.transactions = [row];
    openEditTx(row);
    dirBtn(t('addTx.investmentDividend')).click();
    saveBtn().click();
    await flush();
    const saved = state.transactions[0];
    expect(saved).toMatchObject({ direction: 'dividend', symbol: 'ABC' });
    for (const f of ['fee', 'units', 'pricePerUnit']) expect(saved).not.toHaveProperty(f);
  });

  describe('the symbol rule', () => {
    const batchFiles = (call) => writeBatch.mock.calls[call][1].map(i => i.filename).sort();
    beforeEach(() => {
      vi.spyOn(session, 'dispatch').mockClear();
      // The rule commit is meta-primary, and a commit validates the whole meta.
      state.meta = { schemaVersion: 8 };
      state.transactions = [old(), target()];
      openEditTx(target());
      setValue(input('symbol'), 'abc');
    });
    // Later tests spy on dispatch themselves, on top of the real one.
    afterEach(() => { session.dispatch.mockRestore(); });

    it('backfills earlier rows of the payee when confirmed; the edit is saved first, then the rule and the rows in one commit', async () => {
      saveBtn().click();
      await flush();
      expect(topOverlay().textContent).toContain(t('investments.unmapped.retroApplyConfirm')(1, 'ABC'));
      dialogOk().click();
      await flush();
      expect(writeBatch).toHaveBeenCalledTimes(2);
      expect(batchFiles(1)).toEqual(['budget-meta.json', 'transactions.json']);
      expect(session.dispatch).toHaveBeenCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC', applyTo: ['old1'] });
      expect(state.transactions.find(x => x.id === 'v1')).toMatchObject({ symbol: 'ABC', amount: 50 });
      expect(state.transactions.find(x => x.id === 'old1')).toEqual({ ...old(), symbol: 'ABC', modified_at: AT });
      expect(state.meta.investments.payeeRules['broker x']).toBe('ABC');
    });

    it('leaves earlier rows alone when declined, but still saves the edit and the rule', async () => {
      saveBtn().click();
      await flush();
      topOverlay().querySelector('.btn:not(.btn-accent)').click();
      await flush();
      expect(session.dispatch).toHaveBeenCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC' });
      expect(batchFiles(1)).toEqual(['budget-meta.json']);
      expect(state.transactions.find(x => x.id === 'old1').symbol).toBeUndefined();
      expect(state.transactions.find(x => x.id === 'v1')).toMatchObject({ symbol: 'ABC' });
      expect(state.meta.investments.payeeRules['broker x']).toBe('ABC');
    });

    it('a refused backfill never costs the edit and keeps the rule; one toast says how many rows were not tagged', async () => {
      saveBtn().click();
      await flush();
      // While the question is open, the older row is deleted: the rule-and-rows
      // commit then names an id that is gone and is refused.
      expect((await session.dispatch('transaction.delete', { ids: ['old1'] })).ok).toBe(true);
      dialogOk().click();
      await flush();
      expect(state.transactions.find(x => x.id === 'v1')).toMatchObject({ symbol: 'ABC' });
      expect(state.transactions.find(x => x.id === 'old1')).toBeUndefined();
      expect(session.dispatch).toHaveBeenCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC', applyTo: ['old1'] });
      expect(session.dispatch).toHaveBeenLastCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC' });
      expect(state.meta.investments.payeeRules['broker x']).toBe('ABC');
      expect(toasts()).toContain(t('editTx.saved'));
      expect(toasts()).toContain(t('addTx.backfillPartial')(1));
    });
  });
});

describe('a failed dispatch', () => {
  it('a refused write is toasted with the reason, the row is not kept and the sheet stays', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    openEditTx(expense);
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(byId('e1').amount).toBe(20);
    expect(sheetIsOpen()).toBe(true);
    expect(toasts().some(m => m.startsWith(t('editTx.saveFailed')) && m.includes('disk full'))).toBe(true);
  });

  it('a version conflict opens the conflict dialog instead of a toast', async () => {
    // Only the commit conflicts; the dry run before it is the real thing.
    const real = session.dispatch.bind(session);
    const spy = vi.spyOn(session, 'dispatch').mockImplementation((name, inp, opts) => (
      opts?.dryRun ? real(name, inp, opts) : Promise.resolve({ ok: false, error: { code: 'version_conflict', params: {} } })));
    openEditTx(expense);
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('saveError.versionConflictBody'));
    expect(toasts().some(m => m.startsWith(t('editTx.saveFailed')))).toBe(false);
    spy.mockRestore();
  });

  it('a thrown error is toasted as a failed save, not left unhandled', async () => {
    const spy = vi.spyOn(session, 'dispatch').mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    openEditTx(expense);
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(toasts().some(m => m.startsWith(t('editTx.saveFailed')) && m.includes('boom'))).toBe(true);
    expect(byId('e1').amount).toBe(20);
    spy.mockRestore();
    errSpy.mockRestore();
  });

  it('a refusal by the row checks is toasted in words', async () => {
    // A policy listed in meta refuses an edit of a posted row from the past.
    state.meta = { policies: ['strict-ledger'] };
    const past = { ...expense, created_at: '2026-08-01T00:00:00.000Z', date: '2026-08-20' };
    state.transactions = [other, past];
    openEditTx(past);
    setValue(input('amount'), '30');
    saveBtn().click();
    await flush();
    expect(byId('e1').amount).toBe(20);
    expect(toasts().some(m => m.startsWith(t('editTx.saveFailed')) && m.length > t('editTx.saveFailed').length + 2)).toBe(true);
  });
});

describe('edit a loan payment', () => {
  let debt;
  beforeEach(() => {
    state.accounts.push(
      { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000 },
      { id: 'car', name: 'Car loan', type: 'loan', initialBalance: -8000 },
      { id: 'lent', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0 },
    );
    debt = {
      id: 'd1', type: 'debt_payment', date: '2026-09-05', payee: 'Mortgage', amount: 700,
      from_account: 'chk', to_account: 'mtg', envelope_id: 'rent', note: null, status: 'posted',
      from_budget: 'mortgage:2026-09', created_at: '2026-09-05T08:00:00.000Z', modified_at: '2026-09-05T08:00:00.000Z',
    };
    state.transactions = [other, debt];
  });

  it('opens as a form, offering everyday accounts to pay from and loans to pay into', () => {
    openEditTx(debt);
    expect(saveBtn()).toBeTruthy();
    expect(sheet().textContent).toContain(t('editTx.debtSummaryTitle'));
    expect(input('amount').value).toBe('700.00');
    expect(input('date').value).toBe('2026-09-05');
    const from = fieldSelect(t('editTx.fromAccount'));
    const to = fieldSelect(t('addTx.loanAccount'));
    expect([...from.options].map(o => o.value)).toEqual(['chk', 'sav']);
    expect([...to.options].map(o => o.value)).toEqual(['mtg', 'car']);
    expect(to.value).toBe('mtg');
    expect(form().textContent).toContain(t('editTx.principalHint'));
  });

  it('saves the principal row through the session, keeping its plan link in the same month', async () => {
    openEditTx(debt);
    setValue(input('amount'), '725.40');
    setValue(input('date'), '2026-09-06');
    setValue(fieldSelect(t('addTx.loanAccount')), 'car');
    setValue(fieldSelect(t('editTx.fromAccount')), 'sav');
    setValue(input('note'), 'bank figure');
    saveBtn().click();
    await flush();

    expect(byId('d1')).toMatchObject({
      type: 'debt_payment', amount: 725.4, date: '2026-09-06', from_account: 'sav', to_account: 'car',
      envelope_id: 'rent', note: 'bank figure', from_budget: 'mortgage:2026-09',
      created_at: '2026-09-05T08:00:00.000Z',
    });
    expect(byId('d1').modified_at).toBe(AT);
    expect(lastWrite()).toEqual(written());
    expect(sheetIsOpen()).toBe(false);
  });

  it('money lent out offers the loan-given accounts and no principal note', () => {
    const lend = { ...debt, id: 'd2', to_account: 'lent', from_budget: undefined };
    state.transactions = [other, lend];
    openEditTx(lend);
    expect(sheet().textContent).toContain(t('editTx.lentSummaryTitle'));
    expect([...fieldSelect(t('addTx.lentAccount')).options].map(o => o.value)).toEqual(['lent']);
    expect(form().textContent).not.toContain(t('editTx.principalHint'));
  });

  it('a forecast leg of a planned instalment stays read-only, with no dead Post now', () => {
    openEditTx({ ...debt, id: 'forecast:mortgage:2026-10', is_forecast: true, status: 'scheduled', date: '2026-10-05', forecast_loan_leg: 'principal' });
    expect(saveBtn()).toBeUndefined();
    expect(actionBtn(t('transactions.postNow'))).toBeUndefined();
    expect(form().textContent).toContain(t('editTx.readonlyNote'));
  });
});

describe('repair a row of an unknown type', () => {
  it('reopens as the picked type, filled from the row, and saves that type', async () => {
    const odd = {
      id: 'odd', type: 'expens', date: '2026-09-04', payee: 'Typo Shop', amount: -12.5,
      account: 'chk', envelope_id: 'food', note: 'imported', status: 'posted',
      created_at: '2026-09-04T08:00:00.000Z', modified_at: '2026-09-04T08:00:00.000Z',
    };
    state.transactions = [other, odd];
    openEditTx(odd);
    expect(saveBtn()).toBeUndefined();
    expect(form().textContent).toContain(t('editTx.repairAs'));
    typeBtn('expense').click();
    await flush();

    // The expense form, filled from the row (the first sheet has closed; the
    // new one is the open one).
    const top = topOverlay();
    const field = (n) => top.querySelector(`input[name="${n}"]`);
    expect(field('payee').value).toBe('Typo Shop');
    expect(field('amount').value).toBe('12.5');
    expect(top.querySelector('.split-env').value).toBe('food');
    [...top.querySelectorAll('button')].find(b => b.textContent === t('addTx.save')).click();
    await flush();
    expect(byId('odd')).toMatchObject({ type: 'expense', amount: 12.5, account: 'chk', envelope_id: 'food', payee: 'Typo Shop' });
  });

  it('a known read-only row (a fill) offers no repair', () => {
    const fill = { id: 'f', type: 'fill', date: '2026-09-01', status: 'posted', lines: [{ envelope_id: 'food', mode: 'add', amount: 50 }] };
    state.transactions = [other, fill];
    openEditTx(fill);
    expect(form().textContent).not.toContain(t('editTx.repairAs'));
  });
});

// Let mocked animation frames finish before jsdom tears down document.
afterEach(async () => { await flush(); vi.restoreAllMocks(); });
