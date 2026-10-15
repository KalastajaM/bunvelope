// The engine reads no wall clock. Every function that needs "now" takes it as
// a required parameter, and says so by failing rather than guessing.
//
// A default clock is untestable by omission: a caller that forgets silently
// gets wall time, the answer depends on when and where the process ran, and
// nothing says so. Removing the defaults found three callers doing exactly
// that — including the AI's forecast tool, whose answer had been depending on
// the server's clock and timezone.
import { describe, it, expect } from 'vitest';
import {
  projectEnvelopeBalance, lensTransactions, runMonthlyReview,
  computeAgeOfMoney, computeMoneyCushion, computeEnvelopeBalanceHistory,
  computeEnvelopeGoalProgress, computeAgeOfMoneyHistory, LENS_TODAY, LENS_BOOKED,
  applyEnvelopeRollovers,
} from '../../js/engine.js';
import { requireClock } from '../../js/engine/_constants.js';

const TODAY = new Date(2026, 2, 15);

describe('requireClock', () => {
  it('passes a valid Date through', () => {
    expect(requireClock(TODAY, 'x')).toBe(TODAY);
  });

  it('refuses anything that is not one, naming the caller', () => {
    for (const bad of [undefined, null, '2026-03-15', 0, new Date('nope'), {}]) {
      expect(() => requireClock(bad, 'someFunction')).toThrow(/someFunction/);
    }
  });
});

describe('the clock is a required parameter, not a default', () => {
  it('projectEnvelopeBalance refuses to guess', () => {
    expect(() => projectEnvelopeBalance({ envelopeId: 'e1', envelopes: [{ id: 'e1' }] }))
      .toThrow(/valid Date is required/);
  });

  it('lensTransactions refuses to guess, for the lenses that need one', () => {
    const state = { transactions: [], accounts: [], envelopes: [], budgetItems: [] };
    expect(() => lensTransactions(state, { lens: LENS_TODAY })).toThrow(/valid Date/);
    // Booked is "everything you entered" and needs no clock at all.
    expect(lensTransactions(state, { lens: LENS_BOOKED })).toEqual([]);
  });

  it('the history family refuses to guess', () => {
    expect(() => computeAgeOfMoney([], undefined, 30)).toThrow();
    expect(() => computeMoneyCushion([], [], undefined, 30)).toThrow();
    expect(() => computeEnvelopeBalanceHistory([], 12, undefined)).toThrow();
  });

  it('the review and goal rules refuse to guess', () => {
    expect(() => runMonthlyReview([], [], new Map(), [], '2026-03', undefined)).toThrow();
    const envelope = { id: 'e1', goal_amount: 1000, goal_date: '2026-12-31' };
    expect(() => computeEnvelopeGoalProgress(envelope, 100, undefined)).toThrow();
  });

  it('applyEnvelopeRollovers refuses to guess', () => {
    // QA 2026-09-23 #3 — `new Date(null)` is the epoch, so a missing clock
    // used to post a sweep adjustment dated 1969-12-31 (or 1970-01-01 east
    // of UTC) for "the previous month".
    const envelopes = [{ id: 'e1', rollover: 'zero-monthly' }];
    const txs = [{ id: 'f', type: 'fill', date: '1969-12-01', lines: [{ envelope_id: 'e1', amount: 50 }] }];
    for (const bad of [null, undefined, 'nope', new Date('nope')]) {
      expect(() => applyEnvelopeRollovers(envelopes, txs, bad)).toThrow(/valid Date is required/);
    }
  });
});

describe('given a clock, the answer does not depend on the wall clock', () => {
  it('two calls a moment apart with the same clock agree exactly', async () => {
    const envelopes = [{ id: 'e1', name: 'Rent', category: 'housing' }];
    const input = {
      envelopeId: 'e1', envelopes, transactions: [], budgetItems: [],
      envelopeTemplates: [], accounts: [], months: 3, today: TODAY,
    };
    const a = projectEnvelopeBalance(input);
    await new Promise(r => setTimeout(r, 5));
    const b = projectEnvelopeBalance(input);
    expect(b.daily).toEqual(a.daily);
    expect(b.closing).toBe(a.closing);
  });
});

// The dashboard shipped `computeAgeOfMoneyHistory(aomTxs)` with no clock and
// broke budget loading. The engine threw correctly; nothing caught it before
// the page ran, because page call sites are outside the `checkJs` scope.
// `bunvelope/clock-argument-required` closes that gap statically; this pins
// the runtime half — the option-bag form must fail as loudly as the
// positional one.
describe('the option-bag clock is as required as a positional one', () => {
  it('computeAgeOfMoneyHistory refuses an options object with no refDate', () => {
    expect(() => computeAgeOfMoneyHistory([], {})).toThrow(/valid Date is required/);
    expect(() => computeAgeOfMoneyHistory([], undefined)).toThrow(/valid Date is required/);
  });

  it('and accepts one that has it', () => {
    const out = computeAgeOfMoneyHistory([], { refDate: TODAY, months: 3 });
    expect(out).toHaveLength(3);
  });
});
