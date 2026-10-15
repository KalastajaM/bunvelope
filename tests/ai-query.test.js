// tests/ai-query.test.js — the one helper the AI reads core queries through.
//
// `queryState` runs a registered query over the app state the AI tools and
// context builders already hold (plain collections, no session), with the
// clock the caller hands it.
import { describe, it, expect } from 'vitest';
import { queryState, queryAnswer } from '../js/ai/query.js';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }

// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);

const state = () => deepFreeze({
  meta: { currency: 'EUR', country: 'FI' },
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'food', name: 'Food', category: 'Living' }],
  budgetItems: [],
  envelopeTemplates: [],
  transactions: [
    { id: 'a', type: 'expense', status: 'posted', date: '2026-08-10', payee: 'Shop', amount: 40, account: 'chk', envelope_id: 'food' },
    { id: 'b', type: 'expense', status: 'posted', date: '2026-09-02', payee: 'Shop', amount: 25, account: 'chk', envelope_id: 'food' },
  ],
});

describe('queryState', () => {
  it('runs a query on plain state and returns the pipeline result', () => {
    const s = state();
    const r = queryState(s, 'balances', { lens: 'booked' }, () => at(2026, 9, 15));
    const direct = runQuery(registry, s, 'balances', { lens: 'booked' },
      makeCtx({ now: at(2026, 9, 15), newId: () => 'ai', country: 'FI' }));
    expect(r.ok).toBe(true);
    expect(r).toEqual(direct);
    expect(r.value.accounts).toEqual([{ id: 'chk', name: 'Checking', type: 'bank', archived: false, balance: 935 }]);
  });

  it('takes "now" from the clock it is given', () => {
    const s = state();
    const aug = queryState(s, 'spending.month', {}, () => at(2026, 8, 20));
    const sep = queryState(s, 'spending.month', {}, () => at(2026, 9, 20));
    expect([aug.value.month, aug.value.spent]).toEqual(['2026-08', 40]);
    expect([sep.value.month, sep.value.spent]).toEqual(['2026-09', 25]);
  });

  it('reads the clock once per query, at call time', () => {
    const times = [];
    queryState(state(), 'balances', { lens: 'booked' }, () => { times.push(1); return at(2026, 9, 15); });
    expect(times).toHaveLength(1);
  });

  it('answers a failure as a failed result, not a throw', () => {
    const r = queryState(state(), 'balances', { lens: 'nonsense' }, () => at(2026, 9, 15));
    expect(r.ok).toBe(false);
    expect(queryState(state(), 'no.such.query', {}, () => at(2026, 9, 15)).error.code).toBe('unknown_query');
  });

  it('copes with a state that lacks collections', () => {
    const r = queryState({ transactions: [] }, 'balances', { lens: 'booked' }, () => at(2026, 9, 15));
    expect(r.ok).toBe(true);
    expect(r.value.accounts).toEqual([]);
  });
});

describe('queryAnswer', () => {
  it('returns the answer', () => {
    expect(queryAnswer(state(), 'spending.month', { month: '2026-09' }, () => at(2026, 9, 15)).spent).toBe(25);
  });

  it('throws the failure, with its code, when the query refuses', () => {
    expect(() => queryAnswer(state(), 'balances', { lens: 'nonsense' }, () => at(2026, 9, 15)))
      .toThrowError(/balances/);
    expect(() => queryAnswer(state(), 'no.such.query', {}, () => at(2026, 9, 15)))
      .toThrow(expect.objectContaining({ code: 'unknown_query' }));
  });
});

describe('queryAnswer for the Stress and Net worth queries', () => {
  const clock = () => at(2026, 9, 15);

  it('stress.runway reads the cash through the lens at the clock\'s day', () => {
    const a = queryAnswer(state(), 'stress.runway', {}, clock);
    expect(a).toMatchObject({ lens: 'booked', liquid: 935, bufferFloor: 0, usableCash: 935 });
    expect(a.scenarios[0].scenario).toBe('Baseline');
  });

  it('netWorth.history ends at the clock\'s day', () => {
    const { points } = queryAnswer(state(), 'netWorth.history', { months: 2 }, clock);
    expect(points.map((p) => p.date)).toEqual(['2026-07-31', '2026-08-31', '2026-09-15']);
    expect(points.map((p) => p.total)).toEqual([1000, 960, 935]);
  });

  it('netWorth.projection starts at the clock\'s day and refuses a missing years', () => {
    expect(queryAnswer(state(), 'netWorth.projection', { years: 2 }, clock).years).toBe(2);
    expect(() => queryAnswer(state(), 'netWorth.projection', {}, clock)).toThrow(expect.objectContaining({ code: 'bad_input' }));
  });
});
