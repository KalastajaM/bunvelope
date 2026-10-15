// Generators for property tests. Ported in shape from the v2 rebuild's
// `postings/testing/arbitraries.ts`: a small fixed cast of accounts and
// envelopes, and a ledger of arbitrary transactions over them. Fixed ids
// rather than generated ones because the properties are about the ARITHMETIC,
// and a generated id space just makes every row miss every account.
import fc from 'fast-check';

export const ACCOUNTS = [
  { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
  { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 5000 },
  { id: 'cc', name: 'Card', type: 'credit_card', initialBalance: -250 },
  { id: 'brk', name: 'Brokerage', type: 'investment', initialBalance: 0 },
];
export const ACCOUNT_IDS = ACCOUNTS.map(a => a.id);
export const ENVELOPES = [
  { id: 'e1', name: 'Rent', category: 'housing' },
  { id: 'e2', name: 'Food', category: 'food' },
  { id: 'e3', name: 'Investing', category: 'saving' },
];
export const ENVELOPE_IDS = ENVELOPES.map(e => e.id);

// Amounts are two-decimal magnitudes in a range a budget actually holds.
// Generating arbitrary doubles would test float noise rather than the rules.
const amount = fc.integer({ min: 0, max: 500_000 }).map(cents => cents / 100);
const date = fc
  .integer({ min: 0, max: 900 })
  .map((offset) => {
    const d = new Date(Date.UTC(2025, 0, 1) + offset * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
const accountId = fc.constantFrom(...ACCOUNT_IDS);
const envelopeId = fc.constantFrom(...ENVELOPE_IDS);
const status = fc.constantFrom(undefined, 'posted', 'scheduled');

const withId = (i, obj) => ({ id: `t${i}`, ...obj });

/** One transaction of each type the engine knows, with random contents. */
export function arbTransaction(i) {
  return fc.oneof(
    fc.record({ type: fc.constant('expense'), date, amount, account: accountId, envelope_id: envelopeId, status })
      .map(t => withId(i, t)),
    fc.record({ type: fc.constant('income'), date, amount, account: accountId, envelope_id: envelopeId, status })
      .map(t => withId(i, t)),
    fc.record({
      type: fc.constant('account_transfer'), date, amount, status,
      from_account: accountId, to_account: accountId,
    }).map(t => withId(i, t)),
    fc.record({
      type: fc.constant('envelope_transfer'), date, amount, status,
      from_envelope_id: envelopeId, to_envelope_id: envelopeId,
    }).map(t => withId(i, t)),
    fc.record({ type: fc.constant('debt_payment'), date, amount, status, from_account: accountId, to_account: accountId, envelope_id: envelopeId })
      .map(t => withId(i, t)),
    fc.record({
      type: fc.constant('investment_transfer'), date, amount, status,
      direction: fc.constantFrom('buy', 'sell', 'dividend'),
      symbol: fc.constantFrom('AAPL', 'VWCE'),
      units: fc.integer({ min: 1, max: 100 }),
      from_account: accountId, to_account: accountId, envelope_id: envelopeId,
    }).map(t => withId(i, t)),
    // An adjustment's `target_id` matches its `target`. A row naming an
    // envelope while claiming `target: 'account'` is a data-shape violation
    // `runInvariantCheck` reports, not a case the arithmetic laws are about —
    // and generating it makes the account walk invent an account, which is a
    // different finding for a different test.
    fc.record({
      type: fc.constant('adjustment'), date, status,
      amount: fc.integer({ min: -100_000, max: 100_000 }).map(c => c / 100),
      targeting: fc.oneof(
        fc.record({ target: fc.constant('account'), target_id: accountId }),
        fc.record({ target: fc.constant('envelope'), target_id: envelopeId }),
      ),
    }).map(({ targeting, ...t }) => withId(i, { ...t, ...targeting })),
    fc.record({
      type: fc.constant('fill'), date, status,
      lines: fc.array(
        fc.record({ envelope_id: envelopeId, mode: fc.constantFrom('add', 'set'), amount }),
        { minLength: 1, maxLength: 3 },
      ),
    }).map(t => withId(i, t)),
    // A split expense: the case that has produced more than one defect.
    fc.record({
      type: fc.constant('expense'), date, amount, account: accountId, status,
      envelope_splits: fc.array(fc.record({ envelope_id: envelopeId, amount }), { minLength: 2, maxLength: 3 }),
    }).map(t => withId(i, t)),
  );
}

/** A ledger of up to `max` transactions. */
export function arbLedger(max = 12) {
  return fc
    .array(fc.integer({ min: 0, max: 1000 }), { minLength: 0, maxLength: max })
    .chain(seeds => fc.tuple(...seeds.map((_, i) => arbTransaction(i))));
}
