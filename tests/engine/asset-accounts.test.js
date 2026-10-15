// Asset accounts (owner request 2026-09-24): a home, gold, or a debt such as
// a mortgage, valued by dated adjustments. They count toward net worth and
// nothing else — above all, never toward Unallocated.
import { describe, it, expect } from 'vitest';
import {
  isAssetAccount, isSpendingAccount, isCrisisCashAccount, countsTowardIdentity,
  computeAccountBalances, computeEnvelopeBalances, computeUnallocated, computeNetWorth,
} from '../../js/engine.js';

const accounts = [
  { id: 'bank', type: 'bank', initialBalance: 1000 },
  { id: 'home', type: 'asset', group: 'Properties', initialBalance: 250000 },
  { id: 'mortgage', type: 'asset', group: 'Mortgage', initialBalance: -180000 },
];
const fill = { id: 'f', type: 'fill', date: '2026-09-01', status: 'posted', source: 'allocation',
  lines: [{ envelope_id: 'food', amount: 600, mode: 'add' }] };
const valueUpdate = { id: 'v', type: 'adjustment', target: 'account', target_id: 'home',
  amount: 10000, date: '2026-09-10', status: 'posted', payee: 'Value update' };

const unallocated = (txs) => computeUnallocated(
  computeAccountBalances(accounts, txs), computeEnvelopeBalances(txs), accounts);

describe('asset accounts', () => {
  it('are recognised by type', () => {
    expect(isAssetAccount(accounts[1])).toBe(true);
    expect(isAssetAccount(accounts[0])).toBe(false);
    expect(isAssetAccount(null)).toBe(false);
  });

  it('never count toward Unallocated, and a value update does not move it', () => {
    expect(countsTowardIdentity(accounts[1])).toBe(false);
    expect(unallocated([fill])).toBe(400);
    expect(unallocated([fill, valueUpdate])).toBe(400);
  });

  it('are never spending or crisis cash, whatever their flags say', () => {
    const flagged = { id: 'x', type: 'asset', spending: true, crisisCash: true };
    expect(isSpendingAccount(flagged)).toBe(false);
    expect(isCrisisCashAccount(flagged)).toBe(false);
  });

  it('form the "assets" part of net worth, debts included', () => {
    const w = computeNetWorth(accounts, [valueUpdate]);
    expect(w.assets).toBe(250000 + 10000 - 180000);
    expect(w.spending).toBe(1000);
    expect(w.total).toBe(1000 + 80000);
  });
});
