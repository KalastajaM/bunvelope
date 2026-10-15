// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { state, writeBatch, resetState, mountHosts, flush, session } from './_fakes/pageApp.js';
import { openEnvelopeFunding } from '../js/pages/envelope-funding.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { notifyStateChanged } from '../js/state/events.js';
import { t } from '../js/ui/i18n.js';
const btn = key => [...document.querySelectorAll('.envelope-funding button')].find(b => b.textContent === t(key));
const choose = () => document.querySelector('.funding-source input');
async function preview() {
  openEnvelopeFunding('food');
  await vi.waitFor(() => expect(choose()).toBeTruthy()); choose().click(); btn('funding.preview').click();
  await vi.waitFor(() => expect(document.querySelector('.funding-effects h4')).not.toBeNull());
}
beforeEach(() => {
  resetState(); mountHosts(); beginBudgetSession();
  state.meta = { schemaVersion: 8 };
  state.accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }];
  state.envelopes = [{ id: 'food', name: 'Food' }, { id: 'fun', name: 'Fun' }];
  state.transactions = [
    { id: 'fill', type: 'fill', status: 'posted', date: '2026-09-01', lines: [{ envelope_id: 'food', mode: 'add', amount: 50 }, { envelope_id: 'fun', mode: 'add', amount: 200 }] },
    { id: 'bill', type: 'expense', amount: 100, envelope_id: 'food', account: 'bank', date: '2026-09-20', status: 'scheduled' },
  ];
});
describe('envelope funding sheet', () => {
  it('does not write during suggestions or preview, then saves one transfer and supports Undo', async () => {
    const before = structuredClone(state.transactions);
    await preview();
    expect(state.transactions).toEqual(before); expect(writeBatch).not.toHaveBeenCalled();
    expect(btn('funding.apply').disabled).toBe(false);
    const dispatch = vi.spyOn(session, 'dispatchBatch');
    btn('funding.apply').click();
    await vi.waitFor(() => expect(state.transactions).toHaveLength(3));
    expect(state.transactions.at(-1)).toMatchObject({ type: 'envelope_transfer', amount: 50, date: '2026-09-15' });
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const result = await dispatch.mock.results[0].value;
    await session.undo(result.value.undo);
    expect(state.transactions).toEqual(before); dispatch.mockRestore();
  });
  it('combines selections, invalidates old previews, and saves and undoes the group atomically', async () => {
    state.envelopes.push({ id: 'travel', name: 'Travel' });
    state.transactions[0].lines.push({ envelope_id: 'travel', mode: 'add', amount: 100 });
    const before = structuredClone(state.transactions);
    await preview();
    const second = document.querySelector('input[aria-label="Travel"]');
    second.click();
    expect(btn('funding.apply').disabled).toBe(true);
    expect(document.querySelector('.funding-effects').textContent).toBe('');
    btn('funding.preview').click();
    await vi.waitFor(() => expect(btn('funding.apply').disabled).toBe(false));
    expect(document.querySelectorAll('.funding-contribution')).toHaveLength(2);
    expect(document.querySelector('.funding-selection').textContent).toBe('2 envelopes selected');
    expect(writeBatch).not.toHaveBeenCalled();
    const dispatch = vi.spyOn(session, 'dispatchBatch');
    btn('funding.apply').click();
    await vi.waitFor(() => expect(state.transactions).toHaveLength(4));
    expect(state.transactions.slice(-2).map(t => t.amount)).toEqual([33.33, 16.67]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const result = await dispatch.mock.results[0].value;
    await session.undo(result.value.undo);
    expect(state.transactions).toEqual(before); dispatch.mockRestore();
  });
  it('disables preview and apply when the last source is deselected', async () => {
    await preview(); choose().click();
    expect(btn('funding.preview').disabled).toBe(true);
    expect(btn('funding.apply').disabled).toBe(true);
    expect(document.querySelector('.funding-effects').textContent).toBe('');
  });
  it('prevents double submission', async () => {
    await preview(); const apply = btn('funding.apply'); apply.click(); apply.click(); await flush();
    await vi.waitFor(() => expect(writeBatch).toHaveBeenCalledTimes(1));
    expect(state.transactions).toHaveLength(3);
  });
  it.each([false, true])('invalidates budget changes before saving (notified: %s)', async notify => {
    await preview(); const apply = btn('funding.apply');
    state.transactions = state.transactions.map(tx => tx.id === 'fill' ? { ...tx, lines: tx.lines.map(l => l.envelope_id === 'fun' ? { ...l, amount: 0 } : l) } : tx);
    if (notify) notifyStateChanged('transactions');
    apply.click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(t('funding.stale'));
    expect(btn('funding.apply').disabled).toBe(true);
  });
  it('requires a new preview after save failure and leaves the budget unchanged', async () => {
    await preview(); const before = structuredClone(state.transactions);
    writeBatch.mockRejectedValueOnce(new Error('disk full')); btn('funding.apply').click(); await flush();
    expect(state.transactions).toEqual(before);
    expect(btn('funding.apply').disabled).toBe(true);
    expect(document.querySelector('.sheet-overlay.open')).not.toBeNull();
  });
  it('rechecks after an earlier queued write changes the approved source', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = session.dispatch('transaction.record', { type: 'expense', amount: 160, envelope: 'fun', account: 'bank', date: '2026-09-15' });
    await vi.waitFor(() => expect(writeBatch).toHaveBeenCalledTimes(1));
    await preview();
    btn('funding.apply').click();
    release(); await pending; await flush();
    await vi.waitFor(() => expect(document.body.textContent).toContain(t('funding.stale')));
    expect(state.transactions.filter(tx => tx.type === 'envelope_transfer')).toHaveLength(0);
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });
  it('closes at a budget switch and refuses stale writes', async () => {
    await preview(); const apply = btn('funding.apply'); beginBudgetSession(); apply.click(); await flush();
    expect(writeBatch).not.toHaveBeenCalled(); expect(document.querySelector('.sheet-overlay.open')).toBeNull();
  });
  it('shows a blocked indirect refill effect and never enables apply', async () => {
    state.envelopes.push({ id: 'third', name: 'Third' });
    state.transactions[0].lines.push({ envelope_id: 'third', mode: 'add', amount: 25 });
    state.envelopeTemplates = [{ id: 'refill', name: 'Refill source', lines: [{ envelope_id: 'fun', mode: 'set', amount: 200 }],
      schedule: { enabled: true, payment_day: 1, months: { Oct: true }, since: '2026-09-01', source_envelope_id: 'third' } }];
    await preview();
    expect(btn('funding.apply').disabled).toBe(true);
    expect(document.body.textContent).toContain(t('funding.blocked'));
    expect(document.body.textContent).toContain(t('funding.blockers.reserve'));
    expect(writeBatch).not.toHaveBeenCalled();
  });
});
