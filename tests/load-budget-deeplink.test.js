// @vitest-environment jsdom
// A refresh on a deep link (#/transactions) must stay on that page when the
// load also posts a scheduled row. The first navigate after a load consumes the
// one-time route restore; a repaint that ran before load-budget's own
// navigate('dashboard') used to take it, and the dashboard then won.
// Real app.js and load-budget.js; fake storage.
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';

const data = vi.hoisted(() => ({
  fileExists: vi.fn(async () => true),
  loadBudgetData: vi.fn(),
  saveEnvelopes: vi.fn(async () => {}),
  saveMeta: vi.fn(async () => {}),
  writeBatch: vi.fn(async () => {}),
}));
vi.mock('../js/data.js', async (importOriginal) => ({ ...(await importOriginal()), ...data }));
vi.mock('../js/ui/shell.js', () => ({
  buildShell: () => {}, highlightActive: () => {}, applyPrefs: () => {},
  relabelShell: () => {}, setNavItemVisible: () => {}, refreshAiEntryPoints: () => {},
}));
// Each step yields a macrotask like the real paintYield, so a fast write
// settles before the 'rendering' step ends, as it does in guest mode.
vi.mock('../js/ui/load-progress.js', () => ({
  openLoadProgress: () => ({ step: () => new Promise(resolve => setTimeout(resolve, 0)), close: () => {} }),
}));
vi.mock('../js/ui/tour.js', () => ({ maybeAutoStartTour: vi.fn() }));
vi.mock('../js/state/recent-budgets.js', () => ({ recordRecentBudget: vi.fn() }));

let app;
let loadBudgetIntoState;
let ready;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app-root"><div id="app"></div></div>';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  app = await import('../js/app.js');
  ({ loadBudgetIntoState } = await import('../js/state/load-budget.js'));
});
afterAll(() => { ready.mockRestore(); });
afterEach(() => { vi.useRealTimers(); });

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

it('keeps the deep-linked page when the load posts a scheduled row', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 12));
  const rendered = [];
  for (const name of ['dashboard', 'transactions']) {
    app.registerPage(name, () => Promise.resolve({ render: () => { rendered.push(name); } }));
  }
  window.location.hash = '#/transactions';
  data.loadBudgetData.mockImplementation(async () => ({
    envelopes: [{ id: 'env', name: 'Rent' }],
    budgetItems: [{
      id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'env', account_id: 'chk',
      as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
      default_amount: -100, payment_day: 5, schedule_day_type: 'exact', include: true,
    }],
    accounts: [{ id: 'chk', name: 'Checking' }],
    envelopeTemplates: [],
    meta: { schemaVersion: 8, name: 'Guest' },
    transactions: [],
  }));

  await expect(loadBudgetIntoState({ __guest: true })).resolves.toEqual({ loaded: true });
  await vi.waitFor(() => expect(data.writeBatch).toHaveBeenCalled());
  await vi.waitFor(() => expect(app.state.transactions).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(app.state.currentPage).toBe('transactions');
  expect(app.state.transactions[0]).toMatchObject({ from_budget: 'rent:2026-10' });
  // First paint restored the deep link; the post-write repaint stayed on it.
  expect(rendered[0]).toBe('transactions');
  expect(rendered.at(-1)).toBe('transactions');
});
