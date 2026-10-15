// @vitest-environment jsdom
// runDueScheduled dispatches month.start through the session: the rollover
// and what is due, written through writeBatch, published into state only after
// the write lands. The old code assigned state first and rolled back on a
// failed write; the session never publishes a write that failed, so state is
// simply unchanged. Fake writeBatch, real app.js.
import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi, describe } from 'vitest';

const writeBatch = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../js/data.js', async (importOriginal) => ({ ...(await importOriginal()), writeBatch }));
vi.mock('../js/ui/shell.js', () => ({
  buildShell: () => {}, highlightActive: () => {}, applyPrefs: () => {},
  relabelShell: () => {}, setNavItemVisible: () => {}, refreshAiEntryPoints: () => {},
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../js/ui/toast.js', () => ({ toast }));
const showVersionConflictDialog = vi.hoisted(() => vi.fn());
vi.mock('../js/ui/save-error.js', async (importOriginal) => ({ ...(await importOriginal()), showVersionConflictDialog }));

import { allPayees } from '../js/state/payee-index.js';

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
const rentItem = () => ({
  id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'env', account_id: 'chk',
  as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
  default_amount: -100, payment_day: 5, schedule_day_type: 'exact', include: true,
});

function seed(over = {}) {
  Object.assign(app.state, {
    budgetFolder: { __guest: true },
    envelopes: [{ id: 'env', name: 'Rent' }],
    envelopeTemplates: [],
    budgetItems: [rentItem()],
    transactions: [],
    accounts: [{ id: 'chk', name: 'Checking' }],
    meta: { schemaVersion: 8 },
    currentPage: null,
    ...over,
  });
}

// Local time, so the engine's local-date reads agree in every timezone.
function pinNow(y, m, d) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(y, m, d, 12));
}

let errorSpy;
beforeEach(() => {
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  toast.mockClear();
  showVersionConflictDialog.mockClear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); errorSpy.mockRestore(); });

describe('runDueScheduled through month.start', () => {
  it('posts a due item through writeBatch and publishes it into state', async () => {
    pinNow(2026, 9, 15);
    seed();
    const result = await app.runDueScheduled();
    expect(result).toEqual({ emitted: 1, posted: 1 });
    expect(writeBatch).toHaveBeenCalledTimes(1);
    const [ref, items] = writeBatch.mock.calls[0];
    expect(ref).toBe(app.state.budgetFolder);
    expect(items.map(x => x.filename)).toEqual(['transactions.json', 'budget-meta.json']);
    expect(items[1].data.last_rollover_month).toBe('2026-09');
    expect(items[0].filename).toBe('transactions.json');
    expect(items[0].data).toHaveLength(1);
    expect(items[0].data[0]).toMatchObject({ type: 'expense', from_budget: 'rent:2026-10', date: '2026-10-05', amount: 100 });
    expect(app.state.transactions).toBe(items[0].data);
  });

  it('posts nothing on a second call and does not write', async () => {
    pinNow(2026, 9, 15);
    seed();
    await app.runDueScheduled();
    writeBatch.mockClear();
    expect(await app.runDueScheduled()).toEqual({ emitted: 0, posted: 0 });
    expect(writeBatch).not.toHaveBeenCalled();
    expect(app.state.transactions).toHaveLength(1);
  });

  it('a failed write shows the scheduledPostFailed toast and leaves state unchanged', async () => {
    pinNow(2026, 9, 15);
    seed();
    const before = app.state.transactions;
    writeBatch.mockRejectedValue(new Error('disk full'));
    const result = await app.runDueScheduled();
    expect(result).toEqual({ emitted: 0, error: 'disk full' });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toContain('disk full');
    expect(toast.mock.calls[0][1]).toEqual({ assertive: true });
    expect(app.state.transactions).toBe(before);
    expect(app.state.transactions).toHaveLength(0);
    expect(app.state.meta.last_rollover_month).toBeUndefined();
    // Idempotent retry: the next run posts it once the disk works again.
    writeBatch.mockImplementation(async () => {});
    expect(await app.runDueScheduled()).toEqual({ emitted: 1, posted: 1 });
  });

  it('a version conflict opens the conflict dialog instead of a toast', async () => {
    pinNow(2026, 9, 15);
    seed();
    writeBatch.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    const result = await app.runDueScheduled();
    expect(result.emitted).toBe(0);
    expect(result.error).toBe('version_conflict');
    expect(showVersionConflictDialog).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(app.state.transactions).toHaveLength(0);
  });

  it('keeps a fill dated into the closing month out of the sweep', async () => {
    // Nov 1 2026 is a Sunday: a day-1 prev_work_day fill is dated Fri Oct 30.
    pinNow(2026, 10, 2);
    seed({
      budgetItems: [],
      envelopes: [{ id: 'groc', name: 'Groceries', rollover: 'zero-monthly' }],
      transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: 100, from_envelope_id: null, to_envelope_id: 'groc' }],
      envelopeTemplates: [{
        id: 'tpl', name: 'Start of month', kind: 'manual',
        lines: [{ envelope_id: 'groc', mode: 'add', amount: 300 }],
        schedule: { enabled: true, payment_day: 1, day_type: 'prev_work_day', since: '2026-11-01', months: ALL_MONTHS },
      }],
    });
    // One fill posted, one rollover adjustment.
    expect(await app.runDueScheduled()).toEqual({ emitted: 2, posted: 1 });
    const rows = app.state.transactions.slice(1);
    expect(rows.find(x => x.type === 'adjustment')).toMatchObject({ amount: -100, date: '2026-10-31', from_budget: 'rollover:groc:2026-10' });
    expect(rows.find(x => x.type === 'fill')).toMatchObject({ date: '2026-10-30', from_budget: 'tpl:tpl:2026-11' });
    const { computeEnvelopeBalances } = await import('../js/engine.js');
    expect(computeEnvelopeBalances(app.state.transactions, { asOf: new Date(2026, 10, 30) }).get('groc')).toBe(300);
  });

  it('does not alias the payee of the rows it posts', async () => {
    pinNow(2026, 9, 15);
    seed({ meta: { schemaVersion: 8, payeeAliases: { Rent: 'Landlord' } } });
    await app.runDueScheduled();
    expect(app.state.transactions[0].payee).toBe('Rent');
  });

  it('marks the payee index stale after publishing', async () => {
    pinNow(2026, 9, 15);
    seed();
    // Build the index first, as a page read would; the session's publish hook
    // (markPayeeIndexStale) must make the next read pick the posted row up.
    expect(allPayees(app.state)).not.toContain('Rent');
    await app.runDueScheduled();
    expect(app.state.transactions[0].payee).toBe('Rent');
    expect(allPayees(app.state)).toContain('Rent');
  });

  describe('deferWrite', () => {
    it('does not await the write: returns pendingWrite and publishes when it lands', async () => {
      pinNow(2026, 9, 15);
      seed();
      let release;
      writeBatch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
      const result = await app.runDueScheduled({ deferWrite: true });
      expect(result).toMatchObject({ emitted: 0, pendingWrite: true });
      await vi.waitFor(() => expect(writeBatch).toHaveBeenCalled());
      // Not in state until the write lands.
      expect(app.state.transactions).toHaveLength(0);
      release();
      expect(await result.settled).toEqual({ posted: 1, adjusted: 0, published: true });
      expect(app.state.transactions).toHaveLength(1);
      // The caller owns the repaint: nothing here navigated.
      expect(app.state.currentPage).toBeNull();
    });

    it('settles with nothing published when there was nothing to post', async () => {
      pinNow(2026, 9, 15);
      seed({ budgetItems: [], meta: { schemaVersion: 8, last_rollover_month: '2026-09' } });
      const result = await app.runDueScheduled({ deferWrite: true });
      expect(await result.settled).toEqual({ posted: 0, adjusted: 0, published: false });
      expect(writeBatch).not.toHaveBeenCalled();
    });

    it('reports a failed deferred write with the toast and leaves state unchanged', async () => {
      pinNow(2026, 9, 15);
      seed();
      writeBatch.mockRejectedValue(new Error('offline'));
      const result = await app.runDueScheduled({ deferWrite: true });
      expect(result).toMatchObject({ emitted: 0, pendingWrite: true });
      expect(await result.settled).toEqual({ posted: 0, adjusted: 0, published: false, error: 'offline' });
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast.mock.calls[0][0]).toContain('offline');
      expect(app.state.transactions).toHaveLength(0);
    });
  });
});
