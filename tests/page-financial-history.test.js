// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { openChangeLogSheet } from '../js/change-log-sheet.js';
import { state, session, resetState, mountHosts } from './_fakes/pageApp.js';
import { t } from '../js/ui/i18n.js';
beforeEach(() => {
  resetState(); mountHosts();
  state.accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }];
  state.envelopes = [{ id: 'food', name: 'Food' }]; state.transactions = [];
});
describe('complete financial changelog', () => {
  it('shows additions, edits, deletion and non-transaction changes from automatic revisions', async () => {
    await session.dispatch('transaction.record', { type: 'expense', amount: 25, date: '2026-09-15', account: 'bank', envelope: 'food', payee: 'History coffee' });
    const id = state.transactions[0].id;
    await session.dispatch('account.update', { id: 'bank', fields: { name: 'Renamed bank' } });
    expect((await session.dispatch('transaction.amend', { id, amount: 30 })).ok).toBe(true);
    expect((await session.dispatch('transaction.delete', { ids: [id] })).ok).toBe(true);
    openChangeLogSheet();
    const sheet = document.querySelector('.sheet');
    expect(sheet.textContent).toContain(t('numberChanges.historyTitle'));
    expect(sheet.textContent).toContain('Added · History coffee');
    expect(sheet.textContent).toContain('Edited · History coffee');
    expect(sheet.textContent).toContain('Removed · History coffee');
    expect(sheet.textContent).toContain('Edited · Renamed bank');
    expect(sheet.querySelectorAll('.number-changes-step')).toHaveLength(4);
    expect(state.meta.financialHistory.entries).toHaveLength(4);
  });
});
