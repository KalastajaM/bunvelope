// The balance lens — `lensTransactions` and its three named modes.
//
// The bug this guards: balances used to be filtered by ad-hoc combinations of
// `onlyPosted` and `asOf` chosen per call site, so the dashboard KPI and the
// Accounts page reported different numbers for the same concept. The lens
// gives each combination a name and one definition; these tests pin the
// definitions, the memoization contract the balance cache depends on, and the
// forecast dedup that is the easiest thing to get silently wrong.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  lensTransactions,
  resolveEnvelopeAccounts,
  normalizeLens,
  normalizeHorizon,
  resolveHorizonDate,
  computeAccountBalances,
  computeEnvelopeBalances,
  computeUnallocated,
  LENS_TODAY,
  LENS_BOOKED,
  LENS_FORECAST,
  DEFAULT_LENS,
} from '../js/engine.js';
import { _resetLensCache } from '../js/engine/lens.js';

const TODAY = new Date(2026, 7, 22); // 2026-08-22, local time

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const accounts = [{ id: 'a1', name: 'Checking', type: 'bank', initialBalance: 0 }];
const envelopes = [{ id: 'e1', name: 'Groceries' }];

// The worked example from the design: 5 000 cleared, plus a 10 000 tax refund
// the user entered but which lands two months out.
const cleared = {
  id: 't1', type: 'income', date: '2026-08-01', amount: 5000, account: 'a1',
};
const futureRefund = {
  id: 't2', type: 'income', date: '2026-10-15', amount: 10000, account: 'a1',
};
// A scheduled row dated in the past that has not actually cleared.
const scheduledPast = {
  id: 't3', type: 'expense', date: '2026-08-10', amount: 250, account: 'a1',
  envelope_id: 'e1', status: 'scheduled',
};

const baseState = {
  transactions: [cleared, futureRefund, scheduledPast],
  accounts,
  envelopes,
  budgetItems: [],
  envelopeTemplates: [],
  meta: { country: 'FI' },
};

const balanceOf = (txs) => computeAccountBalances(accounts, txs).get('a1') ?? 0;

beforeEach(() => { _resetLensCache(); });

describe('lens names', () => {
  it('defaults to booked, so an existing budget reads identically', () => {
    expect(DEFAULT_LENS).toBe(LENS_BOOKED);
    expect(normalizeLens(undefined)).toBe(LENS_BOOKED);
    expect(normalizeLens('nonsense')).toBe(LENS_BOOKED);
    expect(normalizeLens(LENS_FORECAST)).toBe(LENS_FORECAST);
  });
});

describe('booked lens', () => {
  it('returns the same array reference, keeping the balance memo warm', () => {
    const out = lensTransactions(baseState, { lens: LENS_BOOKED, today: TODAY });
    expect(out).toBe(baseState.transactions);
  });

  it('counts the future-dated refund — that is what "booked" means', () => {
    const out = lensTransactions(baseState, { lens: LENS_BOOKED, today: TODAY });
    expect(balanceOf(out)).toBeCloseTo(5000 + 10000 - 250, 2);
  });
});

describe('today lens', () => {
  it('is exactly onlyPosted AND asOf — neither filter alone', () => {
    const out = lensTransactions(baseState, { lens: LENS_TODAY, today: TODAY });
    const expected = computeAccountBalances(accounts, baseState.transactions, {
      onlyPosted: true, asOf: '2026-08-22',
    });
    expect(balanceOf(out)).toBeCloseTo(expected.get('a1'), 2);
  });

  it('reads 5000 for the worked example, where each filter alone does not', () => {
    const today = lensTransactions(baseState, { lens: LENS_TODAY, today: TODAY });
    expect(balanceOf(today)).toBeCloseTo(5000, 2);

    // Status alone keeps the future refund: a manually entered row has no
    // `status`, so it counts as posted regardless of its date.
    const statusOnly = computeAccountBalances(accounts, baseState.transactions, { onlyPosted: true });
    expect(statusOnly.get('a1')).toBeCloseTo(15000, 2);

    // Date alone keeps the scheduled row that never cleared.
    const dateOnly = computeAccountBalances(accounts, baseState.transactions, { asOf: '2026-08-22' });
    expect(dateOnly.get('a1')).toBeCloseTo(4750, 2);
  });

  it('returns a stable reference across calls with unchanged inputs', () => {
    const a = lensTransactions(baseState, { lens: LENS_TODAY, today: TODAY });
    const b = lensTransactions(baseState, { lens: LENS_TODAY, today: TODAY });
    expect(a).toBe(b);
  });

  it('does not confuse a hypothetical array with the real one', () => {
    const hypothetical = { ...baseState, transactions: [cleared] };
    const real = lensTransactions(baseState, { lens: LENS_TODAY, today: TODAY });
    const draft = lensTransactions(hypothetical, { lens: LENS_TODAY, today: TODAY });
    expect(real).not.toBe(draft);
    expect(balanceOf(draft)).toBeCloseTo(5000, 2);
    // ...and the first one is still cached, not evicted by the second.
    expect(lensTransactions(baseState, { lens: LENS_TODAY, today: TODAY })).toBe(real);
  });
});

describe('horizon resolution', () => {
  it('clamps month arithmetic to the target month’s real length', () => {
    // 2026-08-31 + 6 months must not spill into March.
    expect(resolveHorizonDate('6m', new Date(2026, 7, 31))).toBe('2027-02-28');
  });

  it('resolves eom to the last day of the current month', () => {
    expect(resolveHorizonDate('eom', TODAY)).toBe('2026-08-31');
  });

  it('passes a custom ISO date through', () => {
    expect(normalizeHorizon('2027-01-15')).toBe('2027-01-15');
    expect(resolveHorizonDate('2027-01-15', TODAY)).toBe('2027-01-15');
  });

  it('falls back to the default for junk', () => {
    expect(normalizeHorizon('next tuesday')).toBe('3m');
    expect(normalizeHorizon(null)).toBe('3m');
  });
});

describe('forecast lens', () => {
  const salary = {
    id: 'inc1', kind: 'income', as_schedule: true, account_id: 'a1',
    monthly_schedule: allMonths, payment_day: 25, default_amount: 2000,
    as_schedule_since: '2026-01-01', description: 'Salary',
  };
  const rent = {
    id: 'exp1', envelope_id: 'e1', as_schedule: true, account_id: 'a1',
    monthly_schedule: allMonths, payment_day: 1, default_amount: 800,
    as_schedule_since: '2026-01-01', description: 'Rent',
  };
  const fcState = { ...baseState, budgetItems: [salary, rent] };

  it('adds generated rows inside the horizon, real rows first and in order', () => {
    const out = lensTransactions(fcState, {
      lens: LENS_FORECAST, horizon: '3m', today: TODAY,
    });
    expect(out.length).toBeGreaterThan(fcState.transactions.length);
    // Every real row survives, in order, at the front — the 3m horizon
    // (2026-11-30) is past all three.
    expect(out.slice(0, 3)).toEqual(fcState.transactions);
    const generated = out.slice(3);
    expect(generated.every(r => r.is_forecast)).toBe(true);
    expect(generated.every(r => r.date <= '2026-11-30')).toBe(true);
  });

  it('caps BOOKED rows at the horizon too, not just generated ones', () => {
    // The whole point of a named lens: the horizon cannot mean one thing for
    // a row the user typed and another for a row the app produced. The
    // refund is dated 2026-10-15, past an end-of-month horizon.
    const out = lensTransactions(fcState, {
      lens: LENS_FORECAST, horizon: 'eom', today: TODAY,
    });
    expect(out.some(r => r.id === 'futureRefund' || r.id === 't2')).toBe(false);
    expect(out.every(r => !r.date || r.date <= '2026-08-31')).toBe(true);
    // ...and it comes back when the horizon reaches it.
    _resetLensCache();
    const wider = lensTransactions(fcState, {
      lens: LENS_FORECAST, horizon: '3m', today: TODAY,
    });
    expect(wider.some(r => r.id === 't2')).toBe(true);
  });

  it('can read lower than booked at a short horizon — deliberately', () => {
    // Booked has no date bound; Forecast(D) is bounded at D. A manually
    // entered row past D therefore drops out, and the balance falls. This is
    // the one place the lenses are not monotonically inclusive, and it is the
    // price of the horizon meaning exactly one thing.
    const booked = lensTransactions(fcState, { lens: LENS_BOOKED, today: TODAY });
    _resetLensCache();
    const shortFc = lensTransactions(fcState, {
      lens: LENS_FORECAST, horizon: 'eom', today: TODAY,
    });
    expect(balanceOf(shortFc)).toBeLessThan(balanceOf(booked));
  });

  it('widens with the horizon', () => {
    const short = lensTransactions(fcState, { lens: LENS_FORECAST, horizon: 'eom', today: TODAY });
    _resetLensCache();
    const long = lensTransactions(fcState, { lens: LENS_FORECAST, horizon: '3m', today: TODAY });
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('counts a generated occurrence exactly once when the real one already posted', () => {
    // The salary for August already landed, tagged with its dedup key.
    const posted = {
      id: 't4', type: 'income', date: '2026-08-25', amount: 2000, account: 'a1',
      from_budget: 'inc1:2026-08',
    };
    const settled = { ...fcState, transactions: [...fcState.transactions, posted] };
    const out = lensTransactions(settled, {
      lens: LENS_FORECAST, horizon: 'eom', today: TODAY,
    });
    const augustSalary = out.filter(r =>
      r.type === 'income' && String(r.date).startsWith('2026-08-25'));
    expect(augustSalary).toHaveLength(1);
    expect(augustSalary[0].is_forecast).toBeUndefined();
  });

  it('returns a stable reference across calls with unchanged inputs', () => {
    const a = lensTransactions(fcState, { lens: LENS_FORECAST, horizon: '3m', today: TODAY });
    const b = lensTransactions(fcState, { lens: LENS_FORECAST, horizon: '3m', today: TODAY });
    expect(a).toBe(b);
  });

  it('returns the source array by identity when the horizon drops nothing and nothing is generated', () => {
    // Identity matters: the balance functions memoize on it, so a wide-horizon
    // forecast with no schedules should share the booked lens's cached walk.
    const out = lensTransactions(baseState, {
      lens: LENS_FORECAST, horizon: '12m', today: TODAY,
    });
    expect(out).toBe(baseState.transactions);
  });

  it('returns a filtered array when the horizon drops a booked row', () => {
    const out = lensTransactions(baseState, {
      lens: LENS_FORECAST, horizon: 'eom', today: TODAY,
    });
    expect(out).not.toBe(baseState.transactions);
    expect(out.map(r => r.id)).toEqual(['t1', 't3']);
  });
});

describe('forecast lens nets a hand-entered payment against its occurrence', () => {
  // The `taken` dedup only matches rows the app materialized, so a bill the
  // user typed in ahead of its due date used to be counted twice in every
  // balance this lens produces: once as that transaction, once as the budget
  // item's own occurrence. Same rule the envelope projection uses.
  const tax = {
    id: 'exp-tax', envelope_id: 'e1', as_schedule: true, account_id: 'a1',
    monthly_schedule: { ...allMonths, Sep: 400 }, payment_day: 10,
    default_amount: 400, as_schedule_since: '2026-09-01', description: 'Tax',
  };
  const septOnly = {
    ...tax,
    monthly_schedule: {
      Jan: false, Feb: false, Mar: false, Apr: false, May: false, Jun: false,
      Jul: false, Aug: false, Sep: 400, Oct: false, Nov: false, Dec: false,
    },
  };
  // Entered by hand for its due date. No `from_budget`: nothing links it back.
  const handEntered = {
    id: 'hand-tax', type: 'expense', date: '2026-09-10', status: 'scheduled',
    amount: 400, envelope_id: 'e1', account: 'a1', payee: 'Tax',
  };
  const stateWith = txs => ({ ...baseState, budgetItems: [septOnly], transactions: txs });

  const taxRows = out => out.filter(r => r.date === '2026-09-10'
    && Math.abs(r.amount) === 400);

  it('emits the occurrence once, not once per source', () => {
    const out = lensTransactions(
      stateWith([...baseState.transactions, handEntered]),
      { lens: LENS_FORECAST, horizon: '3m', today: TODAY },
    );
    const rows = taxRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_forecast).toBeUndefined();
  });

  it('still generates the occurrence when nothing was entered for it', () => {
    const out = lensTransactions(
      stateWith(baseState.transactions),
      { lens: LENS_FORECAST, horizon: '3m', today: TODAY },
    );
    const rows = taxRows(out);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_forecast).toBe(true);
  });

  it('leaves the envelope balance short by one bill, not two', () => {
    const withHand = lensTransactions(
      stateWith([...baseState.transactions, handEntered]),
      { lens: LENS_FORECAST, horizon: '3m', today: TODAY },
    );
    _resetLensCache();
    const withoutHand = lensTransactions(
      stateWith(baseState.transactions),
      { lens: LENS_FORECAST, horizon: '3m', today: TODAY },
    );
    expect(computeEnvelopeBalances(withHand).get('e1'))
      .toBe(computeEnvelopeBalances(withoutHand).get('e1'));
  });

  it('does not net a payment of a different size', () => {
    const out = lensTransactions(
      stateWith([...baseState.transactions, { ...handEntered, amount: 250 }]),
      { lens: LENS_FORECAST, horizon: '3m', today: TODAY },
    );
    expect(taxRows(out)).toHaveLength(1);              // the generated one
    expect(taxRows(out)[0].is_forecast).toBe(true);
    expect(out.filter(r => r.id === 'hand-tax')).toHaveLength(1);
  });
});

describe('unallocated reconciles under every lens', () => {
  // Unallocated is `accounts − envelopes`. It only means anything when both
  // sides are read through the SAME lens, and every row a lens admits must
  // move both sides coherently. A generated expense with no account would
  // debit its envelope and no account, inflating unallocated out of nowhere —
  // which is why planned (non-auto-posting) spend is excluded from forecast.
  const salary = {
    id: 'inc1', kind: 'income', as_schedule: true, account_id: 'a1',
    monthly_schedule: allMonths, payment_day: 25, default_amount: 2000,
    as_schedule_since: '2026-01-01',
  };
  const rent = {
    id: 'exp1', envelope_id: 'e1', as_schedule: true, account_id: 'a1',
    monthly_schedule: allMonths, payment_day: 1, default_amount: 800,
    as_schedule_since: '2026-01-01',
  };
  const st = { ...baseState, budgetItems: [salary, rent] };

  for (const lens of [LENS_TODAY, LENS_BOOKED, LENS_FORECAST]) {
    it(`holds for the ${lens} lens`, () => {
      const txs = lensTransactions(st, { lens, horizon: '3m', today: TODAY });
      const acct = computeAccountBalances(accounts, txs);
      const env = computeEnvelopeBalances(txs);
      const unallocated = computeUnallocated(acct, env, accounts);
      let acctTotal = 0;
      for (const v of acct.values()) acctTotal += v;
      let envTotal = 0;
      for (const v of env.values()) envTotal += v;
      expect(acctTotal - envTotal).toBeCloseTo(unallocated, 2);
    });
  }
});

describe('forecast includes planned (non-auto-posting) spend', () => {
  // The shape that matters: budget-plan.js writes `account_id: null` for every
  // item that is not `as_schedule`, so a real planned item carries no account.
  const groceriesPlan = {
    id: 'plan1', envelope_id: 'e1', monthly_schedule: allMonths,
    default_amount: 800, description: 'Groceries',
  };
  // Posted history, so attribution has something to read.
  const pastGrocery = {
    id: 'h1', type: 'expense', date: '2026-07-14', amount: 800,
    account: 'a1', envelope_id: 'e1',
  };
  const st = {
    ...baseState,
    transactions: [cleared, pastGrocery],
    budgetItems: [groceriesPlan],
  };

  it('debits the envelope — an envelope spent every month is not a growing one', () => {
    const out = lensTransactions(st, { lens: LENS_FORECAST, horizon: '3m', today: TODAY });
    const planned = out.filter(r => r.is_forecast && r.envelope_id === 'e1');
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every(r => r.type === 'expense')).toBe(true);

    const envBal = computeEnvelopeBalances(out).get('e1') ?? 0;
    const bookedEnvBal = computeEnvelopeBalances(st.transactions).get('e1') ?? 0;
    expect(envBal).toBeLessThan(bookedEnvBal);
  });

  it('leaves an envelope flat when the fill and the plan match', () => {
    // 800/month in, 800/month out — the case from the Rent example, where the
    // fill-only forecast showed the envelope climbing by the whole year's
    // funding.
    const template = {
      id: 'tpl1', name: 'Monthly allocation', kind: 'manual',
      lines: [{ envelope_id: 'e1', mode: 'add', amount: 800 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-01-01', months: allMonths },
    };
    const withFills = { ...st, envelopeTemplates: [template] };
    const out = lensTransactions(withFills, { lens: LENS_FORECAST, horizon: '6m', today: TODAY });

    const fills = out.filter(r => r.is_forecast && r.type === 'fill').length;
    const spends = new Set(out.filter(r => r.is_forecast && r.type === 'expense').map(r => r.date.slice(0, 7))).size;
    expect(fills).toBeGreaterThan(0);
    // Each funded month is also a spent month: the envelope cannot drift by a
    // full year of funding the way the fill-only forecast did.
    expect(Math.abs(fills - spends)).toBeLessThanOrEqual(1);
  });

  it('attributes every generated planned row to an account', () => {
    // An accountless expense row debits its envelope and no account, which
    // inflates unallocated by the row's amount. None may survive.
    const out = lensTransactions(st, { lens: LENS_FORECAST, horizon: '12m', today: TODAY });
    const planned = out.filter(r => r.is_forecast && r.type === 'expense');
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every(r => !!r.account)).toBe(true);
    expect(planned.every(r => r.account === 'a1')).toBe(true);
  });

  it('nets the current month against spend already recorded by hand', () => {
    // Groceries plans 800 this month and 500 of it is already spent. The
    // remaining forecast charge must be 300, not another full 800.
    const spentByHand = {
      id: 'h2', type: 'expense', date: '2026-08-05', amount: 500,
      account: 'a1', envelope_id: 'e1',
    };
    const netted = lensTransactions(
      { ...st, transactions: [cleared, pastGrocery, spentByHand] },
      { lens: LENS_FORECAST, horizon: 'eom', today: TODAY },
    );
    const thisMonth = netted.filter(r =>
      r.is_forecast && r.type === 'expense' && String(r.date).startsWith('2026-08'));
    const total = thisMonth.reduce((sum, r) => sum + r.amount, 0);
    expect(total).toBeCloseTo(300, 2);
  });

  it('keeps unallocated reconciling with planned spend in play', () => {
    const out = lensTransactions(st, { lens: LENS_FORECAST, horizon: '6m', today: TODAY });
    const acct = computeAccountBalances(accounts, out);
    const env = computeEnvelopeBalances(out);
    const unallocated = computeUnallocated(acct, env, accounts);
    let acctTotal = 0;
    for (const v of acct.values()) acctTotal += v;
    let envTotal = 0;
    for (const v of env.values()) envTotal += v;
    expect(acctTotal - envTotal).toBeCloseTo(unallocated, 2);
  });
});

describe('resolveEnvelopeAccounts', () => {
  const accts = [
    { id: 'checking', name: 'Checking' },
    { id: 'card', name: 'Card' },
  ];
  const exp = (id, account, envelope_id, date = '2026-07-01') =>
    ({ id, type: 'expense', account, envelope_id, date, amount: 10 });

  it('picks the account an envelope actually spends from', () => {
    const { byEnvelope } = resolveEnvelopeAccounts([
      exp('1', 'checking', 'groceries'),
      exp('2', 'checking', 'groceries'),
      exp('3', 'card', 'groceries'),
      exp('4', 'card', 'vacation'),
    ], accts);
    expect(byEnvelope.get('groceries')).toBe('checking');
    expect(byEnvelope.get('vacation')).toBe('card');
  });

  it('skips archived accounts: an envelope moves to the active account it is paid from now', () => {
    const withClosed = [{ id: 'old', name: 'Closed bank', archived: true }, ...accts];
    const rows = [
      exp('1', 'old', 'groceries'), exp('2', 'old', 'groceries'), exp('3', 'old', 'groceries'),
      exp('4', 'card', 'groceries'),
      exp('5', 'old', 'rent'),
    ];
    const { byEnvelope, fallback } = resolveEnvelopeAccounts(rows, withClosed);
    expect(byEnvelope.get('groceries')).toBe('card');
    // Only ever paid from the closed account: no attribution, so the
    // fallback (an active account) is used for it.
    expect(byEnvelope.has('rent')).toBe(false);
    expect(fallback).toBe('card');
  });

  it('breaks a tie by account order, so the result is stable across renders', () => {
    const rows = [exp('1', 'card', 'dining'), exp('2', 'checking', 'dining')];
    const a = resolveEnvelopeAccounts(rows, accts).byEnvelope.get('dining');
    const b = resolveEnvelopeAccounts([...rows].reverse(), accts).byEnvelope.get('dining');
    expect(a).toBe('checking'); // first in `accounts`, not first seen
    expect(b).toBe(a);
  });

  it('ignores forecast and uncleared rows when reading history', () => {
    const { byEnvelope } = resolveEnvelopeAccounts([
      exp('1', 'checking', 'groceries'),
      { ...exp('2', 'card', 'groceries'), is_forecast: true },
      { ...exp('3', 'card', 'groceries'), status: 'scheduled' },
    ], accts);
    expect(byEnvelope.get('groceries')).toBe('checking');
  });

  it('credits every envelope of a split expense', () => {
    const { byEnvelope } = resolveEnvelopeAccounts([
      {
        id: '1', type: 'expense', account: 'card', date: '2026-07-01', amount: 30,
        envelope_splits: [{ envelope_id: 'groceries', amount: 20 }, { envelope_id: 'dining', amount: 10 }],
      },
    ], accts);
    expect(byEnvelope.get('groceries')).toBe('card');
    expect(byEnvelope.get('dining')).toBe('card');
  });

  it('falls back to the busiest expense account, then to any spendable one', () => {
    const withHistory = resolveEnvelopeAccounts([
      exp('1', 'card', 'groceries'), exp('2', 'card', 'groceries'), exp('3', 'checking', 'dining'),
    ], accts);
    expect(withHistory.fallback).toBe('card');

    const noHistory = resolveEnvelopeAccounts([], [
      { id: 'brokerage', type: 'investment' },
      { id: 'old', archived: true },
      { id: 'checking' },
    ]);
    expect(noHistory.fallback).toBe('checking');
  });
});
