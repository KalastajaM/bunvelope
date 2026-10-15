// tests/session-browser.test.js
import { describe, it, expect, vi } from 'vitest';
import { createBrowserSession, BROWSER_WRITABLE } from '../js/session/browser-session.js';
import { createRegistry } from '../js/core/registry.js';
import { ok, fail } from '../js/core/result.js';
import { createMetaQueue, metaWritesPending } from '../js/state/meta-queue.js';
import accountReorder from '../js/core/commands/account-reorder.js';
import accountCreate from '../js/core/commands/account-create.js';
import envelopeUpdate from '../js/core/commands/envelope-update.js';
import budgetItemUpdate from '../js/core/commands/budget-item-update.js';
import templateUpdate from '../js/core/commands/template-update.js';
import templateConvertIncomeLinked from '../js/core/commands/template-convert-income-linked.js';
import transactionDelete from '../js/core/commands/transaction-delete.js';
import monthReopen from '../js/core/commands/month-reopen.js';
import monthClearReopen from '../js/core/commands/month-clear-reopen.js';
import payeeHide from '../js/core/commands/payee-hide.js';
import settingsUpdate from '../js/core/commands/settings-update.js';
import transactionRecord from '../js/core/commands/transaction-record.js';
import balancesQuery from '../js/core/queries/balances.js';

function setup({ writeBatch, generation, writableKinds, isLoading } = {}) {
  const registry = createRegistry();
  registry.defineCommand({
    name: 'test.add',
    summary: 'Add an expense row',
    input: { type: 'object', properties: { date: { type: 'date' }, note: { type: 'string' } } },
    execute(d, input, c) {
      const row = { id: c.newId(), type: 'expense', amount: 5, date: input.date ?? c.todayIso, account: 'bank', note: input.note ?? '' };
      return ok({ changes: { transactions: [...d.transactions, row] }, value: row });
    },
  });
  // Two commands over one body: they differ only in whether payees are aliased.
  const addWithPayee = (d, input, c) => {
    const row = { id: c.newId(), type: 'expense', amount: 5, date: c.todayIso, account: 'bank', payee: input.payee };
    return ok({ changes: { transactions: [...d.transactions, row] }, value: row });
  };
  const payeeInput = { type: 'object', properties: { payee: { type: 'string' } } };
  registry.defineCommand({ name: 'test.addRaw', summary: 'Add a row the app generated', payeeAliases: false, input: payeeInput, execute: addWithPayee });
  registry.defineCommand({ name: 'test.addPayee', summary: 'Add a row with a payee', input: payeeInput, execute: addWithPayee });
  registry.defineCommand({
    name: 'test.meta', summary: 'x', input: { type: 'object', properties: {} },
    execute: (d) => ok({ changes: { meta: { ...d.meta, x: 1 } }, value: null }),
  });
  registry.defineCommand({
    name: 'test.del', summary: 'x', input: { type: 'object', properties: { id: { type: 'string' } } },
    execute(d, input) {
      const row = d.transactions.find(t => t.id === input.id);
      const tomb = Array.isArray(d.meta.scheduledTombstones) ? d.meta.scheduledTombstones : [];
      return ok({
        changes: { transactions: d.transactions.filter(t => t.id !== input.id), meta: { ...d.meta, scheduledTombstones: [...tomb, row.from_budget] } },
        value: null,
      });
    },
  });
  registry.defineCommand({
    name: 'test.items', summary: 'x', input: { type: 'object', properties: {} },
    execute: (d) => ok({ changes: { budgetItems: [...d.budgetItems, { id: 'b', name: 'Rent' }] }, value: null }),
  });
  registry.defineQuery({ name: 'test.count', summary: 'x', input: { type: 'object', properties: {} }, run: (d) => ok(d.transactions.length) });
  const state = {
    budgetFolder: { name: 'A' },
    meta: { schemaVersion: 8, country: 'FI' }, accounts: [{ id: 'bank', name: 'Bank' }], envelopes: [], budgetItems: [], envelopeTemplates: [],
    transactions: [],
  };
  let gen = generation ?? 1;
  let n = 0;
  const writes = [];
  const notify = vi.fn();
  // The real meta queue over a recording save, so updateMeta and the
  // session's meta-primary commits share one queue as they do in the app.
  const saveMeta = vi.fn(async () => {});
  const queue = createMetaQueue((folder, meta) => saveMeta(folder, meta));
  const updateMeta = vi.fn(queue.update);
  const runMetaExclusive = vi.fn(queue.runExclusive);
  const session = createBrowserSession({
    state, registry, updateMeta, runMetaExclusive,
    writeBatch: writeBatch ?? (async (ref, items) => { writes.push({ ref, items }); }),
    currentGeneration: () => gen,
    notify,
    clock: () => new Date(2026, 9, 15, 12),
    newId: () => `id${++n}`,
    isVersionConflict: (err) => err?.status === 409,
    ...(writableKinds ? { writableKinds } : {}),
    ...(isLoading ? { isLoading } : {}),
  });
  return { state, session, writes, notify, registry, queue, updateMeta, runMetaExclusive, saveMeta, setGen: (g) => { gen = g; } };
}

// A writeBatch that reports when it has been called and stays pending until
// released, so a test can change state while the session's write is in flight
// (not merely before the session took its snapshot).
function heldWrite({ thenImmediate = false } = {}) {
  let release;
  let started;
  const startedP = new Promise((r) => { started = r; });
  const calls = [];
  const writeBatch = (ref, items) => {
    calls.push(items);
    if (calls.length === 1) { started(); return new Promise((r) => { release = r; }); }
    return thenImmediate ? Promise.resolve() : new Promise(() => {});
  };
  return { writeBatch, startedP, calls, release: () => release() };
}

describe('BrowserSession', () => {
  it('the default write scope is frozen: every collection and meta', () => {
    expect(Object.isFrozen(BROWSER_WRITABLE)).toBe(true);
    expect([...BROWSER_WRITABLE]).toEqual(['transactions', 'meta', 'accounts', 'envelopes', 'budgetItems', 'envelopeTemplates']);
  });

  it('commits and publishes a budgetItem.update by default', async () => {
    const ctl = setup();
    ctl.registry.defineCommand(budgetItemUpdate);
    ctl.state.budgetItems = [{
      id: 'rent-item', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -900, include: true,
      monthly_schedule: {}, as_schedule: false, account_id: null, as_schedule_since: null, payment_day: 1,
    }];
    ctl.state.envelopes = [{ id: 'rent', name: 'Rent' }];
    const before = ctl.state.budgetItems[0];
    const r = await ctl.session.dispatch('budgetItem.update', { id: 'rent-item', fields: { description: 'Flat rent' } });
    expect(r.ok).toBe(true);
    expect(r.value.committed).toBe(true);
    expect(r.value.published).toBe(true);
    expect(ctl.writes.map(w => w.items.map(i => i.filename))).toEqual([['budget-items.json', 'budget-meta.json']]);
    expect(ctl.state.budgetItems[0].description).toBe('Flat rent');
    expect(before.description).toBe('Rent');
    expect(ctl.notify).toHaveBeenCalledWith('budgetItems', 'meta');
  });

  it('commits and publishes a template.update by default', async () => {
    const ctl = setup();
    ctl.registry.defineCommand(templateUpdate);
    ctl.state.envelopes = [{ id: 'rent', name: 'Rent' }];
    ctl.state.envelopeTemplates = [{ id: 'monthly', name: 'Monthly', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }] }];
    const before = ctl.state.envelopeTemplates[0];
    const r = await ctl.session.dispatch('template.update', { id: 'monthly', fields: { name: 'Every month' } });
    expect(r.ok).toBe(true);
    expect(r.value.committed).toBe(true);
    expect(r.value.published).toBe(true);
    expect(ctl.writes.map(w => w.items.map(i => i.filename))).toEqual([['envelope-templates.json', 'budget-meta.json']]);
    expect(ctl.state.envelopeTemplates[0].name).toBe('Every month');
    expect(before.name).toBe('Monthly');
    expect(ctl.notify).toHaveBeenCalledWith('envelopeTemplates', 'meta');
  });

  it('commits and publishes an account.create by default', async () => {
    const ctl = setup();
    ctl.registry.defineCommand(accountCreate);
    const r = await ctl.session.dispatch('account.create', { name: 'Savings', type: 'savings' });
    expect(r.ok).toBe(true);
    expect(r.value.committed).toBe(true);
    expect(r.value.published).toBe(true);
    expect(ctl.writes.map(w => w.items.map(i => i.filename))).toEqual([['accounts.json', 'budget-meta.json']]);
    expect(ctl.state.accounts.map(a => a.id)).toEqual(['bank', 'savings']);
    expect(ctl.notify).toHaveBeenCalledWith('accounts', 'meta');
  });

  it('commits and publishes an envelope.update by default', async () => {
    const ctl = setup();
    ctl.registry.defineCommand(envelopeUpdate);
    ctl.state.envelopes = [{ id: 'food', name: 'Food', category: 'Daily' }];
    const r = await ctl.session.dispatch('envelope.update', { id: 'food', fields: { name: 'Groceries' } });
    expect(r.ok).toBe(true);
    expect(r.value.committed).toBe(true);
    expect(r.value.published).toBe(true);
    expect(ctl.writes.map(w => w.items.map(i => i.filename))).toEqual([['envelopes.json', 'budget-meta.json']]);
    expect(ctl.state.envelopes[0].name).toBe('Groceries');
    expect(ctl.notify).toHaveBeenCalledWith('envelopes', 'meta');
  });

  it('treats meta policies as a floor a caller cannot remove', async () => {
    const { state, session } = setup();
    state.meta = { ...state.meta, policies: ['strict-ledger'] };
    expect((await session.dispatch('test.add', { date: '2026-10-20' }, { policies: [] })).error.code).toBe('ledger_future_posted');
  });

  it('commits, then publishes and notifies', async () => {
    const { state, session, writes, notify } = setup();
    const r = await session.dispatch('test.add', {});
    expect(r.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].items[0].filename).toBe('transactions.json');
    expect(state.transactions).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith('transactions', 'meta');
    expect(r.value.published).toBe(true);
    expect(session.query('test.count', {})).toEqual(ok(1));
  });

  it('aliases payees by default, and not for a command that opts out', async () => {
    const { state, session } = setup();
    state.meta = { ...state.meta, payeeAliases: { 'k market': 'K-Market' } };
    expect((await session.dispatch('test.addRaw', { payee: 'k market' })).ok).toBe(true);
    expect((await session.dispatch('test.addPayee', { payee: 'k market' })).ok).toBe(true);
    expect(state.transactions.map(t => t.payee)).toEqual(['k market', 'K-Market']);
  });

  it('dry-runs without writing', async () => {
    const { state, session, writes } = setup();
    const r = await session.dispatch('test.add', {}, { dryRun: true });
    expect(r.value.committed).toBe(false);
    expect(r.value.diff.transactions.added).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
  });

  it('leaves state unchanged when the write fails', async () => {
    const { state, session } = setup({ writeBatch: async () => { throw Object.assign(new Error('409'), { status: 409 }); } });
    expect((await session.dispatch('test.add', {})).error.code).toBe('version_conflict');
    expect(state.transactions).toHaveLength(0);
    const { session: s2 } = setup({ writeBatch: async () => { throw new Error('disk full'); } });
    expect((await s2.dispatch('test.add', {})).error).toEqual({ code: 'write_failed', params: { message: 'disk full' } });
  });

  it('does not publish into a budget opened while the write was in flight', async () => {
    const held = heldWrite();
    const ctl = setup({ writeBatch: held.writeBatch });
    const pending = ctl.session.dispatch('test.add', {});
    await held.startedP;
    ctl.setGen(2);
    ctl.state.budgetFolder = { name: 'B' };
    held.release();
    const r = await pending;
    expect(r.value).toMatchObject({ committed: true, published: false, undo: null });
    expect(ctl.state.transactions).toHaveLength(0);
  });

  describe('while a load or the setup wizard holds the budget', () => {
    // The loader and the wizard hold the budget from the start of its session
    // until they publish its collections; state is cleared or stale meanwhile.
    function held() {
      let loading = true;
      const ctl = setup({ isLoading: () => loading });
      return { ctl, release: () => { loading = false; } };
    }

    it('refuses a dispatch with budget_loading, without reading or writing', async () => {
      const { ctl } = held();
      const execute = vi.fn(() => ok({ changes: {}, value: null }));
      ctl.registry.defineCommand({ name: 'test.spy', summary: 'x', input: { type: 'object', properties: {} }, execute });
      expect((await ctl.session.dispatch('test.add', {})).error).toEqual({ code: 'budget_loading', params: {} });
      expect((await ctl.session.dispatch('test.spy', {})).error.code).toBe('budget_loading');
      expect(execute).not.toHaveBeenCalled();
      expect(ctl.writes).toEqual([]);
      expect(ctl.state.transactions).toEqual([]);
      expect(ctl.updateMeta).not.toHaveBeenCalled();
    });

    it('refuses a batch and a meta-primary command the same way', async () => {
      const { ctl } = held();
      expect((await ctl.session.dispatchBatch([{ name: 'test.add', input: {} }])).error.code).toBe('budget_loading');
      expect((await ctl.session.dispatch('test.meta', {})).error.code).toBe('budget_loading');
      expect(ctl.writes).toEqual([]);
      expect(ctl.runMetaExclusive).not.toHaveBeenCalled();
      expect(ctl.state.meta.x).toBeUndefined();
    });

    it('refuses an undo with budget_loading', async () => {
      let loading = false;
      const ctl = setup({ isLoading: () => loading });
      const done = await ctl.session.dispatch('test.add', {});
      expect(done.ok).toBe(true);
      loading = true;
      const r = await ctl.session.undo(done.value.undo);
      expect(r.error.code).toBe('budget_loading');
      expect(ctl.writes).toHaveLength(1);
      expect(ctl.state.transactions).toHaveLength(1);
    });

    it('refuses an undo made before the hold when its turn comes during it', async () => {
      let loading = false;
      let gate = null;
      let started;
      const writes = [];
      const writeBatch = async (ref, items) => { writes.push(items); started?.(); if (gate) await gate; };
      const ctl = setup({ writeBatch, isLoading: () => loading });
      const done = await ctl.session.dispatch('test.add', {});
      let release;
      gate = new Promise((r) => { release = r; });
      const startedP = new Promise((r) => { started = r; });
      const first = ctl.session.dispatch('test.add', {});
      const undo = ctl.session.undo(done.value.undo);
      await startedP;
      // The wizard holds the session already open: only the hold stops the undo.
      loading = true;
      release();
      expect((await first).ok).toBe(true);
      expect((await undo).error.code).toBe('budget_loading');
      expect(writes).toHaveLength(2);
      expect(ctl.state.transactions).toHaveLength(2);
    });

    it('a hold with no budget open is just no budget', async () => {
      // e.g. the welcome screen after the startup reopen found no budget-meta
      // and left the wizard's hold dangling with budgetFolder null.
      const { ctl } = held();
      ctl.state.budgetFolder = null;
      expect((await ctl.session.dispatch('test.add', {})).error.code).toBe('no_budget');
      expect((await ctl.session.dispatchBatch([{ name: 'test.add', input: {} }])).error.code).toBe('no_budget');
      expect(ctl.writes).toEqual([]);
    });

    it('still answers queries', () => {
      const { ctl } = held();
      expect(ctl.session.query('test.count', {})).toEqual(ok(0));
    });

    it('refuses a dispatch made before the hold when its turn comes during it', async () => {
      let loading = false;
      const held2 = heldWrite({ thenImmediate: true });
      const ctl = setup({ writeBatch: held2.writeBatch, isLoading: () => loading });
      const first = ctl.session.dispatch('test.add', {});
      const second = ctl.session.dispatch('test.add', {});
      await held2.startedP;
      // The wizard holds the session the loader already started: no new
      // generation, so only the hold stops the queued command.
      loading = true;
      held2.release();
      expect((await first).ok).toBe(true);
      expect((await second).error.code).toBe('budget_loading');
      expect(held2.calls).toHaveLength(1);
    });

    it('writes again once the budget is published', async () => {
      const { ctl, release } = held();
      expect((await ctl.session.dispatch('test.add', {})).error.code).toBe('budget_loading');
      release();
      const r = await ctl.session.dispatch('test.add', {});
      expect(r.ok).toBe(true);
      expect(ctl.writes).toHaveLength(1);
      expect(ctl.state.transactions).toHaveLength(1);
    });
  });

  describe('a queued command is bound to the budget it was dispatched for', () => {
    // A switch drains the storage writes, clears state and loads the next
    // budget; a command still queued behind a pending write must not then run
    // against the cleared state or the new budget.
    async function queuedBehindAWrite(dispatchSecond, switchTo = { gen: 2, folder: { name: 'B' } }) {
      const held = heldWrite({ thenImmediate: true });
      const ctl = setup({ writeBatch: held.writeBatch });
      ctl.registry.defineCommand(accountCreate);
      const first = ctl.session.dispatch('test.add', {});
      const second = dispatchSecond(ctl);
      await held.startedP;
      ctl.setGen(switchTo.gen);
      if (switchTo.folder) ctl.state.budgetFolder = switchTo.folder;
      ctl.state.accounts = [];
      ctl.state.transactions = [];
      held.release();
      await first;
      return { ctl, held, r: await second };
    }

    it('a queued command executes and writes nothing after a switch', async () => {
      const { ctl, held, r } = await queuedBehindAWrite(c => c.session.dispatch('test.add', {}));
      expect(r.error.code).toBe('budget_switched');
      expect(held.calls).toHaveLength(1);
      expect(ctl.state.transactions).toEqual([]);
    });

    it('so does account.create, which would otherwise succeed against the cleared state', async () => {
      const { ctl, held, r } = await queuedBehindAWrite(c => c.session.dispatch('account.create', { name: 'Wallet' }));
      expect(r.error.code).toBe('budget_switched');
      expect(held.calls).toHaveLength(1);
      expect(ctl.state.accounts).toEqual([]);
    });

    it('a generation change alone is a switch (the guest budget reuses its folder)', async () => {
      const { held, r } = await queuedBehindAWrite(c => c.session.dispatchBatch([{ name: 'account.create', input: { name: 'Wallet' } }]), { gen: 2 });
      expect(r.error.code).toBe('budget_switched');
      expect(held.calls).toHaveLength(1);
    });

    it('a queued undo is stale after a switch, and writes nothing', async () => {
      const ctl0 = setup();
      const done = await ctl0.session.dispatch('test.add', {});
      const held = heldWrite({ thenImmediate: true });
      const ctl = setup({ writeBatch: held.writeBatch });
      const first = ctl.session.dispatch('test.add', {});
      const undo = ctl.session.undo({ ...done.value.undo, ref: ctl.state.budgetFolder });
      await held.startedP;
      ctl.setGen(2);
      ctl.state.budgetFolder = { name: 'B' };
      held.release();
      await first;
      expect((await undo).error.code).toBe('undo_stale');
      expect(held.calls).toHaveLength(1);
    });

    it('a command dispatched after the switch runs against the new budget', async () => {
      const { ctl, held } = await queuedBehindAWrite(c => c.session.dispatch('test.add', {}));
      const r = await ctl.session.dispatch('test.add', {});
      expect(r.ok).toBe(true);
      expect(held.calls).toHaveLength(2);
      expect(ctl.state.transactions).toHaveLength(1);
    });
  });

  it('writes nothing and keeps state when a later batch step fails', async () => {
    const { state, session, writes } = setup();
    const r = await session.dispatchBatch([
      { name: 'test.add', input: {} },
      { name: 'test.add', input: { date: 'not-a-date' } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error.params.step).toBe(1);
    expect(writes).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
  });

  it('a dry run reports the diff the same dispatch then commits', async () => {
    // Two identically prepared sessions, so the generated ids line up.
    const dry = await setup().session.dispatch('test.add', { note: 'x' }, { dryRun: true });
    const real = await setup().session.dispatch('test.add', { note: 'x' });
    expect(dry.value.committed).toBe(false);
    expect(real.value.committed).toBe(true);
    expect(real.value.diff).toEqual(dry.value.diff);
  });

  it('serialises dispatches so the second builds on the first', async () => {
    const { state, session } = setup();
    await Promise.all([session.dispatch('test.add', {}), session.dispatch('test.add', {})]);
    expect(state.transactions.map(t => t.id)).toEqual(['id1', 'id2']);
  });

  it('applies policies from meta, and refuses unknown ones', async () => {
    const { state, session } = setup();
    state.meta = { ...state.meta, policies: ['strict-ledger'] };
    expect((await session.dispatch('test.add', { date: '2026-10-20' })).error.code).toBe('ledger_future_posted');
    expect((await session.dispatch('test.add', {}, { policies: ['nope'] })).error.code).toBe('unknown_policy');
  });

  it('undoes its own change, and refuses after a budget switch', async () => {
    const { state, session, setGen } = setup();
    const first = await session.dispatch('test.add', {});
    await session.dispatch('test.add', {});
    const undone = await session.undo(first.value.undo);
    expect(undone.ok).toBe(true);
    expect(state.transactions.map(t => t.id)).toEqual(['id2']);
    const again = await session.dispatch('test.add', {});
    setGen(9);
    expect((await session.undo(again.value.undo)).error.code).toBe('undo_stale');
  });

  it('undoing a transaction.delete restores the row exactly: its payee is not re-aliased', async () => {
    const ctl = setup();
    ctl.registry.defineCommand(transactionDelete);
    const row = { id: 'r', type: 'expense', amount: 5, date: '2026-10-01', account: 'bank', payee: 'lidl 1234', note: '' };
    ctl.state.transactions = [row];
    // An alias for that spelling exists now; the restored row is existing data, not new input.
    ctl.state.meta = { ...ctl.state.meta, payeeAliases: { 'lidl 1234': 'Lidl' } };
    const del = await ctl.session.dispatch('transaction.delete', { ids: ['r'] });
    expect(del.ok).toBe(true);
    expect(ctl.state.transactions).toEqual([]);
    const undone = await ctl.session.undo(del.value.undo);
    expect(undone.ok).toBe(true);
    expect(ctl.state.transactions).toEqual([row]);
    expect(ctl.state.transactions[0].payee).toBe('lidl 1234');
  });

  describe('a command whose main effect is meta (meta-primary)', () => {
    const planned = () => [{ id: 'p', type: 'expense', amount: 5, date: '2026-10-01', account: 'bank', from_budget: 'item:2026-10' }];
    const filenames = (writes) => writes.map(w => w.items.map(i => i.filename));
    const metaItem = (items) => items.find(i => i.filename === 'budget-meta.json').data;
    const flushAll = () => new Promise(r => setTimeout(r, 0));
    // A meta save held until released, so a plain meta write can sit in the
    // queue ahead of the session's commit.
    function holdNextSave(ctl) {
      let release;
      ctl.saveMeta.mockImplementationOnce(() => new Promise((r) => { release = r; }));
      return () => release();
    }

    it('writes collections and meta, with the change log, in ONE writeBatch and no separate meta save', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const r = await ctl.session.dispatch('test.del', { id: 'p' });
      expect(r.ok).toBe(true);
      expect(r.value).toMatchObject({ committed: true, published: true });
      expect(r.value.metaFailed).toBeUndefined();
      expect(filenames(ctl.writes)).toEqual([['transactions.json', 'budget-meta.json']]);
      const meta = metaItem(ctl.writes[0].items);
      expect(meta.scheduledTombstones).toEqual(['item:2026-10']);
      expect(meta.change_log).toHaveLength(1);
      expect(meta.change_log[0]).toMatchObject({ op: 'delete', id: 'p' });
      expect(ctl.saveMeta).not.toHaveBeenCalled();
      expect(ctl.updateMeta).not.toHaveBeenCalled();
      expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(1);
      expect(ctl.state.meta).toEqual(meta);
      expect(ctl.state.transactions).toEqual([]);
      expect(ctl.notify.mock.calls).toEqual([['transactions', 'meta']]);
    });

    it('a failed write publishes nothing: neither the collections nor meta change', async () => {
      const ctl = setup({ writeBatch: async () => { throw new Error('disk full'); } });
      ctl.state.transactions = planned();
      const { transactions, meta } = ctl.state;
      const r = await ctl.session.dispatch('test.del', { id: 'p' });
      expect(r.error).toEqual({ code: 'write_failed', params: { message: 'disk full' } });
      expect(ctl.state.transactions).toBe(transactions);
      expect(ctl.state.meta).toBe(meta);
      expect(ctl.saveMeta).not.toHaveBeenCalled();
    });

    it('rechecks policies changed while a meta-primary command waited for the queue', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, policies: ['strict-ledger'] }));
      const pending = ctl.session.dispatch('test.del', { id: 'p' });
      await flushAll();
      release();
      await other;
      const r = await pending;
      expect(r.error.code).toBe('ledger_history_locked');
      expect(ctl.writes).toEqual([]);
      expect(ctl.state.transactions).toHaveLength(1);
    });

    it('keeps a concurrent meta write of a different key queued before it', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, currency: 'USD' }));
      const pending = ctl.session.dispatch('test.del', { id: 'p' });
      await flushAll();
      expect(ctl.writes).toEqual([]);   // waiting its turn in the meta queue
      release();
      await other;
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(metaItem(ctl.writes[0].items)).toMatchObject({ currency: 'USD', scheduledTombstones: ['item:2026-10'] });
      expect(ctl.state.meta).toMatchObject({ currency: 'USD', scheduledTombstones: ['item:2026-10'] });
    });

    it('re-runs on the latest value when a concurrent write changed the same key', async () => {
      const ctl = setup();
      const execute = vi.fn((d) => ok({ changes: { meta: { ...d.meta, counter: (d.meta.counter ?? 0) + 1 } }, value: null }));
      ctl.registry.defineCommand({ name: 'test.bump', summary: 'x', input: { type: 'object', properties: {} }, execute });
      ctl.state.meta = { ...ctl.state.meta, counter: 1 };
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, counter: 10 }));
      const pending = ctl.session.dispatch('test.bump', {});
      await flushAll();
      release();
      await other;
      const r = await pending;
      expect(r.ok).toBe(true);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(ctl.state.meta.counter).toBe(11);
      expect(metaItem(ctl.writes[0].items).counter).toBe(11);
      expect(r.value.diff.meta.changed).toEqual([{ key: 'counter', before: 10, after: 11 }]);
      expect(r.value.undo.diff).toEqual(r.value.diff);
    });

    it('returns the failure when the re-run on the latest value fails, writing nothing', async () => {
      const ctl = setup();
      ctl.registry.defineCommand({
        name: 'test.bumpBelow10', summary: 'x', input: { type: 'object', properties: {} },
        execute: (d) => ((d.meta.counter ?? 0) >= 10
          ? fail('bad_input', { errors: [{ path: 'counter', message: 'too high' }] })
          : ok({ changes: { meta: { ...d.meta, counter: (d.meta.counter ?? 0) + 1 } }, value: null })),
      });
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, counter: 10 }));
      const pending = ctl.session.dispatch('test.bumpBelow10', {});
      await flushAll();
      release();
      await other;
      const r = await pending;
      expect(r.error.code).toBe('bad_input');
      expect(ctl.writes).toEqual([]);
      expect(ctl.state.meta.counter).toBe(10);
    });

    it('a transaction edit saves its history atomically with the collection', async () => {
      const ctl = setup();
      ctl.state.transactions = [{ id: 'p', type: 'expense', amount: 5, date: '2026-10-01', account: 'bank' }];
      ctl.registry.defineCommand({
        name: 'test.edit', summary: 'x', input: { type: 'object', properties: {} },
        execute: (d) => ok({ changes: { transactions: d.transactions.map(t => ({ ...t, amount: 9 })) }, value: null }),
      });
      const r = await ctl.session.dispatch('test.edit', {});
      expect(r.ok).toBe(true);
      expect(filenames(ctl.writes)).toEqual([['transactions.json', 'budget-meta.json']]);
      expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(1);
      expect(ctl.updateMeta).not.toHaveBeenCalled();
      expect(ctl.saveMeta).not.toHaveBeenCalled();
      expect(ctl.state.meta.change_log).toHaveLength(1);
    });

    it('undo restores the row and removes the tombstone, through the same path', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const r = await ctl.session.dispatch('test.del', { id: 'p' });
      const u = await ctl.session.undo(r.value.undo);
      expect(u.ok).toBe(true);
      expect(u.value.metaFailed).toBeUndefined();
      expect(ctl.state.transactions.map(t => t.id)).toEqual(['p']);
      // Nothing moved, so the undo stores the inverse exactly: the key was absent before the delete.
      expect('scheduledTombstones' in ctl.state.meta).toBe(false);
      expect(filenames(ctl.writes)).toEqual([['transactions.json', 'budget-meta.json'], ['transactions.json', 'budget-meta.json']]);
      expect('scheduledTombstones' in metaItem(ctl.writes[1].items)).toBe(false);
      expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(2);
      expect(ctl.updateMeta).not.toHaveBeenCalled();
      expect(ctl.saveMeta).not.toHaveBeenCalled();
    });

    it('undo merges a primitive-array key with a write queued ahead of it', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const r = await ctl.session.dispatch('test.del', { id: 'p' });
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, scheduledTombstones: [...m.scheduledTombstones, 'x:2026-11'] }));
      const pending = ctl.session.undo(r.value.undo);
      await flushAll();
      release();
      await other;
      expect((await pending).ok).toBe(true);
      expect(ctl.state.meta.scheduledTombstones).toEqual(['x:2026-11']);
      expect(ctl.state.transactions.map(t => t.id)).toEqual(['p']);
    });

    it('undo is stale when a write queued ahead of it changed a wholesale key, and writes nothing', async () => {
      const ctl = setup();
      ctl.registry.defineCommand({
        name: 'test.bump', summary: 'x', input: { type: 'object', properties: {} },
        execute: (d) => ok({ changes: { meta: { ...d.meta, counter: (d.meta.counter ?? 0) + 1 } }, value: null }),
      });
      const r = await ctl.session.dispatch('test.bump', {});
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, counter: 10 }));
      const pending = ctl.session.undo(r.value.undo);
      await flushAll();
      release();
      await other;
      expect((await pending).error).toEqual({ code: 'undo_stale', params: { kind: 'meta', id: 'counter' } });
      expect(ctl.writes).toHaveLength(1);
      expect(ctl.state.meta.counter).toBe(10);
    });

    it('delete two planned occurrences, undo the first: the second tombstone stays, the first goes', async () => {
      const ctl = setup();
      ctl.registry.defineCommand(transactionDelete);
      ctl.state.transactions = [
        { id: 'p1', type: 'expense', amount: 5, date: '2026-10-01', account: 'bank', from_budget: 'item:2026-10' },
        { id: 'p2', type: 'expense', amount: 5, date: '2026-11-01', account: 'bank', from_budget: 'item:2026-11' },
      ];
      const first = await ctl.session.dispatch('transaction.delete', { ids: ['p1'] });
      const second = await ctl.session.dispatch('transaction.delete', { ids: ['p2'] });
      expect(second.ok).toBe(true);
      expect(ctl.state.meta.scheduledTombstones).toEqual(['item:2026-10', 'item:2026-11']);
      const u = await ctl.session.undo(first.value.undo);
      expect(u.ok).toBe(true);
      expect(ctl.state.transactions.map(t => t.id)).toEqual(['p1']);
      expect(ctl.state.meta.scheduledTombstones).toEqual(['item:2026-11']);
      expect(metaItem(ctl.writes[2].items).scheduledTombstones).toEqual(['item:2026-11']);
    });

    it('keeps concurrent element changes to a primitive-array key, without a re-run', async () => {
      const ctl = setup();
      const execute = vi.fn((d) => ok({ changes: { meta: { ...d.meta, closed_months: [...(d.meta.closed_months ?? []), '2026-09'] } }, value: null }));
      ctl.registry.defineCommand({ name: 'test.close', summary: 'x', input: { type: 'object', properties: {} }, execute });
      ctl.state.meta = { ...ctl.state.meta, closed_months: ['2026-07'] };
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, closed_months: [...m.closed_months, '2026-08'] }));
      const pending = ctl.session.dispatch('test.close', {});
      await flushAll();
      release();
      await other;
      expect((await pending).ok).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(ctl.state.meta.closed_months).toEqual(['2026-07', '2026-08', '2026-09']);
      expect(metaItem(ctl.writes[0].items).closed_months).toEqual(['2026-07', '2026-08', '2026-09']);
    });

    describe('stores what the command produced when nothing moved', () => {
      const withCommands = (ctl) => [monthReopen, monthClearReopen, payeeHide, settingsUpdate].forEach(c => ctl.registry.defineCommand(c));

      it('a reopen of an earlier month stores the sorted list', async () => {
        const ctl = setup();
        withCommands(ctl);
        ctl.state.meta = { ...ctl.state.meta, auto_close_after_months: 1, reopened_months: ['2026-06'] };
        const r = await ctl.session.dispatch('month.reopen', { month: '2026-03' });
        expect(r.ok).toBe(true);
        expect(ctl.state.meta.reopened_months).toEqual(['2026-03', '2026-06']);
        expect(metaItem(ctl.writes[0].items).reopened_months).toEqual(['2026-03', '2026-06']);
      });

      it('clearReopen of the last exception deletes the key', async () => {
        const ctl = setup();
        withCommands(ctl);
        ctl.state.meta = { ...ctl.state.meta, auto_close_after_months: 1, reopened_months: ['2026-03'] };
        const r = await ctl.session.dispatch('month.clearReopen', { month: '2026-03' });
        expect(r.ok).toBe(true);
        expect('reopened_months' in ctl.state.meta).toBe(false);
        expect('reopened_months' in metaItem(ctl.writes[0].items)).toBe(false);
      });

      it('hide stores payeeHidden sorted', async () => {
        const ctl = setup();
        withCommands(ctl);
        ctl.state.meta = { ...ctl.state.meta, payeeHidden: ['mart'] };
        const r = await ctl.session.dispatch('payee.hide', { payee: 'Bakery' });
        expect(r.ok).toBe(true);
        expect(ctl.state.meta.payeeHidden).toEqual(['bakery', 'mart']);
        expect(metaItem(ctl.writes[0].items).payeeHidden).toEqual(['bakery', 'mart']);
      });

      it('undo of a reopen restores the stored list exactly', async () => {
        const ctl = setup();
        withCommands(ctl);
        ctl.state.meta = { ...ctl.state.meta, auto_close_after_months: 1, reopened_months: ['2026-06'] };
        const r = await ctl.session.dispatch('month.reopen', { month: '2026-03' });
        const u = await ctl.session.undo(r.value.undo);
        expect(u.ok).toBe(true);
        expect(ctl.state.meta.reopened_months).toEqual(['2026-06']);
      });

      it('still merges a concurrent element change, sorted for a sorted key', async () => {
        const ctl = setup();
        withCommands(ctl);
        ctl.state.meta = { ...ctl.state.meta, auto_close_after_months: 1, reopened_months: ['2026-06'] };
        const release = holdNextSave(ctl);
        const other = ctl.updateMeta(ctl.state, m => ({ ...m, reopened_months: [...m.reopened_months, '2026-07'] }));
        const pending = ctl.session.dispatch('month.reopen', { month: '2026-03' });
        await flushAll();
        release();
        await other;
        expect((await pending).ok).toBe(true);
        expect(ctl.state.meta.reopened_months).toEqual(['2026-03', '2026-06', '2026-07']);
      });

      it('a settings.update that clears locale and auto-close deletes both keys', async () => {
        const ctl = setup();
        withCommands(ctl);
        ctl.state.meta = { ...ctl.state.meta, locale: 'fi-FI', auto_close_after_months: 2 };
        const r = await ctl.session.dispatch('settings.update', { fields: { locale: null, auto_close_after_months: null } });
        expect(r.ok).toBe(true);
        expect(r.value.published).toBe(true);
        const stored = metaItem(ctl.writes[0].items);
        expect('locale' in stored).toBe(false);
        expect('auto_close_after_months' in stored).toBe(false);
        expect('locale' in ctl.state.meta).toBe(false);
        expect('auto_close_after_months' in ctl.state.meta).toBe(false);
      });
    });

    it('notifies once for a meta-only commit', async () => {
      const ctl = setup();
      const r = await ctl.session.dispatch('test.meta', {});
      expect(r.ok).toBe(true);
      expect(ctl.notify.mock.calls).toEqual([['meta']]);
    });

    it('publishes nothing when the budget switched as the meta queue finished', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const { transactions } = ctl.state;
      ctl.runMetaExclusive.mockImplementationOnce(async (st, fn) => {
        const meta = await ctl.queue.runExclusive(st, fn);
        ctl.setGen(2);
        return meta;
      });
      const r = await ctl.session.dispatch('test.del', { id: 'p' });
      expect(r.value).toMatchObject({ committed: true, published: false, undo: null });
      expect(ctl.state.transactions).toBe(transactions);
    });

    it('template.convertIncomeLinked with a tombstone rewrite is one atomic batch', async () => {
      const ctl = setup();
      ctl.registry.defineCommand(templateConvertIncomeLinked);
      const everyMonth = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));
      Object.assign(ctl.state, {
        accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 100 }],
        envelopes: [{ id: 'rent', name: 'Rent' }],
        budgetItems: [{
          id: 'inc1', kind: 'income', as_schedule: true, template_id: 'tpl1', account_id: 'chk', payment_day: 25,
          default_amount: 2000, monthly_schedule: { ...everyMonth, Jul: 0 }, as_schedule_since: '2025-01-01', skipped_occurrences: ['2026-07'],
        }],
        envelopeTemplates: [{ id: 'tpl1', name: 'Salary Split', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 100 }] }],
        transactions: [
          { id: 'i1', type: 'income', amount: 2000, date: '2026-08-25', status: 'posted', account: 'chk', from_budget: 'inc1:2026-08' },
          { id: 'f1', type: 'fill', date: '2026-08-25', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'rent', amount: 100, mode: 'add' }], from_budget: 'inc1:2026-08:fill' },
        ],
        meta: { schemaVersion: 8, scheduledTombstones: ['inc1:2026-07:fill', 'other:2026-07'] },
      });
      const r = await ctl.session.dispatch('template.convertIncomeLinked', {});
      expect(r.ok).toBe(true);
      expect(r.value.published).toBe(true);
      expect(ctl.writes).toHaveLength(1);
      expect(filenames(ctl.writes)[0]).toEqual(expect.arrayContaining(['budget-items.json', 'envelope-templates.json', 'transactions.json']));
      expect(filenames(ctl.writes)[0].at(-1)).toBe('budget-meta.json');
      // Nothing moved, so the command's own list is stored as it produced it.
      expect(metaItem(ctl.writes[0].items).scheduledTombstones).toEqual(['tpl:tpl1:2026-07', 'other:2026-07']);
      expect(ctl.updateMeta).not.toHaveBeenCalled();
      expect(ctl.saveMeta).not.toHaveBeenCalled();
      expect(ctl.state.meta.scheduledTombstones).toEqual(['tpl:tpl1:2026-07', 'other:2026-07']);
      expect(ctl.state.budgetItems[0].template_id).toBeNull();
    });

    it('counts as a pending meta write while it is queued and while its batch is in flight', async () => {
      const held = heldWrite();
      const ctl = setup({ writeBatch: held.writeBatch });
      ctl.state.transactions = planned();
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, currency: 'USD' }));
      const pending = ctl.session.dispatch('test.del', { id: 'p' });
      await flushAll();
      expect(held.calls).toHaveLength(0);
      release();
      await other;
      expect(metaWritesPending()).toBe(true);   // the session's commit, still queued or writing
      await held.startedP;
      expect(metaWritesPending()).toBe(true);
      held.release();
      expect((await pending).ok).toBe(true);
      expect(metaWritesPending()).toBe(false);
    });

    it('a switch while its batch is in flight publishes nothing, meta included', async () => {
      const held = heldWrite();
      const ctl = setup({ writeBatch: held.writeBatch });
      ctl.state.transactions = planned();
      const pending = ctl.session.dispatch('test.del', { id: 'p' });
      await held.startedP;
      ctl.setGen(2);   // a generation change alone (the guest budget reuses its folder)
      const { transactions, meta } = ctl.state;
      held.release();
      const r = await pending;
      expect(r.value).toMatchObject({ committed: true, published: false, undo: null });
      expect(ctl.state.transactions).toBe(transactions);
      expect(ctl.state.meta).toBe(meta);
    });

    it('a switch while it waits in the meta queue writes nothing', async () => {
      const ctl = setup();
      ctl.state.transactions = planned();
      const release = holdNextSave(ctl);
      const other = ctl.updateMeta(ctl.state, m => ({ ...m, currency: 'USD' }));
      const pending = ctl.session.dispatch('test.del', { id: 'p' });
      await flushAll();
      ctl.setGen(2);
      ctl.state.budgetFolder = { name: 'B' };
      release();
      await other;
      expect((await pending).error.code).toBe('budget_switched');
      expect(ctl.writes).toEqual([]);
    });
  });

  it('a failed combined history write leaves the edit and metadata unpublished', async () => {
    const ctl = setup({ writeBatch: async () => { throw new Error('disk full'); } });
    const before = structuredClone(ctl.state.meta);
    const r = await ctl.session.dispatch('test.add', {});
    expect(r.ok).toBe(false);
    expect(ctl.state.transactions).toEqual([]);
    expect(ctl.state.meta).toEqual(before);
  });

  it('refuses a command that writes the change log itself: the session appends it', async () => {
    const ctl = setup();
    ctl.registry.defineCommand({
      name: 'test.log', summary: 'x', input: { type: 'object', properties: {} },
      execute: (d) => ok({ changes: { meta: { ...d.meta, change_log: [] } }, value: null }),
    });
    await expect(ctl.session.dispatch('test.log', {})).rejects.toThrow(/change_log/);
    expect(ctl.writes).toEqual([]);
    expect(ctl.runMetaExclusive).not.toHaveBeenCalled();
    expect(ctl.updateMeta).not.toHaveBeenCalled();
  });

  it('refuses collections outside the write scope it is given', async () => {
    const { session, writes } = setup({ writableKinds: new Set(BROWSER_WRITABLE.filter(k => k !== 'budgetItems')) });
    await expect(session.dispatch('test.items', {})).rejects.toThrow(/budgetItems is not writable/);
    expect(writes).toEqual([]);
  });

  it('reports no_budget when nothing is open', async () => {
    const { state, session } = setup();
    state.budgetFolder = null;
    expect((await session.dispatch('test.add', {})).error.code).toBe('no_budget');
    expect(session.query('test.count', {}).error.code).toBe('no_budget');
  });

  it('commits a reorder, publishes the new order, and undoes it', async () => {
    const ctl = setup();
    ctl.registry.defineCommand(accountReorder);
    const bank = ctl.state.accounts[0];
    const sav = { id: 'sav', name: 'Savings' };
    ctl.state.accounts = [bank, sav];
    const r = await ctl.session.dispatch('account.reorder', { ids: ['sav', 'bank'] });
    expect(r.ok).toBe(true);
    expect(r.value.committed).toBe(true);
    expect(ctl.writes.map(w => w.items.map(i => i.filename))).toEqual([['accounts.json', 'budget-meta.json']]);
    expect(ctl.state.accounts).toEqual([sav, bank]);
    expect(ctl.notify).toHaveBeenCalledWith('accounts', 'meta');
    // Order is not a change-log event.
    expect(ctl.updateMeta).not.toHaveBeenCalled();
    expect((await ctl.session.undo(r.value.undo)).ok).toBe(true);
    expect(ctl.state.accounts).toEqual([bank, sav]);
    expect(ctl.state.accounts[0]).toBe(bank);
  });

  it('logs nothing for a reorder of transactions', async () => {
    const ctl = setup();
    ctl.registry.defineCommand({
      name: 'test.reverse', summary: 'x', input: { type: 'object', properties: {} },
      execute: (d) => ok({ changes: { transactions: [...d.transactions].reverse() }, value: null }),
    });
    ctl.state.transactions = ['p', 'q'].map(id => ({ id, type: 'expense', amount: 5, date: '2026-10-01', account: 'bank' }));
    const r = await ctl.session.dispatch('test.reverse', {});
    expect(r.value.committed).toBe(true);
    expect(ctl.state.transactions.map(t => t.id)).toEqual(['q', 'p']);
    expect(ctl.updateMeta).not.toHaveBeenCalled();
    expect(ctl.state.meta.change_log).toBeUndefined();
  });

  it('writes and publishes only the collections that changed', async () => {
    const held = heldWrite({ thenImmediate: true });
    const ctl = setup({ writeBatch: held.writeBatch });
    ctl.registry.defineCommand({
      name: 'test.account', summary: 'x', input: { type: 'object', properties: {} },
      execute: (d, input, c) => ok({
        changes: {
          accounts: [...d.accounts],
          transactions: [...d.transactions, { id: c.newId(), type: 'expense', amount: 5, date: c.todayIso, account: 'bank' }],
        },
        value: null,
      }),
    });
    const legacy = [{ id: 'legacy-acc', name: 'Legacy' }];
    const pending = ctl.session.dispatch('test.account', {});
    await held.startedP;
    ctl.state.accounts = legacy;
    held.release();
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(held.calls).toHaveLength(1);
    expect(held.calls[0].map(i => i.filename)).toEqual(['transactions.json', 'budget-meta.json']);
    expect(ctl.state.transactions).toHaveLength(1);
    expect(ctl.state.accounts).toBe(legacy);
  });
});

describe('BrowserSession.queryAfter', () => {
  // The budget as it would be after `steps`: a dry run of the steps, then the
  // query asked of the data they produce. Nothing is written or published.
  function withBalances(opts) {
    const ctl = setup(opts);
    ctl.registry.defineCommand(transactionRecord);
    ctl.registry.defineQuery(balancesQuery);
    ctl.state.accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }];
    ctl.state.envelopes = [{ id: 'food', name: 'Food' }];
    return ctl;
  }
  const expense = (amount) => ({ name: 'transaction.record', input: { type: 'expense', amount, date: '2026-10-10', account: 'bank', payee: 'Shop' } });

  it('answers the query on the data after the steps, writing nothing', async () => {
    const ctl = withBalances();
    const before = ctl.session.query('balances', { lens: 'booked' });
    expect(before.value.unallocated).toBe(1000);
    const r = await ctl.session.queryAfter([expense(40)], 'balances', { lens: 'booked' });
    expect(r.ok).toBe(true);
    expect(r.value.unallocated).toBe(960);
    expect(r.value.accounts).toEqual([{ id: 'bank', name: 'Bank', type: 'bank', archived: false, balance: 960 }]);
    expect(ctl.writes).toEqual([]);
    expect(ctl.state.transactions).toEqual([]);
    expect(ctl.notify).not.toHaveBeenCalled();
    expect(ctl.updateMeta).not.toHaveBeenCalled();
  });

  it('runs every step, each on the one before', async () => {
    const ctl = withBalances();
    const r = await ctl.session.queryAfter([expense(40), expense(60)], 'balances', { lens: 'booked' });
    expect(r.value.unallocated).toBe(900);
  });

  it('returns a refused step\'s error, without asking the query or writing', async () => {
    const ctl = withBalances();
    const run = vi.fn(() => ok(0));
    ctl.registry.defineQuery({ name: 'test.spyQuery', summary: 'x', input: { type: 'object', properties: {} }, run });
    const r = await ctl.session.queryAfter([
      { name: 'test.add', input: {} },
      { name: 'test.add', input: { date: 'not-a-date' } },
    ], 'test.spyQuery', {});
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.step).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(ctl.writes).toEqual([]);
    expect(ctl.state.transactions).toEqual([]);
  });

  it('applies the budget\'s policies to the steps', async () => {
    const ctl = withBalances();
    ctl.state.meta = { ...ctl.state.meta, policies: ['strict-ledger'] };
    const r = await ctl.session.queryAfter([{ name: 'test.add', input: { date: '2026-10-20' } }], 'test.count', {});
    expect(r.error.code).toBe('ledger_future_posted');
  });

  it('returns the query\'s own failure', async () => {
    const ctl = withBalances();
    expect((await ctl.session.queryAfter([expense(40)], 'balances', { lens: 'nope' })).error.code).toBe('bad_input');
    expect((await ctl.session.queryAfter([expense(40)], 'no.such', {})).error.code).toBe('unknown_query');
  });

  it('is queued behind a pending write, and sees it', async () => {
    const held = heldWrite();
    const ctl = setup({ writeBatch: held.writeBatch });
    const write = ctl.session.dispatch('test.add', {});
    await held.startedP;
    let settled = false;
    const after = ctl.session.queryAfter([{ name: 'test.add', input: {} }], 'test.count', {});
    after.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 0));
    expect(settled).toBe(false);
    held.release();
    expect((await write).ok).toBe(true);
    expect(await after).toEqual(ok(2));
    expect(ctl.state.transactions).toHaveLength(1);
  });

  it('is refused with budget_loading while a load holds the budget, when called and on its turn', async () => {
    let loading = true;
    const ctl = setup({ isLoading: () => loading });
    const run = vi.fn(() => ok(0));
    ctl.registry.defineQuery({ name: 'test.spyQuery', summary: 'x', input: { type: 'object', properties: {} }, run });
    expect((await ctl.session.queryAfter([{ name: 'test.add', input: {} }], 'test.spyQuery', {})).error)
      .toEqual({ code: 'budget_loading', params: {} });

    loading = false;
    const held = heldWrite();
    const ctl2 = setup({ writeBatch: held.writeBatch, isLoading: () => loading });
    ctl2.registry.defineQuery({ name: 'test.spyQuery', summary: 'x', input: { type: 'object', properties: {} }, run });
    const write = ctl2.session.dispatch('test.add', {});
    await held.startedP;
    const after = ctl2.session.queryAfter([{ name: 'test.add', input: {} }], 'test.spyQuery', {});
    loading = true;
    held.release();
    await write;
    expect((await after).error.code).toBe('budget_loading');
    expect(run).not.toHaveBeenCalled();
  });

  it('is refused with budget_switched when the budget changes between the call and its turn', async () => {
    const held = heldWrite({ thenImmediate: true });
    const ctl = setup({ writeBatch: held.writeBatch });
    const run = vi.fn(() => ok(0));
    ctl.registry.defineQuery({ name: 'test.spyQuery', summary: 'x', input: { type: 'object', properties: {} }, run });
    const write = ctl.session.dispatch('test.add', {});
    await held.startedP;
    const after = ctl.session.queryAfter([{ name: 'test.add', input: {} }], 'test.spyQuery', {});
    ctl.setGen(2);
    ctl.state.budgetFolder = { name: 'B' };
    ctl.state.transactions = [];
    held.release();
    await write;
    expect((await after).error.code).toBe('budget_switched');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports no_budget when nothing is open', async () => {
    const ctl = setup();
    ctl.state.budgetFolder = null;
    expect((await ctl.session.queryAfter([{ name: 'test.add', input: {} }], 'test.count', {})).error.code).toBe('no_budget');
  });
});
