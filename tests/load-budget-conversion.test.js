// @vitest-environment jsdom
// The load-time income-template conversion goes through the session: dispatched
// first, so the session runs it before the auto-archive and month.start (it
// serialises dispatches in call order), and month.start posts against the
// converted schedule. Its write is not awaited before the first paint; the
// repaint after it lands covers it.
import { beforeEach, describe, it, expect, vi } from 'vitest';

const toasts = vi.hoisted(() => []);

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', () => ({
  fileExists: vi.fn(async () => true),
  loadBudgetData: vi.fn(),
  saveMeta: vi.fn(async () => {}),
  writeBatch: vi.fn(async () => {}),
}));
vi.mock('../js/ui/load-progress.js', () => ({
  openLoadProgress: () => ({ step: async () => {}, close: () => {} }),
}));
vi.mock('../js/ui/shell.js', () => ({ setNavItemVisible: () => {}, refreshAiEntryPoints: () => {} }));
vi.mock('../js/ui/tour.js', () => ({ maybeAutoStartTour: vi.fn() }));
vi.mock('../js/state/recent-budgets.js', () => ({ recordRecentBudget: vi.fn() }));
vi.mock('../js/ui/toast.js', () => ({ toast: (msg) => toasts.push(msg) }));

import { state, navigate, runDueScheduled, updateStatusBar, resetState, session, writeBatch } from './_fakes/pageApp.js';
import { loadBudgetData } from '../js/data.js';
import { loadBudgetIntoState } from '../js/state/load-budget.js';
import { t } from '../js/ui/i18n.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// An income item that still drives its template (the pre-conversion link). Its
// pay day, the 10th, has come by the fake app's "now" (15 Sep 2026).
const linkedIncome = {
  id: 'inc1', kind: 'income', as_schedule: true, template_id: 'tpl1', account_id: 'chk', payment_day: 10,
  default_amount: 2000, monthly_schedule: everyMonth(), as_schedule_since: '2026-09-01', include: true,
};
const linkedTemplate = { id: 'tpl1', name: 'Salary Split', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 100 }] };
const legacyDeleted = { id: 'old', name: '(deleted: Old)', category: 'x' };

const bundle = (over = {}) => ({
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'rent', name: 'Rent', category: 'Home' }],
  budgetItems: [],
  envelopeTemplates: [],
  transactions: [],
  meta: { schemaVersion: 8, name: 'B' },
  ...over,
});
const linked = (over = {}) => bundle({ budgetItems: [linkedIncome], envelopeTemplates: [linkedTemplate], ...over });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flushAll = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

// As the real runDueScheduled does: dispatch month.start through the session,
// deferred, and hand back what it settled to.
const monthStartThroughSession = () => runDueScheduled.mockImplementationOnce(async () => {
  const settled = session.dispatch('month.start', {}).then(r => (r.ok
    ? { posted: r.value.value.posted, adjusted: r.value.value.adjusted, published: r.value.published === true }
    : { posted: 0, adjusted: 0, published: false, error: r.error.code }));
  return { emitted: 0, pendingWrite: true, settled };
});

const a = { kind: 'cloud', budgetId: 'A', name: 'A' };
const b = { kind: 'cloud', budgetId: 'B', name: 'B' };

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  resetState();
  toasts.length = 0;
  runDueScheduled.mockReset();
  writeBatch.mockReset().mockImplementation(async () => {});
  loadBudgetData.mockReset();
  navigate.mockClear();
  updateStatusBar.mockClear();
  vi.restoreAllMocks();
});

describe('loadBudgetIntoState: the income-template conversion through the session', () => {
  it('runs the conversion, then the archive, then month.start, which posts against the converted schedule; one repaint', async () => {
    loadBudgetData.mockImplementation(async () => linked({
      envelopes: [{ id: 'rent', name: 'Rent', category: 'Home' }, legacyDeleted],
    }));
    monthStartThroughSession();
    const dispatch = vi.spyOn(session, 'dispatch');
    state.currentPage = 'envelopes';

    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });
    expect(dispatch.mock.calls.map(c => c[0])).toEqual(['template.convertIncomeLinked', 'envelope.archiveDeleted', 'month.start']);
    // The first paint does not wait for the conversion's write.
    expect(navigate.mock.calls[0]).toEqual(['dashboard']);

    await flushAll();
    // The session ran them in that order: each write follows the one before.
    const files = writeBatch.mock.calls.map(c => c[1].map(f => f.filename).sort());
    expect(files[0]).toEqual(['budget-items.json', 'budget-meta.json', 'envelope-templates.json']);
    expect(files[1]).toEqual(['budget-meta.json', 'envelopes.json']);
    expect(files[2]).toContain('transactions.json');
    expect(state.budgetItems[0].template_id).toBeNull();
    expect(state.envelopeTemplates[0].schedule).toMatchObject({ enabled: true, payment_day: 10 });
    // month.start read the converted template: its September fill was posted.
    expect(state.transactions.filter(tx => tx.type === 'fill').map(tx => tx.from_budget)).toEqual(['tpl:tpl1:2026-09']);
    expect(toasts).toEqual([t('templatesPage.converted')]);
    expect(navigate.mock.calls).toEqual([['dashboard'], ['envelopes']]);
  });

  it('repaints once the conversion lands, even when nothing else changed', async () => {
    loadBudgetData.mockImplementation(async () => linked({ budgetItems: [{ ...linkedIncome, as_schedule_since: '2026-10-01' }] }));
    state.currentPage = 'budget';
    await loadBudgetIntoState(b);
    expect(navigate.mock.calls).toEqual([['dashboard']]);
    await flushAll();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([t('templatesPage.converted')]);
    expect(navigate.mock.calls).toEqual([['dashboard'], ['budget']]);
  });

  it('commits nothing, says nothing and does not repaint when nothing is linked', async () => {
    loadBudgetData.mockImplementation(async () => bundle());
    await loadBudgetIntoState(b);
    await flushAll();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(navigate.mock.calls).toEqual([['dashboard']]);
  });

  it('toasts convertFailed when the write fails, leaves state unconverted and does not repaint', async () => {
    loadBudgetData.mockImplementation(async () => linked());
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });
    await flushAll();
    expect(error).toHaveBeenCalledWith('income-template conversion save failed:', expect.anything());
    expect(toasts).toEqual([t('templatesPage.convertFailed')]);
    expect(state.budgetItems[0].template_id).toBe('tpl1');
    expect(navigate.mock.calls).toEqual([['dashboard']]);
  });

  it('a superseded load: its conversion publishes, toasts and repaints nothing in the newer budget', async () => {
    const write = deferred();
    writeBatch.mockImplementationOnce(() => write.promise);
    loadBudgetData.mockImplementation(async ref => (ref === a ? linked() : bundle()));
    state.currentPage = 'budget';
    await loadBudgetIntoState(a);
    await vi.waitFor(() => expect(writeBatch).toHaveBeenCalledTimes(1));
    await loadBudgetIntoState(b);
    navigate.mockClear();
    updateStatusBar.mockClear();

    write.resolve();
    await flushAll();
    expect(state.budgetFolder).toBe(b);
    expect(state.budgetItems).toEqual([]);
    expect(state.envelopeTemplates).toEqual([]);
    expect(toasts).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();
  });
});
