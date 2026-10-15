// tests/engine/balance-invariants.test.js — money-conservation identities over
// a fixture containing every transaction type. Previously these invariants
// were only implied by isolated numeric expectations; here they are asserted
// directly:
//
//   1. unallocated == round2(Σ non-investment account balances − Σ envelope balances)
//   2. each account balance == round2(initialBalance + Σ txAccountDelta(tx, id))
//
// and both must hold under the posted-only lens as well.

import { describe, it, expect } from 'vitest';
import {
  computeAccountBalances,
  computeEnvelopeBalances,
  computeUnallocated,
} from '../../js/engine/balances.js';
import { txAccountDelta } from '../../js/engine/tx-amounts.js';
import { round2 } from '../../js/utils.js';

const accounts = [
  { id: 'bank',   name: 'Checking',   type: 'bank',        initialBalance: 1000 },
  { id: 'card',   name: 'Card',       type: 'credit_card', initialBalance: -120 },
  { id: 'broker', name: 'Broker',     type: 'investment',  initialBalance: 0 },
];

// One of every type. Amounts follow the write convention: positive magnitude
// everywhere except adjustments.
const txs = [
  { id: 'i1', type: 'income', account: 'bank', amount: 2500.35, date: '2026-06-01', status: 'posted' },
  { id: 'f1', type: 'fill', source: 'new_income', source_account: 'bank', date: '2026-06-01', status: 'posted',
    lines: [
      { envelope_id: 'food', mode: 'add', amount: 400 },
      { envelope_id: 'rent', mode: 'add', amount: 900.55 },
    ] },
  { id: 'f2', type: 'fill', date: '2026-06-02', status: 'posted',
    lines: [{ envelope_id: 'fun', mode: 'set', amount: 150 }] },
  { id: 'e1', type: 'expense', account: 'bank', envelope_id: 'food', amount: 33.33, date: '2026-06-03', status: 'posted' },
  { id: 'e2', type: 'expense', account: 'card', date: '2026-06-04', status: 'posted', amount: 60,
    envelope_splits: [
      { envelope_id: 'food', amount: 75.5 },
      { envelope_id: 'fun', amount: -15.5 }, // signed credit line
    ] },
  { id: 'at1', type: 'account_transfer', from_account: 'bank', to_account: 'card', amount: 50, date: '2026-06-05', status: 'posted' },
  { id: 'et1', type: 'envelope_transfer', from_envelope_id: 'fun', to_envelope_id: 'food', amount: 25.25, date: '2026-06-06', status: 'posted' },
  { id: 'dp1', type: 'debt_payment', from_account: 'bank', to_account: 'card', envelope_id: 'debt', amount: 70, date: '2026-06-07', status: 'posted' },
  { id: 'iv1', type: 'investment_transfer', direction: 'buy', from_account: 'bank', to_account: 'broker', envelope_id: 'invest', amount: 200, fee: 2, symbol: 'ACME', units: 10, date: '2026-06-08', status: 'posted' },
  { id: 'iv2', type: 'investment_transfer', direction: 'sell', from_account: 'broker', to_account: 'bank', envelope_id: 'invest', amount: 80, symbol: 'ACME', units: 4, date: '2026-06-09', status: 'posted' },
  { id: 'iv3', type: 'investment_transfer', direction: 'dividend', from_account: 'broker', to_account: 'bank', envelope_id: 'invest', amount: 5.05, symbol: 'ACME', date: '2026-06-10', status: 'posted' },
  { id: 'aj1', type: 'adjustment', target: 'account', target_id: 'bank', amount: -12.4, date: '2026-06-11', status: 'posted' },
  { id: 'aj2', type: 'adjustment', target: 'envelope', target_id: 'food', amount: 8.15, date: '2026-06-11', status: 'posted' },
  // Non-posted rows: excluded under { onlyPosted: true }, included otherwise.
  { id: 's1', type: 'expense', account: 'bank', envelope_id: 'food', amount: 40, date: '2026-06-20', status: 'scheduled' },
  { id: 'fc1', type: 'expense', account: 'bank', envelope_id: 'rent', amount: 900.55, date: '2026-06-28', is_forecast: true, status: 'scheduled' },
  // Status-less row = posted (manual entry never sets status).
  { id: 'm1', type: 'expense', account: 'bank', envelope_id: 'fun', amount: 9.99, date: '2026-06-12' },
];

function assertIdentities(opts) {
  const acctBal = computeAccountBalances(accounts, txs, opts);
  const envBal = computeEnvelopeBalances(txs, opts);

  // Identity 2: account balance == initial + Σ deltas (respecting the lens).
  const included = (opts && (opts.onlyPosted || opts.asOf))
    ? txs.filter(tx => {
        if (opts.onlyPosted && (tx.is_forecast || (tx.status && tx.status !== 'posted'))) return false;
        if (opts.asOf && tx.date > opts.asOf) return false;
        return true;
      })
    : txs;
  for (const a of accounts) {
    const expected = included.reduce((s, tx) => s + txAccountDelta(tx, a.id), a.initialBalance);
    expect(round2(acctBal.get(a.id))).toBe(round2(expected));
  }

  // Identity 1: unallocated == non-investment accounts − envelopes.
  let acctSum = 0;
  for (const [id, v] of acctBal) {
    if (accounts.find(a => a.id === id)?.type === 'investment') continue;
    acctSum += v;
  }
  let envSum = 0;
  for (const v of envBal.values()) envSum += v;
  expect(computeUnallocated(acctBal, envBal, accounts)).toBe(round2(acctSum - envSum));
}

describe('balance conservation invariants', () => {
  it('hold in the all-inclusive budget view', () => {
    assertIdentities(undefined);
  });

  it('hold under the posted-only lens', () => {
    assertIdentities({ onlyPosted: true });
  });

  it('hold under an asOf cutoff', () => {
    assertIdentities({ asOf: '2026-06-08' });
  });

  it('posted-only lens excludes scheduled and forecast rows but keeps status-less rows', () => {
    const all = computeAccountBalances(accounts, txs);
    const posted = computeAccountBalances(accounts, txs, { onlyPosted: true });
    // Difference on 'bank' is exactly the scheduled (40) + forecast (900.55) rows.
    expect(round2(all.get('bank'))).toBe(round2(posted.get('bank') - 40 - 900.55));
    // The status-less manual expense is included in both.
    const noManual = txs.filter(tx => tx.id !== 'm1');
    const postedWithout = computeAccountBalances(accounts, noManual, { onlyPosted: true });
    expect(round2(postedWithout.get('bank') - posted.get('bank'))).toBe(9.99);
  });
});
