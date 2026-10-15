import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const a = { id: 'a', type: 'expense', date: '2026-10-01', payee: 'A', amount: 10, account: 'chk', envelope_id: 'groc', cleared: false };
const b = { id: 'b', type: 'expense', date: '2026-10-01', payee: 'B', amount: 20, account: 'chk', envelope_id: 'groc', cleared: true, from_budget: 'rent:2026-10' };
const c = { id: 'c', type: 'expense', date: '2026-09-01', payee: 'C', amount: 5, account: 'chk', envelope_id: 'groc', cleared: false, from_budget: 'gym:2026-09' };
const s = { id: 's', type: 'expense', date: '2026-11-01', payee: 'S', amount: 30, account: 'chk', envelope_id: 'groc', status: 'scheduled' };
const data = (meta = {}) => deepFreeze({
  meta, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }],
  transactions: [a, b, c, s],
});
const run = (name, input, d = data()) => runCommand(registry, d, name, input, ctx());

describe('transaction.delete', () => {
  it('removes the rows and tombstones their from_budget keys', () => {
    const r = run('transaction.delete', { ids: ['a', 'b'] });
    expect(r.value.changes.transactions.map(t => t.id)).toEqual(['c', 's']);
    expect(r.value.changes.meta).toEqual({ scheduledTombstones: ['rent:2026-10'] });
    expect(r.value.value).toEqual({ deleted: 2, tombstones: ['rent:2026-10'] });
  });

  it('keeps existing tombstones and adds a key once', () => {
    const d = data({ other: 1, scheduledTombstones: ['old'] });
    const r = run('transaction.delete', { ids: ['b', 'c'] }, d);
    expect(r.value.changes.meta).toEqual({ other: 1, scheduledTombstones: ['old', 'rent:2026-10', 'gym:2026-09'] });
    const again = runCommand(registry, r.value.after, 'transaction.delete', { ids: ['b'] }, ctx());
    expect(again.error.code).toBe('tx_not_found');
  });

  it('adds no meta change when the key is already a tombstone or the row has none', () => {
    const d = data({ scheduledTombstones: ['rent:2026-10'] });
    const r = run('transaction.delete', { ids: ['a', 'b'] }, d);
    expect(r.value.changes).not.toHaveProperty('meta');
    expect(r.value.value).toEqual({ deleted: 2, tombstones: [] });
    expect(run('transaction.delete', { ids: ['a'] }).value.changes).not.toHaveProperty('meta');
  });

  it('does not duplicate a key shared by two deleted rows', () => {
    const d = deepFreeze({ ...data(), transactions: [b, { ...c, from_budget: 'rent:2026-10' }] });
    const r = run('transaction.delete', { ids: ['b', 'c'] }, d);
    expect(r.value.value.tombstones).toEqual(['rent:2026-10']);
    expect(r.value.changes.meta.scheduledTombstones).toEqual(['rent:2026-10']);
  });

  it('counts a row named twice once', () => {
    const r = run('transaction.delete', { ids: ['a', 'a', 'b'] });
    expect(r.value.value.deleted).toBe(2);
    expect(r.value.changes.transactions.map(t => t.id)).toEqual(['c', 's']);
  });

  it('reports the first missing id and writes nothing', () => {
    const r = run('transaction.delete', { ids: ['a', 'nope', 'nope2'] });
    expect(r.error).toEqual({ code: 'tx_not_found', params: { id: 'nope' } });
  });

  it('needs at least one id', () => {
    const r = run('transaction.delete', { ids: [] });
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors).toEqual([{ path: 'ids', message: 'needs at least one id' }]);
  });
});

describe('transaction.clear', () => {
  it('changes only rows whose value differs', () => {
    const r = run('transaction.clear', { ids: ['a', 'b'] });
    expect(r.value.value).toEqual({ changed: 1 });
    const txs = r.value.changes.transactions;
    expect(txs.find(t => t.id === 'a')).toEqual({ ...a, cleared: true });
    expect(txs.find(t => t.id === 'a')).not.toHaveProperty('modified_at');
    expect(txs.find(t => t.id === 'b')).toBe(b);
  });

  it('cleared: false unclears', () => {
    const r = run('transaction.clear', { ids: ['a', 'b'], cleared: false });
    expect(r.value.value).toEqual({ changed: 1 });
    expect(r.value.changes.transactions.find(t => t.id === 'b').cleared).toBe(false);
  });

  it('reports an unknown id', () => {
    expect(run('transaction.clear', { ids: ['a', 'zz'] }).error).toEqual({ code: 'tx_not_found', params: { id: 'zz' } });
  });
});

describe('transaction.post', () => {
  it('posts a scheduled row, cleared by default, with a new date', () => {
    const r = run('transaction.post', { id: 's', date: '2026-10-02' });
    expect(r.value.value).toMatchObject({ id: 's', status: 'posted', cleared: true, date: '2026-10-02', modified_at: NOW.toISOString() });
    expect(r.value.changes.transactions.find(t => t.id === 's')).toEqual(r.value.value);
  });

  it('keeps the date when none is given and honours cleared: false', () => {
    const v = run('transaction.post', { id: 's', cleared: false }).value.value;
    expect(v).toMatchObject({ status: 'posted', cleared: false, date: '2026-11-01' });
  });

  it('refuses a row that is not scheduled', () => {
    expect(run('transaction.post', { id: 'a' }).error).toEqual({ code: 'not_scheduled', params: { id: 'a', status: undefined } });
    const p = deepFreeze({ ...data(), transactions: [{ ...a, status: 'posted' }] });
    expect(run('transaction.post', { id: 'a' }, p).error.params).toEqual({ id: 'a', status: 'posted' });
  });

  it('reports an unknown id', () => {
    expect(run('transaction.post', { id: 'zz' }).error).toEqual({ code: 'tx_not_found', params: { id: 'zz' } });
  });
});
