// @vitest-environment jsdom
// The status bar and the rail chip read unallocated from the `balances` query.
// It is a refactor: for each lens the figure on screen must equal the old
// composition (viewTxs -> balances -> computeUnallocated) on the same budget at
// the same pinned instant. Real app.js, so this also pins that the session's
// clock is the app clock the lens helpers use.
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi, describe } from 'vitest';

vi.mock('../js/ui/shell.js', () => ({
  buildShell: () => {}, highlightActive: () => {}, applyPrefs: () => {},
  relabelShell: () => {}, setNavItemVisible: () => {}, refreshAiEntryPoints: () => {},
}));

import { computeAccountBalances, computeEnvelopeBalances, computeUnallocated } from '../js/engine.js';
import { fmt } from '../js/utils.js';
import { t } from '../js/ui/i18n.js';

let app;
let ready;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app-root"><div id="app"></div></div>';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  app = await import('../js/app.js');
});
afterAll(() => { ready.mockRestore(); });

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

// Pinned local, so the engine's local-date reads agree in every timezone.
const pinNow = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 15, 14, 30));
};

function seed() {
  Object.assign(app.state, {
    budgetFolder: { __guest: true },
    accounts: [
      { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000.1 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
      { id: 'inv', name: 'Brokerage', type: 'investment', initialBalance: 300 },
      { id: 'old', name: 'Old', type: 'bank', initialBalance: 25, archived: true },
    ],
    envelopes: [
      { id: 'food', name: 'Food', category: 'living' },
      { id: 'rent', name: 'Rent', category: 'housing' },
    ],
    envelopeTemplates: [],
    budgetItems: [{
      id: 'salary', kind: 'income', description: 'Salary', account_id: 'chk',
      as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: ALL_MONTHS,
      default_amount: 2000.5, payment_day: 25, schedule_day_type: 'exact', include: true,
    }, {
      id: 'rent-item', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
      as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: ALL_MONTHS,
      default_amount: -400.33, payment_day: 28, schedule_day_type: 'exact', include: true,
    }],
    transactions: [
      { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 900.07, envelope_id: 'food', account: 'chk', status: 'posted' },
      { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 40.45, envelope_id: 'food', account: 'chk', status: 'posted' },
      { id: 'e2', type: 'expense', date: '2026-09-10', payee: 'Late', amount: 12.2, envelope_id: 'food', account: 'chk', status: 'scheduled' },
      { id: 'e3', type: 'expense', date: '2026-09-20', payee: 'Soon', amount: 30.05, envelope_id: 'food', account: 'chk', status: 'scheduled' },
      { id: 'e4', type: 'expense', date: '2026-09-25', payee: 'Ahead', amount: 7.01, envelope_id: 'food', account: 'chk', status: 'posted' },
      { id: 'i2', type: 'income', date: '2026-09-22', payee: 'Refund', amount: 250.15, account: 'chk', status: 'scheduled' },
      { id: 'i3', type: 'income', date: '2026-09-26', payee: 'Gift', amount: 100, account: 'sav', status: 'posted' },
      { id: 't1', type: 'account_transfer', date: '2026-09-12', amount: 50, account: 'chk', to_account: 'inv', status: 'posted' },
    ],
    meta: {},
    currentPage: null,
  });
}

/** The old composition: the lens rows, balances, computeUnallocated. */
function oldUnallocated() {
  const txs = app.viewTxs();
  return computeUnallocated(
    computeAccountBalances(app.state.accounts, txs), computeEnvelopeBalances(txs), app.state.accounts,
  );
}

const text = (id) => document.getElementById(id).textContent;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="app-root"><div id="app"></div></div>
    <button id="status-unallocated"></button>`;
  pinNow();
  seed();
  app.savePrefs({ uiMode: 'full', lens: 'booked', lensHorizon: 'eom' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('status bar unallocated over the balances query', () => {
  const cases = [
    ['today', { lens: 'today' }],
    ['booked', { lens: 'booked' }],
    ['forecast, end of month', { lens: 'forecast', lensHorizon: 'eom' }],
    ['forecast, 3 months', { lens: 'forecast', lensHorizon: '3m' }],
    ['forecast, a date', { lens: 'forecast', lensHorizon: '2027-02-10' }],
  ];

  it.each(cases)('%s: the status bar shows the old composition\'s figure', (_name, prefs) => {
    app.savePrefs(prefs);
    const expected = fmt(oldUnallocated());
    app.updateStatusBar();
    expect(text('status-unallocated')).toBe(`${t('status.unalloc')} ${expected}`);
    expect(document.getElementById('status-unallocated').disabled).toBe(false);
  });

  it('is not vacuous: the lenses give different figures on this budget', () => {
    const figures = cases.map(([, prefs]) => {
      app.savePrefs(prefs);
      return oldUnallocated();
    });
    expect(new Set(figures).size).toBeGreaterThan(3);
  });

  it('simple mode pins the default lens, as the old composition did', () => {
    app.savePrefs({ lens: 'forecast', lensHorizon: '6m', uiMode: 'simple' });
    app.updateStatusBar();
    expect(text('status-unallocated')).toBe(`${t('status.unalloc')} ${fmt(oldUnallocated())}`);
    expect(app.activeLensInput()).toEqual({ lens: 'booked' });
  });

  it('pins Booked with optional balance views off and restores the saved lens when enabled', () => {
    app.savePrefs({ lens: 'forecast', lensHorizon: '6m', uiMode: 'advanced', uiFeatures: [] });
    expect(app.activeLensInput()).toEqual({ lens: 'booked' });
    app.savePrefs({ uiFeatures: ['balance-views'] });
    expect(app.activeLensInput()).toEqual({ lens: 'forecast', horizon: '6m' });
  });

  it('asks the query for a horizon only with the forecast lens', () => {
    app.savePrefs({ lens: 'booked', lensHorizon: '12m' });
    expect(app.activeLensInput()).toEqual({ lens: 'booked' });
    app.savePrefs({ lens: 'forecast', lensHorizon: '12m' });
    expect(app.activeLensInput()).toEqual({ lens: 'forecast', horizon: '12m' });
  });

  it('shows no figure, and warns, when the query fails (it does not recompute the balances itself)', () => {
    app.savePrefs({ lens: 'forecast', lensHorizon: '3m' });
    // A figure from an earlier refresh must not linger.
    app.updateStatusBar();
    expect(text('status-unallocated')).toBe(`${t('status.unalloc')} ${fmt(oldUnallocated())}`);
    const chip = document.getElementById('status-unallocated');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(app.session, 'query').mockReturnValue({ ok: false, error: { code: 'bad_input', params: {} } });
    app.updateStatusBar();
    expect(text('status-unallocated')).toBe(`${t('status.unalloc')} —`);
    expect(chip.classList.contains('neg')).toBe(false);
    expect(chip.title).toBe(t('status.unallocTip'));
    expect(warn).toHaveBeenCalledWith('[bunvelope] balances query failed:', 'bad_input');
  });
});
