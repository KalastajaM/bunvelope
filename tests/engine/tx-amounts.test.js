// tests/engine/tx-amounts.test.js — write-boundary normalizers and the
// shared posted-lens predicate. The reference-identity assertions matter:
// the balance memoization compares transaction arrays by identity, so a
// no-op normalization must return the same objects/array.

import { describe, it, expect } from 'vitest';
import {
  normalizeTxAmount,
  normalizeTransactionsForWrite,
  isPostedTx,
} from '../../js/engine/tx-amounts.js';

describe('normalizeTxAmount', () => {
  it('flips negative amounts to positive for type-signed transactions', () => {
    for (const type of ['expense', 'income', 'account_transfer', 'envelope_transfer', 'debt_payment', 'investment_transfer', 'fill']) {
      const tx = { id: 't', type, amount: -42.5 };
      const out = normalizeTxAmount(tx);
      expect(out.amount).toBe(42.5);
      expect(out).not.toBe(tx);
      // Input is not mutated.
      expect(tx.amount).toBe(-42.5);
    }
  });

  it('preserves the sign of adjustments', () => {
    const neg = { id: 'a1', type: 'adjustment', target: 'envelope', target_id: 'e1', amount: -30 };
    expect(normalizeTxAmount(neg)).toBe(neg);
    const pos = { id: 'a2', type: 'adjustment', target: 'account', target_id: 'b1', amount: 30 };
    expect(normalizeTxAmount(pos)).toBe(pos);
  });

  it('returns the same object reference when nothing changes', () => {
    const tx = { id: 't', type: 'expense', amount: 12.5 };
    expect(normalizeTxAmount(tx)).toBe(tx);
  });

  it('passes through missing or malformed amounts untouched', () => {
    const noAmount = { id: 't1', type: 'fill', lines: [] };
    expect(normalizeTxAmount(noAmount)).toBe(noAmount);
    const nullAmount = { id: 't2', type: 'expense', amount: null };
    expect(normalizeTxAmount(nullAmount)).toBe(nullAmount);
    const junk = { id: 't3', type: 'expense', amount: 'abc' };
    expect(normalizeTxAmount(junk)).toBe(junk);
    expect(normalizeTxAmount(null)).toBe(null);
  });
});

describe('normalizeTransactionsForWrite', () => {
  it('returns the same array reference when nothing needs normalising', () => {
    const txs = [
      { id: 't1', type: 'expense', amount: 10 },
      { id: 't2', type: 'adjustment', target: 'envelope', target_id: 'e1', amount: -5 },
    ];
    expect(normalizeTransactionsForWrite(txs)).toBe(txs);
  });

  it('replaces only the rows that change, keeping identity for the rest', () => {
    const clean = { id: 't1', type: 'income', amount: 100 };
    const dirty = { id: 't2', type: 'expense', amount: -25 };
    const out = normalizeTransactionsForWrite([clean, dirty]);
    expect(out).not.toBe([clean, dirty]);
    expect(out[0]).toBe(clean);
    expect(out[1]).not.toBe(dirty);
    expect(out[1].amount).toBe(25);
  });

  it('passes non-array input through', () => {
    expect(normalizeTransactionsForWrite(null)).toBe(null);
  });
});

describe('isPostedTx', () => {
  it('treats a missing status as posted (manual entry never sets one)', () => {
    expect(isPostedTx({ type: 'expense', amount: 10 })).toBe(true);
    expect(isPostedTx({ type: 'expense', status: '', amount: 10 })).toBe(true);
  });

  it('accepts explicit posted status', () => {
    expect(isPostedTx({ status: 'posted' })).toBe(true);
  });

  it('rejects scheduled and forecast rows', () => {
    expect(isPostedTx({ status: 'scheduled' })).toBe(false);
    expect(isPostedTx({ is_forecast: true })).toBe(false);
    // Forecast beats a stray posted status.
    expect(isPostedTx({ is_forecast: true, status: 'posted' })).toBe(false);
  });

  it('rejects nullish input', () => {
    expect(isPostedTx(null)).toBe(false);
    expect(isPostedTx(undefined)).toBe(false);
  });
});
