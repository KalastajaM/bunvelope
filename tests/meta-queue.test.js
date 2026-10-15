import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMetaQueue, StaleBudgetError, metaWritesPending, BudgetLoadingError } from '../js/state/meta-queue.js';

import { beginBudgetSession, holdBudget, releaseBudget } from '../js/state/budget-session.js';

beforeEach(() => beginBudgetSession());

const flush = () => new Promise(r => setTimeout(r, 0));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function harness() {
  const writes = [];
  const gates = [];
  const { update, runExclusive } = createMetaQueue((folder, meta) => { writes.push({ folder, meta }); const d = deferred(); gates.push(d); return d.promise; });
  const state = { budgetFolder: 'A', meta: { a: 0, b: 0 } };
  return { update, runExclusive, writes, gates, state };
}

describe('createMetaQueue', () => {
  it('serialises writes and builds each on the previous result', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const p2 = h.update(h.state, m => ({ ...m, b: 2 }));
    await flush();
    expect(h.writes).toHaveLength(1);
    h.gates[0].resolve(); await p1; await flush();
    expect(h.writes[1].meta).toEqual({ a: 1, b: 2 });
    h.gates[1].resolve(); await p2;
    expect(h.state.meta).toEqual({ a: 1, b: 2 });
  });

  it('sets state.meta only after the write resolves', async () => {
    const h = harness();
    const p = h.update(h.state, m => ({ ...m, a: 9 }));
    await flush();
    expect(h.state.meta.a).toBe(0);
    h.gates[0].resolve(); await p;
    expect(h.state.meta.a).toBe(9);
  });

  it('leaves meta untouched on a failed write and still runs the next', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const p2 = h.update(h.state, m => ({ ...m, b: 2 }));
    await flush();
    h.gates[0].reject(new Error('offline'));
    await expect(p1).rejects.toThrow('offline');
    await flush();
    expect(h.writes[1].meta).toEqual({ a: 0, b: 2 });
    h.gates[1].resolve(); await p2;
    expect(h.state.meta).toEqual({ a: 0, b: 2 });
  });

  it('drops a queued patch whose budget was switched away, without writing', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const p2 = h.update(h.state, m => ({ ...m, b: 2 }));   // queued for budget A
    await flush();
    h.state.budgetFolder = 'B';
    h.state.meta = { other: true };
    h.gates[0].resolve();
    await p1;
    await expect(p2).rejects.toBeInstanceOf(StaleBudgetError);
    expect(h.writes).toHaveLength(1);
    expect(h.state.meta).toEqual({ other: true });   // p1 finished after the switch: not applied to B
  });

  it('writes to the folder captured at call time', async () => {
    const h = harness();
    const p = h.update(h.state, m => ({ ...m, a: 1 }));
    await flush();
    expect(h.writes[0].folder).toBe('A');
    h.gates[0].resolve(); await p;
  });

  it('drops a write whose budget was switched while its patch ran', async () => {
    const h = harness();
    const p = h.update(h.state, async (m) => {
      h.state.budgetFolder = 'B';          // user switches budget mid-patch
      await Promise.resolve();
      return { ...m, a: 1 };
    });
    await expect(p).rejects.toBeInstanceOf(StaleBudgetError);
    expect(h.writes).toHaveLength(0);
    expect(h.state.meta).toEqual({ a: 0, b: 0 });
  });
});

describe('createMetaQueue runExclusive', () => {
  // A callback that records the meta it was handed and returns a write held
  // until the test releases it.
  function exclusive(h, makeMeta) {
    const seen = [];
    const gate = deferred();
    const write = vi.fn(() => gate.promise);
    const p = h.runExclusive(h.state, async (latest) => { seen.push(latest); return { meta: makeMeta(latest), write }; });
    return { p, seen, write, gate };
  }

  it('waits its turn, runs on the meta the previous write produced, writes through its own write and never calls save', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const x = exclusive(h, m => ({ ...m, b: 2 }));
    await flush();
    expect(x.seen).toEqual([]);
    h.gates[0].resolve(); await p1; await flush();
    expect(x.seen).toEqual([{ a: 1, b: 0 }]);
    expect(x.write).toHaveBeenCalledTimes(1);
    expect(h.state.meta).toEqual({ a: 1, b: 0 });   // not before the write lands
    x.gate.resolve();
    await expect(x.p).resolves.toEqual({ a: 1, b: 2 });
    expect(h.state.meta).toEqual({ a: 1, b: 2 });
    expect(h.writes).toHaveLength(1);               // only the update's save
  });

  it('runs before an update queued after it, which then builds on its meta', async () => {
    const h = harness();
    const x = exclusive(h, m => ({ ...m, a: 5 }));
    const p2 = h.update(h.state, m => ({ ...m, b: m.a + 1 }));
    await flush();
    expect(h.writes).toHaveLength(0);
    x.gate.resolve(); await x.p; await flush();
    expect(h.writes[0].meta).toEqual({ a: 5, b: 6 });
    h.gates[0].resolve(); await p2;
  });

  it('throws StaleBudgetError when the budget switched while it waited, without calling back', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const x = exclusive(h, m => ({ ...m, b: 2 }));
    await flush();
    h.state.budgetFolder = 'B';
    h.state.meta = { other: true };
    h.gates[0].resolve(); await p1;
    await expect(x.p).rejects.toBeInstanceOf(StaleBudgetError);
    expect(x.seen).toEqual([]);
    expect(x.write).not.toHaveBeenCalled();
    expect(h.state.meta).toEqual({ other: true });
  });

  it('does not assign meta into a budget opened while its write was in flight', async () => {
    const h = harness();
    const x = exclusive(h, m => ({ ...m, a: 7 }));
    await flush();
    expect(x.write).toHaveBeenCalledTimes(1);
    h.state.budgetFolder = 'B';
    h.state.meta = { other: true };
    x.gate.resolve();
    await x.p;
    expect(h.state.meta).toEqual({ other: true });
  });

  it('leaves meta untouched when its write fails, and still runs the next', async () => {
    const h = harness();
    const x = exclusive(h, m => ({ ...m, a: 1 }));
    const p2 = h.update(h.state, m => ({ ...m, b: 2 }));
    await flush();
    x.gate.reject(new Error('offline'));
    await expect(x.p).rejects.toThrow('offline');
    expect(h.state.meta).toEqual({ a: 0, b: 0 });
    await flush();
    expect(h.writes[0].meta).toEqual({ a: 0, b: 2 });
    h.gates[0].resolve(); await p2;
  });

  it('passes on an error the callback throws, writing nothing', async () => {
    const h = harness();
    const p = h.runExclusive(h.state, async () => { throw new Error('refused'); });
    await expect(p).rejects.toThrow('refused');
    expect(h.state.meta).toEqual({ a: 0, b: 0 });
  });

  it('counts as pending while queued and while its write is in flight', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const x = exclusive(h, m => m);
    expect(metaWritesPending()).toBe(true);
    await flush();
    expect(x.write).not.toHaveBeenCalled();
    expect(metaWritesPending()).toBe(true);
    h.gates[0].resolve(); await p1; await flush();
    expect(x.write).toHaveBeenCalledTimes(1);
    expect(metaWritesPending()).toBe(true);
    x.gate.resolve(); await x.p; await flush();
    expect(metaWritesPending()).toBe(false);
  });
});


describe('metadata during budget loads', () => {
  it('refuses immediately while held, even if released before its turn', async () => {
    const h = harness();
    const held = holdBudget();
    const patch = vi.fn(m => m);
    const p = h.update(h.state, patch);
    releaseBudget(held);
    await expect(p).rejects.toBeInstanceOf(BudgetLoadingError);
    expect(patch).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it('refuses a queued patch when a hold starts before its turn', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    await flush();
    const p2 = h.update(h.state, m => ({ ...m, b: 2 }));
    const refused = expect(p2).rejects.toBeInstanceOf(BudgetLoadingError);
    holdBudget();
    h.gates[0].resolve();
    await p1; await refused;
    expect(h.writes).toHaveLength(1);
    expect(h.state.meta).toEqual({ a: 0, b: 0 });
  });

  it('checks again after an asynchronous patch', async () => {
    const h = harness();
    const p = h.update(h.state, async m => { holdBudget(); return { ...m, a: 1 }; });
    await expect(p).rejects.toBeInstanceOf(BudgetLoadingError);
    expect(h.writes).toEqual([]);
  });

  it('does not publish or run queued work after reopening the same folder', async () => {
    const h = harness();
    const p1 = h.update(h.state, m => ({ ...m, a: 1 }));
    const p2 = h.update(h.state, m => ({ ...m, b: 2 }));
    const refused = expect(p2).rejects.toBeInstanceOf(StaleBudgetError);
    await flush();
    beginBudgetSession();
    h.state.meta = { reopened: true };
    h.gates[0].resolve();
    await p1; await refused;
    expect(h.writes).toHaveLength(1);
    expect(h.state.meta).toEqual({ reopened: true });
  });
});
