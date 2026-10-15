import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { cardSettlementRows } from '../js/core/queries/forecast-balances.js';
import { lensTransactions } from '../js/engine/lens.js';
import { resolveSetSourceLegs } from '../js/engine/scheduling.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const balanceOf = (list, id) => list.find(r => r.id === id)?.balance;
const ask = (input, d, now) => runQuery(registry, d, 'forecast.balances', input, ctxAt(now));

// ── Default equivalence ────────────────────────────────────────────────────
// A scheduled rent item, a planned grocery item, a template fill and a
// future-dated expense: every generator the forecast lens runs.
const lensData = () => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'checking', initialBalance: 1000 },
    { id: 'old', name: 'Old savings', type: 'savings', initialBalance: 25.555, archived: true },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 200 },
  ],
  envelopes: [
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
  ],
  budgetItems: [
    {
      id: 'rentItem', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
      default_amount: -100, payment_day: 25, schedule_day_type: 'exact', include: true,
      as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
    },
    {
      id: 'grocItem', kind: 'expense', description: 'Groceries', envelope_id: 'groc', account_id: 'chk',
      default_amount: -80, include: true, monthly_schedule: ALL_MONTHS,
    },
  ],
  envelopeTemplates: [{
    id: 'tpl', name: 'Month end', kind: 'manual',
    lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }],
    schedule: { enabled: true, payment_day: 28, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS },
  }],
  transactions: [
    { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 300, lines: [{ envelope_id: 'groc', amount: 300 }], status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'A', amount: 100, account: 'chk', envelope_id: 'groc', cleared: true, status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-10-20', payee: 'B', amount: 40, account: 'chk', envelope_id: 'groc', cleared: true, status: 'posted' },
    { id: 'e3', type: 'expense', date: '2026-11-20', payee: 'C', amount: 10.5, account: 'sav', envelope_id: 'groc', status: 'scheduled' },
  ],
});

describe('forecast.balances — defaults', () => {
  const NOW = at(2026, 10, 2);
  for (const date of ['2026-10-31', '2026-11-15', '2026-12-31']) {
    it(`equals balances with lens forecast and horizon ${date}`, () => {
      const d = lensData();
      const fc = ask({ date }, d, NOW);
      const bal = runQuery(registry, d, 'balances', { lens: 'forecast', horizon: date }, ctxAt(NOW));
      expect(fc.ok).toBe(true);
      expect(bal.ok).toBe(true);
      expect(fc.value.accounts).toEqual(bal.value.accounts);
      expect(fc.value.envelopes).toEqual(bal.value.envelopes);
      expect(fc.value.unallocated).toBe(bal.value.unallocated);
      expect(fc.value.date).toBe(date);
      expect(fc.value.assumptions).toEqual({ charge: 'plan', cards: 'none', cardFundingAccount: null });
      expect(fc.value.settlements).toEqual([]);
    });
  }

  it('lists archived entries only with includeArchived, as balances does', () => {
    const d = lensData();
    const without = ask({ date: '2026-10-31' }, d, NOW).value;
    const withAll = ask({ date: '2026-10-31', includeArchived: true }, d, NOW).value;
    expect(without.accounts.map(a => a.id)).toEqual(['chk', 'sav']);
    expect(withAll.accounts.map(a => a.id)).toEqual(['chk', 'old', 'sav']);
    expect(without.unallocated).toBe(withAll.unallocated);
  });

  it('runs against deep-frozen data without mutating it', () => {
    const d = lensData();
    const before = JSON.stringify(d);
    expect(ask({ date: '2026-12-31', charge: 'none', cards: 'settle-15th', cardFundingAccount: 'chk' }, d, NOW).ok).toBe(true);
    expect(JSON.stringify(d)).toBe(before);
  });
});

// ── charge ─────────────────────────────────────────────────────────────────
// One planned item: no as_schedule, a monthly_schedule and the default
// payment_day (month end), 200 a month from Groceries on Checking.
const planData = (transactions = []) => deepFreeze({
  meta: {},
  accounts: [{ id: 'chk', name: 'Checking', type: 'checking', initialBalance: 1000 }],
  envelopes: [{ id: 'groc', name: 'Groceries', category: 'Food' }],
  budgetItems: [{
    id: 'grocItem', kind: 'expense', description: 'Groceries', envelope_id: 'groc', account_id: 'chk',
    default_amount: -200, include: true, monthly_schedule: ALL_MONTHS,
  }],
  envelopeTemplates: [],
  transactions: [
    { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 500, lines: [{ envelope_id: 'groc', amount: 500 }], status: 'posted' },
    ...transactions,
  ],
});

describe('forecast.balances — charge', () => {
  const NOW = at(2026, 10, 2);

  it("charge 'none' reads higher by the un-netted plan amount", () => {
    const d = planData();
    const plan = ask({ date: '2026-10-31' }, d, NOW).value;
    const none = ask({ date: '2026-10-31', charge: 'none' }, d, NOW).value;
    expect(balanceOf(plan.envelopes, 'groc')).toBe(300);
    expect(balanceOf(none.envelopes, 'groc')).toBe(500);
    expect(balanceOf(none.accounts, 'chk')).toBe(round2(balanceOf(plan.accounts, 'chk') + 200));
    expect(none.assumptions).toEqual({ charge: 'none', cards: 'none', cardFundingAccount: null });
  });

  it('drops every planned month through the date', () => {
    const d = planData();
    const plan = ask({ date: '2026-12-31' }, d, NOW).value;
    const none = ask({ date: '2026-12-31', charge: 'none' }, d, NOW).value;
    expect(round2(balanceOf(none.envelopes, 'groc') - balanceOf(plan.envelopes, 'groc'))).toBe(600);
  });

  it('reads the same under both when spend already exceeds the plan this month', () => {
    const d = planData([
      { id: 'e1', type: 'expense', date: '2026-10-01', payee: 'Shop', amount: 250, account: 'chk', envelope_id: 'groc', cleared: true, status: 'posted' },
    ]);
    const plan = ask({ date: '2026-10-31' }, d, NOW).value;
    const none = ask({ date: '2026-10-31', charge: 'none' }, d, NOW).value;
    expect(balanceOf(plan.envelopes, 'groc')).toBe(250);
    expect(none.envelopes).toEqual(plan.envelopes);
    expect(none.accounts).toEqual(plan.accounts);
    expect(none.unallocated).toBe(plan.unallocated);
  });

  // A sourced set-mode fill draws `value − target balance before the fill`
  // from its source. With the plan dropped, that balance must be read
  // without the planned row, or the source draws the plan amount too much.
  it("charge 'none' resolves a sourced set-mode fill's draw without the planned rows", () => {
    const d = deepFreeze({
      meta: {},
      accounts: [{ id: 'chk', name: 'Checking', type: 'checking', initialBalance: 2000 }],
      envelopes: [
        { id: 'groc', name: 'Groceries', category: 'Food' },
        { id: 'buf', name: 'Buffer', category: 'Savings' },
      ],
      budgetItems: [{
        id: 'grocItem', kind: 'expense', description: 'Groceries', envelope_id: 'groc', account_id: 'chk',
        default_amount: -200, payment_day: 10, include: true, monthly_schedule: ALL_MONTHS,
      }],
      envelopeTemplates: [{
        id: 'tpl', name: 'Top up groceries', kind: 'manual',
        lines: [{ envelope_id: 'groc', mode: 'set', amount: 500 }],
        schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, source_envelope_id: 'buf' },
      }],
      transactions: [
        { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 1500, lines: [{ envelope_id: 'buf', amount: 1500 }], status: 'posted' },
      ],
    });
    const date = '2026-10-31';
    const pending = lensTransactions(d, { lens: 'forecast', horizon: date, today: NOW, pendingSetSources: true });
    expect(pending.some(tx => tx && tx.is_planned && tx.date < '2026-10-25')).toBe(true);
    const expected = runQuery(registry, d, 'balances', { lens: 'forecast', horizon: date }, ctxAt(NOW)).value;
    const unplanned = resolveSetSourceLegs(pending.filter(tx => !(tx && tx.is_planned)));
    const expBuf = round2(unplanned.reduce((s, tx) => s + (tx.lines || [])
      .filter(l => l.envelope_id === 'buf').reduce((a, l) => a + l.amount, 0), 0));

    const none = ask({ date, charge: 'none' }, d, NOW).value;
    expect(expBuf).toBe(1000);
    expect(balanceOf(none.envelopes, 'buf')).toBe(1000);
    expect(balanceOf(none.envelopes, 'groc')).toBe(500);
    expect(none.unallocated).toBe(500);
    expect(none.unallocated).toBe(round2(balanceOf(none.accounts, 'chk') - 1500));
    // The plan view is unchanged: still the app's lens.
    const plan = ask({ date }, d, NOW).value;
    expect(plan.envelopes).toEqual(expected.envelopes);
    expect(plan.unallocated).toBe(expected.unallocated);
  });
});

// ── Card settlement ────────────────────────────────────────────────────────
const cardData = (transactions = [], extraAccounts = []) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'checking', initialBalance: 1000 },
    { id: 'card', name: 'Visa', type: 'credit_card', initialBalance: 0 },
    ...extraAccounts,
  ],
  envelopes: [{ id: 'groc', name: 'Groceries', category: 'Food' }],
  budgetItems: [],
  envelopeTemplates: [],
  transactions,
});
const cardSpend = (id, date, amount) => ({ id, type: 'expense', date, payee: 'Shop', amount, account: 'card', envelope_id: 'groc', cleared: true, status: 'posted' });
const settle = (date, extra = {}) => ({ date, cards: 'settle-15th', cardFundingAccount: 'chk', ...extra });

describe('forecast.balances — card settlement', () => {
  const OCT20 = at(2026, 10, 20);

  it('settles the October balance on 15 November from the funding account', () => {
    const d = cardData([cardSpend('c1', '2026-10-05', 120)]);
    const r = ask(settle('2026-11-30'), d, OCT20);
    expect(r.ok).toBe(true);
    const a = r.value;
    expect(a.settlements).toEqual([{ account: 'card', date: '2026-11-15', amount: 120 }]);
    expect(balanceOf(a.accounts, 'card')).toBe(0);
    const unsettled = ask({ date: '2026-11-30' }, d, OCT20).value;
    expect(balanceOf(unsettled.accounts, 'card')).toBe(-120);
    expect(balanceOf(a.accounts, 'chk')).toBe(round2(balanceOf(unsettled.accounts, 'chk') - 120));
    expect(a.envelopes).toEqual(unsettled.envelopes);
    expect(a.assumptions).toEqual({ charge: 'plan', cards: 'settle-15th', cardFundingAccount: 'chk' });
  });

  it('settles nothing when the date is before the 15th', () => {
    const d = cardData([cardSpend('c1', '2026-10-05', 120)]);
    const a = ask(settle('2026-11-14'), d, OCT20).value;
    expect(a.settlements).toEqual([]);
    expect(balanceOf(a.accounts, 'card')).toBe(-120);
    expect(balanceOf(a.accounts, 'chk')).toBe(1000);
  });

  it('skips the month when a transfer into the card is already dated in it', () => {
    const d = cardData([
      cardSpend('c1', '2026-10-05', 120),
      { id: 't1', type: 'account_transfer', date: '2026-11-03', payee: 'Pay card', amount: 50, from_account: 'chk', to_account: 'card', status: 'scheduled' },
    ]);
    const a = ask(settle('2026-11-30'), d, OCT20).value;
    expect(a.settlements).toEqual([]);
    expect(balanceOf(a.accounts, 'card')).toBe(-70);
  });

  it('skips the month when a debt payment into the card is already dated in it', () => {
    const d = cardData([
      cardSpend('c1', '2026-10-05', 120),
      { id: 'p1', type: 'debt_payment', date: '2026-11-20', payee: 'Pay card', amount: 120, from_account: 'chk', to_account: 'card', envelope_id: 'groc', status: 'scheduled' },
    ]);
    const a = ask(settle('2026-11-30'), d, OCT20).value;
    expect(a.settlements).toEqual([]);
    expect(balanceOf(a.accounts, 'card')).toBe(0);
  });

  it('skips the month for a real transfer into the card dated after the target in that month', () => {
    const d = cardData([
      cardSpend('c1', '2026-10-05', 120),
      { id: 't1', type: 'account_transfer', date: '2026-11-25', payee: 'Pay card', amount: 120, from_account: 'chk', to_account: 'card', status: 'scheduled' },
    ]);
    const a = ask(settle('2026-11-20'), d, OCT20).value;
    expect(a.settlements).toEqual([]);
    // The transfer itself is after the date, so the card still owes.
    expect(balanceOf(a.accounts, 'card')).toBe(-120);
    expect(balanceOf(a.accounts, 'chk')).toBe(1000);
  });

  it('chains months: December settles November after November’s settlement', () => {
    const d = cardData([cardSpend('c1', '2026-10-05', 120), cardSpend('c2', '2026-11-20', 30)]);
    const a = ask(settle('2026-12-31'), d, OCT20).value;
    expect(a.settlements).toEqual([
      { account: 'card', date: '2026-11-15', amount: 120 },
      { account: 'card', date: '2026-12-15', amount: 30 },
    ]);
    expect(balanceOf(a.accounts, 'card')).toBe(0);
    expect(balanceOf(a.accounts, 'chk')).toBe(850);
  });

  it('uses the 15th in February', () => {
    const d = cardData([cardSpend('c1', '2027-01-20', 80)]);
    const a = ask(settle('2027-02-28'), d, at(2027, 2, 10)).value;
    expect(a.settlements).toEqual([{ account: 'card', date: '2027-02-15', amount: 80 }]);
  });

  it('settles only after today: not today’s month when its 15th has passed or is today', () => {
    const d = cardData([cardSpend('c1', '2026-09-05', 120)]);
    // 20 Oct: October's 15th is past.
    expect(ask(settle('2026-10-31'), d, OCT20).value.settlements).toEqual([]);
    // On the 15th itself: not after today.
    expect(ask(settle('2026-10-31'), d, at(2026, 10, 15)).value.settlements).toEqual([]);
    // The day before: settled on the 15th.
    expect(ask(settle('2026-10-15'), d, at(2026, 10, 14)).value.settlements)
      .toEqual([{ account: 'card', date: '2026-10-15', amount: 120 }]);
  });

  it('ignores archived cards, cards in credit and accounts that are not cards', () => {
    const d = cardData([
      cardSpend('c1', '2026-10-05', 120),
      { id: 'c2', type: 'expense', date: '2026-10-05', payee: 'Shop', amount: 60, account: 'oldcard', envelope_id: 'groc', status: 'posted' },
      { id: 'c3', type: 'expense', date: '2026-10-05', payee: 'Shop', amount: 900, account: 'sav', envelope_id: 'groc', status: 'posted' },
    ], [
      { id: 'oldcard', name: 'Old card', type: 'credit_card', initialBalance: 0, archived: true },
      { id: 'credit', name: 'Card in credit', type: 'credit_card', initialBalance: 15 },
      { id: 'tiny', name: 'Rounding card', type: 'credit_card', initialBalance: -0.004 },
      { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 100 },
    ]);
    const a = ask(settle('2026-11-30'), d, OCT20).value;
    expect(a.settlements).toEqual([{ account: 'card', date: '2026-11-15', amount: 120 }]);
  });

  it('settles from the rows left after charge none', () => {
    const d = cardData([cardSpend('c1', '2026-10-05', 120)]);
    const a = ask(settle('2026-11-30', { charge: 'none' }), d, OCT20).value;
    expect(a.settlements).toEqual([{ account: 'card', date: '2026-11-15', amount: 120 }]);
    expect(a.assumptions).toEqual({ charge: 'none', cards: 'settle-15th', cardFundingAccount: 'chk' });
  });

  it('writes each settlement as a forecast account transfer with a deterministic id', () => {
    const d = cardData([cardSpend('c1', '2026-10-05', 120), cardSpend('c2', '2026-11-20', 30)]);
    const rows = lensTransactions(d, { lens: 'forecast', horizon: '2026-12-31', today: OCT20 });
    const out = cardSettlementRows(d.accounts, rows, { fundingAccount: 'chk', todayIso: '2026-10-20', endIso: '2026-12-31' });
    expect(out).toEqual([
      { id: 'forecast:card:card:2026-11', type: 'account_transfer', date: '2026-11-15', amount: 120, from_account: 'chk', to_account: 'card', is_forecast: true, status: 'scheduled', forecast_kind: 'card-settlement' },
      { id: 'forecast:card:card:2026-12', type: 'account_transfer', date: '2026-12-15', amount: 30, from_account: 'chk', to_account: 'card', is_forecast: true, status: 'scheduled', forecast_kind: 'card-settlement' },
    ]);
    // The lens rows are left as they were.
    expect(rows.some(r => r.forecast_kind === 'card-settlement')).toBe(false);
  });
});

// ── A card's own settledFrom (owner decision 2026-10-05) ────────────────────
describe('forecast.balances — a card settled from its own account', () => {
  const OCT20 = at(2026, 10, 20);
  const settledData = (transactions) => {
    const d = cardData(transactions);
    return deepFreeze({ ...d, accounts: d.accounts.map(a => (a.id === 'card' ? { ...a, settledFrom: 'chk' } : a)) });
  };

  it('the forecast lens itself pays the card from settledFrom, with no assumption asked', () => {
    const d = settledData([cardSpend('c1', '2026-10-05', 120)]);
    const a = ask({ date: '2026-11-30' }, d, OCT20).value;
    expect(balanceOf(a.accounts, 'card')).toBe(0);
    expect(balanceOf(a.accounts, 'chk')).toBe(880);
    // settlements lists the assumption's rows only.
    expect(a.settlements).toEqual([]);
  });

  it('is settled after charge none drops the planned rows, and settle-15th does not pay it twice', () => {
    const d = settledData([cardSpend('c1', '2026-10-05', 120)]);
    const none = ask({ date: '2026-11-30', charge: 'none' }, d, OCT20).value;
    expect(balanceOf(none.accounts, 'card')).toBe(0);
    const both = ask(settle('2026-11-30'), d, OCT20).value;
    expect(both.settlements).toEqual([]);
    expect(balanceOf(both.accounts, 'chk')).toBe(880);
  });
});

// ── Input errors ───────────────────────────────────────────────────────────
describe('forecast.balances — input', () => {
  const NOW = at(2026, 10, 2);
  const d = cardData();
  const errorOf = (input) => ask(input, d, NOW).error;

  it('needs cardFundingAccount with cards settle-15th', () => {
    expect(errorOf({ date: '2026-11-30', cards: 'settle-15th' }))
      .toEqual({ code: 'bad_input', params: { errors: [{ path: 'cardFundingAccount', message: 'required with cards settle-15th' }] } });
  });

  it('refuses cardFundingAccount without card settlement', () => {
    for (const input of [{ date: '2026-11-30', cardFundingAccount: 'chk' }, { date: '2026-11-30', cards: 'none', cardFundingAccount: 'chk' }]) {
      expect(errorOf(input))
        .toEqual({ code: 'bad_input', params: { errors: [{ path: 'cardFundingAccount', message: 'only allowed with cards settle-15th' }] } });
    }
  });

  it('refuses an unknown funding account, a missing or impossible date and unknown options', () => {
    expect(errorOf(settle('2026-11-30', { cardFundingAccount: 'nope' })).params.errors)
      .toEqual([{ path: 'cardFundingAccount', message: 'no account with id "nope"' }]);
    expect(errorOf({}).params.errors).toEqual([{ path: 'date', message: 'is required' }]);
    expect(errorOf({ date: '2026-02-30' }).params.errors[0].path).toBe('date');
    expect(errorOf({ date: '2026-11-30', charge: 'some' }).params.errors[0].path).toBe('charge');
    expect(errorOf({ date: '2026-11-30', cards: 'monthly' }).params.errors[0].path).toBe('cards');
  });
});
