// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { state, writeBatch, resetState, mountHosts, flush } from './_fakes/pageApp.js';
import { openPurchaseCheck } from '../js/pages/purchase-check.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { t } from '../js/ui/i18n.js';

const btn = key => [...document.querySelectorAll('.purchase-check button')].find(b => b.textContent === t(key));
function enter(amount = '100', date = '2026-09-15') {
  const control = key => document.querySelector(`[aria-label="${t('purchase.' + key)}"]`);
  control('amount').value = amount;
  control('amount').dispatchEvent(new Event('input', { bubbles: true }));
  control('date').value = date;
  control('date').dispatchEvent(new Event('input', { bubbles: true }));
  btn('purchase.check').click();
}
async function ready() { await vi.waitFor(() => expect(document.querySelector('.purchase-results h3')).not.toBeNull()); }
beforeEach(() => {
  resetState(); mountHosts(); beginBudgetSession();
  state.meta = { schemaVersion: 1 };
  state.accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }];
  state.envelopes = [{ id: 'food', name: 'Food' }, { id: 'fun', name: 'Fun' }];
  state.transactions = [
    { id: 'food-fill', type: 'fill', status: 'posted', date: '2026-09-01', lines: [{ envelope_id: 'food', mode: 'add', amount: 50 }] },
    { id: 'fun-fill', type: 'fill', status: 'posted', date: '2026-09-01', lines: [{ envelope_id: 'fun', mode: 'add', amount: 200 }] },
  ];
});
describe('purchase check sheet', () => {
  it('leads with missing repayment information and labels current and projected balances separately', async () => {
    state.accounts.push({ id: 'card', name: 'Mastercard', type: 'credit_card' });
    state.transactions.push({ id: 'future', type: 'expense', account: 'bank', amount: 12724.88, date: '2027-03-01', status: 'scheduled' });
    openPurchaseCheck('food');
    document.querySelector(`[aria-label="${t('purchase.account')}"]`).value = 'card';
    enter('25', '2026-12-31'); await ready();
    expect(document.querySelector('.purchase-summary').textContent).toContain(t('purchase.assessment.incomplete'));
    expect(document.querySelector('.purchase-summary').textContent).toContain(t('purchase.repaymentUnknown'));
    const account = document.querySelector('.purchase-account');
    expect(account.textContent).toContain(t('purchase.current'));
    expect(account.textContent).toContain(t('purchase.impacts.existing'));
    expect(account.querySelector('details').open).toBe(false);
    expect(account.textContent).toContain(t('purchase.forecastWithout'));
    expect(account.textContent).toContain(t('purchase.forecastWith'));
    expect(account.textContent).toContain(t('purchase.movements.spending'));
    expect(account.querySelector('.purchase-warning')).toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('keeps both purchase and funding previews read-only, then writes both in one batch', async () => {
    const original = structuredClone(state.transactions);
    openPurchaseCheck('food'); enter(); await ready();
    expect(writeBatch).not.toHaveBeenCalled(); expect(state.transactions).toEqual(original);
    const move = [...document.querySelectorAll('.purchase-results button')].find(b => b.textContent.startsWith(t('purchase.previewMove')));
    expect(move).toBeTruthy(); move.click(); await ready();
    expect(writeBatch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(btn('purchase.recordBoth')?.disabled).toBe(false));
    btn('purchase.recordBoth').click();
    await vi.waitFor(() => expect(state.transactions).toHaveLength(4));
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions.slice(-2).map(r => r.type)).toEqual(['envelope_transfer', 'expense']);
    expect(state.transactions.at(-1).amount).toBe(100);
  });
  it('schedules a future purchase only after the explicit action, and prevents double submission', async () => {
    openPurchaseCheck(); enter('25', '2026-10-01'); await ready();
    const record = btn('purchase.schedule'); expect(record.disabled).toBe(false);
    record.click(); record.click(); await flush();
    await vi.waitFor(() => expect(state.transactions).toHaveLength(3));
    expect(state.transactions.at(-1)).toMatchObject({ amount: 25, status: 'scheduled', date: '2026-10-01' });
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });
  it('invalidates the assessment when input changes or the budget changes', async () => {
    openPurchaseCheck(); enter('25'); await ready();
    const amount = document.querySelector('[type="number"]'); amount.value = '30'; amount.dispatchEvent(new Event('input', { bubbles: true }));
    expect(btn('purchase.record').disabled).toBe(true);
    btn('purchase.check').click(); await ready();
    state.accounts = [{ ...state.accounts[0], initialBalance: -1000 }];
    btn('purchase.record').click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(t('purchase.recheck'));
  });
  it('does not publish a partial purchase or funding move after a failed save', async () => {
    openPurchaseCheck(); enter(); await ready();
    [...document.querySelectorAll('.purchase-results button')].find(b => b.textContent.startsWith(t('purchase.previewMove'))).click();
    await ready(); await vi.waitFor(() => expect(btn('purchase.recordBoth')?.disabled).toBe(false));
    const original = structuredClone(state.transactions);
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    btn('purchase.recordBoth').click(); await flush();
    expect(state.transactions).toEqual(original);
    expect(document.querySelector('.sheet-overlay.open')).not.toBeNull();
  });
  it('closes after budget switching and refuses stale writes', async () => {
    openPurchaseCheck(); enter('25'); await ready();
    const record = btn('purchase.record'); beginBudgetSession(); record.click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.querySelector('.sheet-overlay.open')).toBeNull();
  });
});
