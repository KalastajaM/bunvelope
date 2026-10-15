// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { state, session, writeBatch, resetState, mountHosts, flush } from './_fakes/pageApp.js';
import { openNumberChanges } from '../js/pages/number-changes.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { t, loadLocale, setLang } from '../js/ui/i18n.js';
import { comparisonSourceTable, comparisonDetailTable } from '../js/pages/number-change-sources.js';

beforeEach(() => {
  resetState(); mountHosts(); beginBudgetSession();
  state.meta = { schemaVersion: 8 };
  state.accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }];
  state.envelopes = [{ id: 'food', name: 'Food' }];
});
describe('number changes sheet', () => {
  it('distinguishes interest rates from exchange rates in Finnish details', async () => {
    await loadLocale('fi'); setLang('fi');
    try {
      const table = comparisonDetailTable({ details: [
        { path: ['interestRates', '0', 'rate'], before: 3, after: 4, format: 'text' },
        { path: ['prices', 'ABC', 'fx', 'rate'], before: 1.1, after: 1.2, format: 'text' },
      ] });
      const headings = [...table.querySelectorAll('tbody th')].map(node => node.textContent);
      expect(headings[0]).toBe('Korot · 1 · Korko');
      expect(headings[1]).toContain('Vaihtokurssi');
    } finally { setLang('en'); }
  });
  it('opens removed records as historical details and preserves price precision and currency', () => {
    const source = { id: 'deleted', name: 'Removed holding', kind: 'removed', details: [
      { path: ['price'], before: 1.001, after: 1.004, format: 'price', beforeCurrency: 'USD', afterCurrency: 'USD' },
    ] };
    const table = comparisonSourceTable({ group: 'transactions', sources: [source] }, vi.fn());
    document.body.append(table); table.querySelector('button').click();
    expect(document.querySelector('.number-changes-record').textContent).toContain(t('numberChanges.removedRecord'));
    expect(document.querySelector('.number-changes-record').textContent).toMatch(/1[,.]001 USD/);
    expect(document.querySelector('.number-changes-record').textContent).toMatch(/1[,.]004 USD/);
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('initializes automatically, offers a date picker, and explains later backdated additions without a Save step', async () => {
    openNumberChanges(); await flush();
    await vi.waitFor(() => expect(document.querySelector('.number-changes-totals')).not.toBeNull());
    expect(state.meta.financialHistory).toBeTruthy();
    expect(state.meta.comparisonPoint).toBeUndefined();
    expect(document.querySelector('.number-changes [type="date"]').value).toBe('2026-09-15');
    expect([...document.querySelectorAll('.number-changes button')].some(b => b.textContent === t('numberChanges.save'))).toBe(false);
    await session.dispatch('transaction.record', { type: 'expense', amount: 25, account: 'bank', envelope: 'food', date: '2026-09-01', payee: 'Coffee' });
    document.querySelector('.number-changes select').dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.querySelector('.number-changes-totals')?.textContent).toContain('975'));
    expect(document.querySelector('.number-changes-step').textContent).toContain('Coffee');
    const source = document.querySelector('.number-changes-source');
    expect(source).not.toBeNull();
    expect(source.textContent).toContain('25');
    source.querySelector('button').click();
    expect(document.querySelectorAll('.sheet').length).toBeGreaterThan(1);
    expect(document.querySelector('.sheet:last-child')).not.toBeNull();
    const writes = writeBatch.mock.calls.length;
    const date = document.querySelector('.number-changes [type="date"]'); date.value = '2026-09-01'; date.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.body.textContent).toContain(t('numberChanges.historyUnavailable')));
    expect(writeBatch).toHaveBeenCalledTimes(writes);
  });
  it('reports failed automatic initialization without pretending history was saved', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    openNumberChanges(); await flush();
    await vi.waitFor(() => expect(document.body.textContent).toContain(t('numberChanges.historyFailed')));
    expect(state.meta.financialHistory).toBeUndefined();
  });
  it('closes and prevents writes after switching budget', async () => {
    openNumberChanges(); await flush();
    await vi.waitFor(() => expect(document.querySelector('.number-changes-totals')).not.toBeNull());
    const writes = writeBatch.mock.calls.length;
    beginBudgetSession(); await flush();
    expect(writeBatch).toHaveBeenCalledTimes(writes);
    expect(document.querySelector('.sheet-overlay.open')).toBeNull();
  });
});
