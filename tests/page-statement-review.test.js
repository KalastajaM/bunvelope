// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/ai/client.js', async original => ({ ...(await original()), isAiAvailable: () => false }));
import { openImportSheet } from '../js/import/import-sheet.js';
import { state, resetState, mountHosts, flush, setValue, writeBatch, toastTexts } from './_fakes/pageApp.js';
import { t } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
const sheet = () => [...document.querySelectorAll('#sheet-host .sheet')].at(-1);
const click = label => [...sheet().querySelectorAll('button')].find(b => b.textContent === label).click();
let staged;
beforeEach(() => { resetState(); mountHosts(); staged = []; writeBatch.mockClear(); });
async function open(text, transactions = []) {
  state.transactions = transactions;
  openImportSheet(state, { reconcile: { accountId: 'chk', isActive: () => true,
    getTransactions: () => state.transactions, getBalanceTarget: () => ({ target: 988, date: '2026-09-15' }),
    onStage: rows => staged.push(...rows) } });
  const input = sheet().querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [new File([text], 'bank.csv', { type: 'text/csv' })] });
  input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
  click(t('reconcile.stageImport')); await flush();
}
describe('statement import review', () => {
  it('updates the main remaining difference when pending rows are checked and unchecked', async () => {
    await open('Date,Text,Amount,Status,Account\n2026-09-04,Reservation,-12,Pending,Checking');
    const remaining = () => sheet().querySelector('.statement-review-balance strong').textContent;
    expect(remaining()).toContain(fmt(-12, { signed: true }));
    sheet().querySelector('[data-group="pending"] input').click();
    expect(remaining()).toContain(fmt(0, { signed: true }));
    sheet().querySelector('[data-group="pending"] input').click();
    expect(remaining()).toContain(fmt(-12, { signed: true }));
  });
  it('stages only missing rows by default, collapsing recorded and pending rows and offering bulk review', async () => {
    await open('Date,Text,Amount,Status,Account\n2026-09-02,Shop,-5,Executed,Checking\n2026-09-03,Other name,-7,Executed,Checking\n2026-09-04,New,-12,Executed,Checking\n2026-09-04,Reservation,-9,Pending,Checking', [
      { id: 'a', date: '2026-09-02', type: 'expense', account: 'chk', payee: 'Shop', amount: 5 },
      { id: 'b', date: '2026-09-03', type: 'expense', account: 'chk', payee: 'Old name', amount: 7 },
    ]);
    expect(staged).toEqual([]);
    expect(sheet().querySelector('[data-group="recorded"]').open).toBe(false);
    expect(sheet().querySelector('[data-group="pending"]').open).toBe(false);
    expect(sheet().querySelector('[data-group="review"]').textContent).toContain('Old name');
    click(t('statementReview.continue')); await flush();
    expect(staged.map(r => r.payee)).toEqual(['New']);
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('lets a user restore an exact match explicitly instead of silently discarding it again', async () => {
    await open('Date,Text,Amount,Account\n2026-09-02,Shop,-5,Checking', [
      { id: 'a', date: '2026-09-02', type: 'expense', account: 'chk', payee: 'Shop', amount: 5 },
    ]);
    sheet().querySelector('[data-group="recorded"] input[type="checkbox"]').click();
    click(t('statementReview.continue')); await flush();
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ payee: 'Shop', amount: 5 });
  });
  it('updates the gap as selections change and makes choosing the suggested combination explicit', async () => {
    await open('Date,Text,Amount,Account\n2026-09-02,A,-5,Checking\n2026-09-03,B,-7,Checking\n2026-09-04,C,-20,Checking');
    expect(sheet().querySelector('.statement-review-balance').textContent).toContain(fmt(20, { signed: true }));
    click(t('statementReview.useSuggestion'));
    click(t('statementReview.continue')); await flush();
    expect(staged.map(r => r.payee)).toEqual(['A', 'B']);
  });
  it('blocks rows past the balance date until that date is changed', async () => {
    await open('Date,Text,Amount,Account\n2026-09-20,Later,-12,Checking');
    expect(sheet().querySelector('.statement-review input[type="checkbox"]').disabled).toBe(true);
    setValue(sheet().querySelector('.statement-review input[type="date"]'), '2026-09-20', ['change']);
    const box = sheet().querySelector('.statement-review input[type="checkbox"]');
    expect(box.disabled).toBe(false); box.click();
    click(t('statementReview.continue')); await flush();
    expect(staged).toHaveLength(1);
  });
  it('refreshes changed ledger matches before allowing reconciliation staging', async () => {
    await open('Date,Text,Amount,Account\n2026-09-02,Shop,-5,Checking');
    state.transactions = [{ id: 'new', account: 'chk', type: 'expense', payee: 'Shop', amount: 5, date: '2026-09-02' }];
    click(t('statementReview.continue')); await flush();
    expect(staged).toEqual([]);
    expect(sheet().textContent).toContain(t('statementReview.changed'));
    expect(sheet().querySelector('[data-group="recorded"] input').checked).toBe(false);
    click(t('statementReview.continue')); await flush();
    expect(staged).toEqual([]);
  });
  it('guards the final import after categorization and reopens statement review when a matching row has appeared', async () => {
    openImportSheet(state);
    const input = sheet().querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['Date,Text,Amount,Status\n2026-09-02,Shop,-5,Executed'], 'bank.csv')] });
    input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    const account = [...sheet().querySelectorAll('.field')].find(f => f.querySelector('label')?.textContent === t('txImport.account')).querySelector('select');
    setValue(account, 'chk', ['change']); click(t('txImport.reviewMatches')); await flush();
    click(t('statementReview.continue')); await flush();
    state.transactions = [{ id: 'new', account: 'chk', type: 'expense', payee: 'Shop', amount: 5, date: '2026-09-02' }];
    click(t('txImport.importBtn')(1)); await flush();
    expect(state.transactions).toHaveLength(1);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().querySelector('[data-group="recorded"]')).not.toBeNull();
    expect(toastTexts()).toContain(t('statementReview.changed'));
  });
  it('uses the reviewed target and date for the final balance check, including later existing transactions', async () => {
    state.transactions = [{ id: 'later', account: 'chk', type: 'expense', payee: 'Later', amount: 10, date: '2026-09-10' }];
    openImportSheet(state);
    const input = sheet().querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['Date,Text,Amount,Status\n2026-09-02,Shop,-5,Executed'], 'bank.csv')] });
    input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
    const account = [...sheet().querySelectorAll('.field')].find(f => f.querySelector('label')?.textContent === t('txImport.account')).querySelector('select');
    setValue(account, 'chk', ['change']); click(t('txImport.reviewMatches')); await flush();
    setValue(sheet().querySelector('.statement-review input[type="date"]'), '2026-09-10', ['change']);
    setValue(sheet().querySelector('.statement-review input[type="text"]'), '985', ['change']);
    click(t('statementReview.continue')); await flush();
    click(t('txImport.importBtn')(1)); await flush();
    expect(toastTexts()).toContain(t('txImport.balanceMatch')(fmt(985)));
    expect(state.transactions).toHaveLength(2);
  });
});
