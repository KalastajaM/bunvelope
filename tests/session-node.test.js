// tests/session-node.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNodeSession } from '../server/session/node-session.js';
import { createRegistry } from '../js/core/registry.js';
import { ok } from '../js/core/result.js';
import accountReorder from '../js/core/commands/account-reorder.js';
import { BudgetStoreError } from '../server/services/budget-store.js';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';

const bundle = () => ({
  meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
  accounts: [{ id: 'bank', name: 'Bank' }], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [],
});

function registry() {
  const r = createRegistry();
  r.defineCommand({
    name: 'test.add', summary: 'x', input: { type: 'object', properties: { date: { type: 'date' } } },
    execute(d, input, c) {
      const row = { id: c.newId(), type: 'expense', amount: 5, date: input.date ?? c.todayIso, account: 'bank' };
      return ok({ changes: { transactions: [...d.transactions, row] }, value: row });
    },
  });
  r.defineCommand({
    name: 'test.touch', summary: 'x', input: { type: 'object', properties: {} },
    execute(d) {
      // Returns a fresh array for an unchanged collection alongside a real change.
      return ok({ changes: { accounts: [...d.accounts], envelopes: [{ id: 'e1', name: 'E' }] }, value: null });
    },
  });
  r.defineQuery({ name: 'test.count', summary: 'x', input: { type: 'object', properties: {} }, run: (d) => ok(d.transactions.length) });
  return r;
}
const common = { registry: registry(), clock: () => new Date(2026, 9, 15, 9), newId: () => 'n1' };

describe('file-backed NodeSession', () => {
  let dir; let path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bv-session-')); path = join(dir, 'bundle.json'); writeFileSync(path, JSON.stringify(bundle())); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('logs edits and deletes in the same write', async () => {
    const reg = createRegistry();
    reg.defineCommand({ name: 'test.drop', summary: 'x', input: { type: 'object', properties: {} },
      execute: () => ok({ changes: { transactions: [] }, value: null }) });
    writeFileSync(path, JSON.stringify({ ...bundle(), transactions: [{ id: 'z', type: 'expense', amount: 1, date: '2026-10-01', account: 'bank' }] }));
    const s = createNodeSession({ ...common, registry: reg, source: { kind: 'file', path } });
    expect((await s.dispatch('test.drop', {})).ok).toBe(true);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.meta.change_log).toEqual([expect.objectContaining({ op: 'delete', id: 'z' })]);
  });

  it('writes a reorder', async () => {
    const reg = createRegistry();
    reg.defineCommand(accountReorder);
    const accounts = [{ id: 'bank', name: 'Bank' }, { id: 'sav', name: 'Savings' }];
    writeFileSync(path, JSON.stringify({ ...bundle(), accounts }));
    const s = createNodeSession({ ...common, registry: reg, source: { kind: 'file', path } });
    const r = await s.dispatch('account.reorder', { ids: ['sav', 'bank'] });
    expect(r.value.committed).toBe(true);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.accounts).toEqual([accounts[1], accounts[0]]);
    expect(saved.meta.change_log).toBeUndefined();
  });

  it('dispatches, writes atomically and queries', async () => {
    const s = createNodeSession({ ...common, source: { kind: 'file', path } });
    const r = await s.dispatch('test.add', {});
    expect(r.value).toMatchObject({ committed: true, version: null });
    expect(JSON.parse(readFileSync(path, 'utf8')).transactions).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(['bundle.json']);
    expect(await s.query('test.count', {})).toEqual(ok(1));
  });

  it('dry-runs without writing and applies policies', async () => {
    const s = createNodeSession({ ...common, source: { kind: 'file', path }, policies: ['strict-ledger'] });
    expect((await s.dispatch('test.add', {}, { dryRun: true })).value.committed).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).transactions).toHaveLength(0);
    expect((await s.dispatch('test.add', { date: '2026-10-20' })).error.code).toBe('ledger_future_posted');
    expect(existsSync(path)).toBe(true);
  });

  it('applies policies stored in meta as a floor', async () => {
    writeFileSync(path, JSON.stringify({ ...bundle(), meta: { ...bundle().meta, policies: ['strict-ledger'] } }));
    const s = createNodeSession({ ...common, source: { kind: 'file', path } });
    expect((await s.dispatch('test.add', { date: '2026-10-20' })).error.code).toBe('ledger_future_posted');
  });

  it('writes nothing when a later batch step fails, and names the step', async () => {
    const before = readFileSync(path, 'utf8');
    const s = createNodeSession({ ...common, source: { kind: 'file', path } });
    const r = await s.dispatchBatch([
      { name: 'test.add', input: {} },
      { name: 'test.add', input: { date: 'not-a-date' } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.step).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['bundle.json']);
  });

  it('a dry run reports the diff the same dispatch then commits', async () => {
    const s = createNodeSession({ ...common, source: { kind: 'file', path } });
    const dry = await s.dispatch('test.add', {}, { dryRun: true });
    const real = await s.dispatch('test.add', {});
    expect(dry.value.committed).toBe(false);
    expect(real.value.committed).toBe(true);
    expect(real.value.diff).toEqual(dry.value.diff);
  });

  describe('queryAfter', () => {
    it('answers the query on the data after the steps, writing nothing', async () => {
      const before = readFileSync(path, 'utf8');
      let n = 0;
      const s = createNodeSession({ ...common, newId: () => `n${++n}`, source: { kind: 'file', path } });
      expect(await s.queryAfter([{ name: 'test.add', input: {} }, { name: 'test.add', input: {} }], 'test.count', {})).toEqual(ok(2));
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(readdirSync(dir)).toEqual(['bundle.json']);
    });

    it('returns a refused step\'s error and writes nothing', async () => {
      const before = readFileSync(path, 'utf8');
      const s = createNodeSession({ ...common, source: { kind: 'file', path } });
      const r = await s.queryAfter([
        { name: 'test.add', input: {} },
        { name: 'test.add', input: { date: 'not-a-date' } },
      ], 'test.count', {});
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.step).toBe(1);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('applies the session\'s and the budget\'s policies', async () => {
      const s = createNodeSession({ ...common, source: { kind: 'file', path }, policies: ['strict-ledger'] });
      expect((await s.queryAfter([{ name: 'test.add', input: { date: '2026-10-20' } }], 'test.count', {})).error.code).toBe('ledger_future_posted');
      writeFileSync(path, JSON.stringify({ ...bundle(), meta: { ...bundle().meta, policies: ['strict-ledger'] } }));
      const s2 = createNodeSession({ ...common, source: { kind: 'file', path } });
      expect((await s2.queryAfter([{ name: 'test.add', input: { date: '2026-10-20' } }], 'test.count', {})).error.code).toBe('ledger_future_posted');
    });
  });

  it('refuses a bundle at another schema', async () => {
    writeFileSync(path, JSON.stringify({ ...bundle(), meta: { schemaVersion: 1 } }));
    const s = createNodeSession({ ...common, source: { kind: 'file', path } });
    await expect(s.dispatch('test.add', {})).rejects.toMatchObject({ code: 'unsupported_schema' });
  });
});

describe('Postgres-backed NodeSession (fake store)', () => {
  function fakeStore({ conflicts = 0 } = {}) {
    const db = { version: 3, bundle: bundle() };
    const calls = { apply: 0, kinds: [] };
    return {
      db, calls,
      async readBudget({ budgetId }) { return { budgetId, budgetName: 'B', version: db.version, bundle: structuredClone(db.bundle) }; },
      async applyBudget({ expectedVersion, items, checkAccountRefs }) {
        calls.apply += 1;
        expect(checkAccountRefs).toBe(true);
        if (calls.apply <= conflicts) { db.version += 1; throw new BudgetStoreError('version_conflict', 'version conflict', { current: db.version }); }
        expect(expectedVersion).toBe(db.version);
        calls.kinds.push(items.map(i => i.kind));
        for (const { kind, data } of items) db.bundle[kind] = data;
        db.version += 1;
        return { version: db.version, changedKinds: items.map(i => i.kind) };
      },
    };
  }

  it('commits with the version it read', async () => {
    const store = fakeStore();
    const s = createNodeSession({ ...common, source: { kind: 'postgres', store, budgetId: 'b' } });
    const r = await s.dispatch('test.add', {});
    expect(r.value).toMatchObject({ committed: true, version: 4 });
    expect(store.db.bundle.transactions).toHaveLength(1);
  });

  it('writes only the collections that changed', async () => {
    const store = fakeStore();
    const s = createNodeSession({ ...common, source: { kind: 'postgres', store, budgetId: 'b' } });
    expect((await s.dispatch('test.touch', {})).ok).toBe(true);
    expect(store.calls.kinds).toEqual([['envelopes', 'meta']]);
  });

  it('retries once on a version conflict, then gives up', async () => {
    const once = fakeStore({ conflicts: 1 });
    expect((await createNodeSession({ ...common, source: { kind: 'postgres', store: once, budgetId: 'b' } }).dispatch('test.add', {})).ok).toBe(true);
    expect(once.calls.apply).toBe(2);
    const twice = fakeStore({ conflicts: 2 });
    const r = await createNodeSession({ ...common, source: { kind: 'postgres', store: twice, budgetId: 'b' } }).dispatch('test.add', {});
    expect(r.error).toEqual({ code: 'version_conflict', params: { current: 5 } });
  });

  it('refuses an encrypted budget', async () => {
    const store = fakeStore();
    store.db.bundle.transactions = { __enc: 1, iv: 'x', ct: 'y' };
    const s = createNodeSession({ ...common, source: { kind: 'postgres', store, budgetId: 'b' } });
    await expect(s.query('test.count', {})).rejects.toMatchObject({ code: 'encrypted_budget' });
  });
});
