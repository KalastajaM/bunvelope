// @vitest-environment jsdom
// Reconcile dialog: what Save dispatches for the ticked rows, the rows added
// in the sheet, the plan links, the statement gap and the account stamp.
// reconcile-model.test.js covers the pure decisions and
// core-account-reconcile.test.js the command; this drives the real
// js/reconcile.js DOM through the real browser session (the storage boundary,
// writeBatch, is the fake that records what would be written).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeBatch: vi.fn(async () => {}),
}));

import { writeBatch as legacyWriteBatch } from '../js/data.js';
import { openReconcileModal, openInvestmentValueDialog } from '../js/reconcile.js';
import { applyReconcile, markReconciled } from '../js/reconcile-model.js';
import { t, fmtDateLang } from '../js/ui/i18n.js';
import { fmt, fmtNum } from '../js/utils.js';
import {
  state, prefs, session, writeBatch, updateStatusBar, resetState, mountHosts, flush, setValue, sheetIsOpen, FIXED_NOW,
} from './_fakes/pageApp.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
const statement = () => document.getElementById('reconcile-statement');
const recDate = () => document.getElementById('reconcile-date');
const saveBtn = () => [...sheet().querySelectorAll('button')].find(b => b.textContent === t('reconcile.save') || b.textContent === t('common.saving'));
const check = (id) => sheet().querySelector(`.rec-check[data-id="${id}"]`);
const tick = (id, on = true) => { const cb = check(id); cb.checked = on; cb.dispatchEvent(new Event('change', { bubbles: true })); };
const topOverlay = () => [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')].at(-1);
const toasts = () => [...document.querySelectorAll('#toast-host .toast')].map(el => el.textContent);
const batch = () => writeBatch.mock.calls.at(-1)?.[1];
const batchFile = (name) => batch().find(f => f.filename === name).data;
const acceptGap = () => topOverlay().querySelector('.btn-accent').click();
// dismiss (first ghost), "no" (second ghost), "yes" (accent)
const declineGap = () => [...topOverlay().querySelectorAll('button')].filter(b => b.classList.contains('btn-ghost'))[1].click();

// The add panel: payee field (with its datalist) → first row → panel.
const addPanel = () => sheet().querySelector('datalist').closest('.field').parentElement.parentElement;
const fieldOf = (panel, label) => [...panel.querySelectorAll('.field')].find(f => f.querySelector('label')?.textContent === label);
const panelButton = (panel, label) => [...panel.querySelectorAll('button')].find(b => b.textContent === label);
/** Fill the add panel and press its Save; returns the panel (still open for the next entry). */
async function addRow({ payee = '', amount, type = 'expense', envelope, other, units }) {
  [...sheet().querySelectorAll('button')].find(b => b.textContent === t('reconcile.addTx')).click();
  const panel = addPanel();
  const [payeeIn, amountIn] = panel.querySelectorAll('input');
  const [typeSel, envSel, otherSel] = panel.querySelectorAll('select');
  setValue(typeSel, type, ['change']);
  setValue(payeeIn, payee);
  setValue(amountIn, amount); // the date keeps the reconcile date
  if (envelope) setValue(envSel, envelope, ['change']);
  if (other) setValue(otherSel, other, ['change']);
  if (units !== undefined) setValue(fieldOf(panel, t('addTx.units')).querySelector('input'), units);
  panelButton(panel, t('reconcile.addTxSave')).click();
  await flush();
  return panel;
}
const addedRows = () => sheet().querySelectorAll('tr[style*="italic"]');

let ledger;

describe('statement reservation balance handoff', () => {
  it('matches a checked scheduled payment and saves only the new imported row', async () => {
    state.transactions = [{ id: 'scheduled', type: 'expense', account: 'chk', payee: 'Shop', amount: 20, date: '2026-09-03', status: 'scheduled' }];
    setValue(recDate(), '2026-09-10', ['change']);
    tick('scheduled');
    setValue(statement(), '975', ['input']);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['Date,Payee,Amount,Account\n2026-09-03,Shop,-20,Checking\n2026-09-04,New,-5,Checking'], 'scheduled.csv')] } });
    statement().closest('.sheet-body').firstElementChild.dispatchEvent(drop);
    await flush();
    panelButton(topOverlay(), t('reconcile.stageImport')).click(); await flush();
    expect(topOverlay().querySelector('[data-group="recorded"]').textContent).toContain('Shop');
    expect(topOverlay().querySelector('.statement-review-balance strong').textContent).toContain(fmt(0));
    panelButton(topOverlay(), t('statementReview.continue')).click(); await flush();
    expect(addedRows()).toHaveLength(1);
    tick(addedRows()[0].querySelector('.rec-check').dataset.id);
    expect(sheet().querySelector('[role="status"]').textContent).toBe(fmt(0));
    saveBtn().click(); await flush();
    expect(sheetIsOpen()).toBe(false);
    expect(state.transactions).toHaveLength(2);
    expect(state.transactions.find(tx => tx.id === 'scheduled')).toMatchObject({ cleared: true });
    expect(state.transactions.find(tx => tx.id === 'scheduled').status).not.toBe('scheduled');
    expect(state.transactions.some(tx => tx.type === 'adjustment')).toBe(false);
  });
  it.each(['unrecorded', 'uncleared', 'cleared'])('keeps the target fixed for a %s reservation', async kind => {
    state.transactions = kind === 'unrecorded' ? [] : [{
      id: 'pending-clinic', type: 'expense', date: '2026-09-03', payee: 'Clinic', amount: 10, account: 'chk', cleared: kind === 'cleared',
    }];
    setValue(statement(), '990', ['input']);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['Date,Payee,Amount,Status,Account\n2026-09-03,Clinic,-10,Pending,Checking'], 'pending.csv')] } });
    statement().closest('.sheet-body').firstElementChild.dispatchEvent(drop);
    await flush();
    panelButton(topOverlay(), t('reconcile.stageImport')).click(); await flush();
    expect(topOverlay().querySelector('.statement-review select')).toBeNull();
    if (kind === 'unrecorded') topOverlay().querySelector('[data-group="pending"] input').click();
    panelButton(topOverlay(), t('statementReview.continue')).click(); await flush();
    expect(statement().value).toBe('990');
    if (kind !== 'cleared') {
      const id = kind === 'uncleared' ? 'pending-clinic' : addedRows()[0].querySelector('.rec-check').dataset.id;
      tick(id);
      expect(statement().value).toBe('990');
      expect(sheet().querySelector('[role="status"]').textContent).toBe(fmt(0));
      tick(id, false);
      expect(statement().value).toBe('990');
      expect(sheet().querySelector('[role="status"]').textContent).toBe(fmt(-10));
      tick(id);
    }
    saveBtn().click(); await flush();
    expect(state.transactions.some(tx => tx.type === 'adjustment')).toBe(false);
    expect(sheetIsOpen()).toBe(false);
  });
});

// Spies (session.dispatchBatch) never outlive their test.
afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  legacyWriteBatch.mockClear();
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  ledger = [
    { id: 'x1', type: 'expense', date: '2026-09-02', payee: 'Grocer', amount: 50, envelope_id: 'food', account: 'chk', status: 'posted' },
    { id: 'i1', type: 'income', date: '2026-09-03', payee: 'Job', amount: 200, envelope_id: null, account: 'chk', status: 'posted' },
    { id: 'later', type: 'expense', date: '2026-09-20', payee: 'Future', amount: 5, envelope_id: 'food', account: 'chk', status: 'posted' },
    { id: 'sv', type: 'expense', date: '2026-09-04', payee: 'Other acct', amount: 7, envelope_id: 'food', account: 'sav', status: 'posted' },
  ];
  resetState({ transactions: ledger });
  mountHosts();
  openReconcileModal('chk');
  setValue(recDate(), '2026-09-10', ['change']);
});

describe('reconcile list', () => {
  it('carries the reviewed date back to Check balance and cancels without writing', async () => {
    const content = sheet().querySelector('.sheet-body')?.firstElementChild || sheet().querySelector('#reconcile-statement').closest('.field').parentElement.parentElement;
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['Date,Payee,Amount,Account\n2026-09-20,Later import,-9,Checking'], 'later.csv', { type: 'text/csv' })] } });
    content.dispatchEvent(drop);
    await flush();
    const importer = [...document.querySelectorAll('#sheet-host .sheet')].at(-1);
    panelButton(importer, t('reconcile.stageImport')).click();
    await flush();
    setValue(importer.querySelector('.statement-review input[type="date"]'), '2026-09-20', ['change']);
    importer.querySelector('.statement-review input[type="checkbox"]').click();
    panelButton(importer, t('statementReview.continue')).click();
    await flush();
    const row = [...sheet().querySelectorAll('tr')].find(tr => tr.textContent.includes('Later import'));
    expect(row).toBeDefined();
    expect(recDate().value).toBe('2026-09-20');
    expect(row.querySelector('.rec-check').disabled).toBe(false);
    panelButton(sheet(), t('reconcile.cancel')).click();
    await flush();
    topOverlay().querySelector('.btn-accent').click();
    await flush();
    expect(sheetIsOpen()).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(4);
  });
  it('stages file rows with duplicate warnings, edits envelopes, and saves only retained rows with their clear choices', async () => {
    panelButton(sheet(), t('reconcile.addFile')).click();
    const importer = () => [...document.querySelectorAll('#sheet-host .sheet')].at(-1);
    const file = new File(['Date,Payee,Amount,Account\n2026-09-03,Job,200,Checking\n2026-09-03,Grocer,-50,Checking\n2026-09-04,Keep,-11,Checking\n2026-09-05,Remove,-9,Checking\n2026-09-04,Other,-8,Savings'], 'statement.csv', { type: 'text/csv' });
    const input = importer().querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    panelButton(importer(), t('reconcile.stageImport')).click();
    await flush();
    importer().querySelector('[data-group="review"] input[type="checkbox"]').click();
    panelButton(importer(), t('statementReview.continue')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toHaveLength(4);
    expect(sheet().querySelectorAll('.reconcile-import-source')).toHaveLength(3);
    const imported = () => [...sheet().querySelectorAll('tr')].filter(tr => tr.querySelector('.reconcile-import-source'));
    const grocer = imported().find(tr => tr.textContent.includes('Grocer'));
    expect(grocer.textContent).toContain(t('reconcile.importPossible'));
    expect(grocer.textContent).toContain(fmtDateLang('2026-09-02'));
    expect(grocer.querySelector('.reconcile-envelope').textContent).toBe('Food');
    expect(grocer.querySelector('select')).toBeNull();
    grocer.querySelector('button[title="' + t('reconcile.addTxEdit') + '"]').click();
    const panel = addPanel();
    setValue(fieldOf(panel, t('addTx.envelope')).querySelector('select'), 'fun', ['change']);
    panelButton(panel, t('reconcile.addTxEdit')).click();
    await flush();
    const edited = imported().find(tr => tr.textContent.includes('Grocer'));
    expect(edited.querySelector('.reconcile-envelope').textContent).toBe('Fun');
    const cb = edited.querySelector('.rec-check');
    tick(cb.dataset.id);
    imported().find(tr => tr.textContent.includes('Remove')).querySelector('button[title="' + t('reconcile.addTxRemove') + '"]').click();
    setValue(statement(), '950', ['input']);
    saveBtn().click();
    await flush();
    expect(state.transactions).toHaveLength(6);
    const saved = state.transactions.slice(4);
    expect(saved.find(tx => tx.payee === 'Grocer')).toMatchObject({ cleared: true, envelope_id: 'fun', amount: 50 });
    expect(saved.find(tx => tx.payee === 'Keep').cleared).not.toBe(true);
    expect(saved.some(tx => ['Remove', 'Other'].includes(tx.payee))).toBe(false);
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('lists this account\'s uncleared rows up to the reconcile date, newest first', () => {
    const ids = [...sheet().querySelectorAll('.rec-check')].map(cb => cb.dataset.id);
    // Future-dated and other-account rows are not on this statement.
    expect(ids).toEqual(['i1', 'x1']);
  });

  it('shows envelopes in a separate read-only column for existing and manually added rows', async () => {
    expect([...sheet().querySelectorAll('thead th')].map(th => th.textContent)).toContain(t('addTx.envelope'));
    expect(check('x1').closest('tr').querySelector('.reconcile-envelope').textContent).toBe('Food');
    await addRow({ payee: 'Manual shop', amount: '12', envelope: 'fun' });
    const row = [...addedRows()].find(tr => tr.textContent.includes('Manual shop'));
    expect(row.querySelector('.reconcile-envelope').textContent).toBe('Fun');
    expect(row.querySelector('select')).toBeNull();
    // Dispose the dirty sheet: its Escape listener would otherwise survive
    // the next test replacing the DOM hosts and open a discard dialog there.
    panelButton(sheet(), t('reconcile.cancel')).click();
    await flush();
    topOverlay().querySelector('.btn-accent').click();
    await flush();
  });

  it('seeds the cleared baseline with the opening balance, so the gap is not the opening balance', () => {
    const difference = () => sheet().textContent.includes(t('reconcile.difference') + fmt(gapShown));
    let gapShown = 0;
    // Nothing ticked: reconciled total is the opening 1000, so a 1000
    // statement leaves no difference (unseeded it would read 1000).
    setValue(statement(), '1000', ['input']);
    expect(difference()).toBe(true);
    // Ticking the two rows moves the total to 1150.
    tick('x1');
    tick('i1');
    gapShown = -150;
    expect(difference()).toBe(true);
    setValue(statement(), '1150', ['input']);
    gapShown = 0;
    expect(difference()).toBe(true);
  });
});

describe('plain-language balance check', () => {
  it('names the transaction table for the account being checked', () => {
    expect(sheet().querySelector('table').getAttribute('aria-label')).toBe('Check balance: Checking');
  });

  it('compares selected transactions at the statement date and keeps the breakdown optional', () => {
    const comparison = () => sheet().querySelector('.reconcile-comparison');
    expect(comparison()).not.toBeNull();
    expect(comparison().textContent).toContain(fmt(1000, { signed: true }));
    const details = sheet().querySelector('.reconcile-breakdown');
    expect(details.open).toBe(false);
    tick('x1'); tick('i1');
    setValue(statement(), '1150', ['input']);
    expect(comparison().textContent).toContain(fmt(1150, { signed: true }));
    expect(comparison().textContent).not.toContain(fmt(1145, { signed: true }));
    expect(sheet().querySelector('[role="status"]').textContent).toBe(fmt(0));
    details.open = true;
    setValue(recDate(), '2026-09-21', ['change']);
    tick('later');
    expect(comparison().textContent).toContain(fmt(1145, { signed: true }));
    expect(details.open).toBe(true);
    expect(sheet().querySelector('[role="status"]').textContent).toBe(fmt(5));
  });

  it('reports the committed difference if the account changes after the sheet opens', async () => {
    tick('x1');
    setValue(statement(), '950', ['input']);
    state.accounts = state.accounts.map(a => a.id === 'chk' ? { ...a, initialBalance: 990 } : a);
    saveBtn().click(); await flush();
    expect(state.accounts.find(a => a.id === 'chk')).toMatchObject({ lastReconciledBalance: 950, lastReconciledLedger: 940 });
    expect(toasts()).toContain(t('reconcile.toastUnresolved'));
    expect(toasts()).not.toContain(t('reconcile.toastSaved'));
  });

  it('offers continue checking without saving or losing selected transactions', async () => {
    tick('x1');
    setValue(statement(), '900', ['input']);
    saveBtn().click(); await flush();
    const choice = panelButton(topOverlay(), 'Continue checking');
    expect(choice).toBeDefined();
    choice.click(); await flush();
    expect(check('x1').checked).toBe(true);
    expect(statement().value).toBe('900');
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.accounts.find(a => a.id === 'chk').lastReconciledAt).toBeUndefined();
  });

  it('explicitly saves an unresolved difference without an adjustment and reports that outcome', async () => {
    tick('x1');
    setValue(statement(), '900', ['input']);
    saveBtn().click(); await flush();
    const choice = panelButton(topOverlay(), 'Save with difference');
    expect(choice).toBeDefined();
    choice.click(); await flush();
    expect(state.transactions.find(tx => tx.id === 'x1').cleared).toBe(true);
    expect(state.transactions.some(tx => tx.type === 'adjustment')).toBe(false);
    expect(state.accounts.find(a => a.id === 'chk')).toMatchObject({ lastReconciledBalance: 900, lastReconciledLedger: 950 });
    expect(toasts()).toContain(t('reconcile.toastUnresolved'));
    expect(toasts()).not.toContain(t('reconcile.toastSaved'));
  });

  it('explains the signed adjustment before saving and reports its distinct outcome', async () => {
    tick('x1');
    setValue(statement(), '900', ['input']);
    saveBtn().click(); await flush();
    expect(topOverlay().textContent).toContain(fmt(-50, { signed: true }));
    const choice = panelButton(topOverlay(), 'Add adjustment and save');
    expect(choice).toBeDefined();
    choice.click(); await flush();
    expect(state.transactions.find(tx => tx.type === 'adjustment')).toMatchObject({ amount: -50, target_id: 'chk' });
    expect(toasts()).toContain(t('reconcile.toastAdjusted'));
    expect(toasts()).not.toContain(t('reconcile.toastSaved'));
  });
});

describe('number format', () => {
  it('the statement placeholder and the totals use the budget\'s number format and sign', () => {
    expect(statement().placeholder).toBe(t('reconcile.statementBalancePh')(fmtNum(1234.56, { decimals: 2 })));
    expect(statement().placeholder).not.toContain('1234.56');
    tick('x1');
    const text = sheet().textContent;
    // The ticked expense is shown signed the app's way ("€ −50,00"), never
    // as a hyphen glued before the symbol ("-€ 50,00").
    expect(text).toContain(fmt(-50, { signed: true }));
    expect(text).not.toContain(`-${fmt(50)}`);
  });
});

describe('save with a balanced statement', () => {
  it('marks only the ticked rows cleared and stamps the account, in one dispatch', async () => {
    const dispatchBatch = vi.spyOn(session, 'dispatchBatch');
    tick('x1');
    tick('i1');
    setValue(statement(), '1150', ['input']); // 1000 - 50 + 200
    saveBtn().click();
    await flush();

    expect(dispatchBatch).toHaveBeenCalledTimes(1);
    expect(dispatchBatch.mock.calls[0][0]).toEqual([{
      name: 'account.reconcile',
      input: {
        // No gap, so no question, so no adjustment may be posted.
        account: 'chk', balance: 1150, date: '2026-09-10', clear: ['x1', 'i1'], link: [],
        adjust: false, note: t('reconcile.adjustmentNote'),
      },
    }]);

    // One write, through the session, of exactly the two changed collections.
    expect(legacyWriteBatch).not.toHaveBeenCalled();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(batch().map(f => f.filename)).toEqual(['transactions.json', 'accounts.json', 'budget-meta.json']);

    const txs = batchFile('transactions.json');
    expect(txs).toHaveLength(4);
    expect(txs.find(x => x.id === 'x1').cleared).toBe(true);
    expect(txs.find(x => x.id === 'i1').cleared).toBe(true);
    expect(txs.find(x => x.id === 'later').cleared).toBeUndefined();
    expect(txs.find(x => x.id === 'sv').cleared).toBeUndefined();
    expect(txs.some(x => x.type === 'adjustment')).toBe(false);

    const accts = batchFile('accounts.json');
    expect(accts.find(a => a.id === 'chk')).toMatchObject({ lastReconciledAt: '2026-09-10', lastReconciledBalance: 1150 });
    expect(accts.find(a => a.id === 'sav').lastReconciledAt).toBeUndefined();

    // Published after the write: state holds what was written, the rows were
    // replaced, not mutated, and the sheet closed.
    expect(state.transactions).toBe(txs);
    expect(state.accounts).toBe(accts);
    expect(ledger.find(x => x.id === 'x1').cleared).toBeUndefined();
    expect(updateStatusBar).toHaveBeenCalled();
    expect(toasts()).toContain(t('reconcile.toastSaved'));
    expect(sheetIsOpen()).toBe(false);
  });

  it('reads a comma-decimal statement balance', async () => {
    tick('x1');
    tick('i1');
    setValue(statement(), '1150,00', ['input']);
    saveBtn().click();
    await flush();
    expect(batchFile('accounts.json').find(a => a.id === 'chk').lastReconciledBalance).toBe(1150);
  });

  it('stays open and busy until the write lands, then closes', async () => {
    let land;
    writeBatch.mockImplementationOnce(() => new Promise((resolve) => { land = resolve; }));
    tick('x1');
    tick('i1');
    setValue(statement(), '1150', ['input']);
    const btn = saveBtn();
    btn.click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(sheetIsOpen()).toBe(true);
    expect(btn.disabled).toBe(true);
    expect(btn.classList.contains('is-busy')).toBe(true);
    expect(btn.textContent).toBe(t('common.saving'));
    // Neither Cancel nor Escape closes the sheet under the pending write.
    const cancel = [...sheet().querySelectorAll('button')].find(b => b.textContent === t('reconcile.cancel'));
    expect(cancel.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(sheetIsOpen()).toBe(true);
    // Nothing is published before the write lands.
    expect(state.transactions).toBe(ledger);
    expect(toasts()).not.toContain(t('reconcile.toastSaved'));

    land();
    await flush();
    expect(cancel.disabled).toBe(false);
    expect(sheetIsOpen()).toBe(false);
    expect(state.transactions.find(x => x.id === 'x1').cleared).toBe(true);
    expect(toasts()).toContain(t('reconcile.toastSaved'));
  });
});

describe('save with a gap to the statement', () => {
  beforeEach(async () => {
    tick('x1');
    tick('i1');
    setValue(statement(), '1100', ['input']); // ticked rows total 1150: 50 short of the ledger
    saveBtn().click();
    await flush();
  });

  it('asks before posting anything and writes nothing until answered', () => {
    expect(writeBatch).not.toHaveBeenCalled();
    expect(topOverlay().textContent).toContain(t('reconcile.mismatchTitle'));
  });

  it('accepting posts a cleared, signed adjustment for the gap on the account', async () => {
    acceptGap();
    await flush();
    const txs = batchFile('transactions.json');
    const adj = txs.find(x => x.type === 'adjustment');
    // The core row shape (ruling 2): posted, a payee, timestamps, the sheet's note.
    expect(adj).toMatchObject({
      target: 'account', target_id: 'chk', amount: -50, date: '2026-09-10', cleared: true,
      status: 'posted', payee: 'Reconciliation adjustment', note: t('reconcile.adjustmentNote'),
    });
    expect(adj.id).toBeTruthy();
    expect(adj.created_at).toBeTruthy();
    expect(txs).toHaveLength(5);
    expect(batchFile('accounts.json').find(a => a.id === 'chk').lastReconciledBalance).toBe(1100);
  });

  it('declining the adjustment still reconciles, without posting one', async () => {
    declineGap();
    await flush();
    const txs = batchFile('transactions.json');
    expect(txs.some(x => x.type === 'adjustment')).toBe(false);
    expect(txs.find(x => x.id === 'x1').cleared).toBe(true);
    expect(batchFile('accounts.json').find(a => a.id === 'chk')).toMatchObject({
      lastReconciledAt: '2026-09-10', lastReconciledBalance: 1100, lastReconciledLedger: 1150,
    });
  });

  it('dismissing the question writes nothing at all', async () => {
    topOverlay().querySelector('.btn-ghost').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toBe(ledger);
    expect(state.accounts.find(a => a.id === 'chk').lastReconciledAt).toBeUndefined();
    expect(sheetIsOpen()).toBe(true);
  });
});

// A full sheet session: a row added by hand, a scheduled row posted, an
// existing row linked to its plan occurrence, ticks, and a gap.
describe('a sheet session with additions, a link and a gap', () => {
  const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
  const planItem = (id, description, envelope, amount, day) => ({
    id, kind: 'expense', description, envelope_id: envelope, account_id: 'chk',
    as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: ALL_MONTHS,
    default_amount: -amount, payment_day: day, schedule_day_type: 'exact', include: true,
  });
  // Rent was paid by hand, untagged: Post on its occurrence offers to link it.
  const rentPaid = { id: 'r1', type: 'expense', date: '2026-09-05', payee: 'Landlord', amount: 100, envelope_id: 'rent', account: 'chk', status: 'posted' };
  let accountsBefore;
  let dispatchBatch;

  const postScheduled = async (payee) => {
    const row = [...sheet().querySelectorAll('button')].filter(b => b.textContent === t('reconcile.scheduledPost'))
      .map(b => b.parentElement).find(r => r.textContent.includes(payee));
    row.querySelector('button:last-child').click();
    await flush();
  };
  beforeEach(async () => {
    ledger = [...ledger, rentPaid];
    resetState({ transactions: ledger });
    state.budgetItems = [planItem('rent', 'Rent', 'rent', 100, 5), planItem('gym', 'Gym', 'fun', 30, 7)];
    accountsBefore = state.accounts;
    mountHosts();
    openReconcileModal('chk');
    setValue(recDate(), '2026-09-10', ['change']);
    dispatchBatch = vi.spyOn(session, 'dispatchBatch');

    tick('x1');
    // Rent: Post finds the hand-entered payment and links it (ticked).
    await postScheduled('Rent');
    expect(topOverlay().textContent).toContain(t('reconcile.scheduledLinkTitle'));
    topOverlay().querySelector('.btn-accent').click();
    await flush();
    // Gym: nothing recorded yet, so Post adds the row; the user unticks it.
    await postScheduled('Gym');
    const gymId = sheet().querySelector('tr[style*="italic"] .rec-check').dataset.id;
    tick(gymId, false);
    // A coffee the statement shows, added by hand (ticked on save).
    const panel = await addRow({ payee: 'Cafe', amount: '12', envelope: 'food' });
    panelButton(panel, t('reconcile.addTxCancel')).click();
    // Ticked: x1 -50, r1 -100, Cafe -12 on the opening 1000 = 838; statement 830.
    setValue(statement(), '830', ['input']);
    saveBtn().click();
    await flush();
  });

  const expectedSteps = (adjust) => [
    {
      name: 'transaction.record',
      input: { type: 'expense', amount: 30, date: '2026-09-07', payee: 'Gym', account: 'chk', envelope: 'fun', fromBudget: 'gym:2026-09' },
    },
    {
      name: 'transaction.record',
      input: { type: 'expense', amount: 12, date: '2026-09-10', payee: 'Cafe', account: 'chk', envelope: 'food', cleared: true },
    },
    {
      name: 'account.reconcile',
      input: {
        account: 'chk', balance: 830, date: '2026-09-10', clear: ['x1', 'r1'],
        link: [{ id: 'r1', fromBudget: 'rent:2026-09' }], adjust, note: t('reconcile.adjustmentNote'),
        // The gap the mismatch dialog showed, which the user approved.
        ...(adjust ? { expectGap: -8 } : {}),
      },
    },
  ];

  // What the sheet's own model functions make of the same choices (Task 4's
  // equivalence): the existing rows ticked and linked, the stamp on the
  // resulting ledger. The added rows and the adjustment carry the core shape.
  function expectSheetEquivalent({ adjusted }) {
    const existing = applyReconcile({
      transactions: ledger, selectedIds: new Set(['x1', 'r1']), linkKeys: new Map([['r1', 'rent:2026-09']]),
    });
    expect(state.transactions.slice(0, ledger.length)).toEqual(existing);
    const added = state.transactions.slice(ledger.length);
    expect(added).toHaveLength(adjusted ? 3 : 2);
    expect(added[0]).toMatchObject({ type: 'expense', amount: 30, date: '2026-09-07', payee: 'Gym', account: 'chk', envelope_id: 'fun', from_budget: 'gym:2026-09', status: 'posted' });
    expect(added[0]).not.toHaveProperty('cleared');
    expect(added[1]).toMatchObject({ type: 'expense', amount: 12, date: '2026-09-10', payee: 'Cafe', account: 'chk', envelope_id: 'food', cleared: true });
    if (adjusted) {
      expect(added[2]).toMatchObject({ type: 'adjustment', target: 'account', target_id: 'chk', amount: -8, cleared: true, note: t('reconcile.adjustmentNote') });
    }
    expect(state.accounts).toEqual(markReconciled(accountsBefore, 'chk', '2026-09-10', 830, state.transactions, FIXED_NOW.toISOString()));
    expect(state.accounts.find(a => a.id === 'chk')).toMatchObject({ lastReconciledAt: '2026-09-10', lastReconciledBalance: 830, lastReconciledLedger: adjusted ? 830 : 838 });
  }

  it('accepting the gap dispatches the additions, then account.reconcile with adjust, in one batch', async () => {
    expect(topOverlay().textContent).toContain(t('reconcile.mismatchTitle'));
    acceptGap();
    await flush();
    expect(dispatchBatch).toHaveBeenCalledTimes(1);
    expect(dispatchBatch.mock.calls[0][0]).toEqual(expectedSteps(true));
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expectSheetEquivalent({ adjusted: true });
    expect(sheetIsOpen()).toBe(false);
  });

  it('declining the gap dispatches the same batch with adjust: false', async () => {
    declineGap();
    await flush();
    expect(dispatchBatch.mock.calls[0][0]).toEqual(expectedSteps(false));
    expectSheetEquivalent({ adjusted: false });
    expect(sheetIsOpen()).toBe(false);
  });
});

// BACKLOG 2026-10-05 [bug]: a loan payment in the due list is one row, posted
// whole: every leg under its own key, the principal out of its envelope.
describe('a loan payment in the scheduled list', () => {
  const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
  let dispatchBatch;
  beforeEach(() => {
    state.accounts = [...state.accounts, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -120000, interestDayCount: '30/360' }];
    state.budgetItems = [{
      id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'rent', account_id: 'chk', to_account_id: 'mtg',
      loan_rate: 3, default_amount: -1000, monthly_schedule: ALL, payment_day: 5, as_schedule: true,
      as_schedule_since: '2026-09-01', include: true, schedule_day_type: 'exact',
    }];
    mountHosts();
    openReconcileModal('chk');
    setValue(recDate(), '2026-09-10', ['change']);
    dispatchBatch = vi.spyOn(session, 'dispatchBatch');
  });
  const postRows = () => [...sheet().querySelectorAll('button')].filter(b => b.textContent === t('reconcile.scheduledPost')).map(b => b.parentElement);

  it('lists one row for the whole payment, without the one-row edit button', () => {
    const rows = postRows().filter(r => r.textContent.includes('Mortgage'));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(fmt(-1000, { signed: true }));
    // The edit button keeps its place, hidden and inert, so the amounts line up.
    const [edit, post] = rows[0].querySelectorAll('button');
    expect(post.textContent).toBe(t('reconcile.scheduledPost'));
    expect(edit.disabled).toBe(true);
    expect(edit.style.visibility).toBe('hidden');
  });

  it('Post adds both legs; Save records each under its own key', async () => {
    postRows().find(r => r.textContent.includes('Mortgage')).querySelector('button:last-child').click();
    await flush();
    expect(addedRows()).toHaveLength(2);
    setValue(statement(), '0', ['input']); // 1000 - 700 - 300, both ticked
    saveBtn().click();
    await flush();
    expect(dispatchBatch.mock.calls[0][0].slice(0, 2)).toEqual([
      { name: 'transaction.record', input: { type: 'debt_payment', amount: 700, date: '2026-09-05', payee: 'Mortgage', fromAccount: 'chk', toAccount: 'mtg', envelope: 'rent', fromBudget: 'mortgage:2026-09', cleared: true } },
      { name: 'transaction.record', input: { type: 'expense', amount: 300, date: '2026-09-05', payee: 'Mortgage', account: 'chk', envelope: 'rent', fromBudget: 'mortgage:2026-09:interest', cleared: true } },
    ]);
    expect(state.transactions.filter(tx => tx.from_budget?.startsWith('mortgage:')).map(tx => tx.from_budget))
      .toEqual(['mortgage:2026-09', 'mortgage:2026-09:interest']);
    expect(sheetIsOpen()).toBe(false);
  });
});

describe('transfer and investment rows added in the sheet', () => {
  let dispatchBatch;
  beforeEach(() => {
    state.accounts = [...state.accounts, { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 }];
    mountHosts();
    openReconcileModal('chk');
    setValue(recDate(), '2026-09-10', ['change']);
    dispatchBatch = vi.spyOn(session, 'dispatchBatch');
  });
  const save = async (balance) => { setValue(statement(), balance, ['input']); saveBtn().click(); await flush(); };

  it('a transfer row is recorded with its from and to accounts', async () => {
    await addRow({ type: 'transfer_out', amount: '40', other: 'sav' });
    await save('960'); // 1000 - 40, ticked
    expect(dispatchBatch.mock.calls[0][0][0]).toEqual({
      name: 'transaction.record',
      input: { type: 'account_transfer', amount: 40, date: '2026-09-10', payee: '', fromAccount: 'chk', toAccount: 'sav', cleared: true },
    });
    expect(state.transactions.at(-1)).toMatchObject({ type: 'account_transfer', from_account: 'chk', to_account: 'sav', amount: 40, cleared: true });
    expect(sheetIsOpen()).toBe(false);
  });

  it('a sell row with units records them and saves', async () => {
    await addRow({ type: 'investment_in', amount: '250', other: 'inv', units: '2.5' });
    await save('1250');
    expect(dispatchBatch.mock.calls[0][0][0]).toEqual({
      name: 'transaction.record',
      input: {
        type: 'investment_transfer', amount: 250, date: '2026-09-10', payee: '',
        fromAccount: 'inv', toAccount: 'chk', direction: 'sell', units: 2.5, cleared: true,
      },
    });
    expect(state.transactions.at(-1)).toMatchObject({ type: 'investment_transfer', direction: 'sell', units: 2.5, cleared: true });
    expect(sheetIsOpen()).toBe(false);
  });

  it('a sell row without units is stopped in the form, with a hint on the units field', async () => {
    const panel = await addRow({ type: 'investment_in', amount: '250', other: 'inv' });
    const units = fieldOf(panel, t('addTx.units'));
    expect(units.classList.contains('has-error')).toBe(true);
    expect(units.querySelector('.field-hint').textContent).toBe(t('addTx.investmentSellNeedsUnits'));
    expect(addedRows()).toHaveLength(0);
    // Typing clears the hint; with units the row goes in.
    setValue(units.querySelector('input'), '3');
    expect(units.classList.contains('has-error')).toBe(false);
    panelButton(panel, t('reconcile.addTxSave')).click();
    await flush();
    expect(addedRows()).toHaveLength(1);
  });

  it('a buy row may leave units blank, but not give a number that is not above 0', async () => {
    const panel = await addRow({ type: 'investment_out', amount: '100', other: 'inv', units: '0' });
    const units = fieldOf(panel, t('addTx.units'));
    expect(units.querySelector('.field-hint').textContent).toBe(t('reconcile.addTxUnitsInvalid'));
    expect(addedRows()).toHaveLength(0);
    setValue(units.querySelector('input'), '');
    panelButton(panel, t('reconcile.addTxSave')).click();
    await flush();
    expect(addedRows()).toHaveLength(1);
    await save('900');
    const step = dispatchBatch.mock.calls[0][0][0];
    expect(step.input).toMatchObject({ type: 'investment_transfer', direction: 'buy', fromAccount: 'chk', toAccount: 'inv' });
    expect(step.input).not.toHaveProperty('units');
  });

  it('reconciles an investment account with force, which the command otherwise refuses', async () => {
    mountHosts();
    openReconcileModal('inv');
    setValue(recDate(), '2026-09-10', ['change']);
    await save('0');
    expect(dispatchBatch.mock.calls[0][0].at(-1).input).toMatchObject({ account: 'inv', force: true });
    expect(state.accounts.find(a => a.id === 'inv')).toMatchObject({ lastReconciledAt: '2026-09-10', lastReconciledBalance: 0 });
    expect(sheetIsOpen()).toBe(false);
  });
});

describe('save guards', () => {
  it('needs a statement balance', async () => {
    tick('x1');
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(topOverlay().textContent).toContain(t('reconcile.enterBalance'));
  });

  it('refuses a reconcile date before the last one', async () => {
    state.accounts = state.accounts.map(a => a.id === 'chk' ? { ...a, lastReconciledAt: '2026-09-08', lastReconciledBalance: 900 } : a);
    mountHosts();
    openReconcileModal('chk');
    // The date input clamps to the last reconcile date via its min; force an
    // earlier value the way a stale field could hold it.
    recDate().value = '2026-09-01';
    setValue(statement(), '1000', ['input']);
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(topOverlay().textContent).toContain(t('reconcile.dateBeforeLast'));
  });

  it('does nothing for an unknown account', () => {
    mountHosts();
    openReconcileModal('nope');
    expect(document.querySelector('#sheet-host .sheet')).toBeNull();
  });
});

describe('save failure', () => {
  it('a failed write keeps the sheet open, leaves state unchanged and says why', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    const accountsBefore = state.accounts;
    tick('x1');
    tick('i1');
    setValue(statement(), '1150', ['input']);
    saveBtn().click();
    await flush();
    await flush();
    expect(state.transactions).toBe(ledger);
    expect(state.accounts).toBe(accountsBefore);
    expect(sheetIsOpen()).toBe(true);
    expect(toasts().some(m => m.includes('disk full'))).toBe(true);
    expect(toasts()).not.toContain(t('reconcile.toastSaved'));
    // The busy state is over, so the user can try again, and the retry lands.
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    await flush();
    expect(state.transactions.find(x => x.id === 'x1').cleared).toBe(true);
    expect(sheetIsOpen()).toBe(false);
  });

  it('a refused command keeps the sheet open and leaves state unchanged', async () => {
    // Another tab reconciled meanwhile, past this sheet's date.
    const accountsBefore = state.accounts.map(a => a.id === 'chk' ? { ...a, lastReconciledAt: '2026-09-12' } : a);
    state.accounts = accountsBefore;
    tick('x1');
    tick('i1');
    setValue(statement(), '1150', ['input']);
    saveBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toBe(ledger);
    expect(state.accounts).toBe(accountsBefore);
    expect(sheetIsOpen()).toBe(true);
    expect(toasts().some(m => m.includes(t('common.saveFailed')('').trim()))).toBe(true);
  });
});


describe('balance query reads', () => {
  it('uses the selected lens for add-panel envelope balances', () => {
    prefs.lens = 'today';
    state.transactions = ledger.map((tx, i) => ({ ...tx, status: i === 0 ? 'posted' : 'scheduled' }));
    const query = vi.spyOn(session, 'query');
    mountHosts();
    openReconcileModal('chk');
    [...sheet().querySelectorAll('button')].find(b => b.textContent === t('reconcile.addTx')).click();
    const food = addPanel().querySelector('option[value="food"]');
    expect(food.textContent).toContain(fmt(-50));
    expect(query).toHaveBeenCalledWith('balances', { lens: 'today', includeArchived: true });
  });

  it('does not open a value adjustment with a fabricated balance when its query fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(session, 'query').mockReturnValue({ ok: false, error: { code: 'no_budget' } });
    const count = document.querySelectorAll('[data-sheet-open]').length;
    openInvestmentValueDialog('chk');
    expect(document.querySelectorAll('[data-sheet-open]')).toHaveLength(count);
  });
});

describe('the value update dialog', () => {
  const valueInput = () => document.getElementById('invval-new');
  const valueSave = () => [...sheet().querySelectorAll('button')].find(b => b.textContent === t('addTx.save'));
  const warnShown = () => sheet().querySelector('.invval-negative-warn').style.display !== 'none';
  const dialogBtn = (cls) => [...topOverlay().querySelectorAll('button')].find(b => b.classList.contains(cls));
  const adjusts = () => session.dispatch.mock.calls.filter(c => c[0] === 'balance.adjust').map(c => c[1]);

  beforeEach(() => {
    state.accounts = [
      ...state.accounts,
      { id: 'house', name: 'House', type: 'asset', initialBalance: 1000 },
      { id: 'mort', name: 'Mortgage', type: 'asset', initialBalance: -5000 },
      { id: 'brk', name: 'Broker', type: 'investment', initialBalance: 300 },
    ];
    vi.spyOn(session, 'dispatch');
    mountHosts();
  });

  it('an asset says "Value updated", an investment keeps its own toast', async () => {
    openInvestmentValueDialog('house', null, { asset: true });
    setValue(valueInput(), '1200');
    valueSave().click();
    await flush();
    expect(adjusts()).toEqual([expect.objectContaining({ account: 'house', amount: 200 })]);
    expect(toasts()).toContain(t('assetValue.toastSaved'));
    expect(toasts()).not.toContain(t('investmentValue.toastSaved'));

    mountHosts();
    openInvestmentValueDialog('brk');
    setValue(valueInput(), '350');
    valueSave().click();
    await flush();
    expect(toasts()).toContain(t('investmentValue.toastSaved'));
  });

  it('a value flipping below zero warns and asks before saving', async () => {
    openInvestmentValueDialog('house', null, { asset: true });
    setValue(valueInput(), '900');
    expect(warnShown()).toBe(false);
    setValue(valueInput(), '-50');
    expect(warnShown()).toBe(true);
    valueSave().click();
    await flush();
    // The confirm is open; declining saves nothing and keeps the dialog.
    expect(topOverlay().textContent).toContain(t('investmentValue.negativeConfirm')(fmt(-50)));
    dialogBtn('btn-ghost').click();
    await flush();
    expect(adjusts()).toEqual([]);
    expect(valueInput()).toBeTruthy();
    valueSave().click();
    await flush();
    dialogBtn('btn-accent').click();
    await flush();
    expect(adjusts()).toEqual([expect.objectContaining({ account: 'house', amount: -1050 })]);
  });

  it('a debt already below zero is not warned about', async () => {
    openInvestmentValueDialog('mort', null, { asset: true });
    setValue(valueInput(), '-4000');
    expect(warnShown()).toBe(false);
    valueSave().click();
    await flush();
    expect(adjusts()).toEqual([expect.objectContaining({ account: 'mort', amount: 1000 })]);
    expect(toasts()).toContain(t('assetValue.toastSaved'));
  });
});

describe('find planned transactions', () => {
  const picker = () => topOverlay().querySelector('.rec-picker');
  async function find(term) {
    panelButton(sheet(), t('reconcile.findPlanned')).click();
    setValue(picker().querySelector('input[type="search"]'), term);
    await flush();
  }
  async function choose(text) {
    const row = [...picker().querySelectorAll('.rec-picker-result')].find(r => r.textContent.includes(text));
    expect(row).toBeTruthy();
    row.click();
    await flush();
  }
  async function use() {
    panelButton(picker(), t('reconcile.useMatch')).click();
    await flush();
  }
  function teliaPlan() {
    return { id: 'telia', kind: 'expense', description: 'Telia', envelope_id: 'food', account_id: 'sav',
      as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: { Sep: true, Oct: true },
      default_amount: -35, payment_day: 25, schedule_day_type: 'exact', include: true };
  }

  it('finds future booked payments on another account, stages and saves one amendment atomically', async () => {
    state.transactions = [...state.transactions, { id: 'telia-booked', type: 'expense', payee: 'Telia', account: 'sav',
      date: '2026-09-25', amount: 35, envelope_id: 'food', status: 'scheduled', from_budget: 'telia:2026-09', note: 'Keep this' }];
    state.budgetItems = [teliaPlan()];
    const planBefore = JSON.stringify(state.budgetItems);
    const original = state.transactions.find(tx => tx.id === 'telia-booked');
    await find('Telia');
    expect([...picker().querySelectorAll('.rec-picker-result')].filter(r => r.textContent.includes('2026-09'))).toHaveLength(1);
    await choose(t('reconcile.matchBooked'));
    expect(picker().querySelector('input[type="date"]').value).toBe('2026-09-10');
    await use();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions.find(tx => tx.id === original.id)).toEqual(original);
    expect(check(original.id).checked).toBe(true);
    setValue(statement(), '965');
    saveBtn().click(); await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(ledger.length + 1);
    expect(state.transactions.find(tx => tx.id === original.id)).toMatchObject({
      account: 'chk', date: '2026-09-10', amount: 35, cleared: true, status: 'posted', from_budget: 'telia:2026-09', note: 'Keep this',
    });
    expect(JSON.stringify(state.budgetItems)).toBe(planBefore);
  });

  it('records an early occurrence on this account with its original month and hides it from the next search', async () => {
    state.budgetItems = [teliaPlan()];
    await find('Telia');
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(1);
    await choose(t('reconcile.matchScheduled'));
    await use();
    expect(writeBatch).not.toHaveBeenCalled();
    await find('Telia');
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(1);
    expect(picker().querySelector('.rec-picker-result').textContent).toContain('2026-10');
    panelButton(topOverlay(), t('common.cancel')).click(); await flush();
    setValue(statement(), '965');
    saveBtn().click(); await flush();
    expect(state.transactions.find(tx => tx.from_budget === 'telia:2026-09')).toMatchObject({
      account: 'chk', date: '2026-09-10', amount: 35, cleared: true, type: 'expense',
    });
    expect(state.budgetItems[0].account_id).toBe('sav');
  });

  it('skips reconciled occurrences but keeps the next occurrence of each distinct plan', async () => {
    state.budgetItems = [teliaPlan(), { ...teliaPlan(), id: 'telia-mobile' }];
    state.transactions = [...state.transactions, { id: 'telia-paid', type: 'expense', payee: 'Telia paid',
      date: '2026-09-01', account: 'sav', envelope_id: 'food', amount: 35, cleared: true, from_budget: 'telia:2026-09' }];
    await find('Telia');
    const results = [...picker().querySelectorAll('.rec-picker-result')];
    expect(results).toHaveLength(2);
    expect(results.filter(r => r.textContent.includes('2026-10'))).toHaveLength(1);
    expect(picker().textContent).not.toContain('Telia paid');
  });

  it.each([
    { amount: 29, date: '2026-09-02', budget_item_id: 'telia' },
    { amount: 35, date: '2026-09-24' },
  ])('does not recreate a cleared manual payment: %j', async payment => {
    state.budgetItems = [teliaPlan()];
    state.transactions = [...state.transactions, { id: 'paid-manual', type: 'expense', payee: 'Telia paid',
      account: 'chk', envelope_id: 'food', cleared: true, ...payment }];
    await find('Telia');
    const results = [...picker().querySelectorAll('.rec-picker-result')];
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain('2026-10');
    expect(picker().textContent).not.toContain('Telia paid');
  });

  it('does not hide a plan because a different plan was cleared', async () => {
    state.budgetItems = [teliaPlan()];
    state.transactions = [...state.transactions, { id: 'other-paid', type: 'expense', payee: 'Other paid',
      account: 'sav', envelope_id: 'food', cleared: true, amount: 35, date: '2026-09-24', budget_item_id: 'other-plan' }];
    await find('Telia');
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(1);
    expect(picker().querySelector('.rec-picker-result').textContent).toContain('2026-09');
  });

  it('refuses to save a staged occurrence settled by a newly cleared manual payment', async () => {
    state.budgetItems = [teliaPlan()];
    await find('Telia');
    await choose(t('reconcile.matchScheduled'));
    await use();
    state.transactions = [...state.transactions, { id: 'paid-manual', type: 'expense', payee: 'Telia paid',
      account: 'sav', envelope_id: 'food', cleared: true, amount: 35, date: '2026-09-24' }];
    setValue(statement(), '965');
    saveBtn().click(); await flush();
    expect(topOverlay().textContent).toContain(t('reconcile.matchChanged'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('rejects a scheduled selection if its manual payment was cleared during review', async () => {
    state.budgetItems = [teliaPlan()];
    await find('Telia');
    await choose(t('reconcile.matchScheduled'));
    state.transactions = [...state.transactions, { id: 'paid-manual', type: 'expense', payee: 'Telia paid',
      account: 'sav', envelope_id: 'food', cleared: true, amount: 35, date: '2026-09-24' }];
    await use();
    expect(picker().textContent).toContain(t('reconcile.matchChanged'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('removes a newly reconciled stored payment when search results refresh', async () => {
    await find('Future');
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(1);
    state.transactions = state.transactions.map(tx => tx.id === 'later' ? { ...tx, cleared: true } : tx);
    setValue(picker().querySelector('input[type="search"]'), 'Future ');
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(0);
  });

  it('does not offer an isolated loan interest leg as an invoice occurrence', async () => {
    state.accounts = [...state.accounts, { id: 'loan', name: 'Loan', type: 'loan', initialBalance: -100000,
      interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360' }];
    state.budgetItems = [{ ...teliaPlan(), id: 'mortgage', description: 'Mortgage', kind: 'loan_payment',
      account_id: 'chk', to_account_id: 'loan', default_amount: -1000 }];
    await find('Mortgage');
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(0);
  });

  it('excludes cleared payments and allows an account filter', async () => {
    state.transactions = [...state.transactions, { ...ledger[3], id: 'paid', cleared: true, payee: 'Already paid' }];
    await find('');
    expect(picker().textContent).not.toContain('Already paid');
    setValue(picker().querySelector('select'), 'sav', ['change']);
    expect(picker().querySelectorAll('.rec-picker-result')).toHaveLength(1);
    expect(picker().textContent).toContain('Other acct');
  });

  it('undoes a staged account move without writing or losing the original', async () => {
    await find('Other acct'); await choose(t('reconcile.matchBooked')); await use();
    expect(check('sv')).toBeTruthy();
    panelButton(sheet(), t('reconcile.undoMatch')).click();
    expect(check('sv')).toBeNull();
    expect(state.transactions).toEqual(ledger);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('discarding the reconciliation discards staged amendments', async () => {
    await find('Future'); await choose(t('reconcile.matchBooked')); await use();
    panelButton(sheet(), t('reconcile.cancel')).click(); await flush();
    expect(topOverlay().textContent).toContain(t('reconcile.discardSession'));
    topOverlay().querySelector('.btn-accent').click(); await flush();
    expect(state.transactions).toEqual(ledger);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('refuses future actual dates and leaves the review open', async () => {
    await find('Future'); await choose(t('reconcile.matchBooked'));
    setValue(picker().querySelector('input[type="date"]'), '2026-09-11');
    await use();
    expect(picker().querySelector('[role="alert"]').textContent).toBe(t('reconcile.matchInvalid'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a booked transaction changed after staging', async () => {
    await find('Future'); await choose(t('reconcile.matchBooked')); await use();
    state.transactions = state.transactions.map(tx => tx.id === 'later' ? { ...tx, note: 'Updated elsewhere' } : tx);
    setValue(statement(), '995'); saveBtn().click(); await flush();
    expect(topOverlay().textContent).toContain(t('reconcile.matchChanged'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('reuses a matching booked payment for a scheduled occurrence without duplicating it', async () => {
    state.budgetItems = [teliaPlan()];
    state.transactions = [...state.transactions, { id: 'telia-manual', type: 'expense', payee: 'Telia invoice',
      date: '2026-09-25', amount: 35, account: 'sav', envelope_id: 'food', status: 'posted' }];
    await find('Telia 2026-09'); await choose(t('reconcile.matchScheduled'));
    await use();
    expect(topOverlay().textContent).toContain(t('reconcile.scheduledLinkTitle'));
    topOverlay().querySelector('.btn-accent').click(); await flush();
    setValue(statement(), '965'); saveBtn().click(); await flush();
    expect(state.transactions.filter(tx => tx.payee.includes('Telia'))).toHaveLength(1);
    expect(state.transactions.find(tx => tx.id === 'telia-manual')).toMatchObject({
      account: 'chk', date: '2026-09-10', from_budget: 'telia:2026-09', cleared: true,
    });
  });

  it('preserves split allocations when moving a booked payment', async () => {
    const splits = [{ envelope_id: 'food', amount: 4 }, { envelope_id: 'fun', amount: 3 }];
    state.transactions = state.transactions.map(tx => tx.id === 'sv' ? { ...tx, envelope_id: null, envelope_splits: splits } : tx);
    await find('Other acct'); await choose(t('reconcile.matchBooked'));
    expect(picker().querySelector('input[type="text"]').readOnly).toBe(true);
    await use(); setValue(statement(), '993'); saveBtn().click(); await flush();
    expect(state.transactions.find(tx => tx.id === 'sv').envelope_splits).toEqual(splits);
  });
});

describe('planned picker save integrity', () => {
  async function stageFuture() {
    panelButton(sheet(), t('reconcile.findPlanned')).click();
    const picker = topOverlay().querySelector('.rec-picker');
    setValue(picker.querySelector('input[type="search"]'), 'Future');
    picker.querySelector('.rec-picker-result').click();
    panelButton(picker, t('reconcile.useMatch')).click();
    await flush();
  }

  it('keeps a failed write staged and leaves both stored collections unchanged', async () => {
    const beforeAccounts = JSON.stringify(state.accounts);
    const beforeTransactions = JSON.stringify(state.transactions);
    await stageFuture();
    writeBatch.mockRejectedValueOnce(new Error('disk unavailable'));
    setValue(statement(), '995'); saveBtn().click(); await flush();
    expect(JSON.stringify(state.accounts)).toBe(beforeAccounts);
    expect(JSON.stringify(state.transactions)).toBe(beforeTransactions);
    expect(check('later').checked).toBe(true);
    expect(panelButton(sheet(), t('reconcile.undoMatch'))).toBeTruthy();
    saveBtn().click(); await flush();
    expect(state.transactions.find(tx => tx.id === 'later')).toMatchObject({ date: '2026-09-10', cleared: true });
  });

  it('lets the staged payment be reviewed again before save', async () => {
    await stageFuture();
    const row = check('later').closest('tr');
    panelButton(row, t('reconcile.addTxEdit')).click();
    const picker = topOverlay().querySelector('.rec-picker');
    setValue(picker.querySelector('input[type="text"]'), '8');
    panelButton(picker, t('reconcile.useMatch')).click(); await flush();
    setValue(statement(), '992'); saveBtn().click(); await flush();
    expect(state.transactions.find(tx => tx.id === 'later')).toMatchObject({ amount: 8, date: '2026-09-10', cleared: true });
  });
});
