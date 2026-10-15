// @vitest-environment jsdom
// runLoanPlanUpkeep keeps a loan's plan item in step with the loan when a
// budget opens: here, a repaid loan's item is disabled and announced. It
// dispatches budgetItem.loanUpkeep through the session, which writes first and
// only then publishes, so a failed write leaves state as it was.
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';

const toasts = vi.hoisted(() => []);
const write = vi.hoisted(() => ({ fail: false, calls: [], hold: null }));

vi.mock('../js/ui/shell.js', () => ({
  buildShell: () => {}, highlightActive: () => {}, applyPrefs: () => {},
  relabelShell: () => {}, setNavItemVisible: () => {}, refreshAiEntryPoints: () => {},
}));
vi.mock('../js/ui/toast.js', () => ({ toast: (msg) => toasts.push(msg) }));
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  writeBatch: async (_ref, items) => {
    write.calls.push(items);
    if (write.hold) await write.hold;
    if (write.fail) throw new Error('disk full');
  },
}));

let app;
let ready;
let t;
let beginBudgetSession;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app-root"><div id="app"></div></div>';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  app = await import('../js/app.js');
  ({ t } = await import('../js/ui/i18n.js'));
  ({ beginBudgetSession } = await import('../js/state/budget-session.js'));
});
afterAll(() => { ready.mockRestore(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  toasts.length = 0; write.calls.length = 0; write.fail = false; write.hold = null;
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function seed(item = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 20, 12));
  Object.assign(app.state, {
    budgetFolder: { __guest: true },
    accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -5000 }],
    envelopes: [{ id: 'housing', name: 'Housing' }],
    budgetItems: [{
      id: 'mortgage', kind: 'loan_payment', description: 'Home loan', envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg',
      default_amount: -1000, monthly_schedule: Object.fromEntries(MONTHS.map(m => [m, true])), payment_day: 5,
      as_schedule: true, include: true, schedule_day_type: 'exact', ...item,
    }],
    transactions: [{ id: 'p', type: 'debt_payment', date: '2026-09-05', amount: 5000, from_account: 'chk', to_account: 'mtg', envelope_id: 'housing', status: 'posted' }],
    meta: {},
  });
}

it('dispatches budgetItem.loanUpkeep: the repaid loan’s item is disabled, written and announced', async () => {
  seed();
  const dispatch = vi.spyOn(app.session, 'dispatch');
  const r = await app.runLoanPlanUpkeep();
  expect(dispatch.mock.calls).toEqual([['budgetItem.loanUpkeep', {}]]);
  expect(r.updated).toBe(1);
  expect(app.state.budgetItems[0]).toMatchObject({ include: false, loan_paid_off: '2026-09-05' });
  expect(write.calls).toHaveLength(1);
  expect(write.calls[0].map(f => f.filename)).toEqual(['budget-items.json', 'budget-meta.json']);
  expect(toasts).toEqual([t('loanSchedule.repaidToast')('Home loan')]);
  // Nothing more to do on the next open: nothing written, nothing said.
  expect((await app.runLoanPlanUpkeep()).updated).toBe(0);
  expect(write.calls).toHaveLength(1);
  expect(toasts).toHaveLength(1);
});

it('names the loan account in the toast when the item has no description', async () => {
  seed({ description: '' });
  await app.runLoanPlanUpkeep();
  expect(toasts).toEqual([t('loanSchedule.repaidToast')('Mortgage')]);
});

it('leaves state as it was and reports the failure when the write fails', async () => {
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  write.fail = true;
  const before = app.state.budgetItems;
  const r = await app.runLoanPlanUpkeep();
  expect(r.updated).toBe(0);
  expect(app.state.budgetItems).toBe(before);
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toContain('disk full');
  expect(toasts[0]).not.toBe(t('loanSchedule.repaidToast')('Home loan'));
});

it('says nothing, and reports no update, when the budget is switched while the write is in flight', async () => {
  seed();
  let land;
  write.hold = new Promise((resolve) => { land = resolve; });
  const pending = app.runLoanPlanUpkeep();
  await vi.waitFor(() => expect(write.calls).toHaveLength(1));
  beginBudgetSession();
  land();
  expect((await pending).updated).toBe(0);
  expect(toasts).toEqual([]);
});
