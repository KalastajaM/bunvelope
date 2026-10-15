// @vitest-environment jsdom
// runDueScheduled({ deferWrite: true }) posts due rows on load and lets the
// write settle in the background. If that write fails after the user opened
// another budget, the failure belongs to a budget that is no longer open: no
// toast, no conflict dialog, and the new budget's rows are left alone.
//
// Since PR 1c the write goes through the browser session (month.start), which
// writes first and publishes into state only after the write lands, so there
// is no optimistic assign and no rollback: a failure leaves state as it was.
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';

const toasts = vi.hoisted(() => []);
const pending = vi.hoisted(() => ({ reject: null }));

vi.mock('../js/ui/shell.js', () => ({
  buildShell: () => {}, highlightActive: () => {}, applyPrefs: () => {},
  relabelShell: () => {}, setNavItemVisible: () => {}, refreshAiEntryPoints: () => {},
}));
vi.mock('../js/ui/toast.js', () => ({ toast: (msg) => toasts.push(msg) }));
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeBatch: () => new Promise((_resolve, reject) => { pending.reject = reject; }),
}));

let app;
let ready;
let budgetSession;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app-root"><div id="app"></div></div>';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  app = await import('../js/app.js');
  budgetSession = await import('../js/state/budget-session.js');
});
afterAll(() => { ready.mockRestore(); });
afterEach(() => { vi.useRealTimers(); toasts.length = 0; vi.restoreAllMocks(); });

function seed() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 29, 12));
  Object.assign(app.state, {
    budgetFolder: { __guest: true },
    envelopes: [{ id: 'food', name: 'Food' }],
    envelopeTemplates: [{
      id: 'tpl', name: 'Monthly', kind: 'manual',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 10 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-09-01', months: { Sep: true } },
    }],
    budgetItems: [],
    transactions: [],
    accounts: [],
    meta: { schemaVersion: 8 },
  });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it('stays silent when the deferred write fails after a budget switch', async () => {
  seed();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await app.runDueScheduled({ deferWrite: true });
  expect(r).toMatchObject({ emitted: 0, pendingWrite: true });
  await settle();
  expect(pending.reject).toBeTypeOf('function');
  // Write-first: nothing reaches state until the write lands.
  expect(app.state.transactions).toHaveLength(0);

  // The user opens another budget while the write is in flight.
  budgetSession.beginBudgetSession();
  const otherRows = [{ id: 'other', type: 'expense', amount: 5, date: '2026-09-28' }];
  app.state.budgetFolder = { __guest: true };
  app.state.transactions = otherRows;
  vi.useRealTimers();

  pending.reject(new Error('disk full'));
  const outcome = await r.settled;
  expect(outcome).toMatchObject({ posted: 0, adjusted: 0, published: false, error: 'disk full' });
  expect(toasts).toEqual([]);
  expect(app.state.transactions).toBe(otherRows);
  expect(warn).toHaveBeenCalled();
  expect(error).not.toHaveBeenCalledWith('runDueScheduled failed:', expect.anything());
});

it('stays silent when the awaited write fails after a budget switch', async () => {
  seed();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  pending.reject = null;
  const run = app.runDueScheduled();
  await settle();
  expect(pending.reject).toBeTypeOf('function');

  budgetSession.beginBudgetSession();
  const otherRows = [{ id: 'other', type: 'expense', amount: 5, date: '2026-09-28' }];
  app.state.budgetFolder = { __guest: true };
  app.state.transactions = otherRows;
  vi.useRealTimers();

  pending.reject(new Error('disk full'));
  expect(await run).toEqual({ emitted: 0, error: 'disk full' });
  expect(toasts).toEqual([]);
  expect(app.state.transactions).toBe(otherRows);
  expect(warn).toHaveBeenCalled();
});

it('still reports a failure in the budget that is open, leaving state unchanged', async () => {
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await app.runDueScheduled({ deferWrite: true });
  await settle();
  expect(app.state.transactions).toHaveLength(0);
  vi.useRealTimers();

  pending.reject(new Error('disk full'));
  const outcome = await r.settled;
  expect(outcome).toMatchObject({ posted: 0, published: false, error: 'disk full' });
  expect(app.state.transactions).toHaveLength(0);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain('disk full');
});
