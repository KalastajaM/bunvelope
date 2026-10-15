// transaction.import: many recorded rows in one step. It builds each row with
// the same helper transaction.record uses, so the two cannot drift; the point
// of a separate command is that the commit checks run once, not once per row.
import { describe, it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runBatch } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import { createBrowserSession } from '../js/session/browser-session.js';
import { createMetaQueue } from '../js/state/meta-queue.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const STAMP = NOW.toISOString();
const counter = (prefix) => { let n = 0; return () => `${prefix}${++n}`; };
const ctx = (prefix = 'n') => makeCtx({ now: NOW, newId: counter(prefix) });
const existing = [
  { id: 'old1', type: 'expense', date: '2026-10-05', payee: 'Later', amount: 3, account: 'chk', envelope_id: 'groc' },
  { id: 'old2', type: 'income', date: '2026-01-01', payee: 'Earlier', amount: 9, account: 'chk', envelope_id: null },
];
const data = (transactions = existing, meta = {}) => deepFreeze({
  meta, budgetItems: [{ id: 'rent', description: 'Rent' }], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }, { id: 'sav', name: 'Savings' }, { id: 'broker', name: 'Broker', type: 'investment' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }],
  transactions,
});
const run = (input, d = data(), opts) => runCommand(registry, d, 'transaction.import', input, ctx('i'), opts);
const paths = (r) => r.error.params.errors.map(e => e.path);

const MIXED = [
  { type: 'expense', amount: 12.3, account: 'chk', envelope: 'groc', payee: 'K-Market', date: '2026-10-01', source: 'csv' },
  { type: 'expense', amount: 30, account: 'chk', date: '2026-10-02', splits: [{ envelope: 'groc', amount: 20 }, { envelope: 'fun', amount: 10 }] },
  { type: 'income', amount: 100, account: 'chk', payee: 'Salary', note: ' August ', cleared: true },
  { type: 'account_transfer', amount: 5, fromAccount: 'chk', toAccount: 'sav' },
  { type: 'envelope_transfer', amount: 7, fromEnvelope: null, toEnvelope: 'groc' },
  { type: 'investment_transfer', amount: 500, direction: 'buy', fromAccount: 'chk', toAccount: 'broker', units: 13.82, pricePerUnit: 36.18, symbol: ' abc ' },
];

describe('transaction.import', () => {
  it('gives exactly the rows N transaction.record steps give, apart from ids', () => {
    const viaBatch = runBatch(registry, data(), MIXED.map(input => ({ name: 'transaction.record', input })), ctx('b'));
    expect(viaBatch.ok).toBe(true);
    const r = run({ rows: MIXED });
    expect(r.ok).toBe(true);
    const strip = ({ id: _i, ...rest }) => rest;
    expect(r.value.value.rows.map(strip)).toEqual(viaBatch.value.value.map(strip));
    expect(r.value.value.rows.map(t => t.id)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5', 'i6']);
    // Same ledger too, not just the same values.
    expect(r.value.changes.transactions.map(strip)).toEqual(viaBatch.value.changes.transactions.map(strip));
  });

  it('appends in input order after the existing rows, without re-sorting the ledger', () => {
    const r = run({ rows: MIXED });
    const ids = r.value.changes.transactions.map(t => t.id);
    expect(ids).toEqual(['old1', 'old2', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6']);
    expect(r.value.diff.transactions.added).toHaveLength(6);
  });

  it('keeps source and cleared, stamps both timestamps and defaults the date to today', () => {
    const [first, , third] = run({ rows: MIXED }).value.value.rows;
    expect(first).toMatchObject({ source: 'csv', created_at: STAMP, modified_at: STAMP, envelope_id: 'groc' });
    expect(third).toMatchObject({ cleared: true, date: '2026-10-02', note: 'August' });
    expect(run({ rows: [{ type: 'income', amount: 1, account: 'chk' }] }).value.value.rows[0].date).toBe('2026-10-02');
  });

  it('records scheduled rows as scheduled, without cleared', () => {
    const r = run({ rows: [{ type: 'expense', amount: 1, account: 'chk', scheduled: true, cleared: true }, { type: 'expense', amount: 2, account: 'chk' }] });
    const [a, b] = r.value.value.rows;
    expect(a.status).toBe('scheduled');
    expect(a).not.toHaveProperty('cleared');
    expect(b).not.toHaveProperty('status');
  });

  it('refuses an empty rows list', () => {
    const r = run({ rows: [] });
    expect(r.error.code).toBe('bad_input');
    expect(paths(r)).toEqual(['rows']);
    expect(run({}).error.code).toBe('bad_input');
  });

  it('a schema error on a row names the row in its path and changes nothing', () => {
    const unknownField = run({ rows: [MIXED[0], { type: 'expense', amount: 1, account: 'chk', colour: 'red' }] });
    expect(unknownField.error.code).toBe('bad_input');
    expect(paths(unknownField)).toEqual(['rows[1].colour']);
    const noAmount = run({ rows: [{ type: 'expense', account: 'chk' }] });
    expect(paths(noAmount)).toEqual(['rows[0].amount']);
    const noEnvelope = run({ rows: [MIXED[0], MIXED[1], { type: 'expense', amount: 1, account: 'chk', envelope: 'nope' }] });
    expect(paths(noEnvelope)).toEqual(['rows[2].envelope']);
    // force belongs to the import, not to a row.
    expect(paths(run({ rows: [{ ...MIXED[0], force: true }] }))).toEqual(['rows[0].force']);
    expect(run({ rows: [MIXED[0]], force: true }).ok).toBe(true);
  });

  it('a row the builder refuses fails the whole command, naming the row', () => {
    const r = run({ rows: [MIXED[0], MIXED[3], { type: 'account_transfer', amount: 5, fromAccount: 'chk', toAccount: 'chk' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({ code: 'same_account', params: { row: 2 } });
    expect(run({ rows: [{ type: 'expense', amount: 5 }] }).error).toEqual({ code: 'field_required', params: { field: 'account', row: 0 } });
    expect(run({ rows: [{ type: 'expense', amount: 5, account: 'chk', splits: [{ envelope: 'groc', amount: 5 }] }] }).error)
      .toEqual({ code: 'split_invalid', params: { problems: ['tooFewSplits'], row: 0 } });
  });

  it('a refused import writes nothing: the input data is untouched', () => {
    const d = data();
    const r = runCommand(registry, d, 'transaction.import', { rows: [MIXED[0], { type: 'expense', amount: 5 }] }, ctx());
    expect(r.ok).toBe(false);
    expect(d.transactions).toEqual(existing);
  });

  it('is one pipeline step: the commit checks are called once for 2,000 rows on a 20,000-row ledger', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => ({ id: `t${i}`, type: 'expense', date: '2026-01-01', payee: 'P', amount: 1, account: 'chk', envelope_id: 'groc' }));
    const rows = Array.from({ length: 2_000 }, (_, i) => ({ type: 'expense', amount: 1 + (i % 9), account: 'chk', envelope: 'groc', payee: `Shop ${i % 50}` }));
    const checks = vi.fn(applyCommitChecks);
    const r = run({ rows }, data(big), { checks });
    expect(r.ok).toBe(true);
    expect(checks).toHaveBeenCalledTimes(1);
    expect(r.value.changes.transactions).toHaveLength(22_000);
    expect(r.value.diff.transactions.added).toHaveLength(2_000);
  });

  it('is described as a command with rows in its schema, and its items do not take force', () => {
    const entry = registry.get('transaction.import');
    expect(entry.kind).toBe('command');
    expect(entry.input.required).toEqual(['rows']);
    expect(entry.input.properties.rows.items.properties).not.toHaveProperty('force');
    expect(entry.input.properties.rows.items.properties).toHaveProperty('scheduled');
  });
});

describe('transaction.import through a session', () => {
  it('applies payee aliases to every imported row, in one write', async () => {
    const state = {
      budgetFolder: { name: 'A' },
      meta: { schemaVersion: 8, country: 'FI', payeeAliases: { 'k market': 'K-Market' } },
      accounts: [{ id: 'chk', name: 'Checking' }], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [],
    };
    const writes = [];
    const queue = createMetaQueue(async () => {});
    const session = createBrowserSession({
      state, registry, updateMeta: queue.update, runMetaExclusive: queue.runExclusive,
      writeBatch: async (ref, items) => { writes.push(items); },
      currentGeneration: () => 1, notify: () => {}, clock: () => NOW, newId: counter('s'),
      isVersionConflict: () => false,
    });
    const r = await session.dispatch('transaction.import', { rows: [
      { type: 'expense', amount: 4, account: 'chk', payee: 'k market' },
      { type: 'expense', amount: 5, account: 'chk', payee: 'Other' },
      { type: 'expense', amount: 6, account: 'chk', payee: 'K MARKET' },
    ] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(state.transactions.map(t => t.payee)).toEqual(['K-Market', 'Other', 'K-Market']);
    expect(writes).toHaveLength(1);
    expect(r.value.undo).toBeTruthy();
  });
});
