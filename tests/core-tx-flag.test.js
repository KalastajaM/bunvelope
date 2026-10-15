import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import strictLedger from '../js/core/policies/strict-ledger.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: () => 'n1' });
const a = { id: 'a', type: 'expense', date: '2026-10-01', payee: 'A', amount: 10, account: 'chk', envelope_id: 'groc' };
const f = { id: 'f', type: 'expense', date: '2026-10-01', payee: 'F', amount: 20, account: 'chk', envelope_id: 'groc', flagged: true };
// Legacy rows the amend path would refuse (checkTxRow): a unit-less sell with
// no direction, and a split that does not add up.
const sell = { id: 'sell', type: 'investment_transfer', date: '2026-09-01', amount: 100, account: 'brk', status: 'posted' };
const brokenSplit = { id: 'bs', type: 'expense', date: '2026-09-01', amount: 30, account: 'chk', envelope_splits: [{ envelope_id: 'groc', amount: 5 }], status: 'posted' };
const data = (transactions = [a, f, sell, brokenSplit]) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }],
  transactions,
});
const run = (input, d = data(), name = 'transaction.flag') => runCommand(registry, d, name, input, ctx());

describe('transaction.flag', () => {
  it('flags by default, stamps modified_at, and touches nothing else on the row', () => {
    const r = run({ ids: ['a'] });
    expect(r.value.value).toEqual({ changed: 1 });
    const row = r.value.changes.transactions.find(t => t.id === 'a');
    expect(row).toEqual({ ...a, flagged: true, modified_at: NOW.toISOString() });
    expect(row).not.toHaveProperty('created_at');
  });

  it('flags legacy rows that fail the amend checks, without stripping or defaulting', () => {
    expect(run({ id: 'sell', flagged: true }, data(), 'transaction.amend').ok).toBe(false);
    const r = run({ ids: ['sell', 'bs'] });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ changed: 2 });
    const txs = r.value.changes.transactions;
    expect(txs.find(t => t.id === 'sell')).toEqual({ ...sell, flagged: true, modified_at: NOW.toISOString() });
    expect(txs.find(t => t.id === 'bs')).toEqual({ ...brokenSplit, flagged: true, modified_at: NOW.toISOString() });
  });

  it('flagged: false unflags', () => {
    const r = run({ ids: ['f'], flagged: false });
    expect(r.value.changes.transactions.find(t => t.id === 'f')).toEqual({ ...f, flagged: false, modified_at: NOW.toISOString() });
  });

  it('leaves rows that already have the value untouched, and reports no change', () => {
    const r = run({ ids: ['a', 'f'] });
    expect(r.value.value).toEqual({ changed: 1 });
    expect(r.value.changes.transactions.find(t => t.id === 'f')).toBe(f);
    const none = run({ ids: ['f'] });
    expect(none.value.value).toEqual({ changed: 0 });
    expect(none.value.changes).toEqual({});
    // An absent flag counts as false.
    expect(run({ ids: ['a'], flagged: false }).value.value).toEqual({ changed: 0 });
  });

  it('reports an unknown id and writes nothing', () => {
    expect(run({ ids: ['a', 'zz'] }).error).toEqual({ code: 'tx_not_found', params: { id: 'zz' } });
  });

  it('needs at least one id', () => {
    const r = run({ ids: [] });
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors).toEqual([{ path: 'ids', message: 'needs at least one id' }]);
  });

  it('passes strict-ledger on a posted past row with no created_at', () => {
    const r = runCommand(registry, data(), 'transaction.flag', { ids: ['sell'] }, ctx(), { policies: [strictLedger] });
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions.find(t => t.id === 'sell').flagged).toBe(true);
  });
});
