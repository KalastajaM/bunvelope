// A transfer whose two legs name the same account moved no money. The bulk
// walk in balances.js has always agreed — it adds both legs and they cancel —
// while `txAccountDelta` matched `from_account` first and returned a pure
// debit. Found by the property suite (A1), which asserts those two
// derivations against each other over generated ledgers.
//
// `runInvariantCheck` reports such a row as `selfTransferAccount`, so this is
// bad data either way. But it reached the screen as a disagreement: the
// Accounts page (bulk walk) and the reconcile dialog / running balances
// (`txAccountDelta`) showed different balances for the same account.
import { describe, it, expect } from 'vitest';
import { txAccountDelta, computeAccountBalances, runInvariantCheck } from '../../js/engine.js';

const accounts = [{ id: 'sav', type: 'savings', initialBalance: 5000 }];

const selfTransfer = (type, extra = {}) => ({
  id: `x-${type}`, type, date: '2026-03-01', amount: 250,
  from_account: 'sav', to_account: 'sav', ...extra,
});

describe('a transfer from an account to itself', () => {
  for (const [type, extra] of [
    ['account_transfer', {}],
    ['debt_payment', { envelope_id: 'e1' }],
    ['investment_transfer', { direction: 'buy', symbol: 'AAPL', units: 1, envelope_id: 'e1' }],
  ]) {
    it(`moves nothing — ${type}`, () => {
      expect(txAccountDelta(selfTransfer(type, extra), 'sav')).toBe(0);
    });

    it(`agrees with the bulk walk — ${type}`, () => {
      const balances = computeAccountBalances(accounts, [selfTransfer(type, extra)]);
      expect(balances.get('sav')).toBe(5000);
      expect(balances.get('sav')).toBe(5000 + txAccountDelta(selfTransfer(type, extra), 'sav'));
    });
  }

  it('is still reported as a data problem, not silently accepted', () => {
    const report = runInvariantCheck({
      accounts, envelopes: [], transactions: [selfTransfer('account_transfer')],
    });
    expect(JSON.stringify(report)).toContain('selfTransfer');
  });

  it('leaves a genuine two-account transfer alone', () => {
    const tx = { id: 't', type: 'account_transfer', date: '2026-03-01', amount: 250, from_account: 'sav', to_account: 'chk' };
    expect(txAccountDelta(tx, 'sav')).toBe(-250);
    expect(txAccountDelta(tx, 'chk')).toBe(250);
  });
});
