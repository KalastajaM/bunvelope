// Credit cards paid off in the forecast from their `settledFrom` account
// (owner decision 2026-10-05; js/engine/card-settlement.js). The Forecast lens
// adds the settlements, so the projection walk and the long net-worth line
// built on its last year see the paying account carry the spending.
// Every test passes an explicit clock; the engine reads none.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  simulate, lensTransactions, computeAccountBalances, LENS_FORECAST,
  cardFundingFor, cardSettlementRows, withCardSettlements,
} from '../../js/engine.js';
import { _resetSimulationCache } from '../../js/engine/simulation.js';
import { _resetLensCache } from '../../js/engine/lens.js';

const TODAY = new Date(2026, 9, 5); // 2026-10-05, local time

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const salary = {
  id: 'inc1', kind: 'income', as_schedule: true, account_id: 'chk',
  monthly_schedule: allMonths, payment_day: 25, default_amount: 3000,
  as_schedule_since: '2026-01-01', description: 'Salary',
};
// Groceries paid with the card, every month on the 10th.
const groceries = {
  id: 'exp1', envelope_id: 'groc', as_schedule: true, account_id: 'card',
  monthly_schedule: allMonths, payment_day: 10, default_amount: 400,
  as_schedule_since: '2026-01-01', description: 'Groceries',
};

function source({ settledFrom, cardType = 'credit_card', extraAccounts = [] } = {}) {
  return {
    accounts: [
      { id: 'chk', name: 'Income & Expenses', type: 'bank', initialBalance: 2000 },
      { id: 'card', name: 'Mastercard', type: cardType, initialBalance: -150, ...(settledFrom ? { settledFrom } : {}) },
      ...extraAccounts,
    ],
    envelopes: [{ id: 'groc', name: 'Groceries' }],
    budgetItems: [salary, groceries],
    envelopeTemplates: [],
    transactions: [],
    meta: { country: 'FI' },
  };
}

beforeEach(() => { _resetSimulationCache(); _resetLensCache(); });

describe('cardFundingFor', () => {
  const accounts = [
    { id: 'chk', type: 'bank' },
    { id: 'old', type: 'bank', archived: true },
    { id: 'cc2', type: 'credit_card' },
    { id: 'sav', type: 'savings' },
    { id: 'inv', type: 'investment' },
  ];
  it('names the paying account of a live card', () => {
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'chk' }, accounts)).toBe('chk');
    // A bank or cash account used as a card settles the same way.
    expect(cardFundingFor({ id: 'deb', type: 'bank', settledFrom: 'chk' }, accounts)).toBe('chk');
    expect(cardFundingFor({ id: 'wallet', type: 'cash', settledFrom: 'chk' }, accounts)).toBe('chk');
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'sav' }, accounts)).toBe('sav');
    // A legacy type (checking) is cash-like money too.
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'leg' }, [...accounts, { id: 'leg', type: 'checking' }])).toBe('leg');
  });
  it('is null when the setting cannot apply, so the card accumulates as before', () => {
    expect(cardFundingFor({ id: 'card', type: 'credit_card' }, accounts)).toBeNull();
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'gone' }, accounts)).toBeNull();
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'old' }, accounts)).toBeNull();
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'cc2' }, accounts)).toBeNull();
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'inv' }, accounts)).toBeNull();
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'card' }, [...accounts, { id: 'card', type: 'credit_card' }])).toBeNull();
    expect(cardFundingFor({ id: 'card', type: 'credit_card', settledFrom: 'chk', archived: true }, accounts)).toBeNull();
    expect(cardFundingFor({ id: 'sav', type: 'savings', settledFrom: 'chk' }, accounts)).toBeNull();
  });
});

describe('cardSettlementRows', () => {
  const accounts = [
    { id: 'chk', type: 'bank', initialBalance: 0 },
    { id: 'card', type: 'credit_card', initialBalance: -100 },
  ];
  const spend = (id, date, amount) => ({ id, type: 'expense', date, amount, account: 'card', envelope_id: 'groc' });
  const fundingFor = (card) => (card.id === 'card' ? 'chk' : null);

  it('pays the previous month-end balance on the 15th, month by month, the earlier settlements counted', () => {
    const rows = [spend('s1', '2026-10-01', 50), spend('s2', '2026-10-20', 70), spend('s3', '2026-11-03', 30)];
    const out = cardSettlementRows(accounts, rows, { fundingFor, todayIso: '2026-10-05', endIso: '2026-12-31' });
    expect(out.map(r => [r.date, r.amount, r.from_account, r.to_account])).toEqual([
      ['2026-10-15', 100, 'chk', 'card'], // September's -100
      ['2026-11-15', 120, 'chk', 'card'], // October's 50 + 70, after the October settlement
      ['2026-12-15', 30, 'chk', 'card'],
    ]);
    expect(out[0]).toMatchObject({ type: 'account_transfer', is_forecast: true, status: 'scheduled', forecast_kind: 'card-settlement', id: 'forecast:card:card:2026-10' });
  });

  it('agrees with computeAccountBalances at every month-end', () => {
    const rows = [spend('s1', '2026-10-01', 50.25), spend('s2', '2026-10-20', 70.1), spend('s3', '2026-11-03', 30.3)];
    const out = cardSettlementRows(accounts, rows, { fundingFor, todayIso: '2026-10-05', endIso: '2027-01-31' });
    const all = rows.concat(out);
    for (const iso of ['2026-11-30', '2026-12-31']) {
      // Every month-end after the first settlement holds only that month's spend.
      const month = iso.slice(0, 7);
      const spent = rows.filter(r => r.date.slice(0, 7) === month).reduce((s, r) => s + r.amount, 0);
      expect(computeAccountBalances(accounts, all, { asOf: iso }).get('card')).toBeCloseTo(-spent, 2);
    }
  });

  it('skips a month the user already pays the card in, and a card in credit', () => {
    const rows = [spend('s1', '2026-10-20', 70)];
    const booked = [{ id: 'p', type: 'account_transfer', date: '2026-11-02', amount: 170, from_account: 'chk', to_account: 'card' }];
    const out = cardSettlementRows(accounts, rows, { fundingFor, todayIso: '2026-10-05', endIso: '2026-12-31', booked });
    // November is paid by hand; October's 100 was settled on the 15th.
    expect(out.map(r => r.date)).toEqual(['2026-10-15', '2026-12-15']);
    const inCredit = [{ id: 'chk', type: 'bank' }, { id: 'card', type: 'credit_card', initialBalance: 20 }];
    expect(cardSettlementRows(inCredit, [], { fundingFor, todayIso: '2026-10-05', endIso: '2026-12-31' })).toEqual([]);
  });

  it('withCardSettlements returns the rows themselves without a settled card', () => {
    const rows = [spend('s1', '2026-10-20', 70)];
    expect(withCardSettlements(accounts, rows, { todayIso: '2026-10-05', endIso: '2026-12-31' })).toBe(rows);
    const settled = [accounts[0], { ...accounts[1], settledFrom: 'chk' }];
    expect(withCardSettlements(settled, rows, { todayIso: '2026-10-05', endIso: '2026-12-31' })).toHaveLength(3);
  });
});

describe('the Forecast lens with a settled card', () => {
  it('adds no rows without settledFrom (today\'s behaviour)', () => {
    const rows = lensTransactions(source(), { lens: LENS_FORECAST, horizon: '12m', today: TODAY });
    expect(rows.some(r => r.forecast_kind === 'card-settlement')).toBe(false);
  });

  it('pays the card from the named account: the card holds one month of spending, the paying account the rest', () => {
    const plain = source();
    const settled = source({ settledFrom: 'chk' });
    const rowsPlain = lensTransactions(plain, { lens: LENS_FORECAST, horizon: '12m', today: TODAY });
    const rowsSettled = lensTransactions(settled, { lens: LENS_FORECAST, horizon: '12m', today: TODAY });
    const end = '2027-10-31';
    const before = computeAccountBalances(plain.accounts, rowsPlain, { asOf: end });
    const after = computeAccountBalances(settled.accounts, rowsSettled, { asOf: end });
    expect(before.get('card')).toBeCloseTo(-150 - 13 * 400, 2);
    // October 2027's groceries only: every earlier month was paid on the 15th.
    expect(after.get('card')).toBeCloseTo(-400, 2);
    // The money moved, it did not appear or vanish.
    expect(after.get('chk') + after.get('card')).toBeCloseTo(before.get('chk') + before.get('card'), 2);
    const settlements = rowsSettled.filter(r => r.forecast_kind === 'card-settlement');
    expect(settlements[0]).toMatchObject({ date: '2026-10-15', amount: 150, from_account: 'chk', to_account: 'card' });
    expect(settlements.slice(1).every(r => r.amount === 400)).toBe(true);
  });

  it('settles a bank account used as a card too', () => {
    const s = source({ settledFrom: 'chk', cardType: 'bank' });
    const rows = lensTransactions(s, { lens: LENS_FORECAST, horizon: '6m', today: TODAY });
    expect(computeAccountBalances(s.accounts, rows, { asOf: '2027-04-30' }).get('card')).toBeCloseTo(-400, 2);
  });
});

describe('the projection walk with a settled card', () => {
  it('keeps the card bounded and moves its yearly contribution to the paying account; net worth is unchanged', () => {
    const plain = simulate({ source: source(), today: TODAY });
    const settled = simulate({ source: source({ settledFrom: 'chk' }), today: TODAY });
    expect(plain.monthly[24].accounts.get('card')).toBeLessThan(-9000);
    for (const snap of settled.monthly) expect(snap.accounts.get('card')).toBeGreaterThanOrEqual(-400 - 0.005);
    expect(settled.monthly[24].netWorth.total).toBeCloseTo(plain.monthly[24].netWorth.total, 2);
    // The long projection adds each account's last-year contribution.
    expect(plain.lastYearContribution.get('card')).toBeCloseTo(-400, 2);
    expect(settled.lastYearContribution.get('card')).toBeCloseTo(0, 2);
    expect(settled.lastYearContribution.get('chk'))
      .toBeCloseTo(plain.lastYearContribution.get('chk') - 400, 2);
  });

  it('flags the paying account, not the card, when the spending outruns it', () => {
    const s = source({ settledFrom: 'chk' });
    s.budgetItems = [groceries]; // no salary: the account pays the card until it runs dry
    const sim = simulate({ source: s, today: TODAY });
    expect(sim.alerts.some(a => a.kind === 'account-negative' && a.id === 'chk')).toBe(true);
    const plain = simulate({ source: { ...s, accounts: source().accounts }, today: TODAY });
    expect(plain.alerts.some(a => a.kind === 'account-negative' && a.id === 'chk')).toBe(false);
  });

  it('a bank account settled like a card is not a date to act on while it dips between top-ups', () => {
    const s = source({ settledFrom: 'chk', cardType: 'bank' });
    const plain = simulate({ source: source({ cardType: 'bank' }), today: TODAY });
    expect(plain.alerts.some(a => a.kind === 'account-negative' && a.id === 'card')).toBe(true);
    const sim = simulate({ source: s, today: TODAY });
    expect(sim.alerts.some(a => a.id === 'card')).toBe(false);
  });

  it('settles after a what-if scenario changes the card\'s spending', () => {
    const s = source({ settledFrom: 'chk' });
    // 100 more a month on the card from November.
    const scenario = { id: 'w', name: 'More on the card', changes: [{ type: 'monthly', amount: -100, account: 'card', from: '2026-11', day: 12 }] };
    const sim = simulate({ source: s, today: TODAY, scenario });
    const settlements = sim.rows.filter(r => r.forecast_kind === 'card-settlement');
    expect(settlements.slice(2).every(r => r.amount === 500)).toBe(true);
    expect(sim.monthly[24].accounts.get('card')).toBeCloseTo(-500, 2);
  });
});
