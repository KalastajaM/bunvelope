// tests/ai-core-queries.test.js — the AI's remaining tools and every context
// builder read core queries, and none of them reads the wall clock.
//
// The `old*` functions copy the previous code of js/ai/tools/read.js and
// js/ai/context-builder.js (HEAD before this change) with the clock made a
// parameter. Where the new answer must equal the old, the test says so; where
// it changes, the test pins the before and the after (these are the answer
// changes the PR body lists). The fixture is dated March 2031 and the system
// time is faked to other years, so a stray `new Date()` shows.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { runTool, listToolNames } from '../js/ai/tools/registry.js';
import {
  buildMonthlyBriefingCtx, buildAnomalyCtx, buildEnvelopeHealthCtx, buildSubscriptionCtx,
  buildWhatifCtx, buildOnboardingCtx, buildSearchCtx, buildPortfolioInsightCtx, buildReconcileCtx,
} from '../js/ai/context-builder.js';
import { queryAnswer } from '../js/ai/query.js';
import {
  aggregateSpendingByEnvelope, aggregatePayeeSpending, aggregateIncomeVsSpending,
  projectEnvelopeBalance, txEnvelopeEffect, computeEnvelopeBalances, computeMonthlyPlanByEnvelope,
  computeBufferByEnvelope, computeAccountBalances, computeAccountBalancesAsOf, listHoldings,
  planItemsAsOf, monthStartDate,
} from '../js/engine.js';
import { round2 } from '../js/utils.js';

beforeAll(async () => {
  await import('../js/ai/agent/loop.js');
});
afterEach(() => vi.useRealTimers());

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

// Today is Monday 10 March 2031, local time.
const NOW = new Date(2031, 2, 10, 10, 0, 0);
const CLOCK = () => NOW;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const PAYEES = Array.from({ length: 10 }, (_, i) => `Shop ${i + 1}`);

// Every case the changed answers treat differently:
//   - ten payees in the last 90 days plus one without a payee, so the top 8
//     folds an Other row and the (no payee) row is dropped
//   - loan principal (a debt payment into the mortgage): saving on the Reports
//     page, spending for the old tools
//   - a Fun template fill on the 15th that was deleted (a tombstone)
//   - a future-dated posted row: in the old posted balances, not in the
//     Today view (a scheduled row is in neither)
//   - an archived envelope with a plan item, and a plan item for an envelope
//     that does not exist
//   - two investment accounts: a sold-out holding, a held one, a dividend, and
//     cash parked in an account with no holdings
const data = () => deepFreeze({
  meta: { country: 'FI', currency: 'EUR', scheduledTombstones: ['tpl:tplFun:2031-03'] },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 3000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 1000 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -20000 },
    { id: 'brk', name: 'Broker', type: 'investment', initialBalance: 0 },
    { id: 'ira', name: 'IRA', type: 'investment', initialBalance: 0 },
  ],
  envelopes: [
    { id: 'food', name: 'Food', category: 'Living' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'fun', name: 'Fun', category: 'Living' },
    { id: 'old', name: 'Old', category: 'Misc', archived: true },
  ],
  budgetItems: [
    { id: 'bi-food', kind: 'expense', description: 'Food', envelope_id: 'food', default_amount: -300, extra_buffer: 50, include: true, monthly_schedule: ALL_MONTHS },
    { id: 'bi-rent', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk', default_amount: -900, extra_buffer: 20,
      payment_day: 20, schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2031-01-01', monthly_schedule: ALL_MONTHS },
    { id: 'bi-old', kind: 'expense', description: 'Old', envelope_id: 'old', default_amount: -24, include: true, monthly_schedule: ALL_MONTHS },
    { id: 'bi-ghost', kind: 'expense', description: 'Ghost', envelope_id: 'ghost', default_amount: -12, include: true, monthly_schedule: ALL_MONTHS },
  ],
  envelopeTemplates: [
    { id: 'tplFun', name: 'Mid-month', kind: 'manual', lines: [{ envelope_id: 'fun', mode: 'add', amount: 50 }],
      schedule: { enabled: true, payment_day: 15, day_type: 'exact', since: '2031-01-01', months: ALL_MONTHS } },
  ],
  transactions: [
    ...['2031-01-01', '2031-02-01', '2031-03-01'].map((date) => ({ id: `pay-${date}`, type: 'income', date, payee: 'Employer', amount: 2500, account: 'chk', status: 'posted' })),
    { id: 'f1', type: 'fill', date: '2031-01-02', payee: 'Fill', status: 'posted',
      lines: [{ envelope_id: 'food', amount: 600 }, { envelope_id: 'rent', amount: 900 }, { envelope_id: 'fun', amount: 200 }] },
    ...PAYEES.map((p, i) => ({ id: `s${i}`, type: 'expense', date: `2031-02-${String(i + 1).padStart(2, '0')}`, payee: p, amount: 100 - i * 7, account: 'chk', envelope_id: 'food', status: 'posted' })),
    { id: 'np', type: 'expense', date: '2031-02-14', payee: '', amount: 400, account: 'chk', envelope_id: 'fun', status: 'posted' },
    { id: 'h1', type: 'expense', date: '2031-02-20', payee: 'Landlord', amount: 900, account: 'chk', envelope_id: 'rent', status: 'posted' },
    { id: 'p1', type: 'debt_payment', date: '2031-02-25', payee: 'Bank', amount: 500, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent', status: 'posted' },
    { id: 'old1', type: 'expense', date: '2031-02-26', payee: 'Old shop', amount: 10, account: 'chk', envelope_id: 'old', status: 'posted' },
    { id: 'big1', type: 'expense', date: '2030-12-03', payee: 'Shop 1', amount: 250, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'fut', type: 'expense', date: '2031-03-20', payee: 'Shop 2', amount: 40, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'sch', type: 'expense', date: '2031-03-05', payee: 'Cinema', amount: 25, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
    // Investments
    { id: 'b1', type: 'investment_transfer', date: '2031-01-20', direction: 'buy', symbol: 'AAPL', units: 10, amount: 1500, from_account: 'chk', to_account: 'brk', status: 'posted' },
    { id: 'b2', type: 'investment_transfer', date: '2031-01-22', direction: 'buy', symbol: 'MSFT', units: 5, amount: 1000, from_account: 'chk', to_account: 'brk', status: 'posted' },
    { id: 'b3', type: 'investment_transfer', date: '2031-02-10', direction: 'sell', symbol: 'MSFT', units: 5, amount: 1100, from_account: 'brk', to_account: 'chk', status: 'posted' },
    { id: 'b4', type: 'investment_transfer', date: '2031-02-15', direction: 'dividend', symbol: 'AAPL', amount: 24, from_account: 'brk', to_account: 'chk', status: 'posted' },
    { id: 'b5', type: 'account_transfer', date: '2031-03-01', amount: 500, from_account: 'chk', to_account: 'ira', status: 'posted' },
  ],
});

// ── The previous code, copied (js/ai/tools/read.js and js/ai/context-builder.js at HEAD) ──

const clampTop = (v) => Math.min(Math.max(Number(v) || 12, 1), 40);
function oldGetReports(state, input) {
  const range = { from: input.date_from || null, to: input.date_to || null };
  const top = clampTop(input.top);
  const txs = state.transactions || [];
  if (input.by === 'payee') return { by: 'payee', rows: aggregatePayeeSpending(txs, range, top) };
  if (input.by === 'income_vs_spending') return { by: 'income_vs_spending', rows: aggregateIncomeVsSpending(txs, state.accounts || [], range) };
  return { by: 'envelope', rows: aggregateSpendingByEnvelope(txs, state.envelopes || [], range, top) };
}

function oldGetForecast(state, input, today) {
  const months = Math.min(Math.max(Number(input.months) || 3, 1), 24);
  const projection = projectEnvelopeBalance({
    envelopeId: input.envelope_id,
    transactions: state.transactions || [],
    budgetItems: state.budgetItems || [],
    envelopeTemplates: state.envelopeTemplates || [],
    accounts: state.accounts || [],
    envelopes: state.envelopes || [],
    months,
    today,
    country: state.meta?.country || 'FI',
  });
  return {
    envelope: (state.envelopes || []).find((e) => e.id === input.envelope_id)?.name || null,
    months,
    opening: projection?.opening ?? null,
    closing: projection?.closing ?? null,
    low: projection?.low ?? null,
    high: projection?.high ?? null,
    firstNegative: projection?.firstNegative ?? null,
    monthlyFill: projection?.monthlyFill ?? null,
    fillSource: projection?.fillSource ?? null,
    months_detail: (projection?.months || []).map((m) => ({
      month: m.key, opening: m.opening, in: m.in, out: m.out, partial: m.partial,
    })),
  };
}

function oldGetHistory(state, input, now) {
  const months = Math.min(Math.max(Number(input.months) || 12, 1), 36);
  const buckets = new Map();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, { month: key, in: 0, out: 0 });
  }
  for (const tx of (state.transactions || [])) {
    if (tx.is_forecast) continue;
    const bucket = buckets.get(String(tx.date || '').slice(0, 7));
    if (!bucket) continue;
    const effect = txEnvelopeEffect(tx, input.envelope_id);
    if (!effect || effect.mode !== 'add') continue;
    const amount = effect.amount;
    if (!amount) continue;
    if (amount > 0) bucket.in = round2(bucket.in + amount);
    else bucket.out = round2(bucket.out - amount);
  }
  return { envelope: (state.envelopes || []).find((e) => e.id === input.envelope_id)?.name || null, months: [...buckets.values()] };
}

function oldTopPayees(transactions, days, topN, accounts, today) {
  const from = new Date(today.getTime() - days * 86_400_000);
  const range = { from: iso(from), to: iso(today) };
  const rows = aggregatePayeeSpending(transactions, range, topN, { accounts });
  return rows.filter((r) => r.label !== '(no payee)').map((r) => ({ payee: r.label, total: r2(r.value) }));
}

function oldBriefingFigures(state, monthIso, today) {
  const { envelopes = [], accounts = [], transactions = [], budgetItems = [] } = state;
  const range = { from: iso(new Date(today.getFullYear(), today.getMonth() - 5, 1)), to: iso(today) };
  const incomeVsSpend = aggregateIncomeVsSpending(transactions, accounts, range);
  const envBalances = computeEnvelopeBalances(transactions);
  const monthlyPlan = computeMonthlyPlanByEnvelope(planItemsAsOf(budgetItems, monthStartDate(monthIso)));
  const lowEnvelopes = envelopes.filter((e) => !e.archived)
    .map((e) => ({ id: e.id, balance: r2(envBalances.get(e.id) || 0), planned: r2(monthlyPlan.get(e.id) || 0) }))
    .filter((e) => e.balance < 0 || (e.planned > 0 && e.balance < e.planned * 0.25))
    .slice(0, 10);
  return {
    incomeVsSpend6mo: incomeVsSpend.series.map((s) => ({ name: s.name, points: s.points.map((p) => ({ month: p.label, value: r2(p.value) })) })),
    lowEnvelopes,
    topPayees90d: oldTopPayees(transactions, 90, 8, accounts, today),
  };
}

function oldHealthRows(state, monthIso) {
  const { envelopes = [], transactions = [], budgetItems = [] } = state;
  const balances = computeEnvelopeBalances(transactions);
  const dated = planItemsAsOf(budgetItems, monthStartDate(monthIso));
  const monthlyPlan = computeMonthlyPlanByEnvelope(dated);
  const buffers = computeBufferByEnvelope(dated);
  return envelopes.filter((e) => !e.archived).map((e) => ({
    id: e.id,
    balance: r2(balances.get(e.id) || 0),
    monthly_plan: r2(monthlyPlan.get(e.id) || 0),
    buffer: r2(buffers.get(e.id) || 0),
  }));
}

function oldWhatif(state, monthIso) {
  const { accounts = [], transactions = [], budgetItems = [] } = state;
  const monthlyPlan = computeMonthlyPlanByEnvelope(planItemsAsOf(budgetItems, monthStartDate(monthIso)));
  const accBal = computeAccountBalances(accounts, transactions, { onlyPosted: true });
  return {
    accounts: accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, type: a.type || null, balance: r2(accBal.get(a.id) || 0) })),
    monthlyPlan: [...monthlyPlan.entries()].filter(([, v]) => v !== 0).map(([id, v]) => ({ envelope_id: id, monthly_plan: r2(v) })).slice(0, 50),
  };
}

function oldReconcileExpected(state, accountId, monthEnd) {
  return r2(computeAccountBalancesAsOf(state.accounts || [], state.transactions || [], monthEnd).get(accountId) || 0);
}

function oldPortfolio(state) {
  const { accounts = [], transactions = [] } = state;
  const inv = state.meta?.investments || {};
  const investmentAccounts = accounts.filter((a) => a && a.type === 'investment' && !a.archived && a.trackInvestments !== false);
  const ids = new Set(investmentAccounts.map((a) => a.id));
  const allHoldings = listHoldings(transactions, inv.holdingOverrides || {}, inv.manualRows || {}).filter((h) => ids.has(h.accountId));
  const accBal = computeAccountBalances(accounts, transactions, { onlyPosted: true });
  const unitsByAcct = new Map();
  for (const h of allHoldings) unitsByAcct.set(h.accountId, (unitsByAcct.get(h.accountId) || 0) + (Number(h.units) || 0));
  const idleCash = [];
  for (const acc of investmentAccounts) {
    const bal = Number(accBal.get(acc.id)) || 0;
    if (bal > 0 && Math.abs(unitsByAcct.get(acc.id) || 0) < 1e-6) idleCash.push({ account_id: acc.id, balance: r2(bal) });
  }
  return {
    accounts: investmentAccounts.map((a) => ({ id: a.id, name: a.name, balance: r2(accBal.get(a.id) || 0) })),
    holdings: allHoldings.slice(0, 50).map((h) => ({
      account_id: h.accountId, symbol: h.symbol, cost_basis: r2(h.costBasis), realized: r2(h.realized || 0), distributions: r2(h.distributions || 0),
    })),
    idle_cash: idleCash,
    totals: {
      cost_basis: r2(allHoldings.reduce((s, h) => s + (Number(h.costBasis) || 0), 0)),
      distributions: r2(allHoldings.reduce((s, h) => s + (Number(h.distributions) || 0), 0)),
      realized: r2(allHoldings.reduce((s, h) => s + (Number(h.realized) || 0), 0)),
    },
  };
}

const withoutLoanPayment = () => {
  const d = data();
  return deepFreeze({ ...d, transactions: d.transactions.filter((tx) => tx.id !== 'p1') });
};
const tool = (name, input, state = data(), clock = CLOCK) => runTool(name, state, input, clock).result;

// ── get_reports ─────────────────────────────────────────────────────────────

describe('get_reports reads reports.spending and reports.cashflow', () => {
  it('by envelope: the query rows; the folded rest is `other`, not a row', () => {
    // Without the loan payment, whose treatment changes (below), so the rows are the old ones.
    const d = withoutLoanPayment();
    const old = oldGetReports(d, { by: 'envelope', top: 2 });
    const now = tool('get_reports', { by: 'envelope', top: 2 }, d);
    jsonSafe(now);
    const q = queryAnswer(d, 'reports.spending', { groupBy: 'envelope', topN: 2 }, CLOCK);
    expect(now).toEqual({ by: 'envelope', rows: q.rows, other: q.other });
    // Unchanged figures: the same rows, and the old "Other (n)" row is the new `other`.
    expect(old.rows.slice(0, -1).map(({ key, label, value }) => ({ key, label, value }))).toEqual(now.rows);
    const oldOther = old.rows.at(-1);
    expect(oldOther).toMatchObject({ key: null, label: `Other (${now.other.count})` });
    expect(oldOther.value).toBe(now.other.value);
  });

  it('by payee, with a range and the old top clamp', () => {
    const d = data();
    const now = tool('get_reports', { by: 'payee', date_from: '2031-02-01', date_to: '2031-02-28', top: 500 });
    const q = queryAnswer(d, 'reports.spending', { groupBy: 'payee', from: '2031-02-01', to: '2031-02-28', topN: 40 }, CLOCK);
    expect(now).toEqual({ by: 'payee', rows: q.rows, other: q.other });
    expect(tool('get_reports', { by: 'payee', top: 0 }).rows.length).toBeLessThanOrEqual(12);
  });

  it('income_vs_spending: months and the three series from reports.cashflow', () => {
    const d = data();
    const q = queryAnswer(d, 'reports.cashflow', { from: '2031-01-01', to: '2031-03-31' }, CLOCK);
    const now = tool('get_reports', { by: 'income_vs_spending', date_from: '2031-01-01', date_to: '2031-03-31' });
    jsonSafe(now);
    expect(now.rows.months).toEqual(q.months);
    expect(now.rows.series.map((s) => s.name)).toEqual(['Income', 'Spending', 'Saving']);
    expect(now.rows.series[0].points).toEqual(q.income.map((p) => ({ label: p.month, value: p.value })));
    expect(now.rows.series[2].points).toEqual(q.saving.map((p) => ({ label: p.month, value: p.value })));
  });

  it('ANSWER CHANGE: loan principal is saving, not spending', () => {
    const d = data();
    const range = { date_from: '2031-02-01', date_to: '2031-02-28' };
    const before = oldGetReports(d, { by: 'envelope', ...range });
    const after = tool('get_reports', { by: 'envelope', ...range });
    const rent = (res) => res.rows.find((r) => r.key === 'rent').value;
    // Before: the 500 paid into the mortgage counted as Rent spending (900 + 500); after: 900.
    expect(rent(before)).toBe(1400);
    expect(rent(after)).toBe(900);
    const savingBefore = oldGetReports(d, { by: 'income_vs_spending', ...range }).rows.series.find((s) => s.name === 'Saving').points;
    const savingAfter = tool('get_reports', { by: 'income_vs_spending', ...range }).rows.series.find((s) => s.name === 'Saving').points;
    expect(savingBefore).toEqual(savingAfter);
    // February's saving: the 500 into the mortgage, less the 1100 the sale brought back from the broker.
    expect(savingAfter).toEqual([{ label: '2031-02', value: -600 }]);
    const spendingBefore = oldGetReports(d, { by: 'income_vs_spending', ...range }).rows.series.find((s) => s.name === 'Spending').points;
    const spendingAfter = tool('get_reports', { by: 'income_vs_spending', ...range }).rows.series.find((s) => s.name === 'Spending').points;
    expect(round2(spendingBefore[0].value - spendingAfter[0].value)).toBe(0);
  });

  it('a fractional top is cut to a whole number, as the old slice did, not refused', () => {
    const d = withoutLoanPayment();
    const now = tool('get_reports', { by: 'envelope', top: 2.5 }, d);
    expect(now).toEqual(tool('get_reports', { by: 'envelope', top: 2 }, d));
    // The old tool sliced the rows at 2.5: two rows and the folded rest.
    expect(oldGetReports(d, { by: 'envelope', top: 2.5 }).rows.slice(0, -1).map(({ key, label, value }) => ({ key, label, value }))).toEqual(now.rows);
    expect(tool('get_reports', { by: 'payee', top: 0.5 }).rows).toHaveLength(1);
  });

  it('an unrecognised `by` is the envelope breakdown, as before', () => {
    expect(tool('get_reports', { by: 'nonsense' }).by).toBe('envelope');
  });
});

// ── get_forecast and get_envelope_history ───────────────────────────────────

describe('get_forecast reads envelope.forecast with the tool’s clock', () => {
  it('equals the old tool with the deleted occurrence added back', () => {
    const d = data();
    const withoutTombstones = { ...d, meta: { ...d.meta, scheduledTombstones: [] } };
    for (const [envelope_id, months] of [['food', undefined], ['rent', 6], ['fun', 3], ['old', 1]]) {
      const now = tool('get_forecast', { envelope_id, months }, deepFreeze(withoutTombstones));
      jsonSafe(now);
      expect(now).toEqual(JSON.parse(JSON.stringify(oldGetForecast(withoutTombstones, { envelope_id, months }, NOW))));
    }
  });

  it('ANSWER CHANGE: a deleted (tombstoned) occurrence no longer counts', () => {
    const d = data();
    const before = oldGetForecast(d, { envelope_id: 'fun', months: 3 }, NOW);
    const after = tool('get_forecast', { envelope_id: 'fun', months: 3 });
    // The 15 March Fun fill of 50 was deleted: the old tool still projected it.
    expect([before.closing, after.closing]).toEqual([-75, -125]);
    expect(round2(before.closing - after.closing)).toBe(50);
  });

  it('clamps months as before (1..24, default 3)', () => {
    expect(tool('get_forecast', { envelope_id: 'food' }).months).toBe(3);
    expect(tool('get_forecast', { envelope_id: 'food', months: 99 }).months).toBe(24);
    expect(tool('get_forecast', { envelope_id: 'food', months: -4 }).months).toBe(1);
    expect(tool('get_forecast', { envelope_id: 'food', months: 'abc' }).months).toBe(3);
  });

  it('a fractional months is cut to a whole number, not refused', () => {
    const now = tool('get_forecast', { envelope_id: 'food', months: 2.5 });
    expect(now).toEqual(tool('get_forecast', { envelope_id: 'food', months: 2 }));
    expect(now.months).toBe(2);
    expect(tool('get_forecast', { envelope_id: 'food', months: 0.5 }).months).toBe(1);
  });

  it('a missing or non-string envelope_id answers as an unknown envelope, as before', () => {
    for (const input of [{}, { envelope_id: null }, { envelope_id: '' }, { envelope_id: 42 }, { envelope_id: ['food'] }]) {
      const now = tool('get_forecast', { ...input, months: 2 });
      expect(now).toEqual(JSON.parse(JSON.stringify(oldGetForecast(data(), { ...input, months: 2 }, NOW))));
      expect(now.envelope).toBeNull();
      expect(now.months_detail).toEqual([]);
    }
  });

  it('an unknown envelope answers envelope null and nothing to project, as before', () => {
    const now = tool('get_forecast', { envelope_id: 'nope', months: 2 });
    expect(now).toEqual(JSON.parse(JSON.stringify(oldGetForecast(data(), { envelope_id: 'nope', months: 2 }, NOW))));
    expect(now.envelope).toBeNull();
    expect(now.months_detail).toEqual([]);
  });
});

describe('get_envelope_history reads envelope.history with the tool’s clock', () => {
  it('equals the old tool', () => {
    for (const [envelope_id, months] of [['food', undefined], ['food', 3], ['rent', 36], ['fun', 2], ['old', 2]]) {
      const now = tool('get_envelope_history', { envelope_id, months });
      jsonSafe(now);
      expect(now).toEqual(oldGetHistory(data(), { envelope_id, months }, NOW));
    }
  });

  it('pins food: in, out and the months of a fixed clock', () => {
    expect(tool('get_envelope_history', { envelope_id: 'food', months: 3 })).toEqual({
      envelope: 'Food',
      months: [
        { month: '2031-01', in: 600, out: 0 },
        { month: '2031-02', in: 0, out: 685 },
        { month: '2031-03', in: 0, out: 40 },
      ],
    });
  });

  it('clamps months as before (1..36, default 12)', () => {
    expect(tool('get_envelope_history', { envelope_id: 'food' }).months).toHaveLength(12);
    expect(tool('get_envelope_history', { envelope_id: 'food', months: 99 }).months).toHaveLength(36);
    expect(tool('get_envelope_history', { envelope_id: 'food', months: 0 }).months).toHaveLength(12);
  });

  it('a fractional months is cut to a whole number, not refused', () => {
    const now = tool('get_envelope_history', { envelope_id: 'food', months: 2.5 });
    expect(now).toEqual(tool('get_envelope_history', { envelope_id: 'food', months: 2 }));
    expect(now.months.map((m) => m.month)).toEqual(['2031-02', '2031-03']);
    expect(tool('get_envelope_history', { envelope_id: 'food', months: 0.5 }).months).toHaveLength(1);
  });

  it('a missing or non-string envelope_id answers as an unknown envelope, as before', () => {
    for (const input of [{}, { envelope_id: null }, { envelope_id: '' }, { envelope_id: 42 }]) {
      const now = tool('get_envelope_history', { ...input, months: 2 });
      expect(now).toEqual(oldGetHistory(data(), { ...input, months: 2 }, NOW));
      expect(now.envelope).toBeNull();
      expect(now.months).toEqual([{ month: '2031-02', in: 0, out: 0 }, { month: '2031-03', in: 0, out: 0 }]);
    }
  });

  it('an unknown envelope answers envelope null, as before', () => {
    const now = tool('get_envelope_history', { envelope_id: 'nope', months: 2 });
    expect(now).toEqual(oldGetHistory(data(), { envelope_id: 'nope', months: 2 }, NOW));
    expect(now.envelope).toBeNull();
  });
});

// ── The context builders ────────────────────────────────────────────────────

describe('the monthly briefing reads reports.cashflow, reports.spending and envelopes.month', () => {
  it('income vs spending and the low envelopes are the old figures', () => {
    const ctx = buildMonthlyBriefingCtx(data(), undefined, CLOCK);
    const old = oldBriefingFigures(data(), '2031-03', NOW);
    expect(ctx.incomeVsSpend6mo).toEqual(old.incomeVsSpend6mo);
    expect(ctx.lowEnvelopes).toEqual(old.lowEnvelopes);
    expect(ctx.lowEnvelopes.map((e) => e.id)).toEqual(['food', 'rent', 'fun']);
  });

  it('ANSWER CHANGE: topPayees90d drops the Other row', () => {
    const before = oldBriefingFigures(data(), '2031-03', NOW).topPayees90d;
    const after = buildMonthlyBriefingCtx(data(), undefined, CLOCK).topPayees90d;
    expect(before.map((p) => p.payee)).toContain('Other (5)');
    expect(after.map((p) => p.payee)).not.toContain('Other (5)');
    expect(after).toEqual(before.filter((p) => p.payee !== 'Other (5)'));
    // Eight rows asked for, the (no payee) row dropped: seven payees, the rest (5 payees, 200) no longer shown.
    expect(after.map((p) => p.payee)).toEqual(['Landlord', 'Shop 1', 'Shop 2', 'Shop 3', 'Shop 4', 'Shop 5', 'Shop 6']);
    expect(before.at(-1)).toEqual({ payee: 'Other (5)', total: 200 });
  });
});

describe('the envelope health and what-if contexts read envelopes.month', () => {
  it('health rows: balance, monthly plan and buffer equal the old figures', () => {
    const ctx = buildEnvelopeHealthCtx(data(), undefined, CLOCK);
    const old = oldHealthRows(data(), '2031-03');
    for (const row of ctx.envelopes) {
      const o = old.find((x) => x.id === row.id);
      expect([row.balance, row.monthly_plan, row.buffer]).toEqual([o.balance, o.monthly_plan, o.buffer]);
    }
    expect(ctx.envelopes.map((e) => e.id).sort()).toEqual(['food', 'fun', 'rent']);
    expect(ctx.today).toBe('2031-03-10');
    expect(ctx.month).toBe('2031-03');
  });

  it('what-if: the plan per envelope is the old set (order follows the envelopes now)', () => {
    const ctx = buildWhatifCtx(data(), undefined, CLOCK);
    const old = oldWhatif(data(), '2031-03');
    const byId = (rows) => [...rows].sort((a, b) => a.envelope_id.localeCompare(b.envelope_id));
    // The archived envelope's item stays; an item for an envelope that does not exist is gone.
    expect(old.monthlyPlan.map((r) => r.envelope_id)).toContain('ghost');
    expect(ctx.monthlyPlan.map((r) => r.envelope_id)).toEqual(['food', 'rent', 'old']);
    expect(byId(ctx.monthlyPlan)).toEqual(byId(old.monthlyPlan.filter((r) => r.envelope_id !== 'ghost')));
  });
});

describe('the what-if context survives a malformed envelope row', () => {
  it('an envelope without a string id is skipped, not a failed context', () => {
    const d = data();
    const broken = deepFreeze({ ...d, envelopes: [...d.envelopes, { name: 'No id', category: 'Misc' }, { id: 7, name: 'Number id' }] });
    const ctx = buildWhatifCtx(broken, undefined, CLOCK);
    expect(ctx.monthlyPlan).toEqual(buildWhatifCtx(d, undefined, CLOCK).monthlyPlan);
  });
});

describe('ANSWER CHANGE: account balances in the what-if and portfolio contexts are the Today view', () => {
  it('a future-dated posted row no longer counts', () => {
    const ctx = buildWhatifCtx(data(), undefined, CLOCK);
    const old = oldWhatif(data(), '2031-03');
    const chk = (rows) => rows.find((a) => a.id === 'chk').balance;
    // Before: all posted rows, the 40 posted for 20 March included. After: cleared as of 10 March.
    expect([chk(old.accounts), chk(ctx.accounts)]).toEqual([5839, 5879]);
    expect(round2(chk(ctx.accounts) - chk(old.accounts))).toBe(40);
    const bal = queryAnswer(data(), 'balances', { lens: 'today' }, CLOCK).accounts;
    expect(ctx.accounts).toEqual(bal.map(({ id, name, type, balance }) => ({ id, name, type, balance })));
  });

  it('the portfolio: holdings, totals and idle cash are the old figures; balances are the Today view', () => {
    const ctx = buildPortfolioInsightCtx(data(), CLOCK);
    const old = oldPortfolio(data());
    jsonSafe(ctx);
    expect(ctx.holdings.map(({ account_id, symbol, cost_basis, realized, distributions }) => ({ account_id, symbol, cost_basis, realized, distributions })))
      .toEqual(old.holdings);
    expect(ctx.holdings.map((h) => h.symbol)).toContain('MSFT'); // the sold-out holding is still listed
    expect(ctx.totals).toMatchObject(old.totals);
    expect(ctx.idle_cash).toEqual(old.idle_cash);
    expect(ctx.idle_cash).toEqual([{ account_id: 'ira', balance: 500 }]);
    expect(ctx.accounts).toEqual(old.accounts);
  });
});

describe('the reconcile context reads balances as of the month end', () => {
  it('expected_balance equals the old as-of balance', () => {
    for (const month of ['2031-01', '2031-02', '2031-03']) {
      const ctx = buildReconcileCtx(data(), 'chk', month, CLOCK);
      expect(ctx.expected_balance).toBe(oldReconcileExpected(data(), 'chk', `${month}-${month === '2031-02' ? 28 : 31}`));
    }
    expect(buildReconcileCtx(data(), 'chk', '2031-02', CLOCK).expected_balance).toBe(queryAnswer(data(), 'balances', { lens: 'booked', asOf: '2031-02-28' }, CLOCK).accounts.find((a) => a.id === 'chk').balance);
  });

  it('defaults the month to the clock’s', () => {
    const ctx = buildReconcileCtx(data(), 'chk', undefined, CLOCK);
    expect(ctx.month).toBe('2031-03');
    expect(ctx.today).toBe('2031-03-10');
  });
});

// ── No clock but the one handed in ──────────────────────────────────────────

describe('no builder or tool reads the wall clock', () => {
  const runAll = () => ({
    tools: Object.fromEntries(listToolNames().map((name) => [name, SAMPLE[name].map((input) => runTool(name, data(), input, CLOCK).result)])),
    briefing: buildMonthlyBriefingCtx(data(), undefined, CLOCK),
    anomaly: buildAnomalyCtx(data(), undefined, CLOCK),
    health: buildEnvelopeHealthCtx(data(), undefined, CLOCK),
    subscription: buildSubscriptionCtx(data(), CLOCK),
    whatif: buildWhatifCtx(data(), undefined, CLOCK),
    onboarding: buildOnboardingCtx(data(), undefined, CLOCK),
    search: buildSearchCtx(data(), CLOCK),
    portfolio: buildPortfolioInsightCtx(data(), CLOCK),
    reconcile: buildReconcileCtx(data(), 'chk', undefined, CLOCK),
  });
  const SAMPLE = {
    get_envelopes: [{}], get_accounts: [{}], query_transactions: [{}, { search: 'shop' }],
    get_envelope_history: [{ envelope_id: 'food' }], get_reports: [{ by: 'envelope' }, { by: 'payee' }, { by: 'income_vs_spending' }],
    get_forecast: [{ envelope_id: 'food' }], get_runway: [{}], get_net_worth_history: [{}], get_net_worth_projection: [{ years: 3 }],
    propose_transactions: [{ transactions: [{ date: '2031-03-12', payee: 'T', amount: 12, type: 'expense', account_id: 'chk', envelope_id: 'food' }], summary: 's' }],
    propose_envelope_changes: [{ moves: [{ from_envelope_id: 'food', to_envelope_id: 'fun', amount: 5 }] }],
  };

  it('every answer is the same whatever the system time says', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1999, 5, 1, 12));
    const early = runAll();
    vi.setSystemTime(new Date(2045, 10, 20, 12));
    const late = runAll();
    expect(late).toEqual(early);
    expect(Object.keys(early.tools).sort()).toEqual(listToolNames().sort());
    // And the answers are about the injected day, not the faked one.
    expect(early.health.today).toBe('2031-03-10');
    expect(early.search.today).toBe('2031-03-10');
    expect(early.onboarding.today).toBe('2031-03-10');
    expect(early.reconcile.month).toBe('2031-03');
    expect(early.portfolio.contributions.monthly.at(-1).month).toBe('2031-03');
    expect(early.tools.get_envelope_history[0].months.at(-1).month).toBe('2031-03');
    // The proposal’s default date is the clock’s too.
    const moves = runTool('propose_envelope_changes', data(), SAMPLE.propose_envelope_changes[0], CLOCK).proposal;
    expect(JSON.stringify(moves)).toContain('2031-03-10');
  });

  it('a builder given no clock throws instead of reading one', () => {
    for (const build of [
      () => buildAnomalyCtx(data()), () => buildEnvelopeHealthCtx(data()), () => buildSubscriptionCtx(data()),
      () => buildOnboardingCtx(data()), () => buildSearchCtx(data()), () => buildPortfolioInsightCtx(data()),
      () => buildReconcileCtx(data(), 'chk', '2031-02'),
    ]) expect(build).toThrow();
  });

  it('reads the clock once per build', () => {
    for (const build of [
      (c) => buildMonthlyBriefingCtx(data(), undefined, c), (c) => buildAnomalyCtx(data(), undefined, c),
      (c) => buildEnvelopeHealthCtx(data(), undefined, c), (c) => buildSubscriptionCtx(data(), c),
      (c) => buildWhatifCtx(data(), undefined, c), (c) => buildPortfolioInsightCtx(data(), c),
      (c) => buildReconcileCtx(data(), 'chk', undefined, c),
    ]) {
      let reads = 0;
      build(() => { reads++; return NOW; });
      expect(reads).toBe(1);
    }
  });
});
