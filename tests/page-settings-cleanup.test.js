// @vitest-environment jsdom
// Settings → Clean-up: each card runs its check when the tab renders and
// shows the count, and its button opens the right fix. The scans themselves
// are covered by duplicate-finder.test.js and payee-merge.test.js; this checks
// they are wired to the right cards. The data check (runInvariantCheck plus
// the badge's extras) lives in app.js, so it is stubbed here.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const dataCheck = {
  report: { totalProblems: 2 },
  extras: { unlinked: 5, postedDuplicates: 4, archivedFuture: [{ id: 'f1' }] },
};
vi.mock('../js/app.js', async () => ({
  ...(await import('./_fakes/pageApp.js')).appStub,
  runDataCheck: vi.fn(async () => dataCheck),
  openDataCheckSheet: vi.fn(),
}));

import { renderCleanupTab } from '../js/pages/settings-cleanup.js';
import { runDataCheck, openDataCheckSheet } from '../js/app.js';
import { t } from '../js/ui/i18n.js';
import { state, navigate, resetState, mountHosts, flush } from './_fakes/pageApp.js';

const card = (key) => document.querySelector(`[data-check="${key}"]`);
const status = (key) => card(key).querySelector('[role="status"]').textContent;
const button = (key) => card(key).querySelector('button');

async function renderTab() {
  const host = document.getElementById('app-root');
  renderCleanupTab(host);
  // One 0ms hop per card before its check runs.
  for (let i = 0; i < 8; i++) await flush();
  return host;
}

const ledger = [
  // Same payee, amount and account two days apart: one plain duplicate group.
  { id: 'd1', type: 'expense', date: '2026-09-02', payee: 'Cafe', amount: 12, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'd2', type: 'expense', date: '2026-09-03', payee: 'Cafe', amount: 12, envelope_id: 'food', account: 'chk', status: 'posted' },
  // One shop written two ways: one payee group.
  { id: 'p1', type: 'expense', date: '2026-09-05', payee: 'LIDL 1234', amount: 30, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'p2', type: 'expense', date: '2026-09-06', payee: 'Lidl', amount: 41, envelope_id: 'food', account: 'chk', status: 'posted' },
  // A buy into the investment account with no symbol.
  { id: 'i1', type: 'investment_transfer', date: '2026-09-07', payee: 'Broker', amount: 100, from_account: 'chk', to_account: 'inv', status: 'posted' },
];

beforeEach(() => {
  mountHosts();
  resetState({ transactions: ledger.map(tx => ({ ...tx })) });
  state.accounts = [...state.accounts, { id: 'inv', name: 'Broker', type: 'investment' }];
  runDataCheck.mockClear();
  openDataCheckSheet.mockClear();
});

describe('Settings → Clean-up tab', () => {
  it('shows each check\'s count once it has run', async () => {
    await renderTab();
    // Unlinked bills and automatic-post duplicates have their own cards, so
    // the data-check card counts only rule breaks and archived-future rows.
    expect(status('dataCheck')).toBe(t('cleanup.dataCheck.found')(3));
    expect(status('repairLinks')).toBe(t('cleanup.clean'));
    expect(status('duplicates')).toBe(t('duplicates.found')(1));
    expect(status('transferPairs')).toBe(t('cleanup.clean'));
    expect(status('payees')).toBe(t('payeeMerge.settingsFound')(1));
    expect(status('unmapped')).toBe(t('cleanup.unmapped.found')(1));
  });

  it('marks a card with something to fix differently from a clean one', async () => {
    await renderTab();
    expect(card('duplicates').querySelector('.chip').classList.contains('chip--health-yellow')).toBe(true);
    expect(card('repairLinks').querySelector('.chip').classList.contains('chip--health-green')).toBe(true);
  });

  it('says "no exact duplicates", not "nothing to fix", when no exact payee group is found', async () => {
    // The loose "possible duplicates" are not counted, so zero is not a clean bill.
    state.transactions = state.transactions.filter(tx => tx.payee !== 'LIDL 1234');
    await renderTab();
    expect(status('payees')).toBe(t('payeeMerge.settingsNoExact'));
    const chip = card('payees').querySelector('.chip');
    expect(chip.classList.contains('chip--health-green')).toBe(false);
    expect(chip.classList.contains('chip--health-yellow')).toBe(false);
  });

  it('leaves out the investment card when no investment account is tracked', async () => {
    state.accounts = state.accounts.filter(a => a.type !== 'investment');
    await renderTab();
    expect(card('unmapped')).toBeNull();
    expect(card('payees')).not.toBeNull();
  });

  it('opens the data-check sheet with the report it counted', async () => {
    await renderTab();
    button('dataCheck').click();
    expect(openDataCheckSheet).toHaveBeenCalledTimes(1);
    expect(openDataCheckSheet.mock.calls[0][0]).toBe(dataCheck);
  });

  it('re-runs the data check after its sheet closes', async () => {
    await renderTab();
    button('dataCheck').click();
    const { onClose } = openDataCheckSheet.mock.calls[0][1];
    onClose();
    await flush();
    expect(runDataCheck).toHaveBeenCalledTimes(2);
  });

  it('counts and opens the transfer pairs', async () => {
    state.transactions = [...state.transactions,
      { id: 't1', type: 'expense', date: '2026-09-08', payee: 'To savings', amount: 200, envelope_id: 'food', account: 'chk', status: 'posted' },
      { id: 't2', type: 'income', date: '2026-09-08', payee: 'To savings', amount: 200, account: 'sav', status: 'posted' }];
    await renderTab();
    expect(status('transferPairs')).toBe(t('transferPairs.found')(1));
    button('transferPairs').click();
    expect(document.querySelector('#sheet-host .sheet')?.textContent).toContain(t('transferPairs.title'));
  });

  it('sends the investment card to the Investments page', async () => {
    await renderTab();
    button('unmapped').click();
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  it('opens the duplicate finder sheet', async () => {
    await renderTab();
    button('duplicates').click();
    expect(document.querySelector('#sheet-host .sheet')?.textContent).toContain(t('duplicates.title'));
  });
});

describe('leaving the tab while its checks run', () => {
  // The checks run one per 0ms hop after the cards paint. A user who moves on
  // takes the cards out of the page; the rest must not run (they would paint
  // detached cards, and in a test outlive the DOM: BACKLOG 2026-09-29).
  it('runs no further checks once the cards are detached', async () => {
    runDataCheck.mockClear();
    const host = document.getElementById('app-root');
    renderCleanupTab(host);
    host.replaceChildren();
    for (let i = 0; i < 8; i++) await flush();
    expect(runDataCheck).not.toHaveBeenCalled();
  });
});
