// The balance walks add whole cents, not euros (owner decision 2026-09-29,
// "cents inside the engine"). A float sum of two-decimal amounts drifts in
// its last bits: 0.1 + 0.2 is 0.30000000000000004, and on the owner's ledger
// 26 of 50 envelope balances failed a two-decimal round trip. Every balance
// the engine returns is now an exact two-decimal number, and it never differs
// from the old float walk by anything a cent can see.
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  computeEnvelopeBalances, computeAccountBalances, computeAccountBalancesAtDates,
  computeEnvelopeRunningBalances, computeAccountRunningBalances, computeUnallocated,
  txEnvelopeIds, txEnvelopeEffect, applyAccountEffects,
} from '../../js/engine/balances.js';
import { ACCOUNTS, ENVELOPE_IDS, arbLedger } from './arbitraries.js';

const isExactCents = (v) => Math.round(v * 100) / 100 === v && Number.isFinite(v);

/**
 * The old walk: euros added as floats, in date order (array index breaking
 * ties), since a set-mode fill overwrites whatever came before it by date.
 */
function floatEnvelopeWalk(txs) {
  const out = new Map();
  const ordered = txs.map((tx, i) => ({ tx, i }))
    .sort((a, b) => ((a.tx.date || '') < (b.tx.date || '') ? -1 : (a.tx.date || '') > (b.tx.date || '') ? 1 : a.i - b.i))
    .map(x => x.tx);
  for (const tx of ordered) {
    for (const id of txEnvelopeIds(tx)) {
      const e = txEnvelopeEffect(tx, id);
      if (!e) continue;
      out.set(id, e.mode === 'set' ? e.value : (out.get(id) ?? 0) + e.amount);
    }
  }
  return out;
}
function floatAccountWalk(accounts, txs) {
  const out = new Map(accounts.map(a => [a.id, a.initialBalance ?? 0]));
  for (const tx of txs) applyAccountEffects(tx, (id, d) => out.set(id, (out.get(id) ?? 0) + d));
  return out;
}

describe('balances in whole cents', () => {
  it('0.1 + 0.2 is 0.3, exactly', () => {
    const txs = [
      { id: 'a', type: 'income', date: '2026-09-01', amount: 0.1, account: 'chk', envelope_id: 'e1' },
      { id: 'b', type: 'income', date: '2026-09-02', amount: 0.2, account: 'chk', envelope_id: 'e1' },
    ];
    expect(computeEnvelopeBalances(txs).get('e1')).toBe(0.3);
    expect(computeAccountBalances([{ id: 'chk', initialBalance: 0 }], txs).get('chk')).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3); // the drift this removes
  });

  it('every envelope, account, running and unallocated figure is exact, and within a cent of the float walk', () => {
    fc.assert(fc.property(arbLedger(40), (txs) => {
      const env = computeEnvelopeBalances(txs);
      const acct = computeAccountBalances(ACCOUNTS, txs);
      const oldEnv = floatEnvelopeWalk(txs);
      const oldAcct = floatAccountWalk(ACCOUNTS, txs);
      for (const [id, v] of env) {
        expect(isExactCents(v), `envelope ${id} = ${v}`).toBe(true);
        expect(Math.abs(v - (oldEnv.get(id) ?? 0))).toBeLessThan(0.005);
      }
      for (const [id, v] of acct) {
        expect(isExactCents(v), `account ${id} = ${v}`).toBe(true);
        expect(Math.abs(v - (oldAcct.get(id) ?? 0))).toBeLessThan(0.005);
      }
      expect(isExactCents(computeUnallocated(acct, env, ACCOUNTS))).toBe(true);
      for (const v of computeEnvelopeRunningBalances(txs, ENVELOPE_IDS[0]).values()) expect(isExactCents(v)).toBe(true);
      for (const v of computeAccountRunningBalances(ACCOUNTS, txs, 'chk').values()) expect(isExactCents(v)).toBe(true);
      // The running walk's last step is the bulk walk's figure, exactly.
      const run = [...computeAccountRunningBalances(ACCOUNTS, txs, 'chk').values()];
      if (run.length) expect(run.at(-1)).toBe(acct.get('chk'));
    }), { numRuns: 300 });
  });

  it('the multi-date walk now agrees with the single-date walk exactly', () => {
    fc.assert(fc.property(arbLedger(40), (txs) => {
      const dates = ['2025-06-30', '2026-01-31', '2027-12-31'];
      const at = computeAccountBalancesAtDates(ACCOUNTS, txs, { dates });
      dates.forEach((d, k) => {
        const single = computeAccountBalances(ACCOUNTS, txs, { asOf: d });
        for (const [id, v] of single) expect(at[k].get(id)).toBe(v);
      });
    }), { numRuns: 200 });
  });
});
