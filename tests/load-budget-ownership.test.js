// @vitest-environment jsdom
// Overlapping budget loads: the one the user picked last owns app state. An
// older load that finishes later used to publish its collections next to the
// newer budget's handle, so the next save wrote budget A's rows into B.
import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', () => ({
  fileExists: vi.fn(async () => true),
  loadBudgetData: vi.fn(),
  saveEnvelopes: vi.fn(async () => {}),
  saveMeta: vi.fn(async () => {}),
  writeBatch: vi.fn(async () => {}),
}));
vi.mock('../js/ui/load-progress.js', () => ({
  openLoadProgress: () => ({ step: async () => {}, close: () => {} }),
}));
vi.mock('../js/ui/shell.js', () => ({ setNavItemVisible: () => {}, refreshAiEntryPoints: () => {} }));
vi.mock('../js/ui/tour.js', () => ({ maybeAutoStartTour: vi.fn() }));
vi.mock('../js/state/recent-budgets.js', () => ({ recordRecentBudget: vi.fn() }));
vi.mock('../js/state/initial-budget.js', () => ({ writeInitialBudget: vi.fn(async () => {}) }));

import { state, navigate, runDueScheduled, updateStatusBar, resetState, session, writeBatch } from './_fakes/pageApp.js';
import { fileExists, loadBudgetData, saveMeta } from '../js/data.js';
import { loadBudgetIntoState } from '../js/state/load-budget.js';
import { currentBudgetSession, budgetHeld } from '../js/state/budget-session.js';
import { publishNewBudget, runSetupWizard } from '../js/setup.js';

const bundle = (rowId, name = rowId) => ({
  envelopes: [],
  budgetItems: [],
  accounts: [],
  envelopeTemplates: [],
  meta: { schemaVersion: 8, name },
  transactions: [{ id: rowId, type: 'income', date: '2026-09-01', amount: 1 }],
});

/** A promise plus its resolver/rejecter, for controlling completion order. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const a = { kind: 'cloud', budgetId: 'A', name: 'A' };
const b = { kind: 'cloud', budgetId: 'B', name: 'B' };

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  resetState();
  runDueScheduled.mockClear();
  fileExists.mockReset().mockImplementation(async () => true);
  loadBudgetData.mockReset();
  saveMeta.mockClear();
});

describe('loadBudgetIntoState with overlapping loads', () => {
  it('keeps the newer budget when the older read finishes last', async () => {
    const readA = deferred();
    loadBudgetData.mockImplementation(ref => (ref === a ? readA.promise : Promise.resolve(bundle('B-row'))));

    const first = loadBudgetIntoState(a);
    await vi.waitFor(() => expect(loadBudgetData).toHaveBeenCalledWith(a));
    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });
    navigate.mockClear();

    readA.resolve(bundle('A-row'));
    await expect(first).resolves.toEqual({ loaded: false, superseded: true });

    expect(state.budgetFolder).toBe(b);
    expect(state.transactions.map(tx => tx.id)).toEqual(['B-row']);
    expect(state.meta.name).toBe('B');
    // The superseded load neither posts scheduled rows nor navigates.
    expect(runDueScheduled).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not ask for the setup wizard for a budget the user has left', async () => {
    const existsA = deferred();
    fileExists.mockImplementation(async ref => (ref === a ? existsA.promise : true));
    loadBudgetData.mockImplementation(async () => bundle('B-row'));

    const first = loadBudgetIntoState(a);
    await loadBudgetIntoState(b);
    existsA.resolve(false);

    await expect(first).resolves.toEqual({ loaded: false, superseded: true });
    expect(state.budgetFolder).toBe(b);
  });

  it('swallows a failure from a superseded load instead of reporting it', async () => {
    const readA = deferred();
    loadBudgetData.mockImplementation(ref => (ref === a ? readA.promise : Promise.resolve(bundle('B-row'))));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = loadBudgetIntoState(a);
    await vi.waitFor(() => expect(loadBudgetData).toHaveBeenCalledWith(a));
    await loadBudgetIntoState(b);
    readA.reject(new Error('network down'));

    await expect(first).resolves.toEqual({ loaded: false, superseded: true });
    expect(state.transactions.map(tx => tx.id)).toEqual(['B-row']);
    warn.mockRestore();
  });

  it('still throws when the current load fails', async () => {
    loadBudgetData.mockImplementation(async () => { throw new Error('network down'); });
    await expect(loadBudgetIntoState(a)).rejects.toThrow('network down');
  });

  it('does not adopt the synced name of a budget that lost ownership mid-save', async () => {
    // Cloud picker name differs from meta.name, so the loader writes meta.
    const save = deferred();
    saveMeta.mockImplementation(() => save.promise);
    loadBudgetData.mockImplementation(async ref => (ref.budgetId === 'A'
      ? bundle('A-row', 'old name')
      : bundle('B-row')));

    const first = loadBudgetIntoState({ ...a, name: 'renamed' });
    await vi.waitFor(() => expect(saveMeta).toHaveBeenCalled());
    saveMeta.mockImplementation(async () => {});
    await loadBudgetIntoState(b);
    save.resolve();

    await expect(first).resolves.toEqual({ loaded: false, superseded: true });
    expect(state.meta.name).toBe('B');
  });

  it('starts a new session on every load', async () => {
    loadBudgetData.mockImplementation(async () => bundle('B-row'));
    const before = currentBudgetSession();
    await loadBudgetIntoState(b);
    await loadBudgetIntoState(b);
    expect(currentBudgetSession()).toBe(before + 2);
  });
});

describe('loadBudgetIntoState repaint after the deferred scheduled write', () => {
  const settledWith = (r) => runDueScheduled.mockImplementationOnce(async () => ({
    emitted: 0, pendingWrite: true, settled: Promise.resolve(r),
  }));
  const flushAll = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    loadBudgetData.mockImplementation(async () => bundle('B-row'));
    navigate.mockClear();
    updateStatusBar.mockClear();
  });

  it('repaints the current page, after the first navigate, when rows were posted', async () => {
    settledWith({ posted: 1, adjusted: 1, published: true });
    state.currentPage = 'transactions';
    await loadBudgetIntoState(b);
    await flushAll();
    expect(navigate.mock.calls).toEqual([['dashboard'], ['transactions']]);
    expect(updateStatusBar).toHaveBeenCalled();
  });

  it('does not repaint when nothing was posted', async () => {
    settledWith({ posted: 0, adjusted: 0, published: false });
    await loadBudgetIntoState(b);
    await flushAll();
    expect(navigate.mock.calls).toEqual([['dashboard']]);
  });

  it('does not repaint when the write was not published', async () => {
    settledWith({ posted: 1, adjusted: 0, published: false, error: 'x' });
    await loadBudgetIntoState(b);
    await flushAll();
    expect(navigate.mock.calls).toEqual([['dashboard']]);
  });

  it('does not repaint when a newer load has started', async () => {
    const write = deferred();
    runDueScheduled.mockImplementationOnce(async () => ({ emitted: 0, pendingWrite: true, settled: write.promise }));
    await loadBudgetIntoState(a);
    await loadBudgetIntoState(b);
    navigate.mockClear();
    write.resolve({ posted: 1, adjusted: 0, published: true });
    await flushAll();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not wait for the write before painting', async () => {
    runDueScheduled.mockImplementationOnce(async () => ({ emitted: 0, pendingWrite: true, settled: new Promise(() => {}) }));
    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });
    expect(navigate).toHaveBeenCalledWith('dashboard');
  });
});

describe('loadBudgetIntoState auto-archive of legacy "(deleted: …)" envelopes', () => {
  const flushAll = () => new Promise(resolve => setTimeout(resolve, 0));
  const withEnvelopes = (envelopes) => ({ ...bundle('B-row'), envelopes });
  const legacy = { id: 'old', name: '(deleted: Old)', category: 'x' };
  const live = { id: 'rent', name: 'Rent', category: 'Home' };

  beforeEach(() => {
    navigate.mockClear();
    updateStatusBar.mockClear();
    writeBatch.mockClear();
    runDueScheduled.mockClear();
  });

  it('archives it through the session, dispatched before the first paint and month.start, and repaints once the write lands', async () => {
    loadBudgetData.mockImplementation(async () => withEnvelopes([live, legacy]));
    const dispatch = vi.spyOn(session, 'dispatch');
    state.currentPage = 'envelopes';
    await loadBudgetIntoState(b);
    // Dispatched after the income-template conversion and ahead of the
    // month.start that runDueScheduled dispatches (the stub does not, so the
    // call order against the stub is the proof).
    expect(dispatch.mock.calls.map(c => c[0])).toEqual(['template.convertIncomeLinked', 'envelope.archiveDeleted']);
    expect(dispatch.mock.invocationCallOrder[1]).toBeLessThan(runDueScheduled.mock.invocationCallOrder[0]);
    // Its write is not awaited by the load: the first paint does not wait for it.
    expect(navigate.mock.calls).toEqual([['dashboard']]);

    await flushAll();
    expect(state.envelopes).toEqual([live, { ...legacy, archived: true }]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][1].map(f => f.filename)).toEqual(['envelopes.json', 'budget-meta.json']);
    expect(navigate.mock.calls).toEqual([['dashboard'], ['envelopes']]);
    dispatch.mockRestore();
  });

  it('commits nothing and does not repaint when there is nothing to archive', async () => {
    loadBudgetData.mockImplementation(async () => withEnvelopes([live, { ...legacy, archived: true }]));
    await loadBudgetIntoState(b);
    await flushAll();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(navigate.mock.calls).toEqual([['dashboard']]);
  });

  it('a newer load while the archive write is pending: nothing is published or repainted into the new budget', async () => {
    const write = deferred();
    writeBatch.mockImplementationOnce(() => write.promise);
    loadBudgetData.mockImplementation(async ref => (ref === a ? withEnvelopes([live, legacy]) : withEnvelopes([live])));
    state.currentPage = 'envelopes';
    await loadBudgetIntoState(a);
    await vi.waitFor(() => expect(writeBatch).toHaveBeenCalledTimes(1));
    await loadBudgetIntoState(b);
    navigate.mockClear();
    updateStatusBar.mockClear();

    write.resolve();
    await flushAll();
    expect(state.budgetFolder).toBe(b);
    expect(state.envelopes).toEqual([live]);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();
    // B had nothing to archive, so A's write is the only one.
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('only warns when the archive write fails, and leaves the envelope as it was', async () => {
    loadBudgetData.mockImplementation(async () => withEnvelopes([legacy]));
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });
    await flushAll();
    expect(warn).toHaveBeenCalledWith('auto-archive failed:', expect.anything());
    expect(state.envelopes).toEqual([legacy]);
    expect(navigate.mock.calls).toEqual([['dashboard']]);
    warn.mockRestore();
    error.mockRestore();
  });
});

// While a load (or the setup wizard after it) holds the budget, state is
// cleared or stale under the new budget's handle: a write then would put rows
// computed on nothing into the new budget's files. The session refuses every
// write until the collections are published (js/session/browser-session.js).
describe('no writes while a load or the setup wizard holds the budget', () => {
  const create = () => session.dispatch('account.create', { name: 'Wallet' });

  beforeEach(() => {
    writeBatch.mockClear();
    loadBudgetData.mockImplementation(async () => bundle('B-row'));
  });

  it('refuses a write made while the load reads, and writes once it has published', async () => {
    const read = deferred();
    loadBudgetData.mockImplementation(() => read.promise);
    const loading = loadBudgetIntoState(b);
    await vi.waitFor(() => expect(loadBudgetData).toHaveBeenCalledWith(b));
    expect(budgetHeld()).toBe(true);

    // account.create would succeed on the cleared state.
    expect((await create()).error.code).toBe('budget_loading');
    expect(writeBatch).not.toHaveBeenCalled();

    read.resolve(bundle('B-row'));
    await expect(loading).resolves.toEqual({ loaded: true });
    expect(budgetHeld()).toBe(false);
    const r = await create();
    expect(r.ok).toBe(true);
    expect(state.accounts.map(x => x.name)).toEqual(['Wallet']);
  });

  it('a failed load lets go of the budget and leaves none open, so nothing writes over its files', async () => {
    loadBudgetData.mockImplementation(async () => { throw new Error('network down'); });
    await expect(loadBudgetIntoState(a)).rejects.toThrow('network down');
    expect(budgetHeld()).toBe(false);
    expect(state.budgetFolder).toBe(null);
    // account.create would otherwise write accounts.json = [Wallet] over the real file.
    expect((await create()).error.code).toBe('no_budget');
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('holds the budget through the cloud name sync, which follows the publication', async () => {
    const save = deferred();
    saveMeta.mockImplementation(() => save.promise);
    loadBudgetData.mockImplementation(async () => bundle('A-row', 'old name'));
    const loading = loadBudgetIntoState({ ...a, name: 'renamed' });
    await vi.waitFor(() => expect(saveMeta).toHaveBeenCalled());
    expect(state.transactions.map(tx => tx.id)).toEqual(['A-row']);
    expect(budgetHeld()).toBe(true);
    expect((await create()).error.code).toBe('budget_loading');
    save.resolve();
    await expect(loading).resolves.toEqual({ loaded: true });
    expect(budgetHeld()).toBe(false);
    saveMeta.mockImplementation(async () => {});
  });

  it('a superseded load does not let go of the newer load\'s hold', async () => {
    const readA = deferred();
    const readB = deferred();
    loadBudgetData.mockImplementation(ref => (ref === a ? readA.promise : readB.promise));
    const first = loadBudgetIntoState(a);
    await vi.waitFor(() => expect(loadBudgetData).toHaveBeenCalledWith(a));
    const second = loadBudgetIntoState(b);
    await vi.waitFor(() => expect(loadBudgetData).toHaveBeenCalledWith(b));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readA.reject(new Error('network down'));
    await expect(first).resolves.toEqual({ loaded: false, superseded: true });
    warn.mockRestore();
    expect(budgetHeld()).toBe(true);
    readB.resolve(bundle('B-row'));
    await second;
    expect(budgetHeld()).toBe(false);
  });

  it('keeps the budget held through the setup wizard until it publishes', async () => {
    fileExists.mockImplementation(async () => false);
    const result = await loadBudgetIntoState(b);
    expect(result).toEqual({ loaded: false, wizard: true, session: currentBudgetSession() });
    expect(budgetHeld()).toBe(true);
    expect((await create()).error.code).toBe('budget_loading');
    // The wizard takes the loader's hold over, and the user fills it in.
    await runSetupWizard(document.getElementById('app'), b, result.session);
    expect(document.getElementById('setup-name')).not.toBe(null);
    expect(budgetHeld()).toBe(true);
    expect((await create()).error.code).toBe('budget_loading');
    expect(writeBatch).not.toHaveBeenCalled();

    // The wizard has written the new budget and publishes it.
    await expect(publishNewBudget(b)).resolves.toBe(true);
    expect(budgetHeld()).toBe(false);
    expect(state.transactions.map(tx => tx.id)).toEqual(['B-row']);
    expect((await create()).ok).toBe(true);
  });

  it('a wizard for a budget the user has left neither opens nor holds the newer budget', async () => {
    fileExists.mockImplementation(async ref => ref !== b);
    loadBudgetData.mockImplementation(async () => bundle('A-row'));
    const result = await loadBudgetIntoState(b);
    // While the picker fetches the wizard module, another budget is opened.
    await expect(loadBudgetIntoState(a)).resolves.toEqual({ loaded: true });
    document.getElementById('app').innerHTML = '<p id="dashboard"></p>';
    await runSetupWizard(document.getElementById('app'), b, result.session);
    expect(document.getElementById('dashboard')).not.toBe(null);
    expect(document.getElementById('setup-name')).toBe(null);
    expect(budgetHeld()).toBe(false);
    expect((await create()).ok).toBe(true);
  });

  it('a wizard that finishes after the user opened another budget publishes nothing over it', async () => {
    fileExists.mockImplementation(async ref => ref !== b);
    loadBudgetData.mockImplementation(async ref => bundle(ref === b ? 'B-row' : 'A-row'));
    const result = await loadBudgetIntoState(b);
    await runSetupWizard(document.getElementById('app'), b, result.session);
    await expect(loadBudgetIntoState(a)).resolves.toEqual({ loaded: true });
    await expect(publishNewBudget(b)).resolves.toBe(false);
    expect(state.budgetFolder).toBe(a);
    expect(state.transactions.map(tx => tx.id)).toEqual(['A-row']);
    expect(budgetHeld()).toBe(false);
  });
});
