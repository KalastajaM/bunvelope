// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { openEditTx } from '../js/pages/edit-tx.js';
import { openTransactionReversal } from '../js/ui/transaction-reversal.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { t, fmtDateLang } from '../js/ui/i18n.js';
import { state, session, writeBatch, resetState, mountHosts, flush, setValue } from './_fakes/pageApp.js';
const top = () => [...document.querySelectorAll('[data-sheet-open]')].at(-1);
const button = key => [...top().querySelectorAll('button')].find(b => b.textContent === t(key));
const original = (over = {}) => ({ id: 'original', type: 'expense', date: '2026-09-03', payee: 'Shop', amount: 20,
  account: 'chk', envelope_id: 'food', status: 'posted', ...over });
beforeEach(() => { resetState({ transactions: [original()] }); mountHosts(); vi.stubGlobal('requestAnimationFrame', cb => setTimeout(cb, 0)); });
afterEach(() => vi.restoreAllMocks());
const open = async () => { openEditTx(state.transactions[0]); button('reversal.title').click(); await flush(); };

describe('browser reversal', () => {
  it('previews without writing, confirms once, and links both sides of the correction', async () => {
    const dispatch = vi.spyOn(session, 'dispatch');
    await open();
    // Dated today (the fixed clock, 15 Sep), not the original's 3 Sep.
    expect(dispatch).toHaveBeenCalledWith('transaction.reverse', { id: 'original', date: '2026-09-15' }, { dryRun: true });
    expect(writeBatch).not.toHaveBeenCalled();
    expect(top().querySelectorAll('.reversal-row')).toHaveLength(1);
    expect(top().querySelector('.reversal-row').textContent).toContain('Food');
    const confirm = button('reversal.confirm'); confirm.click(); confirm.click(); await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(2);
    expect(state.transactions[1]).toMatchObject({ type: 'income', date: '2026-09-15', reverses: 'original' });
    expect(state.transactions[0].reversed_by).toBe(state.transactions[1].id);
    button('reversal.counterpart').click(); await flush();
    expect(button('reversal.original')).toBeTruthy();
  });
  it('says what it will add: the rows, their date, and that a reversed expense is income', async () => {
    await open();
    const summary = top().querySelector('.reversal-summary').textContent;
    expect(summary).toContain(t('reversal.willCreate')(1, fmtDateLang('2026-09-15')));
    expect(summary).toContain(t('reversal.expenseAsIncome'));
    // Editing the date drops the summary with the preview until it is checked again.
    setValue(top().querySelector('[name="reversal-date"]'), '2026-09-20');
    expect(top().querySelector('.reversal-summary').textContent).toBe('');
  });
  it('a reversed income says it is recorded as an expense', async () => {
    state.transactions = [original({ type: 'income' })];
    await open();
    expect(top().querySelector('.reversal-summary').textContent).toContain(t('reversal.incomeAsExpense'));
  });
  it('never defaults to a date before the original', async () => {
    state.transactions = [original({ date: '2026-09-20' })];
    const dispatch = vi.spyOn(session, 'dispatch');
    await open();
    expect(dispatch).toHaveBeenCalledWith('transaction.reverse', { id: 'original', date: '2026-09-20' }, { dryRun: true });
  });
  it('requires a new preview after editing the date and keeps strict-ledger refusals', async () => {
    state.meta.policies = ['strict-ledger'];
    await open();
    setValue(top().querySelector('[name="reversal-date"]'), '2026-09-20');
    expect(button('reversal.confirm').disabled).toBe(true);
    button('reversal.preview').click(); await flush();
    expect(top().querySelector('.reversal-error').textContent).toContain('Strict ledger');
    expect(button('reversal.confirm').disabled).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('uses an explicitly previewed replacement date', async () => {
    await open();
    setValue(top().querySelector('[name="reversal-date"]'), '2026-09-12');
    button('reversal.preview').click(); await flush();
    button('reversal.confirm').click(); await flush();
    expect(state.transactions[1].date).toBe('2026-09-12');
  });
  it.each([
    { envelope_splits: [{ envelope_id: 'food', amount: 20 }] },
    { type: 'fill', lines: [{ envelope_id: 'food', mode: 'set', amount: 20 }] },
    { type: 'investment_transfer', direction: 'dividend' },
    { type: 'investment_transfer', direction: 'adjust' },
    { status: 'scheduled' },
    { reversed_by: 'existing' },
  ])('shows the command refusal without offering a write: %j', async (over) => {
    state.transactions = [original(over)];
    openTransactionReversal(state.transactions[0], { isCurrent: () => true, onCommitted: vi.fn() });
    await flush();
    expect(top().querySelector('.reversal-error').textContent).not.toBe('');
    expect(button('reversal.confirm').disabled).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('requires renewed review when the original changes after preview', async () => {
    await open();
    state.transactions = [original({ amount: 30 })];
    button('reversal.confirm').click(); await flush();
    expect(top().querySelector('.reversal-error').textContent).toBe(t('reversal.changed'));
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('never applies an old preview to another budget, even with the same folder and id', async () => {
    await open(); beginBudgetSession();
    button('reversal.confirm').click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('respects the existing closed-month confirmation', async () => {
    state.meta.closed_months = ['2026-09'];
    await open(); button('reversal.confirm').click(); await flush();
    expect(top().textContent).toContain(t('closedPeriod.title'));
    button('common.cancel').click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('leaves a failed write available for retry', async () => {
    await open(); writeBatch.mockRejectedValueOnce(new Error('offline'));
    button('reversal.confirm').click(); await flush();
    expect(state.transactions).toHaveLength(1);
    expect(button('reversal.confirm').disabled).toBe(false);
    button('reversal.confirm').click(); await flush();
    expect(state.transactions).toHaveLength(2);
  });
});
