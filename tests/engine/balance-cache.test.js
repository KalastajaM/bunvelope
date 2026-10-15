import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeEnvelopeBalances,
  computeAccountBalances,
  computeAccountBalancesAsOf,
} from '../../js/engine.js';
import { _stats, _resetStats } from '../../js/engine/balance-cache.js';

const accounts = [
  { id: 'a1', name: 'Checking', initialBalance: 1000 },
  { id: 'a2', name: 'Savings',  initialBalance: 5000 },
];

const txs = [
  { id: 't1', type: 'income',  date: '2025-01-05', amount: 200, account: 'a1', envelope_id: 'food' },
  { id: 't2', type: 'expense', date: '2025-01-10', amount:  30, account: 'a1', envelope_id: 'food' },
  { id: 't3', type: 'expense', date: '2025-02-01', amount:  50, account: 'a2', envelope_id: 'fun' },
];

beforeEach(() => { _resetStats(); });

describe('balance-cache identity memo', () => {
  it('returns reference-equal Map for same (transactions, accounts, opts)', () => {
    const a = computeAccountBalances(accounts, txs);
    const b = computeAccountBalances(accounts, txs);
    expect(b).toBe(a);
    expect(_stats.hits).toBe(1);
    expect(_stats.misses).toBe(1);
  });

  it('reference-equal for envelope balances too', () => {
    const a = computeEnvelopeBalances(txs);
    const b = computeEnvelopeBalances(txs);
    expect(b).toBe(a);
  });

  it('different transactions array (same contents) produces a fresh Map', () => {
    const txsCopy = txs.map(t => ({ ...t }));
    const a = computeAccountBalances(accounts, txs);
    const b = computeAccountBalances(accounts, txsCopy);
    expect(b).not.toBe(a);
    // Value-equal
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it('different accounts identity does not collide with cached entry', () => {
    const a = computeAccountBalances(accounts, txs);
    const accounts2 = accounts.map(x => ({ ...x }));
    const b = computeAccountBalances(accounts2, txs);
    expect(b).not.toBe(a);
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it('different opts keys do not collide', () => {
    const all      = computeAccountBalances(accounts, txs);
    const posted   = computeAccountBalances(accounts, txs, { onlyPosted: true });
    expect(posted).not.toBe(all);
    // Same content here because no scheduled rows exist in the fixture.
    expect([...posted.entries()].sort()).toEqual([...all.entries()].sort());
  });

  it('asOf opts variants are memoized separately by date', () => {
    const eom1 = computeAccountBalancesAsOf(accounts, txs, new Date('2025-01-31'));
    const eom2 = computeAccountBalancesAsOf(accounts, txs, new Date('2025-02-28'));
    expect(eom1).not.toBe(eom2);
    // Jan-only excludes the Feb expense from a2.
    expect(eom1.get('a2')).toBe(5000);
    expect(eom2.get('a2')).toBe(5000 - 50);
  });

  it('cached Map is locked: set/delete/clear throw', () => {
    const m = computeAccountBalances(accounts, txs);
    expect(() => m.set('zzz', 0)).toThrow(/cached/);
    expect(() => m.delete('a1')).toThrow(/cached/);
    expect(() => m.clear()).toThrow(/cached/);
  });

  it('reading values still works on locked Map', () => {
    const m = computeAccountBalances(accounts, txs);
    expect(m.get('a1')).toBe(1000 + 200 - 30);
    expect(m.get('a2')).toBe(5000 - 50);
    expect(m.size).toBe(2);
    expect([...m.keys()].sort()).toEqual(['a1', 'a2']);
  });

  it('cached path returns equal results to a fresh array call (correctness)', () => {
    const cached = computeEnvelopeBalances(txs);
    const fresh  = computeEnvelopeBalances([...txs]);
    expect([...fresh.entries()].sort()).toEqual([...cached.entries()].sort());
  });

  it('empty transactions array yields empty balance Map', () => {
    const out = computeEnvelopeBalances([]);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });
});
