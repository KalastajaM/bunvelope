// @vitest-environment jsdom
// Account editor: what create / edit / archive / delete hand to the account
// commands (through the real browser session; the storage boundary,
// writeBatch, is the fake that records what would be written), including the
// archive warnings (a confirm that must be accepted before anything is
// written) and the delete rules. Drives the real js/pages/account-edit.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { openAccountEdit } from '../js/pages/account-edit.js';
import { t } from '../js/ui/i18n.js';
import {
  state, navigate, updateStatusBar, writeBatch, session, FIXED_NOW, resetState, mountHosts, flush, setValue,
  sheetIsOpen, topOverlay, dialogOk, dialogButton, toastTexts,
} from './_fakes/pageApp.js';

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const nameIn = () => sheet().querySelector('input[name="name"]');
const typeSel = () => sheet().querySelector('select');
const balanceIn = () => sheet().querySelector('input[name="initialBalance"]');
const notesIn = () => sheet().querySelector('textarea[name="notes"]');
const sheetBtn = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const submit = async () => { sheet().querySelector('form').requestSubmit(); await flush(); };
const saved = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'accounts.json')?.data;
const savedTxs = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'transactions.json')?.data;
const savedAcct = (id) => saved().find(a => a.id === id);
const toastButton = () => document.querySelector('#toast-host .toast-action');
const switchFor = (labelText) => [...sheet().querySelectorAll('label.settings-toggle')]
  .find(l => l.textContent.includes(labelText)).querySelector('input[type="checkbox"]');
const tick = (cb, on) => { cb.checked = on; cb.dispatchEvent(new Event('change', { bubbles: true })); };

let old;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState({
    transactions: [
      { id: 'x1', type: 'expense', date: '2026-09-02', payee: 'Grocer', amount: 50, envelope_id: 'food', account: 'chk', status: 'posted' },
    ],
  });
  // An account nothing refers to, so it can be deleted.
  old = { id: 'old', name: 'Old wallet', type: 'cash', initialBalance: 20, notes: 'spare' };
  state.accounts = [...state.accounts, old];
  mountHosts();
});

describe('create an account', () => {
  beforeEach(() => openAccountEdit(null));

  it('marks Name required and keeps an empty or whitespace submission in the editor', async () => {
    expect(nameIn().getAttribute('aria-required')).toBe('true');
    expect(nameIn().closest('.field').querySelector('.required-marker')).not.toBeNull();
    setValue(nameIn(), '   ');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nameIn());
    expect(nameIn().getAttribute('aria-invalid')).toBe('true');
    expect(nameIn().closest('.field').querySelector('.field-hint').textContent).toBe(t('common.fieldRequired'));
    setValue(nameIn(), 'A new name');
    expect(nameIn().getAttribute('aria-invalid')).toBe('false');
    await submit();
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('writes a slug id, the typed name and balance, and nothing optional', async () => {
    setValue(nameIn(), 'Joint Account');
    setValue(balanceIn(), '250.5');
    await submit();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(saved().map(a => a.id)).toEqual(['chk', 'sav', 'old', 'joint-account']);
    expect(savedAcct('joint-account')).toEqual({ id: 'joint-account', code: 'JO01', name: 'Joint Account', type: 'bank', initialBalance: 250.5 });
    expect(state.accounts).toBe(saved());
    expect(navigate).toHaveBeenCalledWith('accounts');
    expect(sheetIsOpen()).toBe(false);
  });

  it('a name whose slug collides with another account\'s id gets a distinct id', async () => {
    setValue(nameIn(), 'Checking!');
    await submit();
    const ids = saved().map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('an empty name writes nothing', async () => {
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('an unreadable opening balance is refused and nothing is written', async () => {
    setValue(nameIn(), 'Broken');
    setValue(balanceIn(), 'abc');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('a formula opening balance is evaluated', async () => {
    setValue(nameIn(), 'Sum');
    setValue(balanceIn(), '100+25', ['input']);
    balanceIn().dispatchEvent(new Event('blur', { bubbles: true }));
    await submit();
    expect(savedAcct('sum').initialBalance).toBe(125);
  });

  it('a savings account keeps its interest tiers and a non-default payout', async () => {
    setValue(nameIn(), 'Rainy Day');
    setValue(typeSel(), 'savings', ['change']);
    sheetBtn('+ ' + t('accountEdit.addTier')).click();
    sheetBtn('+ ' + t('accountEdit.addTier')).click();
    const rows = [...sheet().querySelectorAll('.tier-row')];
    setValue(rows[0].querySelectorAll('input')[0], '10000');
    setValue(rows[0].querySelectorAll('input')[1], '1.5');
    setValue(rows[1].querySelectorAll('input')[1], '2.25');
    const payout = [...sheet().querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'quarterly'));
    setValue(payout, 'quarterly', ['change']);
    setValue(sheet().querySelector('[name="interestTierMode"]'), 'full-balance');
    await submit();
    expect(savedAcct('rainy-day')).toMatchObject({
      type: 'savings',
      interestTiers: [{ rate: 1.5, upTo: 10000 }, { rate: 2.25 }],
      interestPayout: 'quarterly',
      interestTierMode: 'full-balance',
    });
  });

  it('reopens the stored mode and can switch back to progressive', async () => {
    state.accounts = [...state.accounts, { id: 'danske', name: 'Danske', type: 'savings', initialBalance: 10000,
      interestTierMode: 'full-balance', interestTiers: [{ upTo: 10000, rate: 1 }, { rate: 2 }] }];
    openAccountEdit(state.accounts.find(a => a.id === 'danske'));
    const mode = sheet().querySelector('[name="interestTierMode"]');
    expect(mode.value).toBe('full-balance');
    setValue(mode, 'progressive');
    await submit();
    expect(savedAcct('danske')).not.toHaveProperty('interestTierMode');
  });

  it('tiers typed on an account that is then switched to a non-savings type are dropped', async () => {
    setValue(nameIn(), 'Switched');
    setValue(typeSel(), 'savings', ['change']);
    sheetBtn('+ ' + t('accountEdit.addTier')).click();
    setValue(sheet().querySelector('.tier-row').querySelectorAll('input')[1], '3');
    setValue(typeSel(), 'bank', ['change']);
    await submit();
    expect(savedAcct('switched').interestTiers).toBeUndefined();
    expect(savedAcct('switched').interestPayout).toBeUndefined();
  });

  it('an investment account stores the track-off and pension flags, only when they differ from the default', async () => {
    setValue(nameIn(), 'Pension pot');
    setValue(typeSel(), 'investment', ['change']);
    tick(switchFor(t('accountEdit.trackInvestments')), false);
    tick(switchFor(t('accountEdit.pensionInsurance')), true);
    await submit();
    expect(savedAcct('pension-pot')).toMatchObject({ type: 'investment', trackInvestments: false, pensionInsurance: true });
  });

  it('stores a loan given\'s dated rates and terms; refuses an end before the start, or interest without a start', async () => {
    setValue(nameIn(), 'Loan to Sam');
    setValue(typeSel(), 'loan_given', ['change']);
    const inp = (n) => sheet().querySelector(`input[name="${n}"]`);
    const addRate = [...sheet().querySelectorAll('button')].find(b => b.textContent === '+ ' + t('accountEdit.addRate'));
    addRate.click();
    const rows = () => [...sheet().querySelectorAll('.rate-row')];
    setValue(rows()[0].querySelector('input[name="rateFrom"]'), '2026-03-01');
    setValue(rows()[0].querySelector('input[name="rate"]'), '2.5');
    // Interest without a start date has no cycle to count from.
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    setValue(inp('loanStart'), '2026-03-01');
    setValue(inp('loanEnd'), '2025-01-01');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    setValue(inp('loanEnd'), '2031-02-28');
    addRate.click();
    setValue(rows()[1].querySelector('input[name="rateFrom"]'), '2027-01-01');
    setValue(rows()[1].querySelector('input[name="rate"]'), '3');
    setValue(sheet().querySelector('select[name="loanPayout"]'), 'quarterly');
    await submit();
    const saved = savedAcct('loan-to-sam');
    expect(saved).toMatchObject({
      type: 'loan_given', loanStart: '2026-03-01', loanEnd: '2031-02-28', interestPayout: 'quarterly',
      interestRates: [{ from: '2026-03-01', rate: 2.5 }, { from: '2027-01-01', rate: 3 }],
    });
    expect(saved).not.toHaveProperty('interestTiers');
  });

  it("stores a loan's interest day count only when it is not actual/365", async () => {
    const dayCount = () => sheet().querySelector('select[name="interestDayCount"]');
    setValue(nameIn(), 'Car loan');
    setValue(typeSel(), 'loan', ['change']);
    expect(dayCount().value).toBe('act/365');
    await submit();
    const created = savedAcct('car-loan');
    expect(created).not.toHaveProperty('interestDayCount');

    state.accounts = saved();
    openAccountEdit(created);
    setValue(dayCount(), 'act/360');
    await submit();
    expect(savedAcct('car-loan').interestDayCount).toBe('act/360');
  });

  it('a loan asks for the amount owed: entered positive, stored negative', async () => {
    const label = () => balanceIn().closest('.field').querySelector('label').textContent;
    expect(label()).toBe(t('accountEdit.initialBalance'));
    setValue(nameIn(), 'Mortgage');
    setValue(balanceIn(), '150000');
    setValue(typeSel(), 'loan', ['change']);
    expect(label()).toBe(t('accountEdit.amountOwed'));
    expect(balanceIn().value).toBe('150000');
    await submit();
    expect(savedAcct('mortgage').initialBalance).toBe(-150000);

    // Editing shows what is owed as a positive amount; a switch away from
    // the loan type keeps the balance's meaning.
    state.accounts = saved();
    openAccountEdit(savedAcct('mortgage'));
    expect(label()).toBe(t('accountEdit.amountOwed'));
    expect(balanceIn().value).toBe('150000');
    setValue(typeSel(), 'bank', ['change']);
    expect(label()).toBe(t('accountEdit.initialBalance'));
    expect(balanceIn().value).toBe('-150000');
  });

  it('a loan given has no day count of its own (it accrues day by day)', async () => {
    setValue(nameIn(), 'Loan to Ann');
    setValue(typeSel(), 'loan_given', ['change']);
    expect(sheet().querySelector('select[name="interestDayCount"]').closest('div').parentElement.style.display).toBe('none');
    await submit();
    expect(savedAcct('loan-to-ann')).not.toHaveProperty('interestDayCount');
  });

  it('stores the tax-wrapped flag on an investment account, and only there', async () => {
    setValue(nameIn(), 'OST');
    setValue(typeSel(), 'investment', ['change']);
    tick(switchFor(t('accountEdit.taxWrapped')), true);
    await submit();
    expect(savedAcct('ost')).toMatchObject({ type: 'investment', taxWrapped: true });
  });

  it('the spending switch is stored only when it departs from the type\'s default', async () => {
    setValue(nameIn(), 'Stash');
    setValue(typeSel(), 'savings', ['change']);
    // Savings is not spending by default; switching it on is stored.
    tick(switchFor(t('accountEdit.spendingAccount')), true);
    await submit();
    expect(savedAcct('stash').spending).toBe(true);
  });

  it('an untouched account of any type stores no spending or crisisCash flag', async () => {
    setValue(nameIn(), 'Plain');
    setValue(typeSel(), 'savings', ['change']);
    await submit();
    expect(savedAcct('plain')).not.toHaveProperty('spending');
    expect(savedAcct('plain')).not.toHaveProperty('crisisCash');
  });

  it('an asset account keeps its group and never a spending flag', async () => {
    setValue(nameIn(), 'Flat');
    setValue(typeSel(), 'asset', ['change']);
    setValue(sheet().querySelector('input[list="account-asset-groups"]'), 'Properties');
    await submit();
    expect(savedAcct('flat')).toMatchObject({ type: 'asset', group: 'Properties' });
    expect(savedAcct('flat')).not.toHaveProperty('spending');
  });

  it('a failed write reports it, leaves the list alone and keeps the sheet open', async () => {
    const before = state.accounts;
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    setValue(nameIn(), 'Doomed');
    await submit();
    expect(state.accounts).toBe(before);
    expect(navigate).not.toHaveBeenCalled();
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(sheetIsOpen()).toBe(true);
  });
});

describe('edit an account', () => {
  it('a save whose meta write failed still closes, and says the change log was not saved', async () => {
    const real = session.dispatch;
    const spy = vi.spyOn(session, 'dispatch').mockImplementationOnce(async (...args) => {
      const r = await real(...args);
      return { ...r, value: { ...r.value, metaFailed: { message: 'meta down' } } };
    });
    openAccountEdit(state.accounts.find(a => a.id === 'old'));
    setValue(nameIn(), 'Purse');
    await submit();
    expect(savedAcct('old').name).toBe('Purse');
    expect(toastTexts()).toContain(t('common.metaSaveFailed')('meta down'));
    expect(sheetIsOpen()).toBe(false);
    spy.mockRestore();
  });

  it('rewrites the account in place, clearing optional fields that were emptied', async () => {
    state.accounts = state.accounts.map(a => a.id === 'old'
      ? { ...a, lastReconciledAt: '2026-08-01', lastReconciledBalance: 20, trackInvestments: false }
      : a);
    const chk = state.accounts[0];
    openAccountEdit(state.accounts.find(a => a.id === 'old'));
    setValue(nameIn(), 'Purse');
    setValue(balanceIn(), '35');
    setValue(notesIn(), '');
    await submit();
    // The opening balance moves a reconciled balance, so it asks first.
    expect(writeBatch).not.toHaveBeenCalled();
    [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')].at(-1).querySelector('.btn-accent').click();
    await flush();
    expect(saved().map(a => a.id)).toEqual(['chk', 'sav', 'old']);
    const out = savedAcct('old');
    expect(out).toMatchObject({ name: 'Purse', initialBalance: 35, type: 'cash', lastReconciledAt: '2026-08-01' });
    expect(out).not.toHaveProperty('notes');
    // trackInvestments only applies to investment accounts.
    expect(out).not.toHaveProperty('trackInvestments');
    // Untouched accounts are the same objects.
    expect(saved()[0]).toBe(chk);
  });

  it('cancelling the reconciled opening-balance prompt saves nothing', async () => {
    state.accounts = state.accounts.map(a => a.id === 'old' ? { ...a, lastReconciledAt: '2026-08-01', lastReconciledBalance: 20 } : a);
    openAccountEdit(state.accounts.find(a => a.id === 'old'));
    setValue(balanceIn(), '35');
    await submit();
    const overlay = [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')].at(-1);
    expect(overlay.textContent).toContain(t('reconciledRow.editAnyway'));
    overlay.querySelector('.btn-ghost').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('the id never changes, whatever the new name', async () => {
    openAccountEdit(old);
    setValue(nameIn(), 'Totally different');
    await submit();
    expect(savedAcct('old').name).toBe('Totally different');
    expect(saved().some(a => a.id === 'totally-different')).toBe(false);
  });

  it('changing the type away from the spending default stores the override', async () => {
    openAccountEdit(state.accounts.find(a => a.id === 'chk'));
    // Checking-type default is spending; switching it off is an override.
    tick(switchFor(t('accountEdit.spendingAccount')), false);
    await submit();
    expect(savedAcct('chk').spending).toBe(false);
  });
});

describe('archive an account', () => {
  const open = (acc) => openAccountEdit(acc);
  const archiveBtn = () => sheetBtn(t('common.archive'));

  it('with nothing pointing at it: archives straight away and offers Undo', async () => {
    open(old);
    archiveBtn().click();
    await flush();
    expect(saved().find(a => a.id === 'old').archived).toBe(true);
    expect(state.accounts).toBe(saved());
    expect(navigate).toHaveBeenCalledWith('accounts');
    expect(updateStatusBar).toHaveBeenCalled();
    expect(toastTexts()).toContain(t('common.archivedToast')('Old wallet'));

    // Undo writes the previous list back.
    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(saved().find(a => a.id === 'old').archived).toBeUndefined();
    expect(saved()).toHaveLength(3);
    expect(state.accounts).toBe(saved());
  });

  it('a scheduled plan item posting to it: confirm first; cancel writes nothing', async () => {
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'food', as_schedule: true, account_id: 'old', default_amount: -10 }];
    open(old);
    archiveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('accountEdit.planItemsArchiveWarning')(1));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.accounts.find(a => a.id === 'old').archived).toBeUndefined();
  });

  it('a scheduled plan item posting to it: accepting archives', async () => {
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'food', as_schedule: true, account_id: 'old', default_amount: -10 }];
    open(old);
    archiveBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(saved().find(a => a.id === 'old').archived).toBe(true);
  });

  it('a planned (unscheduled) item forecasting from it is named in the warning', async () => {
    state.budgetItems = [{ id: 'b2', kind: 'expense', envelope_id: 'food', as_schedule: false, account_id: 'old', default_amount: -10 }];
    open(old);
    archiveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('accountEdit.plannedItemsHistoryWarning')(1));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('future-dated rows on it are named in the warning; cancel writes nothing', async () => {
    state.transactions = [
      ...state.transactions,
      { id: 'f1', type: 'expense', date: '2026-10-05', payee: 'Later', amount: 9, envelope_id: 'food', account: 'old', status: 'posted' },
    ];
    open(old);
    archiveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('common.futureRowsArchiveWarning')(1));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('several reasons share one confirm', async () => {
    state.budgetItems = [
      { id: 'b1', kind: 'expense', envelope_id: 'food', as_schedule: true, account_id: 'old', default_amount: -10 },
      { id: 'b2', kind: 'expense', envelope_id: 'food', as_schedule: false, account_id: 'old', default_amount: -10 },
    ];
    state.transactions = [
      ...state.transactions,
      { id: 'f1', type: 'expense', date: '2026-10-05', payee: 'Later', amount: 9, envelope_id: 'food', account: 'old', status: 'posted' },
    ];
    open(old);
    archiveBtn().click();
    await flush();
    const text = topOverlay().textContent;
    expect(text).toContain(t('accountEdit.planItemsArchiveWarning')(1));
    expect(text).toContain(t('accountEdit.plannedItemsHistoryWarning')(1));
    expect(text).toContain(t('common.futureRowsArchiveWarning')(1));
  });

  it('a disabled plan item does not warn', async () => {
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'food', as_schedule: true, include: false, account_id: 'old', default_amount: -10 }];
    open(old);
    archiveBtn().click();
    await flush();
    expect(saved().find(a => a.id === 'old').archived).toBe(true);
  });

  it('unarchiving never asks, even with plan items pointing at it', async () => {
    state.accounts = state.accounts.map(a => a.id === 'old' ? { ...a, archived: true } : a);
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'food', as_schedule: true, account_id: 'old', default_amount: -10 }];
    open(state.accounts.find(a => a.id === 'old'));
    sheetBtn(t('common.unarchive')).click();
    await flush();
    expect(saved().find(a => a.id === 'old').archived).toBe(false);
    expect(toastTexts()).toContain(t('common.unarchivedToast')('Old wallet'));
  });

  it('a failed archive write leaves the account as it was', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    const before = state.accounts;
    open(old);
    archiveBtn().click();
    await flush();
    expect(state.accounts).toBe(before);
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
  });
});

describe('delete an account', () => {
  const deleteBtn = () => sheetBtn(t('common.delete'));

  it('is not offered while transactions refer to the account', () => {
    openAccountEdit(state.accounts.find(a => a.id === 'chk'));
    expect(deleteBtn()).toBeUndefined();
    expect(sheet().textContent).toContain(t('accountEdit.refsCannotDelete')(1));
  });

  it('is not offered for a new account', () => {
    openAccountEdit(null);
    expect(deleteBtn()).toBeUndefined();
  });

  it('asks first; cancelling writes nothing', async () => {
    openAccountEdit(old);
    deleteBtn().click();
    await flush();
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.accounts).toHaveLength(3);
  });

  it('confirming writes the list without it, and Undo restores the same list', async () => {
    const before = state.accounts;
    openAccountEdit(old);
    deleteBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(saved().map(a => a.id)).toEqual(['chk', 'sav']);
    expect(state.accounts).toBe(saved());
    expect(navigate).toHaveBeenCalledWith('accounts');
    expect(toastTexts()).toContain(t('accountEdit.deleted'));

    toastButton().click();
    await flush();
    expect(saved()).toStrictEqual(before);
    expect(state.accounts).toStrictEqual(before);
  });

  it('the confirm names plan items that post to the account', async () => {
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'food', as_schedule: true, account_id: 'old', default_amount: -10 }];
    openAccountEdit(old);
    deleteBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('accountEdit.planItemsWarning')(1));
  });

  it('a failed delete write keeps the account', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    openAccountEdit(old);
    deleteBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.accounts).toHaveLength(3);
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the page hands to the commands, and the Undo contract (ruling 6).
// ---------------------------------------------------------------------------
describe('the commands the page dispatches', () => {
  const dispatched = () => vi.spyOn(session, 'dispatch').mockClear();
  const moveDialog = () => topOverlay();
  const moveOk = () => dialogButton(t('accountEdit.moveConfirm'));

  it('create sends one account.create with the form\'s fields', async () => {
    const spy = dispatched();
    openAccountEdit(null);
    setValue(nameIn(), 'Joint Account');
    setValue(balanceIn(), '250.5');
    await submit();
    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe('account.create');
    expect(input).toMatchObject({ name: 'Joint Account', type: 'bank', initialBalance: 250.5 });
  });

  it('an edit sends one account.update by id, with no moveEnvelope key when the type stays on one side', async () => {
    const spy = dispatched();
    openAccountEdit(old);
    setValue(nameIn(), 'Purse');
    await submit();
    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe('account.update');
    expect(input.id).toBe('old');
    expect(input.fields).toMatchObject({ name: 'Purse', type: 'cash', initialBalance: 20 });
    expect(Object.hasOwn(input, 'moveEnvelope')).toBe(false);
    expect(Object.hasOwn(input, 'moveNote')).toBe(false);
  });

  it('a type change across the cash boundary is one account.update carrying moveEnvelope, and one write', async () => {
    const spy = dispatched();
    openAccountEdit(state.accounts.find(a => a.id === 'chk'));
    setValue(typeSel(), 'investment', ['change']);
    await submit();
    // The move dialog stacks above the form.
    const sel = moveDialog().querySelector('select');
    setValue(sel, 'food');
    moveOk().click();
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe('account.update');
    expect(input.moveEnvelope).toBe('food');
    expect(input.moveNote).toBe(t('accountEdit.moveNote')('Checking'));
    expect(input.fields.type).toBe('investment');

    // Account and adjustment row land in the same write.
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(saved().find(a => a.id === 'chk').type).toBe('investment');
    const row = savedTxs().find(x => x.type === 'adjustment');
    expect(row).toMatchObject({ target: 'envelope', target_id: 'food', amount: -950, date: '2026-09-15' });
    expect(row.created_at).toBe(FIXED_NOW.toISOString());
    expect(state.transactions).toBe(savedTxs());
  });

  it('choosing Unallocated sends moveEnvelope null and adds no adjustment row', async () => {
    const spy = dispatched();
    openAccountEdit(state.accounts.find(a => a.id === 'chk'));
    setValue(typeSel(), 'investment', ['change']);
    await submit();
    moveOk().click();
    await flush();
    expect(spy.mock.calls[0][1].moveEnvelope).toBeNull();
    expect(state.transactions.some(x => x.type === 'adjustment')).toBe(false);
    expect(state.accounts.find(a => a.id === 'chk').type).toBe('investment');
  });

  it('cancelling the move dialog dispatches nothing', async () => {
    const spy = dispatched();
    openAccountEdit(state.accounts.find(a => a.id === 'chk'));
    setValue(typeSel(), 'investment', ['change']);
    await submit();
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.accounts.find(a => a.id === 'chk').type).toBe('bank');
  });

  it('a name another account already has shows a hint on the name field and writes nothing', async () => {
    openAccountEdit(null);
    setValue(nameIn(), 'checking');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
    const field = nameIn().closest('.field');
    expect(field.querySelector('.field-hint').textContent).toBe(t('accountEdit.nameTaken')('checking'));
    expect(field.classList.contains('has-error')).toBe(true);
    expect(toastTexts()).toEqual([]);
  });

  it('the same clash on rename is refused; keeping the name is not', async () => {
    openAccountEdit(old);
    setValue(nameIn(), 'Savings');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(nameIn().closest('.field').classList.contains('has-error')).toBe(true);
    setValue(nameIn(), 'Old wallet');
    setValue(notesIn(), 'changed');
    await submit();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(savedAcct('old').notes).toBe('changed');
  });
});

describe('Undo of archive and delete goes through the session', () => {
  it('archive Undo restores, and keeps an edit made in between', async () => {
    openAccountEdit(state.accounts[0]);
    sheetBtn(t('common.archive')).click();
    await flush();
    expect(state.accounts[0].archived).toBe(true);
    state.accounts = [...state.accounts, { id: 'late', name: 'Added later', initialBalance: 0 }];

    toastButton().click();
    await flush();
    expect(saved().map(a => a.id)).toEqual(['chk', 'sav', 'old', 'late']);
    expect(saved().find(a => a.id === 'chk')).not.toHaveProperty('archived');
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('delete Undo puts the account back in its place', async () => {
    // chk has a transaction; drop it so the account can be deleted.
    state.transactions = [];
    openAccountEdit(state.accounts[0]);
    sheetBtn(t('common.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.accounts.map(a => a.id)).toEqual(['sav', 'old']);
    toastButton().click();
    await flush();
    expect(saved().map(a => a.id)).toEqual(['chk', 'sav', 'old']);
  });

  it('Undo after a budget switch writes nothing and says so', async () => {
    openAccountEdit(old);
    sheetBtn(t('common.archive')).click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);

    state.budgetFolder = { name: 'budget-B' };
    const accountsB = [{ id: 'b-only', name: 'B account', initialBalance: 0 }];
    state.accounts = accountsB;

    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.accounts).toBe(accountsB);
    expect(toastTexts()).toContain(t('coreError.undoBudgetChanged'));
  });
});

// Owner decision 2026-10-05: a card names the account that pays it off in
// the forecast (account.update's settledFrom).
describe('paid off from (cards)', () => {
  const settleSel = () => [...sheet().querySelectorAll('select')]
    .find(s => [...s.options].some(o => o.textContent === t('accountEdit.settledFromNone')));
  const settleField = () => settleSel().closest('.field');

  it('is offered for a credit card, a bank and a cash account, with the other live bank, cash and savings accounts', () => {
    state.accounts = [...state.accounts,
      { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 },
      { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: -40 },
      { id: 'cc2', name: 'Amex', type: 'credit_card', initialBalance: 0 },
      { id: 'gone', name: 'Closed', type: 'bank', initialBalance: 0, archived: true }];
    openAccountEdit(state.accounts.find(a => a.id === 'cc'));
    expect(settleField().style.display).toBe('');
    expect([...settleSel().options].map(o => o.value)).toEqual(['', 'chk', 'sav', 'old']);
    expect(settleField().textContent).toContain(t('accountEdit.settledFrom'));
    setValue(typeSel(), 'savings', ['change']);
    expect(settleField().style.display).toBe('none');
    setValue(typeSel(), 'bank', ['change']);
    expect(settleField().style.display).toBe('');
  });

  it('sends the chosen account on save, and stores it', async () => {
    const card = { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: -40 };
    state.accounts = [...state.accounts, card];
    const spy = vi.spyOn(session, 'dispatch').mockClear();
    openAccountEdit(card);
    expect(settleSel().value).toBe('');
    setValue(settleSel(), 'chk', ['change']);
    await submit();
    expect(spy.mock.calls[0][1].fields.settledFrom).toBe('chk');
    expect(savedAcct('cc')).toEqual({ ...card, code: 'VI01', settledFrom: 'chk' });
  });

  it('shows the stored choice, and "not paid off" clears it', async () => {
    const card = { id: 'cc', name: 'Visa', type: 'credit_card', initialBalance: -40, settledFrom: 'chk' };
    state.accounts = [...state.accounts, card];
    openAccountEdit(card);
    expect(settleSel().value).toBe('chk');
    setValue(settleSel(), '', ['change']);
    await submit();
    expect(savedAcct('cc')).not.toHaveProperty('settledFrom');
  });

  it('a savings account never sends it', async () => {
    const spy = vi.spyOn(session, 'dispatch').mockClear();
    openAccountEdit(state.accounts.find(a => a.id === 'sav'));
    setValue(nameIn(), 'Savings 2');
    await submit();
    expect(spy.mock.calls[0][1].fields.settledFrom).toBeNull();
  });
});
