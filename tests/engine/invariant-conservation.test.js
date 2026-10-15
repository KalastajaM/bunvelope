// §4.5 — a money-conservation check.
//
// The identity §4.5 names — Σ accounts − Σ envelopes === unallocated — is
// definitional in v1 and cannot fail: envelope balances derive entirely from
// the transaction list, account balances are initialBalance plus a walk over
// the SAME list, and computeUnallocated IS the difference. insights.js's own
// docstring already said so, correctly.
//
// The non-tautological half is real, though. v1 derives a transaction's
// account-side movement and its envelope-side movement in two SEPARATE
// implementations — txAccountDelta in tx-amounts.js, txEnvelopeEffect in
// balances.js. For a row that charges an envelope the two describe the same
// money and must agree, and nothing enforced that they did.
import { describe, it, expect } from 'vitest';
import { runInvariantCheck, validateConservation } from '../../js/engine/insights.js';

const ACCOUNTS = [{ id: 'cash', name: 'Cash' }];
const ENVELOPES = [{ id: 'food', name: 'Food' }, { id: 'rent', name: 'Rent' }];
const acctIds = new Set(['cash']);
const envIds = new Set(['food', 'rent']);

const run = txs => runInvariantCheck({
  accounts: ACCOUNTS, envelopes: ENVELOPES, transactions: txs,
});

describe('money conservation across the two delta derivations', () => {
  it('a well-formed expense conserves', () => {
    const tx = { id: 't1', type: 'expense', date: '2026-08-06', account: 'cash', envelope_id: 'food', amount: 25 };
    expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
    expect(run([tx]).byCategory.conservation).toBe(0);
  });

  it('a split expense whose lines sum to the total conserves', () => {
    const tx = {
      id: 't2', type: 'expense', date: '2026-08-06', account: 'cash', amount: 30,
      envelope_splits: [
        { envelope_id: 'food', amount: 20 },
        { envelope_id: 'rent', amount: 10 },
      ],
    };
    expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
  });

  it('flags a row that moves one amount in the accounts and another in the envelopes', () => {
    // Splits summing to less than the total: money leaves the account that
    // never leaves an envelope.
    const tx = {
      id: 't3', type: 'expense', date: '2026-08-06', account: 'cash', amount: 30,
      envelope_splits: [
        { envelope_id: 'food', amount: 20 },
        { envelope_id: 'rent', amount: 5 },
      ],
    };
    const out = run([tx]);
    expect(out.byCategory.conservation).toBe(1);
    const p = out.problems.find(x => x.code === 'conservationGap');
    expect(p.id).toBe('t3');
    expect(p.params.account).toBe(-30);
    expect(p.params.envelope).toBe(-25);
    expect(p.params.gap).toBe(-5);
  });

  it('an income row is checked the same way', () => {
    const good = { id: 'i1', type: 'income', date: '2026-08-06', account: 'cash', envelope_id: 'food', amount: 100 };
    expect(validateConservation(good, acctIds, envIds)).toEqual([]);
  });

  describe('rows where the two sides legitimately differ are not flagged', () => {
    it('an unenveloped expense — the other side is unallocated, not a mistake', () => {
      // Three such rows exist on the owner's real budget.
      const tx = { id: 'u1', type: 'expense', date: '2026-08-06', account: 'cash', amount: 30 };
      expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
    });

    it('a fill — it draws from unallocated, so it is account-neutral', () => {
      const tx = {
        id: 'f1', type: 'fill', date: '2026-08-06',
        lines: [{ envelope_id: 'food', amount: 200, mode: 'add' }],
      };
      expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
    });

    it('an account transfer — envelope-neutral by design', () => {
      const tx = {
        id: 'a1', type: 'account_transfer', date: '2026-08-06',
        from_account: 'cash', to_account: 'cash2', amount: 50,
      };
      expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
    });

    it('an envelope transfer — account-neutral by design', () => {
      const tx = {
        id: 'x1', type: 'envelope_transfer', date: '2026-08-06',
        from_envelope_id: 'food', to_envelope_id: 'rent', amount: 50,
      };
      expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
    });

    it('a dangling envelope reference — envelopeRefs already reports it', () => {
      const tx = { id: 'd1', type: 'expense', date: '2026-08-06', account: 'cash', envelope_id: 'gone', amount: 25 };
      expect(validateConservation(tx, acctIds, envIds)).toEqual([]);
      // ...and it is still reported, once, by the check that owns it.
      expect(run([tx]).byCategory.envelopeRefs).toBe(1);
    });
  });
});
