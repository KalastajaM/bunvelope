// Property-based tests for the money math. Every other fixture in this suite
// is hand-authored, which means it only ever asserts the cases someone
// thought of; these assert laws over generated ledgers.
//
// Ported in shape from the v2 rebuild's invariant suite. Its A1 header makes
// the point this file is built on:
//
//   "The identity everyone reaches for, `accounts = envelopes + unallocated`,
//    is a tautology: `unallocated` is *defined* as the difference, so a check
//    on it can only ever pass."
//
// So the laws below are the ones with two independent sides.
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  computeAccountBalances, computeEnvelopeBalances, identityAccountTotal,
  txAccountDelta, txEnvelopeEffect, normalizeTransactionsForWrite, txAbsAmount,
} from '../../js/engine.js';
import { fmt, fmtParts, round2 } from '../../js/utils.js';
import { parseAmountInput } from '../../js/ui/amount-input.js';
import { ACCOUNTS, ENVELOPE_IDS, arbLedger } from './arbitraries.js';

const RUNS = 200;

const LENSES = [
  ['budget (all rows)', undefined],
  ['posted only', { onlyPosted: true }],
  ['as of a date', { asOf: '2026-01-01' }],
];

describe('A1 — an account balance is its opening balance plus its own postings', () => {
  // The two sides are computed differently: `computeAccountBalances` walks
  // once and memoizes; the expectation re-derives per account from
  // `txAccountDelta`, the per-row rule. They must not drift.
  for (const [name, opts] of LENSES) {
    it(`holds for every account, in the ${name} lens`, () => {
      fc.assert(
        fc.property(arbLedger(12), (txs) => {
          const balances = computeAccountBalances(ACCOUNTS, txs, opts);
          const rows = opts?.onlyPosted
            ? txs.filter(t => !t.is_forecast && (!t.status || t.status === 'posted'))
            : opts?.asOf
              ? txs.filter(t => String(t.date).slice(0, 10) <= opts.asOf)
              : txs;
          for (const account of ACCOUNTS) {
            let expected = account.initialBalance;
            for (const tx of rows) expected += txAccountDelta(tx, account.id);
            expect(balances.get(account.id)).toBeCloseTo(expected, 6);
          }
        }),
        { numRuns: RUNS },
      );
    });
  }
});

describe('the envelope walk obeys the same law, seeded at zero', () => {
  it('equals the sum of per-row effects when no row overwrites a balance', () => {
    fc.assert(
      fc.property(arbLedger(12), (txs) => {
        // `set`-mode fill lines overwrite rather than add, so the sum of
        // deltas is not the balance for those ledgers — that is the whole
        // reason `txEnvelopeEffect` returns a mode rather than a number.
        const hasSet = txs.some(t => t.type === 'fill' && (t.lines || []).some(l => l.mode === 'set'));
        fc.pre(!hasSet);
        const balances = computeEnvelopeBalances(txs);
        for (const id of ENVELOPE_IDS) {
          let expected = 0;
          for (const tx of txs) {
            const effect = txEnvelopeEffect(tx, id);
            if (effect && effect.mode === 'add') expected += effect.amount;
          }
          expect(balances.get(id) ?? 0).toBeCloseTo(expected, 6);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('A2 — balances do not depend on the order rows are stored in', () => {
  it('a shuffled ledger produces identical account balances', () => {
    fc.assert(
      fc.property(arbLedger(12), fc.integer({ min: 0, max: 1_000_000 }), (txs, seed) => {
        // Deterministic shuffle: the order must not matter, so any
        // permutation will do, but the failure has to be reproducible.
        const shuffled = [...txs];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = (seed * (i + 1) * 2654435761) % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const a = computeAccountBalances(ACCOUNTS, txs);
        const b = computeAccountBalances(ACCOUNTS, shuffled);
        for (const account of ACCOUNTS) {
          expect(b.get(account.id)).toBeCloseTo(a.get(account.id), 6);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('A6 — normalising is idempotent, and preserves identity when it changes nothing', () => {
  it('a second pass changes nothing, and returns the very same array', () => {
    fc.assert(
      fc.property(arbLedger(12), (txs) => {
        const once = normalizeTransactionsForWrite(txs);
        const twice = normalizeTransactionsForWrite(once);
        expect(twice).toBe(once); // reference identity — the balance cache keys on it
        expect(twice).toEqual(once);
      }),
      { numRuns: RUNS },
    );
  });

  it('leaves every type-signed amount a positive magnitude', () => {
    fc.assert(
      fc.property(arbLedger(12), (txs) => {
        for (const tx of normalizeTransactionsForWrite(txs)) {
          if (tx.type === 'adjustment' || tx.amount == null) continue;
          expect(tx.amount).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('the money helpers are total — no input produces NaN', () => {
  const anything = fc.oneof(
    fc.double(), fc.integer(), fc.string(), fc.constant(null), fc.constant(undefined),
    fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity), fc.boolean(), fc.object(),
  );

  it('round2 always returns a finite number', () => {
    fc.assert(fc.property(anything, (v) => {
      expect(Number.isFinite(round2(v))).toBe(true);
    }), { numRuns: 500 });
  });

  it('txAbsAmount always returns a finite, non-negative number', () => {
    fc.assert(fc.property(anything, (v) => {
      const n = txAbsAmount({ type: 'expense', amount: v });
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }), { numRuns: 500 });
  });

  it('txAccountDelta is finite for any row shape', () => {
    fc.assert(fc.property(arbLedger(8), (txs) => {
      for (const tx of txs) {
        for (const a of ACCOUNTS) expect(Number.isFinite(txAccountDelta(tx, a.id))).toBe(true);
      }
    }), { numRuns: RUNS });
  });
});

describe('what the app prints, the app can read back', () => {
  // The round trip that was broken until 2026-08-29: `fmt` groups thousands
  // with a no-break space, and `parseAmountInput` stopped at it, so pasting a
  // figure the app had just printed read a thousandth of it.
  const money = fc.integer({ min: -99_999_999, max: 99_999_999 }).map(c => c / 100);

  it('parseAmountInput(fmt(n)) === n, for any amount', () => {
    fc.assert(fc.property(money, (n) => {
      expect(parseAmountInput(fmt(n))).toBeCloseTo(n, 2);
    }), { numRuns: 500 });
  });

  it('the parts join back into exactly what fmt returned', () => {
    fc.assert(fc.property(money, (n) => {
      const p = fmtParts(n);
      expect(`${p.currency} ${p.prefix}${p.whole}${p.decimal}${p.frac}`).toBe(fmt(n));
    }), { numRuns: 500 });
  });
});

describe('the identity account scope is a partition, not an opinion', () => {
  it('identity total + investment total === every account', () => {
    fc.assert(
      fc.property(arbLedger(12), (txs) => {
        const balances = computeAccountBalances(ACCOUNTS, txs);
        const identity = identityAccountTotal(balances, ACCOUNTS);
        const investment = ACCOUNTS
          .filter(a => a.type === 'investment')
          .reduce((s, a) => s + (balances.get(a.id) ?? 0), 0);
        const all = [...balances.values()].reduce((s, v) => s + v, 0);
        expect(identity + investment).toBeCloseTo(all, 6);
      }),
      { numRuns: RUNS },
    );
  });
});
