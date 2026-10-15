// @vitest-environment jsdom
// The load-time envelope-transfer repair. A budget holding a transfer written
// with the pre-v3 endpoint names (`from_envelope` / `to_envelope`, which the
// engine does not read) gets those keys renamed onto the canonical
// `from_envelope_id` / `to_envelope_id` before the first paint, through the
// internal transaction.repairTransferEndpoints command on the session (the real
// browser session over the fake state in _fakes/pageApp.js). A failed write
// says so and the load carries on; the repair is idempotent, so the next load
// retries. A budget with nothing to repair dispatches nothing new.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

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

import {
  state, navigate, runDueScheduled, resetState, session, writeBatch, mountHosts, toastTexts,
} from './_fakes/pageApp.js';
import { loadBudgetData, writeBatch as dataWriteBatch } from '../js/data.js';
import { loadBudgetIntoState } from '../js/state/load-budget.js';
import { t } from '../js/ui/i18n.js';

const envelopes = [{ id: 'food', name: 'Food', category: 'living' }, { id: 'fun', name: 'Fun', category: 'living' }];
const income = { id: 'inc', type: 'income', date: '2026-09-01', amount: 100, account: 'chk', envelope_id: null, status: 'posted' };
// Written before 2026-08-26 by the AI proposal path: moves no money as stored.
const legacyTransfer = () => ({
  id: 'et1', type: 'envelope_transfer', date: '2026-09-02', amount: 25, from_envelope: 'food', to_envelope: 'fun', status: 'posted',
});
const bundle = (transactions, name = 'B') => ({
  envelopes,
  budgetItems: [],
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }],
  envelopeTemplates: [],
  meta: { schemaVersion: 8, name },
  transactions,
});
const a = { kind: 'cloud', budgetId: 'A', name: 'A' };
const b = { kind: 'cloud', budgetId: 'B', name: 'B' };
const flushAll = () => new Promise(resolve => setTimeout(resolve, 0));
const dispatchedNames = (spy) => spy.mock.calls.map(c => c[0]);
const writtenFiles = (call) => call[1].map(f => f.filename);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let warn;

beforeEach(() => {
  mountHosts();
  resetState();
  runDueScheduled.mockClear();
  loadBudgetData.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); });

describe('load-time envelope-transfer repair', () => {
  it('repairs a pre-v3 transfer through the session before the first paint, and says so', async () => {
    loadBudgetData.mockImplementation(async () => bundle([income, legacyTransfer()]));
    const dispatch = vi.spyOn(session, 'dispatch');
    let painted;
    navigate.mockImplementationOnce(() => { painted = state.transactions; });

    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });

    // The repair is dispatched first and awaited; the other load-time commands follow.
    expect(dispatchedNames(dispatch)).toEqual([
      'transaction.repairTransferEndpoints', 'template.convertIncomeLinked', 'envelope.archiveDeleted',
    ]);
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(runDueScheduled.mock.invocationCallOrder[0]);
    // The first paint already sees the repaired row.
    expect(navigate.mock.calls[0]).toEqual(['dashboard']);
    const repaired = painted.find(x => x.id === 'et1');
    expect(repaired).toEqual({
      id: 'et1', type: 'envelope_transfer', date: '2026-09-02', amount: 25,
      from_envelope_id: 'food', to_envelope_id: 'fun', status: 'posted',
    });
    expect(painted.find(x => x.id === 'inc')).toEqual(income);
    // Written through the session (its writeBatch), the ledger only.
    expect(dataWriteBatch).not.toHaveBeenCalled();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(b);
    expect(writtenFiles(writeBatch.mock.calls[0])).toEqual(['transactions.json', 'budget-meta.json']);
    expect(toastTexts()).toContain(t('transfers.repaired')(1));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[bunvelope] repaired 2 envelope-transfer endpoint(s) on 1 row(s)'));
  });

  it('dispatches the repair with force: a strict-ledger budget is repaired, not refused, on load', async () => {
    // The rename is not a history edit; without force strict-ledger would
    // refuse the posted past row and toast repairFailed on every load.
    const strict = { ...bundle([income, legacyTransfer()]), meta: { schemaVersion: 8, name: 'B', policies: ['strict-ledger'] } };
    loadBudgetData.mockImplementation(async () => strict);
    const dispatch = vi.spyOn(session, 'dispatch');

    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });

    expect(dispatch.mock.calls[0]).toEqual(['transaction.repairTransferEndpoints', { force: true }]);
    expect(state.transactions.find(x => x.id === 'et1')).toMatchObject({ from_envelope_id: 'food', to_envelope_id: 'fun' });
    expect(toastTexts()).toContain(t('transfers.repaired')(1));
    expect(toastTexts()).not.toContain(t('transfers.repairFailed'));
  });

  it('warns about repaired endpoints that name an envelope that no longer exists', async () => {
    loadBudgetData.mockImplementation(async () => bundle([{ ...legacyTransfer(), to_envelope: 'gone' }]));
    await loadBudgetIntoState(b);
    expect(state.transactions[0]).toMatchObject({ from_envelope_id: 'food', to_envelope_id: 'gone' });
    expect(warn).toHaveBeenCalledWith('[bunvelope] repaired endpoints referencing unknown envelopes:', ['gone']);
  });

  it('a refused write says so, leaves the rows as loaded, and the load carries on', async () => {
    const rows = [income, legacyTransfer()];
    loadBudgetData.mockImplementation(async () => bundle(rows));
    writeBatch.mockRejectedValueOnce(new Error('disk full'));

    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });

    expect(toastTexts()).toContain(t('transfers.repairFailed'));
    expect(toastTexts()).not.toContain(t('transfers.repaired')(1));
    expect(warn).toHaveBeenCalledWith('[bunvelope] envelope-transfer repair could not be saved:', expect.anything());
    // Nothing was published: the transfer keeps its pre-v3 keys until the next load retries.
    expect(state.transactions.find(x => x.id === 'et1')).toMatchObject({ from_envelope: 'food', to_envelope: 'fun' });
    expect(state.transactions.find(x => x.id === 'et1').from_envelope_id).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('dashboard');
    expect(runDueScheduled).toHaveBeenCalledTimes(1);
  });

  it('a dispatch that throws is reported the same way, and the load carries on', async () => {
    loadBudgetData.mockImplementation(async () => bundle([legacyTransfer()]));
    const dispatch = vi.spyOn(session, 'dispatch');
    dispatch.mockImplementationOnce(async () => { throw new Error('boom'); });

    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });

    expect(dispatch.mock.calls[0][0]).toBe('transaction.repairTransferEndpoints');
    expect(toastTexts()).toContain(t('transfers.repairFailed'));
    expect(state.transactions[0].from_envelope).toBe('food');
    expect(navigate).toHaveBeenCalledWith('dashboard');
  });

  it('with nothing to repair it dispatches nothing new and says nothing', async () => {
    loadBudgetData.mockImplementation(async () => bundle([income]));
    const dispatch = vi.spyOn(session, 'dispatch');
    await loadBudgetIntoState(b);
    await flushAll();
    expect(dispatchedNames(dispatch)).toEqual(['template.convertIncomeLinked', 'envelope.archiveDeleted']);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(toastTexts()).not.toContain(t('transfers.repaired')(1));
  });

  it('a newer load while the repair write is pending: the old load gives up quietly', async () => {
    const write = deferred();
    writeBatch.mockImplementationOnce(() => write.promise);
    loadBudgetData.mockImplementation(async ref => (ref === a ? bundle([legacyTransfer()], 'A') : bundle([income], 'B')));

    const first = loadBudgetIntoState(a);
    await vi.waitFor(() => expect(writeBatch).toHaveBeenCalledTimes(1));
    await expect(loadBudgetIntoState(b)).resolves.toEqual({ loaded: true });
    navigate.mockClear();

    write.resolve();
    await expect(first).resolves.toEqual({ loaded: false, superseded: true });
    await flushAll();
    expect(state.budgetFolder).toBe(b);
    expect(state.transactions).toEqual([income]);
    expect(toastTexts()).not.toContain(t('transfers.repaired')(1));
    expect(navigate).not.toHaveBeenCalled();
  });
});
