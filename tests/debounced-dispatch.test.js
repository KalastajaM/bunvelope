// Live edits (sliders, toggles) send one budgetItem.update per id after a quiet
// window, and the unload guard sees the window as unsaved work.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncedDispatch } from '../js/ui/debounced-dispatch.js';
import { hasUnsavedWrites, pendingSourceCount } from '../js/state/unload-guard.js';

function setup(over = {}) {
  const calls = [];
  const session = {
    dispatch: vi.fn(async (name, input) => {
      calls.push([name, input]);
      return over.result ?? { ok: true, value: {} };
    }),
  };
  const settled = [];
  const folder = { current: 'A' };
  const d = createDebouncedDispatch({
    session,
    command: 'budgetItem.update',
    onSettled: (id, result) => settled.push([id, result]),
    currentFolder: () => folder.current,
  });
  return { d, calls, session, settled, folder };
}

describe('createDebouncedDispatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces two sets on one id into one dispatch with merged fields', async () => {
    const { d, calls } = setup();
    d.set('i1', { default_amount: -10 });
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([['budgetItem.update', { id: 'i1', fields: { default_amount: -10, include: false } }]]);
  });

  it('sends one dispatch per id', async () => {
    const { d, calls } = setup();
    d.set('i1', { include: false });
    d.set('i2', { include: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.map(([, i]) => i.id).sort()).toEqual(['i1', 'i2']);
  });

  it('the latest value for a key wins, and each set restarts the timer', async () => {
    const { d, calls } = setup();
    d.set('i1', { default_amount: -10 });
    await vi.advanceTimersByTimeAsync(300);
    d.set('i1', { default_amount: -20 });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([['budgetItem.update', { id: 'i1', fields: { default_amount: -20 } }]]);
  });

  it('pending(id) is the merged fields while waiting, and null once nothing is outstanding', async () => {
    const { d } = setup();
    expect(d.pending('i1')).toBeNull();
    d.set('i1', { default_amount: -10 });
    d.set('i1', { include: false });
    expect(d.pending('i1')).toEqual({ default_amount: -10, include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(d.pending('i1')).toBeNull();
  });

  it('keeps the overlay while the dispatch is in flight', async () => {
    let release;
    const session = { dispatch: vi.fn(() => new Promise((r) => { release = r; })) };
    const d = createDebouncedDispatch({ session, command: 'c', onSettled() {}, currentFolder: () => 'A' });
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(d.pending('i1')).toEqual({ include: false });
    expect(d.hasPending()).toBe(true);
    release({ ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.pending('i1')).toBeNull();
    expect(d.hasPending()).toBe(false);
  });

  it('hands a failure to onSettled with the result', async () => {
    const failure = { ok: false, error: { code: 'bad_input', params: {} } };
    const { d, settled } = setup({ result: failure });
    d.set('i1', { default_amount: 0 });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toEqual([['i1', failure]]);
  });

  it('treats a thrown dispatch as a failure', async () => {
    const session = { dispatch: vi.fn(async () => { throw new Error('boom'); }) };
    const settled = [];
    const d = createDebouncedDispatch({ session, command: 'c', onSettled: (id, r) => settled.push([id, r]), currentFolder: () => 'A' });
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toHaveLength(1);
    expect(settled[0][1].ok).toBe(false);
    expect(settled[0][1].error.params.message).toBe('boom');
    expect(d.hasPending()).toBe(false);
  });

  it('a dispatch that throws synchronously settles as a failure and leaves nothing in flight', async () => {
    const session = { dispatch: vi.fn(() => { throw new Error('sync boom'); }) };
    const settled = [];
    const d = createDebouncedDispatch({ session, command: 'c', onSettled: (id, r) => settled.push([id, r]), currentFolder: () => 'A' });
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toHaveLength(1);
    expect(settled[0][1].error.params.message).toBe('sync boom');
    expect(d.hasPending()).toBe(false);
    expect(d.pending('i1')).toBeNull();
    expect(hasUnsavedWrites()).toBe(false);
    d.set('i1', { include: true });
    await d.flush(); // resolves: nothing stays in flight
    expect(settled).toHaveLength(2);
  });

  it('dropAll dispatches nothing', async () => {
    const { d, calls } = setup();
    d.set('i1', { include: false });
    d.dropAll();
    expect(d.hasPending()).toBe(false);
    expect(d.pending('i1')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
  });

  it('flush dispatches everything pending now and resolves once settled', async () => {
    const { d, calls, settled } = setup();
    d.set('i1', { include: false });
    d.set('i2', { include: true });
    await d.flush();
    expect(calls).toHaveLength(2);
    expect(settled).toHaveLength(2);
    expect(d.hasPending()).toBe(false);
  });

  it('hasUnsavedWrites() is true during the window and false after', async () => {
    const { d } = setup();
    expect(hasUnsavedWrites()).toBe(false);
    d.set('i1', { include: false });
    expect(hasUnsavedWrites()).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(hasUnsavedWrites()).toBe(false);
  });

  it('a folder change before firing gives no dispatch and nothing pending', async () => {
    const { d, calls, folder, settled } = setup();
    d.set('i1', { include: false });
    folder.current = 'B';
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([]);
    expect(settled).toEqual([]);
    expect(d.hasPending()).toBe(false);
  });

  it('pending(id) shows nothing queued or in flight for another budget', async () => {
    let release;
    const session = { dispatch: vi.fn(() => new Promise((r) => { release = r; })) };
    const folder = { current: 'A' };
    const d = createDebouncedDispatch({ session, command: 'c', currentFolder: () => folder.current });
    d.set('i1', { include: false });
    folder.current = 'B';
    expect(d.pending('i1')).toBeNull();
    folder.current = 'A';
    await vi.advanceTimersByTimeAsync(400);
    expect(session.dispatch).toHaveBeenCalledTimes(1);
    expect(d.pending('i1')).toEqual({ include: false });
    folder.current = 'B';
    expect(d.pending('i1')).toBeNull();
    release({ ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a set after a switch does not carry the old budget\'s fields along', async () => {
    const { d, calls, folder } = setup();
    d.set('i1', { default_amount: -10 });
    folder.current = 'B';
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toEqual([['budgetItem.update', { id: 'i1', fields: { include: false } }]]);
  });

  it('orders two edits on one id: the second carries the latest values and the overlay holds until both settle', async () => {
    const releases = [];
    const inputs = [];
    const session = { dispatch: vi.fn((name, input) => { inputs.push(input); return new Promise((r) => releases.push(r)); }) };
    const d = createDebouncedDispatch({ session, command: 'c', onSettled() {}, currentFolder: () => 'A' });
    d.set('i1', { default_amount: -10 });
    await vi.advanceTimersByTimeAsync(400);
    d.set('i1', { default_amount: -20, include: false });
    expect(d.pending('i1')).toEqual({ default_amount: -20, include: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(inputs).toEqual([
      { id: 'i1', fields: { default_amount: -10 } },
      { id: 'i1', fields: { default_amount: -20, include: false } },
    ]);
    expect(d.pending('i1')).toEqual({ default_amount: -20, include: false });
    releases[0]({ ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.pending('i1')).toEqual({ default_amount: -20, include: false });
    releases[1]({ ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.pending('i1')).toBeNull();
    expect(d.hasPending()).toBe(false);
  });

  it('dropAll with a dispatch in flight gets no onSettled', async () => {
    let release;
    const session = { dispatch: vi.fn(() => new Promise((r) => { release = r; })) };
    const settled = [];
    const d = createDebouncedDispatch({ session, command: 'c', onSettled: (id, r) => settled.push([id, r]), currentFolder: () => 'A' });
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    d.dropAll();
    expect(d.hasPending()).toBe(false);
    release({ ok: false, error: { code: 'x', params: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual([]);
  });

  it('a dispatch that settles after a folder change gets no onSettled', async () => {
    let release;
    const session = { dispatch: vi.fn(() => new Promise((r) => { release = r; })) };
    const settled = [];
    const folder = { current: 'A' };
    const d = createDebouncedDispatch({ session, command: 'c', onSettled: (id, r) => settled.push([id, r]), currentFolder: () => folder.current });
    d.set('i1', { include: false });
    await vi.advanceTimersByTimeAsync(400);
    folder.current = 'B';
    release({ ok: false, error: { code: 'x', params: {} } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual([]);
  });

  it('drop(id) forgets that id only and stops its timer', async () => {
    const { d, calls } = setup();
    d.set('i1', { include: false });
    d.set('i2', { include: true });
    d.drop('i1');
    expect(d.pending('i1')).toBeNull();
    expect(d.pending('i2')).toEqual({ include: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(calls.map(([, i]) => i.id)).toEqual(['i2']);
  });

  it('flush also awaits a dispatch queued while it waits', async () => {
    const { d, calls, session } = setup();
    d.set('i1', { default_amount: -10 });
    let first = true;
    session.dispatch.mockImplementation(async (name, input) => {
      calls.push([name, input]);
      if (first) { first = false; d.set('i2', { include: true }); }
      return { ok: true, value: {} };
    });
    const p = d.flush();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(calls.map(([, i]) => i.id)).toEqual(['i1', 'i2']);
    expect(d.hasPending()).toBe(false);
  });

  it('registers with the guard lazily and unregisters when idle', async () => {
    const before = pendingSourceCount();
    const { d } = setup();
    expect(pendingSourceCount()).toBe(before);
    d.set('i1', { include: false });
    expect(pendingSourceCount()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(400);
    expect(pendingSourceCount()).toBe(before);
    expect(hasUnsavedWrites()).toBe(false);
    d.set('i1', { include: true });
    expect(pendingSourceCount()).toBe(before + 1);
    d.dispose();
    expect(pendingSourceCount()).toBe(before);
    expect(hasUnsavedWrites()).toBe(false);
  });
});

describe('registerPending', () => {
  it('ORs every registered fn into hasUnsavedWrites and unregisters', async () => {
    const { registerPending } = await import('../js/state/unload-guard.js');
    let on = false;
    const off = registerPending(() => on);
    expect(hasUnsavedWrites()).toBe(false);
    on = true;
    expect(hasUnsavedWrites()).toBe(true);
    off();
    expect(hasUnsavedWrites()).toBe(false);
  });
});

it('reports a failed flush to dependent actions, and allows a later successful retry', async () => {
  const session = { dispatch: vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'write_failed' } }).mockResolvedValue({ ok: true }) };
  const d = createDebouncedDispatch({ session, command: 'c', currentFolder: () => 'A' });
  d.set('i1', { include: true });
  expect(await d.flush()).toBe(false);
  d.set('i1', { include: true });
  expect(await d.flush()).toBe(true);
  d.dispose();
});
