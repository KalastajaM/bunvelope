import { describe, it, expect } from 'vitest';
import {
  runMonthlyReview,
  validateTxSplits,
  findInvalidTxSplits,
  computeAccountBalances,
  computeAccountBalancesAsOf,
  computeEnvelopeBalances,
  computeCreditCardPaymentDue,
  txAbsAmount,
  txAccountDelta,
} from '../js/engine.js';

describe('§2.3 — runMonthlyReview projection symmetry', () => {
  const envelopes = [{ id: 'food', name: 'Food', category: 'Needs' }];
  const items = [{
    envelope_id: 'food', kind: 'expense', default_amount: 100,
    monthly_schedule: { Apr: true }, extra_buffer: 0, include: true,
  }];

  it('over-budget row no longer ignores remaining-plan vs scheduled', () => {
    // Spent 150 of 100 plan, nothing scheduled. Old logic: projected = balance - 0 = 200.
    // New logic: remaining = max(scheduled=0, planned-actual=-50) = 0; projected = 200.
    // (Same outcome here, but ensure scheduled wins when present.)
    const balances = new Map([['food', 200]]);
    const txs = [
      { id: 't1', type: 'expense', envelope_id: 'food', date: '2026-04-10', status: 'posted', amount: 150 },
      { id: 't2', type: 'expense', envelope_id: 'food', date: '2026-04-25', status: 'scheduled', amount: 60 },
    ];
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-04', new Date(2026, 3, 15));
    const row = rows.find(r => r.envelope_id === 'food');
    expect(row.spendFlag).toBe('over');
    // remaining = max(scheduled=60, planned-actual=100-150=-50) = 60
    expect(row.projected).toBe(140); // 200 − 60
  });

  it('under-budget row still projects pessimistically against full plan', () => {
    const balances = new Map([['food', 200]]);
    const txs = [
      { id: 't1', type: 'expense', envelope_id: 'food', date: '2026-04-05', status: 'posted', amount: 30 },
    ];
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-04', new Date(2026, 3, 6));
    const row = rows.find(r => r.envelope_id === 'food');
    expect(row.spendFlag).toBe('under');
    // remaining = max(scheduled=0, planned-actual=100-30=70) = 70
    expect(row.projected).toBe(130); // 200 − 70
  });
});

describe('§2.5 — split-sum invariant validator', () => {
  it('flags expense whose splits sum mismatches amount', () => {
    const tx = {
      id: 'x', type: 'expense', amount: 100,
      envelope_splits: [
        { envelope_id: 'a', amount: 40 },
        { envelope_id: 'b', amount: 50 },
      ],
    };
    const problems = validateTxSplits(tx);
    const mismatch = problems.find(p => p.code === 'splitSumMismatch');
    expect(mismatch).toBeTruthy();
    expect(mismatch.params).toEqual({ sum: 90, total: 100 });
    expect(mismatch.message).toContain('split sum');
  });

  it('flags expense that has both envelope_id and envelope_splits', () => {
    const tx = {
      id: 'x', type: 'expense', amount: 100, envelope_id: 'a',
      envelope_splits: [
        { envelope_id: 'a', amount: 60 },
        { envelope_id: 'b', amount: 40 },
      ],
    };
    const problems = validateTxSplits(tx);
    expect(problems.some(p => p.code === 'splitBothEnvelopeAndSplits')).toBe(true);
  });

  it('passes a well-formed split', () => {
    const tx = {
      id: 'x', type: 'expense', amount: 100,
      envelope_splits: [
        { envelope_id: 'a', amount: 60 },
        { envelope_id: 'b', amount: 40 },
      ],
    };
    expect(validateTxSplits(tx)).toEqual([]);
  });

  it('passes a signed split where one line is a credit/correction', () => {
    // Real case: 57.71 expense booked as 60.96 to one envelope and a -3.25
    // refund/correction to another. Signed sum = 57.71 = tx.amount.
    const tx = {
      id: 'x', type: 'expense', amount: 57.71,
      envelope_splits: [
        { envelope_id: 'a', amount: -3.25 },
        { envelope_id: 'b', amount: 60.96 },
      ],
    };
    expect(validateTxSplits(tx)).toEqual([]);
  });

  it('flags a zero-amount split line', () => {
    const tx = {
      id: 'x', type: 'expense', amount: 100,
      envelope_splits: [
        { envelope_id: 'a', amount: 0 },
        { envelope_id: 'b', amount: 100 },
      ],
    };
    const problems = validateTxSplits(tx);
    expect(problems.some(p => p.code === 'splitInvalidAmount')).toBe(true);
  });

  it('findInvalidTxSplits returns only malformed rows', () => {
    const txs = [
      { id: 'good', type: 'expense', amount: 50,
        envelope_splits: [{ envelope_id: 'a', amount: 50 }] },
      { id: 'bad', type: 'expense', amount: 50,
        envelope_splits: [{ envelope_id: 'a', amount: 30 }] },
      { id: 'unrelated', type: 'income', amount: 200, envelope_id: 'inc' },
    ];
    const out = findInvalidTxSplits(txs);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('bad');
  });
});

describe('§2.1 — computeAccountBalances opts', () => {
  const accounts = [{ id: 'bank', initialBalance: 1000 }];
  const txs = [
    { id: '1', type: 'expense', account: 'bank', date: '2026-04-10', status: 'posted', amount: 100 },
    { id: '2', type: 'expense', account: 'bank', date: '2026-04-30', status: 'scheduled', amount: 50 },
    { id: '3', type: 'expense', account: 'bank', date: '2026-05-01', status: 'posted', amount: 10 },
  ];

  it('default counts everything (budget view)', () => {
    expect(computeAccountBalances(accounts, txs).get('bank')).toBe(840);
  });

  it('onlyPosted skips scheduled rows', () => {
    expect(computeAccountBalances(accounts, txs, { onlyPosted: true }).get('bank')).toBe(890);
  });

  it('asOf cuts off future-dated rows', () => {
    expect(computeAccountBalancesAsOf(accounts, txs, new Date('2026-04-25')).get('bank')).toBe(900);
  });

  it('combining onlyPosted and asOf', () => {
    const bal = computeAccountBalances(accounts, txs, {
      onlyPosted: true, asOf: new Date('2026-04-25'),
    });
    expect(bal.get('bank')).toBe(900);
  });
});

describe('§2.2 — computeEnvelopeBalances onlyPosted', () => {
  it('excludes scheduled rows when onlyPosted', () => {
    const txs = [
      { type: 'expense', envelope_id: 'food', date: '2026-04-10', status: 'posted', amount: 30 },
      { type: 'expense', envelope_id: 'food', date: '2026-04-25', status: 'scheduled', amount: 50 },
    ];
    expect(computeEnvelopeBalances(txs).get('food')).toBe(-80);
    expect(computeEnvelopeBalances(txs, { onlyPosted: true }).get('food')).toBe(-30);
  });
});

describe('§3.1 — computeCreditCardPaymentDue', () => {
  it('returns due amount for each non-zero credit-card account', () => {
    const accounts = [
      { id: 'visa', name: 'Visa', type: 'credit_card', initialBalance: 0 },
      { id: 'mc',   name: 'MC',   type: 'credit_card', initialBalance: 0 },
      { id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 },
    ];
    const txs = [
      { id: 't1', type: 'expense', account: 'visa', date: '2026-04-10', status: 'posted', amount: 50, envelope_id: 'food' },
      { id: 't2', type: 'expense', account: 'visa', date: '2026-04-30', status: 'scheduled', amount: 20, envelope_id: 'food' },
      // MC has no charges → omitted from result
    ];
    const out = computeCreditCardPaymentDue(accounts, txs);
    expect(out.size).toBe(1);
    const visa = out.get('visa');
    expect(visa.paymentDue).toBe(70);  // budget view incl. scheduled
    expect(visa.postedDue).toBe(50);   // cleared only
  });

  it('omits archived credit cards', () => {
    const accounts = [
      { id: 'old', name: 'Old', type: 'credit_card', archived: true, initialBalance: -100 },
    ];
    expect(computeCreditCardPaymentDue(accounts, []).size).toBe(0);
  });

  it('omits cards with zero or positive balance (overpayment)', () => {
    const accounts = [
      { id: 'paid', name: 'Paid off', type: 'credit_card', initialBalance: 50 },
      { id: 'zero', name: 'Zero',     type: 'credit_card', initialBalance: 0 },
    ];
    expect(computeCreditCardPaymentDue(accounts, []).size).toBe(0);
  });
});

describe('§2.4 — tx amount helpers', () => {
  it('txAbsAmount strips sign', () => {
    expect(txAbsAmount({ amount: 50 })).toBe(50);
    expect(txAbsAmount({ amount: -50 })).toBe(50);
    expect(txAbsAmount({ amount: 'oops' })).toBe(0);
    expect(txAbsAmount(null)).toBe(0);
  });

  it('txAccountDelta tracks expense as outflow', () => {
    expect(txAccountDelta({ type: 'expense', account: 'a', amount: 30 }, 'a')).toBe(-30);
    expect(txAccountDelta({ type: 'expense', account: 'a', amount: -30 }, 'a')).toBe(-30);
    expect(txAccountDelta({ type: 'expense', account: 'b', amount: 30 }, 'a')).toBe(0);
  });

  it('txAccountDelta handles transfers in both directions', () => {
    const tx = { type: 'account_transfer', from_account: 'a', to_account: 'b', amount: 25 };
    expect(txAccountDelta(tx, 'a')).toBe(-25);
    expect(txAccountDelta(tx, 'b')).toBe(25);
    expect(txAccountDelta(tx, 'c')).toBe(0);
  });

  it('txAccountDelta debt_payment moves cash bank → CC', () => {
    const tx = { type: 'debt_payment', from_account: 'bank', to_account: 'visa', amount: 100 };
    expect(txAccountDelta(tx, 'bank')).toBe(-100);
    expect(txAccountDelta(tx, 'visa')).toBe(100);
  });
});

describe('booked future transactions affect envelope balance and required reserve', () => {
  it('manual future-dated expense reduces envelope balance (sanity check)', () => {
    // Engine default counts everything: a posted/no-status tx dated next
    // week must subtract from envelope balance immediately, even though it
    // hasn't "cleared" yet. Locks the engine contract referenced by the
    // dashboard / envelopes / review card displays.
    const txs = [
      { type: 'fill', date: '2026-05-08', lines: [{ envelope_id: 'rent', mode: 'set', amount: 2300 }] },
      { type: 'expense', envelope_id: 'rent', account: 'bank', date: '2026-05-23', amount: 2300 },
    ];
    expect(computeEnvelopeBalances(txs).get('rent')).toBe(0);
  });

  it('runMonthlyReview: booked one-off future tx raises req for that envelope', () => {
    // Reviewing May with a €100/m schedule and a one-off €200 booked for June.
    // Without the augmentation, eRoll = [_, 100, 100, ...], annual=1200, D=100,
    // req=0. With the booked-extras augmentation, June (pos 2) gets +200 →
    // annual=1400, D=ceil(1400/12 cents)=116.67, req = max(C[2]-C[1]-D) =
    // 400-100-116.67 = 183.33.
    const envelopes = [{ id: 'rent', name: 'Rent', category: 'Needs' }];
    const items = [{
      envelope_id: 'rent', kind: 'expense', default_amount: 100,
      monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
        Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
      include: true,
    }];
    const balances = new Map([['rent', 1000]]); // 1200 prefilled minus 200 booked
    const txs = [
      { id: 'oneoff', type: 'expense', envelope_id: 'rent', account: 'bank',
        date: '2026-06-15', amount: 200 },
    ];
    const refDate = new Date(2026, 4, 8); // May 8
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-05', refDate);
    const row = rows.find(r => r.envelope_id === 'rent');
    expect(row.D).toBeCloseTo(116.67, 2);
    expect(row.required).toBeCloseTo(183.33, 2);
  });

  it('runMonthlyReview: tx with from_budget is NOT double-counted (already in eRoll)', () => {
    // A materialized scheduled budget item carries `from_budget`. eCal already
    // includes the underlying budget item's monthly schedule, so adding the
    // materialised tx to eRoll would double the future outflow. The skip rule
    // prevents that.
    const envelopes = [{ id: 'rent', name: 'Rent', category: 'Needs' }];
    const items = [{
      id: 'rent-item', envelope_id: 'rent', kind: 'expense', default_amount: 100,
      monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
        Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
      include: true,
    }];
    const balances = new Map([['rent', 1200]]);
    const txs = [
      { id: 'mat', type: 'expense', envelope_id: 'rent', account: 'bank',
        date: '2026-06-01', amount: 100, status: 'scheduled',
        from_budget: 'rent-item:2026-06' },
    ];
    const refDate = new Date(2026, 4, 8);
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-05', refDate);
    const row = rows.find(r => r.envelope_id === 'rent');
    expect(row.D).toBe(100); // unchanged: 1200 / 12
    expect(row.required).toBe(0);
  });

  it('runMonthlyReview: is_forecast rows are NOT counted in req', () => {
    // forecastScheduledTransactions produces in-memory rows with is_forecast:true.
    // The underlying budget item is already in eRoll, so forecasts must not
    // double-count even when the caller passes the effective tx list (real +
    // forecasts) — review.js does this for the actual/scheduled split.
    const envelopes = [{ id: 'rent', name: 'Rent', category: 'Needs' }];
    const items = [{
      id: 'rent-item', envelope_id: 'rent', kind: 'expense', default_amount: 100,
      monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
        Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
      include: true,
    }];
    const balances = new Map([['rent', 1200]]);
    const txs = [
      { id: 'forecast:rent-item:2026-06', type: 'expense', envelope_id: 'rent',
        account: 'bank', date: '2026-06-15', amount: 100, is_forecast: true,
        status: 'scheduled' },
    ];
    const refDate = new Date(2026, 4, 8);
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-05', refDate);
    const row = rows.find(r => r.envelope_id === 'rent');
    expect(row.D).toBe(100);
    expect(row.required).toBe(0);
  });

  it('runMonthlyReview: booked tx outside 12-month window is ignored', () => {
    // A tx 13+ months out is beyond the rolling window — no contribution.
    const envelopes = [{ id: 'rent', name: 'Rent', category: 'Needs' }];
    const items = [{
      envelope_id: 'rent', kind: 'expense', default_amount: 100,
      monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
        Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
      include: true,
    }];
    const balances = new Map([['rent', 1200]]);
    const txs = [
      { id: 'far', type: 'expense', envelope_id: 'rent', account: 'bank',
        date: '2027-08-15', amount: 999 }, // > 12 months from May 2026
    ];
    const refDate = new Date(2026, 4, 8);
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-05', refDate);
    const row = rows.find(r => r.envelope_id === 'rent');
    expect(row.D).toBe(100);
    expect(row.required).toBe(0);
  });

  it('runMonthlyReview: past-dated tx is not augmented (already in balance)', () => {
    // A tx dated before today is already deducted from the balance and is
    // not "upcoming" — augmenting eRoll with it would inflate the required
    // reserve incorrectly. (We do not include past-month txs in the rolling
    // forward window relative to refDate.)
    const envelopes = [{ id: 'rent', name: 'Rent', category: 'Needs' }];
    const items = [{
      envelope_id: 'rent', kind: 'expense', default_amount: 100,
      monthly_schedule: { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
        Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true },
      include: true,
    }];
    const balances = new Map([['rent', 1100]]);
    const txs = [
      { id: 'past', type: 'expense', envelope_id: 'rent', account: 'bank',
        date: '2026-04-15', amount: 100 }, // last month, already past
    ];
    const refDate = new Date(2026, 4, 8); // May 8
    const rows = runMonthlyReview(envelopes, items, balances, txs, '2026-05', refDate);
    const row = rows.find(r => r.envelope_id === 'rent');
    expect(row.D).toBe(100);
    expect(row.required).toBe(0);
  });
});
