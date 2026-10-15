// @vitest-environment jsdom
// Import sheet: what a bank CSV becomes in the ledger. Drives the real
// js/import/import-sheet.js through both phases: pick a file, map the
// columns and account, review the matches, import. The rows are recorded by
// one transaction.import through the session (the real browser session over
// the fake state in _fakes/pageApp.js), so these tests assert on
// state.transactions and the session's writeBatch: dedupe of a row already in
// the budget, the sign of each row, the account, appended in file order. Also
// the closing-balance check, CSV templates (saved through the meta queue), and
// the AI path with the model calls mocked so nothing touches the network.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveMeta: vi.fn(async () => {}),
}));
vi.mock('../js/ai/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAiAvailable: vi.fn(() => false),
}));
vi.mock('../js/import/ai-parse.js', () => ({ parseFileWithAi: vi.fn() }));
vi.mock('../js/ai/categorize.js', async (importOriginal) => ({
  ...(await importOriginal()),
  categorizeRows: vi.fn(),
}));

import { saveMeta } from '../js/data.js';
import { isAiAvailable } from '../js/ai/client.js';
import { parseFileWithAi } from '../js/import/ai-parse.js';
import { categorizeRows } from '../js/ai/categorize.js';
import { openImportSheet } from '../js/import/import-sheet.js';
import { t } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { describeError } from '../js/core/errors.js';
import {
  state, writeBatch, resetState, mountHosts, flush, setValue, sheetIsOpen,
  topOverlay, dialogOk, dialogButton, toastTexts, navigate, updateStatusBar, FIXED_NOW,
} from './_fakes/pageApp.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
const buttons = (label) => [...sheet().querySelectorAll('button')].filter(b => b.textContent === label);
const button = (label) => buttons(label)[0];
// What the import added: the rows after the ones the budget already had.
const added = () => state.transactions.slice(existing.length);
const failText = (message) => `${t('txImport.importError')}: ${describeError({ code: 'write_failed', params: { message } }, t)}`;
const norm = (s) => s.replace(/\s/g, '');
const savedMeta = () => saveMeta.mock.calls.at(-1)?.[1];

const csvFile = (text, name = 'bank.csv') => new File([text], name, { type: 'text/csv' });
async function pick(file) {
  const input = sheet().querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}
const selects = () => [...sheet().querySelectorAll('select')];
// Phase 1's selects, in order: date, payee, then (single mode) amount, account.
const selectAfterLabel = (label) => [...sheet().querySelectorAll('.field')]
  .find(f => f.querySelector('label')?.textContent === label).querySelector('select');
const pickAccount = (id) => setValue(selectAfterLabel(t('txImport.account')), id, ['change']);
const reviewBtn = () => button(t('txImport.reviewMatches'));
const importBtn = () => [...sheet().querySelectorAll('button.btn-accent')].at(-1);
const tableRows = () => [...sheet().querySelectorAll('tbody tr')];
const badges = () => tableRows().map(tr => tr.querySelector('.import-match-badge').textContent);

const CSV = [
  'Date,Payee,Amount',
  '2026-09-01,Lidl,-45.20',
  '2026-09-04,Rent Co,-700.00',
  '2026-09-02,Employer,2000.00',
  '2026-09-03,K-Market,-12.50',
  'not a date,Broken,abc',
].join('\n');

let existing;

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  isAiAvailable.mockReset();
  isAiAvailable.mockReturnValue(false);
  parseFileWithAi.mockReset();
  categorizeRows.mockReset();
  saveMeta.mockReset();
  saveMeta.mockImplementation(async () => {});
  existing = [
    // The same Lidl purchase is already in checking: an exact duplicate.
    { id: 'x1', type: 'expense', date: '2026-09-01', payee: 'Lidl', amount: 45.2, account: 'chk', envelope_id: 'food', status: 'posted' },
    // Same amount as the K-Market row, but on SAVINGS: not a duplicate of a checking row.
    { id: 'x2', type: 'expense', date: '2026-09-03', payee: 'Elsewhere', amount: 12.5, account: 'sav', envelope_id: 'food', status: 'posted' },
  ];
  resetState({ transactions: existing });
  // A failure queued by a test whose write never happened must not leak into the next.
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
  ];
  state.meta = {};
  mountHosts();
});

async function openWithCsv(text = CSV) {
  openImportSheet(state);
  await pick(csvFile(text));
}

describe('phase 1: columns and account', () => {
  it.each(['Savings', 'Unrecognised account'])('closes a document import rejected for %s without staging rows', async (sourceAccount) => {
    isAiAvailable.mockReturnValue(true);
    parseFileWithAi.mockResolvedValue({
      rows: [{ date: '2026-09-04', payee: 'Shop', amount: -17, sourceAccount }],
      declaredTotal: null, skipped: 0,
    });
    const onStage = vi.fn();
    openImportSheet(state, { reconcile: {
      accountId: 'chk', isActive: () => true, getTransactions: () => state.transactions, onStage,
    } });
    await pick(new File(['image'], 'statement.png', { type: 'image/png' }));
    if (sourceAccount === 'Savings') {
      expect(topOverlay().textContent).toContain(t('reconcile.importNoAccountRows'));
      dialogOk().click();
    } else {
      expect(topOverlay().textContent).toContain(t('reconcile.importConfirmAccount')(sourceAccount, 'Checking'));
      dialogButton(t('common.cancel')).click();
    }
    await flush();
    expect(sheetIsOpen()).toBe(false);
    expect(onStage).not.toHaveBeenCalled();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(parseFileWithAi).toHaveBeenCalledTimes(1);
    expect(categorizeRows).not.toHaveBeenCalled();
  });

  it('requires account confirmation before staging unidentified rows and never writes them', async () => {
    const staged = [];
    openImportSheet(state, { reconcile: {
      accountId: 'chk', isActive: () => true, getTransactions: () => state.transactions,
      onStage: rows => staged.push(...rows),
    } });
    await pick(csvFile('Date,Payee,Amount\n2026-09-04,New shop,-17'));
    button(t('reconcile.stageImport')).click();
    await flush();
    expect(staged).toEqual([]);
    expect(topOverlay().textContent).toContain(t('reconcile.importConfirmAccount')(t('reconcile.importUnknownAccount'), 'Checking'));
    dialogOk().click();
    await flush();
    button(t('statementReview.continue')).click();
    await flush();
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ account: 'chk', amount: 17, date: '2026-09-04', importFilename: 'bank.csv' });
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('matches a second file against staged additions and keeps the selected account locked', async () => {
    const staged = [{ id: 'draft', account: 'chk', type: 'expense', amount: 17, date: '2026-09-04', payee: 'New shop' }];
    openImportSheet(state, { reconcile: {
      accountId: 'chk', isActive: () => true, getTransactions: () => [...state.transactions, ...staged],
      onStage: rows => staged.push(...rows),
    } });
    await pick(csvFile('Date,Payee,Amount,Account\n2026-09-04,New shop,-17,Checking'));
    expect(selectAfterLabel(t('txImport.account')).disabled).toBe(true);
    button(t('reconcile.stageImport')).click();
    await flush();
    button(t('statementReview.continue')).click();
    await flush();
    expect(staged).toHaveLength(1);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('does not stage a file whose budget was switched while it was being read', async () => {
    const staged = [];
    let complete;
    openImportSheet(state, { reconcile: {
      accountId: 'chk', isActive: () => true, getTransactions: () => state.transactions,
      onStage: rows => staged.push(...rows),
    } });
    const read = pick({ name: 'slow.csv', arrayBuffer: () => new Promise(resolve => { complete = resolve; }) });
    state.budgetFolder = { name: 'another budget' };
    complete(new TextEncoder().encode('Date,Payee,Amount,Account\n2026-09-04,Shop,-17,Checking').buffer);
    await read;
    expect(staged).toEqual([]);
    expect(sheet().querySelector('.import-preview-scroll')).toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('detects the columns from the header and previews what it parsed', async () => {
    await openWithCsv();
    expect(selectAfterLabel(t('txImport.dateCol')).selectedOptions[0].textContent).toBe('[0] Date');
    expect(selectAfterLabel(t('txImport.payeeCol')).selectedOptions[0].textContent).toBe('[1] Payee');
    // Four rows parse; the row with no date is skipped, and the preview says so.
    expect(sheet().textContent).toContain('4 parsed, 1 skipped');
    expect(sheet().textContent).toContain('Lidl');
  });

  it('the preview scrolls sideways in its own box and keeps a readable payee width', async () => {
    await openWithCsv();
    const box = sheet().querySelector('.import-preview-scroll');
    expect(box.hasAttribute('data-scroll-cue')).toBe(true);
    expect(box.style.overflowX).toBe('auto');
    const cells = box.querySelector('tbody tr').children;
    expect(cells[1].style.minWidth).toBe('140px');
    expect(cells[0].style.whiteSpace).toBe('nowrap');
  });

  it('cannot go on until an account is chosen', async () => {
    await openWithCsv();
    expect(reviewBtn().disabled).toBe(true);
    pickAccount('chk');
    expect(reviewBtn().disabled).toBe(false);
  });

  it('with no file yet it shows only the picker', () => {
    openImportSheet(state);
    expect(selects()).toHaveLength(0);
    expect(reviewBtn().disabled).toBe(true);
  });

  it('a debit / credit export is detected and read with out as negative, in as positive', async () => {
    await openWithCsv([
      'Date;Description;Debit;Credit',
      '01.09.2026;Groceries;33,10;',
      '02.09.2026;Salary;;2.000,00',
    ].join('\n'));
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    importBtn().click();
    await flush();
    expect(added().map(x => [x.date, x.type, x.amount, x.payee])).toEqual([
      ['2026-09-01', 'expense', 33.1, 'Groceries'],
      ['2026-09-02', 'income', 2000, 'Salary'],
    ]);
  });
});

describe('phase 2: review and import', () => {
  beforeEach(async () => {
    await openWithCsv();
    pickAccount('chk');
    reviewBtn().click();
    await flush();
  });

  it('flags the row already in this account as a duplicate and everything else as new', () => {
    expect(tableRows()).toHaveLength(4);
    const byPayee = Object.fromEntries(tableRows().map(tr => [tr.children[2].textContent, tr.querySelector('.import-match-badge').textContent]));
    expect(byPayee).toEqual({ Lidl: t('txImport.badge.exact'), 'Rent Co': t('txImport.badge.none'), Employer: t('txImport.badge.none'), 'K-Market': t('txImport.badge.none') });
    expect(sheet().textContent).toContain(t('txImport.parseErrors')(1));
  });

  it('the match table scrolls sideways in its own box with a minimum width, so the payee keeps room on a phone', () => {
    const box = sheet().querySelector('.import-match-scroll');
    expect(box).toBeTruthy();
    expect(box.hasAttribute('data-scroll-cue')).toBe(true);
    expect(box.style.overflowX).toBe('auto');
    const tbl = box.querySelector('table');
    expect(tbl.style.minWidth).toBe('720px');
    expect(tbl.querySelectorAll('tbody tr')).toHaveLength(4);
  });

  it('shows each row\'s signed amount', () => {
    const amounts = Object.fromEntries(tableRows().map(tr => [tr.children[2].textContent, norm(tr.children[3].textContent)]));
    expect(amounts['Rent Co']).toBe(norm('−' + fmt(700)));
    expect(amounts.Employer).toBe(norm('+' + fmt(2000)));
  });

  it('importing records only the new rows: magnitudes with a type for the sign, on the picked account, appended in file order', async () => {
    expect(importBtn().textContent).toBe(t('txImport.importBtn')(3));
    importBtn().click();
    await flush();

    // One write through the session, of the budget open when the import ran.
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    const all = state.transactions;
    expect(all).toHaveLength(existing.length + 3);
    // Existing rows are unchanged and in place, and the duplicate was not written again.
    expect(all.slice(0, existing.length)).toEqual(existing);
    expect(all.filter(x => x.payee === 'Lidl')).toHaveLength(1);
    // The new rows come after them in the file's order (the ledger is not re-sorted).
    expect(added().map(x => ({ date: x.date, type: x.type, amount: x.amount, payee: x.payee, account: x.account, envelope_id: x.envelope_id })))
      .toEqual([
        { date: '2026-09-04', type: 'expense', amount: 700, payee: 'Rent Co', account: 'chk', envelope_id: null },
        { date: '2026-09-02', type: 'income', amount: 2000, payee: 'Employer', account: 'chk', envelope_id: null },
        { date: '2026-09-03', type: 'expense', amount: 12.5, payee: 'K-Market', account: 'chk', envelope_id: null },
      ]);
    // No status key: a missing status means posted. Stamped like every recorded row.
    expect(added().some(x => 'status' in x)).toBe(false);
    expect(added().every(x => x.created_at && x.created_at === x.modified_at)).toBe(true);
    expect(new Set(all.map(x => x.id)).size).toBe(all.length);
    expect(toastTexts()).toContain(t('txImport.success')(3));
    expect(sheetIsOpen()).toBe(false);
    // The open page and the status bar repaint on the new rows, once.
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('transactions');
  });

  it('a duplicate can be forced in by clicking its row', async () => {
    expect(tableRows().find(tr => tr.children[2].textContent === 'Lidl').hidden).toBe(true);
    button(t('statementReview.showRecorded')).click();
    expect(tableRows().find(tr => tr.children[2].textContent === 'Lidl').hidden).toBe(false);
    tableRows().find(tr => tr.children[2].textContent === 'Lidl').click();
    expect(importBtn().textContent).toBe(t('txImport.importBtn')(4));
    importBtn().click();
    await flush();
    expect(state.transactions.filter(x => x.payee === 'Lidl')).toHaveLength(2);
  });

  it('a new row can be skipped, and with nothing left to import the button is disabled', async () => {
    for (const tr of tableRows().filter(r => r.querySelector('.import-match-badge').textContent === t('txImport.badge.none'))) tr.click();
    expect(importBtn().disabled).toBe(true);
    expect(sheet().textContent).toContain(t('txImport.allDuplicates'));
    importBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a failed write keeps the sheet open, says so, changes nothing, and lets the user try again', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    importBtn().click();
    await flush();
    expect(sheet().textContent).toContain(failText('disk full'));
    expect(state.transactions).toEqual(existing);
    expect(importBtn().disabled).toBe(false);
    expect(button(t('txImport.backBtn')).disabled).toBe(false);
    expect(button(t('txImport.cancel')).disabled).toBe(false);
    expect(sheetIsOpen()).toBe(true);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();

    importBtn().click();
    await flush();
    expect(added()).toHaveLength(3);
    expect(toastTexts()).toContain(t('txImport.success')(3));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('a version conflict offers the reload dialog and keeps the sheet usable', async () => {
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    importBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('saveError.versionConflictBody'));
    expect(state.transactions).toEqual(existing);
    expect(importBtn().disabled).toBe(false);
  });

  it('with no budget open any more the sheet closes without a word', async () => {
    state.budgetFolder = null;
    importBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toEqual(existing);
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toEqual([]);
    // The budget it belonged to is gone: the next one's loader paints.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a budget switch after the write landed closes the sheet without a toast or a repaint', async () => {
    // The write lands, then another budget opens before the session publishes.
    writeBatch.mockImplementationOnce(async () => { state.budgetFolder = { name: 'other-budget' }; });
    importBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toEqual(existing);
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();
  });

  it('Back returns to the column mapping with the file still loaded', async () => {
    button(t('txImport.backBtn')).click();
    expect(selectAfterLabel(t('txImport.account')).value).toBe('chk');
    expect(sheet().textContent).toContain('5 rows loaded');
  });
});

describe('a closed month', () => {
  beforeEach(() => { state.meta = { closed_months: ['2026-09'] }; });

  it('CSV: cancelling the closed-month confirm writes nothing and keeps the review open', async () => {
    await openWithCsv();
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    importBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.title'));
    dialogButton(t('common.cancel')).click();
    await flush();

    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toEqual(existing);
    expect(sheetIsOpen()).toBe(true);
    expect(importBtn().disabled).toBe(false);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('AI document: cancelling the closed-month confirm writes nothing and says the import was cancelled', async () => {
    isAiAvailable.mockReturnValue(true);
    parseFileWithAi.mockResolvedValue({
      rows: [{ date: '2026-09-05', payee: 'Cafe', amount: -8 }],
      declaredTotal: null, skipped: 0,
    });
    categorizeRows.mockResolvedValue([
      { index: 0, type: 'expense', account_id: 'chk', envelope_id: 'fun', confidence: 0.9, rationale: 'coffee' },
    ]);
    openImportSheet(state);
    await pick(new File(['%PDF'], 'statement.pdf', { type: 'application/pdf' }));
    await flush();
    const approve = sheet().querySelector('.proposal-actions .btn-accent');
    approve.click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.title'));
    dialogButton(t('common.cancel')).click();
    await flush();

    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toEqual(existing);
    expect(sheet().querySelector('.import-review-status').textContent).toContain(t('closedPeriod.importCancelled'));
    expect(approve.disabled).toBe(false);
    expect(toastTexts()).toEqual([]);
  });
});

describe('a possible match (owner decision 6, 2026-10-05)', () => {
  beforeEach(async () => {
    // The rent is in checking already, but two days earlier and under
    // another payee: maybe the same, maybe not.
    state.transactions = [...existing,
      { id: 'x3', type: 'expense', date: '2026-09-02', payee: 'Landlord', amount: 700, account: 'chk', status: 'posted' }];
    await openWithCsv();
    pickAccount('chk');
    reviewBtn().click();
    await flush();
  });

  const rentRow = () => tableRows().find(tr => tr.children[2].firstChild.textContent === 'Rent Co');

  it('is imported by default and stays marked with the row it may duplicate', async () => {
    expect(rentRow().querySelector('.import-match-badge').textContent).toBe(t('txImport.badge.possible'));
    expect(rentRow().querySelector('.import-possible-of').textContent).toBe(t('txImport.possibleOf')('2026-09-02', 'Landlord'));
    // Lidl (same day, amount and payee) is still skipped; the other three import.
    expect(importBtn().textContent).toBe(t('txImport.importBtn')(3));
    importBtn().click();
    await flush();
    expect(added().slice(1).map(x => x.payee)).toEqual(['Rent Co', 'Employer', 'K-Market']);
  });

  it('can be unticked like any other row', async () => {
    rentRow().click();
    expect(importBtn().textContent).toBe(t('txImport.importBtn')(2));
    expect(rentRow().querySelector('.import-match-badge').textContent).toBe(t('txImport.badge.possible'));
    importBtn().click();
    await flush();
    expect(added().slice(1).map(x => x.payee)).toEqual(['Employer', 'K-Market']);
  });
});

describe('the same account rule for signs', () => {
  it('a row is a duplicate only of a transaction that moved the same account the same way', async () => {
    // A -12.50 checking row matches neither the savings expense (other account)
    // nor an income of the same size (other direction).
    state.transactions = [
      { id: 'y1', type: 'income', date: '2026-09-03', payee: 'Refund', amount: 12.5, account: 'chk', status: 'posted' },
      existing[1],
    ];
    await openWithCsv('Date,Payee,Amount\n2026-09-03,K-Market,-12.50');
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    expect(badges()).toEqual([t('txImport.badge.none')]);
  });
});

describe('closing balance check', () => {
  const importWithBalance = async (balance) => {
    await openWithCsv();
    pickAccount('chk');
    const input = [...sheet().querySelectorAll('input[type="text"]')].at(-1);
    setValue(input, balance, ['input']);
    reviewBtn().click();
    await flush();
    button(t('statementReview.continue')).click();
    await flush();
    importBtn().click();
    await flush();
  };

  it('says so when the account now agrees with the statement', async () => {
    // 1000 opening - 45.20 (already there) + 2000 - 12.50 - 700
    await importWithBalance('2242.30');
    expect(toastTexts()).toContain(t('txImport.balanceMatch')(fmt(2242.3)));
  });

  it('offers Reconcile when it does not, and writes no adjustment', async () => {
    await importWithBalance('2000');
    expect(topOverlay().textContent).toContain(fmt(2242.3));
    expect(dialogButton(t('txImport.balanceLater'))).toBeTruthy();
    expect(dialogOk().textContent).toBe(t('txImport.balanceOpenReconcile'));
    expect(state.transactions.some(x => x.type === 'adjustment')).toBe(false);
  });

  it('checks nothing when the field is left blank', async () => {
    await openWithCsv();
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    importBtn().click();
    await flush();
    expect(toastTexts()).toEqual([t('txImport.success')(3)]);
  });
});

describe('CSV templates', () => {
  it('saving a template stores the mapping, separator and account in the meta', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'My bank'));
    await openWithCsv();
    pickAccount('chk');
    button(t('txImport.saveTemplate')).click();
    await flush();
    const [tpl] = savedMeta().csvTemplates;
    expect(tpl).toMatchObject({
      name: 'My bank', separator: ',', amountMode: 'single',
      dateCol: 0, payeeCol: 1, amountCol: 2, defaultAccountId: 'chk',
    });
    expect(toastTexts()).toContain(t('txImport.templateSaved'));
  });

  it('a saved template is offered, loads its mapping and account, and can be deleted', async () => {
    state.meta = { csvTemplates: [
      { id: 'tpl1', name: 'Other bank', separator: ';', amountMode: 'debitcredit', dateCol: 0, payeeCol: 1, amountCol: -1, debitCol: 2, creditCol: 3, defaultAccountId: 'sav' },
    ] };
    openImportSheet(state);
    // The file's own headers mean nothing to the detector; the template supplies the mapping.
    await pick(csvFile('a;b;c;d\n01.09.2026;X;5,00;'));
    button(t('txImport.loadTemplate')).click();
    expect(selectAfterLabel(t('txImport.account')).value).toBe('sav');
    expect(selectAfterLabel(t('txImport.debitCol')).value).toBe('2');
    expect(selectAfterLabel(t('txImport.creditCol')).value).toBe('3');

    button(t('txImport.deleteTemplate')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(savedMeta().csvTemplates).toEqual([]);
  });
});

describe('closing', () => {
  it('discarding a loaded file asks first; an empty sheet closes at once', async () => {
    openImportSheet(state);
    button(t('txImport.cancel')).click();
    await flush();
    expect(sheetIsOpen()).toBe(false);

    mountHosts();
    await openWithCsv();
    button(t('txImport.cancel')).click();
    await flush();
    expect(sheetIsOpen()).toBe(true);
    expect(topOverlay().textContent).toContain(t('common.discardConfirm'));
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('a document read by the model (AI on)', () => {
  const pdf = () => new File(['%PDF'], 'statement.pdf', { type: 'application/pdf' });

  beforeEach(() => {
    isAiAvailable.mockReturnValue(true);
  });

  it('a missing API key says only that, and does not blame the file', async () => {
    parseFileWithAi.mockRejectedValue(Object.assign(new Error('412 Precondition Failed'), { code: 'no_user_api_key', status: 412 }));
    openImportSheet(state);
    await pick(pdf());
    await flush();
    expect(topOverlay().textContent).toContain(t('ai.error.noUserApiKey'));
    expect(topOverlay().textContent).not.toContain(t('txImport.ai.readFailed'));
    expect(topOverlay().textContent).not.toContain('412');
  });

  it('reads the rows, categorizes only the ones not already in the budget, and writes what is approved', async () => {
    parseFileWithAi.mockResolvedValue({
      rows: [
        { date: '2026-09-01', payee: 'Lidl', amount: -45.2 },
        { date: '2026-09-05', payee: 'Cafe', amount: -8 },
      ],
      declaredTotal: null, skipped: 0,
    });
    categorizeRows.mockResolvedValue([
      { index: 0, type: 'expense', account_id: 'chk', envelope_id: 'fun', confidence: 0.9, rationale: 'coffee' },
    ]);
    openImportSheet(state);
    await pick(pdf());
    await flush();

    expect(parseFileWithAi).toHaveBeenCalledTimes(1);
    // Lidl is already in the budget (the matcher falls back to a type check when no
    // account is picked), so only Cafe is sent for categorizing.
    expect(categorizeRows).toHaveBeenCalledTimes(1);
    expect(categorizeRows.mock.calls[0][0].map(r => r.payee)).toEqual(['Cafe']);
    // The prompt's today is the app's clock, not the wall clock.
    expect(categorizeRows.mock.calls[0][1].clock()).toEqual(FIXED_NOW);

    const approve = sheet().querySelector('.proposal-actions .btn-accent');
    approve.click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions.slice(0, existing.length)).toEqual(existing);
    expect(added()).toHaveLength(1);
    expect(added()[0]).toMatchObject({
      type: 'expense', date: '2026-09-05', payee: 'Cafe', amount: 8, account: 'chk', envelope_id: 'fun', source: 'statement',
    });
    expect(state.transactions.filter(x => x.payee === 'Lidl')).toHaveLength(1);
    expect(toastTexts()).toContain(t('txImport.success')(1));
    expect(sheetIsOpen()).toBe(false);
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('transactions');
  });

  it('a refused write shows the reason in the review and lets the user approve again', async () => {
    parseFileWithAi.mockResolvedValue({
      rows: [{ date: '2026-09-05', payee: 'Cafe', amount: -8 }],
      declaredTotal: null, skipped: 0,
    });
    categorizeRows.mockResolvedValue([
      { index: 0, type: 'expense', account_id: 'chk', envelope_id: 'fun', confidence: 0.9, rationale: 'coffee' },
    ]);
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    openImportSheet(state);
    await pick(pdf());
    await flush();

    const approve = sheet().querySelector('.proposal-actions .btn-accent');
    approve.click();
    await flush();

    expect(sheet().querySelector('.import-review-status').textContent).toBe(failText('disk full'));
    expect(state.transactions).toEqual(existing);
    expect(approve.disabled).toBe(false);
    expect(sheetIsOpen()).toBe(true);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();

    approve.click();
    await flush();
    expect(added()).toHaveLength(1);
    expect(toastTexts()).toContain(t('txImport.success')(1));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('a document with nothing readable says so and returns to the picker', async () => {
    parseFileWithAi.mockResolvedValue({ rows: [], declaredTotal: null, skipped: 0 });
    openImportSheet(state);
    await pick(pdf());
    await flush();
    expect(topOverlay().textContent).toContain(t('txImport.ai.nothingFound'));
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a failed read shows the reason', async () => {
    parseFileWithAi.mockRejectedValue(new Error('rate limited'));
    openImportSheet(state);
    await pick(pdf());
    await flush();
    expect(topOverlay().textContent).toContain('rate limited');
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('without a key a PDF is refused before anything is read', async () => {
    isAiAvailable.mockReturnValue(false);
    openImportSheet(state);
    await pick(pdf());
    expect(topOverlay().textContent).toContain(t('ai.error.noUserApiKey'));
    expect(parseFileWithAi).not.toHaveBeenCalled();
  });
});

// ── UX 2026-10-05 ───────────────────────────────────────────────────────────

describe('envelopes from payee history, notes, unreadable rows (UX 2026-10-05)', () => {
  const envOf = (payee) => tableRows().find(tr => tr.children[2].textContent === payee)?.querySelector('select.import-env');

  it('a new row defaults to its payee\'s envelope, shown in the review and editable before import', async () => {
    state.transactions = [...existing,
      { id: 'h1', type: 'expense', date: '2026-08-03', payee: 'k-market', amount: 9, account: 'chk', envelope_id: 'food', status: 'posted' },
      { id: 'h2', type: 'expense', date: '2026-08-04', payee: 'Rent Co', amount: 700, account: 'chk', envelope_id: 'fun', status: 'posted' }];
    existing = state.transactions;
    await openWithCsv();
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    expect(envOf('K-Market').value).toBe('food');
    expect(envOf('Rent Co').value).toBe('fun');
    // No history for the employer: unassigned. A duplicate shows its match instead.
    expect(envOf('Employer').value).toBe('');
    expect(envOf('Lidl')).toBeNull();
    // The user corrects one before importing.
    setValue(envOf('Rent Co'), 'food', ['change']);
    importBtn().click();
    await flush();
    expect(added().map(x => [x.payee, x.envelope_id])).toEqual([
      ['Rent Co', 'food'], ['Employer', null], ['K-Market', 'food'],
    ]);
  });

  it('imports the message and archive id of an OP export into the note', async () => {
    await openWithCsv([
      'Kirjauspäivä;Arvopäivä;Määrä EUROA;Laji;Selitys;Saaja/Maksaja;Saajan tilinumero;Viite;Viesti;Arkistointitunnus',
      '05.09.2026;05.09.2026;-564,70;101;Tilisiirto;Vastike Oy;FI1234;;Vastike syyskuu;20260905/001',
    ].join('\n'));
    expect(sheet().querySelector('.import-note-cols').textContent)
      .toBe(t('txImport.noteCols')('Viesti, Selitys, Arkistointitunnus, Viite'));
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    importBtn().click();
    await flush();
    expect(added()[0]).toMatchObject({ payee: 'Vastike Oy', note: 'Vastike syyskuu · Tilisiirto · Arkistointitunnus 20260905/001' });
  });

  it('says when the chosen payee column is empty', async () => {
    await openWithCsv([
      'Kirjauspäivä;Määrä;Maksaja;Maksunsaaja;Nimi',
      '2026/09/05;-112,95;;;Claude Max',
    ].join('\n'));
    // Detection picks "Nimi", which has the names: no warning.
    expect(selectAfterLabel(t('txImport.payeeCol')).selectedOptions[0].textContent).toBe('[4] Nimi');
    expect(sheet().querySelector('.import-payee-empty').hidden).toBe(true);
    setValue(selectAfterLabel(t('txImport.payeeCol')), '3', ['change']);
    expect(sheet().querySelector('.import-payee-empty').hidden).toBe(false);
    expect(sheet().querySelector('.import-payee-empty').textContent).toBe(t('txImport.payeeColEmpty'));
  });

  it('lists the rows that could not be read, by line and reason', async () => {
    await openWithCsv([
      'Kirjauspäivä;Määrä',
      '05.09.2026;abc',
      ';;;;',
      '31.02.2026;-5,00',
      '06.09.2026;-7,00',
    ].join('\n'));
    const items = () => [...sheet().querySelectorAll('.import-problems li')].map(li => li.textContent);
    expect(items()).toEqual([
      t('txImport.rowProblem')({ line: 2, reason: 'amount', value: 'abc' }),
      t('txImport.rowProblem')({ line: 4, reason: 'date', value: '31.02.2026' }),
    ]);
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    expect(items()).toHaveLength(2);
  });

  it('with no readable row, Review stays disabled', async () => {
    await openWithCsv('Kirjauspäivä;Määrä\n05.09.2026;abc');
    pickAccount('chk');
    expect(reviewBtn().disabled).toBe(true);
    expect(sheet().textContent).toContain(t('txImport.parseErrors')(1));
  });

  it('a file that is not a CSV says so instead of showing nothing', async () => {
    await openWithCsv('this is not csv at all\u0000\u0001');
    expect(sheet().querySelector('.import-file-problem').textContent).toBe(t('txImport.notCsv'));
    expect(selects()).toHaveLength(0);
    expect(reviewBtn().disabled).toBe(true);
  });

  it('a CSV whose AI suggestions fail still imports through the plain review, envelopes from history', async () => {
    isAiAvailable.mockReturnValue(true);
    categorizeRows.mockRejectedValue(new Error('412 Precondition Failed'));
    state.transactions = [...existing,
      { id: 'h1', type: 'expense', date: '2026-08-03', payee: 'K-Market', amount: 9, account: 'chk', envelope_id: 'food', status: 'posted' }];
    existing = state.transactions;
    await openWithCsv();
    pickAccount('chk');
    reviewBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('txImport.ai.categorizeFailed'));
    dialogOk().click();
    await flush();
    expect(envOf('K-Market').value).toBe('food');
    importBtn().click();
    await flush();
    expect(added().find(x => x.payee === 'K-Market').envelope_id).toBe('food');
  });

  it('an empty file says so', async () => {
    await openWithCsv('');
    expect(sheet().querySelector('.import-file-problem').textContent).toBe(t('txImport.emptyFile'));
  });
});

describe('explainable import rules', () => {
  const savedRule = { id: 'rule1', name: 'Market groceries', enabled: true,
    conditions: { merchant: 'K-Market', operator: 'equals', direction: 'expense', account: 'chk' }, actions: { payee: 'Market', envelope: 'food' } };
  it.each([false,true])('uses the same explicit rule in the AI=%s path', async ai => {
    state.meta = { schemaVersion: 8, importRules: [savedRule] };
    isAiAvailable.mockReturnValue(ai);
    categorizeRows.mockResolvedValue([{type:'expense',envelope_id:'fun',account_id:'chk',confidence:1}]);
    await openWithCsv('Date,Payee,Amount\n2026-09-04,K-Market,-12.50');
    pickAccount('chk'); reviewBtn().click(); await flush();
    expect(sheet().textContent).toContain('Market groceries');
    expect(sheet().textContent).toContain(t('importRules.manage'));
    importBtn().click(); await flush();
    expect(added()).toHaveLength(1);
    expect(added()[0]).toMatchObject({payee:'Market',envelope_id:'food',amount:12.5,account:'chk'});
    expect(added()[0]).not.toHaveProperty('importSource');
  });
  it.each([false,true])('blocks a conflict until the user explicitly chooses an envelope (AI=%s)', async ai => {
    isAiAvailable.mockReturnValue(ai);
    categorizeRows.mockResolvedValue([{type:'expense',envelope_id:'fun',account_id:'chk',confidence:1}]);
    state.meta = { schemaVersion: 8, importRules: [savedRule,{...savedRule,id:'rule2',actions:{envelope:'fun'}}] };
    await openWithCsv('Date,Payee,Amount\n2026-09-04,K-Market,-12.50');
    pickAccount('chk'); reviewBtn().click(); await flush();
    expect(importBtn().disabled).toBe(true);
    const choose = [...sheet().querySelectorAll('.import-rule-conflict button')].find(b=>b.textContent==='Food');
    choose.click(); expect(importBtn().disabled).toBe(false);
    importBtn().click(); await flush(); expect(added()[0].envelope_id).toBe('food');
  });
  it.each([false,true])('an exact duplicate included later must resolve rules (AI=%s)', async ai => {
    state.meta = {schemaVersion:8,importRules:[{...savedRule,conditions:{...savedRule.conditions,merchant:'Lidl'}},{...savedRule,id:'b',conditions:{...savedRule.conditions,merchant:'Lidl'},actions:{envelope:'fun'}}]};
    isAiAvailable.mockReturnValue(ai);
    await openWithCsv('Date,Payee,Amount\n2026-09-01,Lidl,-45.20');
    pickAccount('chk'); reviewBtn().click(); await flush();
    if (ai) { const include=sheet().querySelector('.prow-include'); include.click(); }
    else tableRows()[0].click();
    await flush();
    expect(importBtn().disabled).toBe(true);
    expect(sheet().querySelector('.import-rule-conflict')).not.toBeNull();
    [...sheet().querySelectorAll('.import-rule-conflict button')].find(b=>b.textContent==='Food').click();
    importBtn().click(); await flush();
    expect(added()).toHaveLength(1);
    expect(added()[0]).toMatchObject({payee:'Market',envelope_id:'food',amount:45.2});
  });
  it('uses a single alias lookup when completing an initially excluded AI transfer', async () => {
    state.meta={schemaVersion:8,payeeAliases:{alpha:'Beta',beta:'Gamma'}};
    isAiAvailable.mockReturnValue(true);
    categorizeRows.mockResolvedValue([{type:'account_transfer',account_id:'chk',counter_account:null,confidence:1}]);
    await openWithCsv('Date,Payee,Amount\n2026-09-04,Alpha,-12.50');
    pickAccount('chk'); reviewBtn().click(); await flush();
    const counterpart=sheet().querySelector('select[aria-label="'+t('ai.proposal.transferTo')+'"]');
    setValue(counterpart,'sav',['change']);
    expect(sheet().querySelector('.prow-payee').textContent).toBe('Beta');
    importBtn().click(); await flush();
    expect(added()).toHaveLength(1);
    expect(added()[0].payee).toBe('Beta');
  });
  it('keeps an explicitly saved rule after cancelling its parent import', async () => {
    state.meta = {schemaVersion:8};
    await openWithCsv('Date,Payee,Amount\n2026-09-04,K-Market,-12.50');
    pickAccount('chk'); reviewBtn().click(); await flush();
    setValue(sheet().querySelector('select.import-env'),'food',['change']);
    button(t('importRules.remember')).click(); await flush();
    const editor=document.querySelector('[data-sheet-open] .import-rule-editor');
    [...editor.closest('.sheet').querySelectorAll('button')].find(b=>b.textContent===t('common.save')).click();
    await flush();
    expect(state.meta.importRules).toHaveLength(1);
    button(t('txImport.cancel')).click(); await flush();
    if (document.querySelector('.dialog-overlay')) { dialogOk().click(); await flush(); }
    expect(state.meta.importRules).toHaveLength(1);
    expect(added()).toEqual([]);
  });
  it('requires another approval after aliases change while reviewing', async () => {
    state.meta = { schemaVersion:8,importRules:[savedRule] };
    await openWithCsv('Date,Payee,Amount\n2026-09-04,K-Market,-12.50');
    pickAccount('chk'); reviewBtn().click(); await flush();
    state.meta = {...state.meta,payeeAliases:{market:'Final market','final market':'Do not chain'}};
    importBtn().click(); await flush(); expect(added()).toEqual([]);
    expect(sheet().textContent).toContain(t('coreError.import_review_changed'));
    importBtn().click(); await flush(); expect(added()[0].payee).toBe('Final market');
  });
});
