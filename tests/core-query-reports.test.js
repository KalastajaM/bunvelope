// tests/core-query-reports.test.js — the Reports page's figures as queries:
// `reports.spending`, `reports.cashflow`, `reports.balances`,
// `plan.allocation` and `envelopes.history`.
//
// `pageReports` below copies the page's composition from js/pages/reports.js
// (render, L127-186, and the average reference lines L316-330) verbatim, with
// `state` → the fixture, `viewTxs()` → the lens rows, `now()` → the fixed
// clock, `datedPlanItems()` → `planItemsAsOf(state.budgetItems, now())`, and
// the saved prefs and page filter → parameters. The helpers it calls from
// js/pages/reports-prefs.js (`averageWindowEnd`, `sortEnvelopeRows`,
// `envelopeCount`) are copied too, so the page can drop them later without
// this test changing. Every query answer must equal the copy.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions } from '../js/engine/lens.js';
import {
  aggregateSpendingByEnvelope,
  aggregateIncomeVsSpending,
  aggregateSpendingByMonth,
  aggregateSavingByMonth,
  aggregateEnvelopeBalances,
  aggregateBudgetAllocation,
  aggregatePayeeSpending,
  computeEnvelopeBalanceHistory,
  computeEnvelopeBalanceHistoryByEnvelope,
  trailingWindowStart,
  trailingMonthlyAverage,
  txPayeeLabel,
} from '../js/engine.js';
import { planItemsAsOf } from '../js/engine/item-dates.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);
// Clocks from explicit components, so every zone test:tz runs reads the same day.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};

// ── The page's helpers, copied from js/pages/reports-prefs.js ──────────────

function averageWindowEnd(rangeTo, today) {
  if (rangeTo && rangeTo < today) return { endYm: rangeTo.slice(0, 7), endIso: rangeTo };
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, 0)); // last day of the month before
  const endIso = prev.toISOString().slice(0, 10);
  return { endYm: endIso.slice(0, 7), endIso };
}

function sortEnvelopeRows(rows, sort) {
  if (sort !== 'name') return rows.slice();
  const other = rows.filter(r => r.key == null);
  const named = rows.filter(r => r.key != null).sort((a, b) => a.label.localeCompare(b.label));
  return [...named, ...other];
}

function envelopeCount(rows) {
  let count = 0;
  for (const r of rows) {
    if (r.key != null) { count++; continue; }
    const m = /\((\d+)\)/.exec(r.label);
    if (m) count += Number(m[1]);
  }
  return count;
}

// ── The page's composition, copied from js/pages/reports.js ────────────────

/**
 * @param {any} state
 * @param {{ from: string|null, to: string|null }} range  resolveRange()
 * @param {{ envelopes?: string[], payees?: string[] }} excluded  the page filter
 * @param {{ topN?: number, sort?: string }} topPrefs  readTopNPrefs(...)
 * @param {string[]} picks  readEnvelopePicks(...)
 * @param {any[]} lensTxs  viewTxs()
 * @param {Date} clock  now()
 */
function pageReports(state, range, excluded, topPrefs, picks, lensTxs, clock) {
  const todayStr = () => {
    const d = clock;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const exEnv = new Set(excluded.envelopes || []);
  const exPay = new Set(excluded.payees || []);
  // `accounts`: principal paid into a loan is saving, not Spending.
  const envOpt = { excludeEnvelopes: exEnv, accounts: state.accounts };
  const flowTxs = exPay.size ? state.transactions.filter(tx => !exPay.has(txPayeeLabel(tx))) : state.transactions;

  const byEnvelope = sortEnvelopeRows(
    aggregateSpendingByEnvelope(flowTxs, state.envelopes, range, topPrefs.topN, envOpt), topPrefs.sort);
  const ivs        = aggregateIncomeVsSpending(flowTxs, state.accounts, range, envOpt);
  const byMonth    = aggregateSpendingByMonth(flowTxs, range, envOpt);
  const bySaving   = aggregateSavingByMonth(flowTxs, state.accounts, range);
  const balances   = aggregateEnvelopeBalances(state.envelopes, lensTxs, 15, envOpt);
  const allocation = aggregateBudgetAllocation(state.envelopes, planItemsAsOf(state.budgetItems, clock), 10, envOpt);
  const balanceHistory = computeEnvelopeBalanceHistory(lensTxs, 12, clock, { excludeIds: exEnv });

  const pickedHistory = picks.length ? computeEnvelopeBalanceHistoryByEnvelope(lensTxs, 12, clock, picks) : null;

  const { endYm, endIso } = averageWindowEnd(range.to, todayStr());
  const range12 = { from: `${trailingWindowStart(endYm, 12)}-01`, to: endIso };
  const firstYm = state.transactions.reduce((m, tx) => (tx.date && (!m || tx.date < m) ? tx.date : m), '').slice(0, 7) || null;
  const avgOf = points => trailingMonthlyAverage(points, endYm, 12, firstYm);
  const avgSpend = avgOf(aggregateSpendingByMonth(flowTxs, range12, envOpt));
  const ivs12 = aggregateIncomeVsSpending(flowTxs, state.accounts, range12, envOpt);
  const byPayee = aggregatePayeeSpending(flowTxs, range, 12, envOpt);

  const totalIncome   = ivs.series.find(s => s.name === 'Income').points.reduce((s, p) => s + p.value, 0);
  const totalSpending = ivs.series.find(s => s.name === 'Spending').points.reduce((s, p) => s + p.value, 0);
  const totalSaving   = ivs.series.find(s => s.name === 'Saving').points.reduce((s, p) => s + p.value, 0);
  const net = totalIncome - totalSpending;

  // The income-vs-spending reference lines (L316-321), keyed by engine name.
  const refLines = Object.fromEntries(ivs12.series.map((s, i) => {
    const points = ivs12.series[i].points;
    const value = avgOf(points);
    if (value == null || points.every(p => p.value === 0)) return [s.name, null];
    return [s.name, value];
  }));
  // The spending-by-month reference line (L330).
  const spendRefLine = (avgSpend == null || avgSpend === 0) ? null : avgSpend;

  return {
    byEnvelope, ivs, byMonth, bySaving, balances, allocation, balanceHistory, pickedHistory, byPayee,
    totalIncome, totalSpending, totalSaving, net, refLines, spendRefLine, range12,
    subtitleEnvelopes: envelopeCount(byEnvelope),
  };
}

// ── The fixture ────────────────────────────────────────────────────────────

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const EXTRAS = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'];
const exp = (id, date, payee, amount, envelope_id, extra = {}) => ({ id, type: 'expense', date, payee, amount, account: 'chk', envelope_id, status: 'posted', ...extra });
const salary = (date) => ({ id: `pay-${date}`, type: 'income', date, payee: 'Employer', amount: 2500, account: 'chk', status: 'posted' });

// A budget with every case the figures treat differently:
//   - March 2026 has no row at all (sparse months)
//   - a split expense (groc 60 / fun 40), a payee with spaces, a missing payee
//   - loan principal paid into a loan (saving, not spending) and its interest
//   - money moved into savings and back out
//   - an archived envelope (old) and an envelope that does not exist (ghost)
//   - eight small envelopes, so a top 5 and a top 12 both fold an "Other" row
//   - a scheduled row after today, and a rent item the forecast lens generates
//   - plan items that ended (gym), start later (car) and are income (skipped)
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI' },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 3000 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 1000 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -20000 },
    { id: 'visa', name: 'Visa', type: 'credit_card', initialBalance: 0 },
  ],
  envelopes: [
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'rest', name: 'Restaurants', category: 'Food' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'fun', name: 'Fun', category: 'Living' },
    { id: 'car', name: 'Car', category: 'Transport' },
    { id: 'gym', name: 'Gym', category: 'Health' },
    { id: 'gift', name: 'Gifts', category: 'Living' },
    { id: 'old', name: 'Old', category: 'Misc', archived: true },
    ...EXTRAS.map((id, i) => ({ id, name: `Extra ${i + 1}`, category: 'Extra' })),
  ],
  budgetItems: [
    { id: 'rentItem', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
      default_amount: -900, payment_day: 1, schedule_day_type: 'exact', include: true,
      as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS },
    { id: 'grocItem', kind: 'expense', description: 'Food', envelope_id: 'groc', default_amount: -400,
      extra_buffer: 100, include: true, monthly_schedule: ALL_MONTHS },
    { id: 'gymItem', kind: 'expense', description: 'Gym', envelope_id: 'gym', default_amount: -50,
      include: true, end_month: '2026-06', monthly_schedule: ALL_MONTHS },
    { id: 'carItem', kind: 'expense', description: 'Car', envelope_id: 'car', default_amount: -150,
      include: true, start_month: '2027-03', monthly_schedule: ALL_MONTHS },
    { id: 'salaryItem', kind: 'income', description: 'Salary', default_amount: 2500, include: true, monthly_schedule: ALL_MONTHS },
    { id: 'offItem', kind: 'expense', description: 'Off', envelope_id: 'fun', default_amount: -70, include: false, monthly_schedule: ALL_MONTHS },
    ...EXTRAS.map((id, i) => ({ id: `${id}Item`, kind: 'expense', description: id, envelope_id: id,
      default_amount: -(10 + i), include: true, monthly_schedule: ALL_MONTHS })),
  ],
  envelopeTemplates: [],
  transactions: [
    ...['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-04-01', '2026-05-01',
      '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map(salary),
    { id: 'f1', type: 'fill', date: '2025-10-02', payee: 'Fill', amount: 1700, status: 'posted',
      lines: [{ envelope_id: 'groc', amount: 600 }, { envelope_id: 'rent', amount: 900 }, { envelope_id: 'fun', amount: 200 }] },
    { id: 'f2', type: 'fill', date: '2026-06-02', payee: 'Fill', amount: 450, status: 'posted',
      lines: [{ envelope_id: 'car', amount: 400 }, { envelope_id: 'old', amount: 50 }] },
    exp('g1', '2025-10-05', 'Shop A', 120.5, 'groc'),
    exp('g2', '2026-01-10', 'Shop A', 80, 'groc'),
    exp('g3', '2026-06-03', ' Shop A ', 60, 'groc'),
    exp('r1', '2026-02-14', 'Cafe', 45.25, 'rest', { account: 'visa' }),
    exp('r2', '2026-05-05', '', 30, 'rest'),
    exp('h1', '2026-01-01', 'Landlord', 900, 'rent'),
    exp('h2', '2026-06-01', 'Landlord', 900, 'rent'),
    exp('h3', '2026-09-01', 'Landlord', 900, 'rent'),
    { id: 's1', type: 'expense', date: '2026-07-07', payee: 'Market', amount: 100, account: 'chk', status: 'posted',
      envelope_splits: [{ envelope_id: 'groc', amount: 60 }, { envelope_id: 'fun', amount: 40 }] },
    exp('c1', '2026-04-20', 'Garage', 300, 'car'),
    exp('y1', '2026-08-02', 'Gym', 50, 'gym'),
    exp('gi1', '2025-12-20', 'Gift shop', 75, 'gift'),
    exp('o1', '2025-11-11', 'Old', 20, 'old'),
    exp('u1', '2026-02-02', 'Ghost', 10, 'ghost'),
    ...EXTRAS.map((id, i) => exp(`xe${i}`, `2026-05-${String(10 + i).padStart(2, '0')}`, `Misc ${i + 1}`, i + 1.5, id)),
    { id: 'p1', type: 'debt_payment', date: '2026-05-25', payee: 'Bank', amount: 500, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent', status: 'posted' },
    exp('p2', '2026-05-25', 'Bank', 80, 'rent'),
    { id: 't1', type: 'account_transfer', date: '2026-01-15', payee: 'Save', amount: 300, from_account: 'chk', to_account: 'sav', status: 'posted' },
    { id: 't2', type: 'account_transfer', date: '2026-06-15', payee: 'Unsave', amount: 100, from_account: 'sav', to_account: 'chk', status: 'posted' },
    exp('z1', '2026-09-20', 'Shop A', 99, 'groc', { status: 'scheduled' }),
    exp('z2', '2026-09-18', 'Shop B', 12, 'groc', { status: 'posted' }),
  ],
  ...extra,
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

const viewTxsOf = (d, lens = { lens: 'booked' }, now = NOW) => lensTransactions(d, { lens: lens.lens, horizon: lens.horizon, today: now });

// The page's view of the spending answer: the "Other" row put back as the
// engine labelled it.
const asPageRows = (a) => [...a.rows, ...(a.other ? [{ key: null, label: `Other (${a.other.count})`, value: a.other.value }] : [])];
const points = (pts) => pts.map(p => ({ month: p.label, value: p.value }));

const RANGES = [
  ['ytd (ends today)', { from: '2026-01-01', to: '2026-09-15' }],
  ['12m', { from: '2025-10-01', to: '2026-09-15' }],
  ['all time', { from: null, to: null }],
  ['ends before today', { from: '2026-01-01', to: '2026-05-20' }],
  ['ends after today', { from: '2026-06-01', to: '2026-12-31' }],
  ['open start, ends before today', { from: null, to: '2026-02-28' }],
  ['empty, before any data', { from: '2020-01-01', to: '2020-03-31' }],
];
const rangeInput = (r) => ({ ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) });

const EXCLUSIONS = [
  ['no exclusions', {}],
  ['envelopes (per split line)', { envelopes: ['fun', 'rent'] }],
  ['payees (whole rows)', { payees: ['Shop A', '(no payee)'] }],
  ['both', { envelopes: ['groc'], payees: ['Market', 'Landlord'] }],
];
const exclusionInput = (ex) => ({
  ...(ex.envelopes ? { excludeEnvelopes: ex.envelopes } : {}),
  ...(ex.payees ? { excludePayees: ex.payees } : {}),
});

// ── reports.spending ───────────────────────────────────────────────────────

describe('reports.spending', () => {
  for (const [rName, range] of RANGES) {
    for (const [eName, ex] of EXCLUSIONS) {
      for (const topN of [5, 12, 0]) {
        it(`by envelope, ${rName}, ${eName}, top ${topN}: equals the page`, () => {
          const page = pageReports(data(), range, ex, { topN, sort: 'amount' }, [], viewTxsOf(data()), NOW);
          const a = answer('reports.spending', { groupBy: 'envelope', topN, ...rangeInput(range), ...exclusionInput(ex) }, data());
          expect(a.groupBy).toBe('envelope');
          expect(asPageRows(a)).toEqual(page.byEnvelope);
          expect(a.rows.length + (a.other?.count ?? 0)).toBe(page.subtitleEnvelopes);
          expect(a.rows.every(r => r.key != null)).toBe(true);
          jsonSafe(a);
        });
      }
      it(`by payee, ${rName}, ${eName}: equals the page (top 12)`, () => {
        const page = pageReports(data(), range, ex, { topN: 12, sort: 'amount' }, [], viewTxsOf(data()), NOW);
        const a = answer('reports.spending', { groupBy: 'payee', ...rangeInput(range), ...exclusionInput(ex) }, data());
        expect(asPageRows(a)).toEqual(page.byPayee);
        jsonSafe(a);
      });
      it(`by month, ${rName}, ${eName}: equals the page`, () => {
        const page = pageReports(data(), range, ex, { topN: 12, sort: 'amount' }, [], viewTxsOf(data()), NOW);
        const a = answer('reports.spending', { groupBy: 'month', ...rangeInput(range), ...exclusionInput(ex) }, data());
        expect(a.rows).toEqual(page.byMonth);
        expect(a.other).toBeNull();
      });
    }
  }

  it('sorted by name on the page, the answer\'s rows give the page\'s order (Other last)', () => {
    const range = { from: null, to: null };
    for (const topN of [5, 12, 0]) {
      const page = pageReports(data(), range, {}, { topN, sort: 'name' }, [], viewTxsOf(data()), NOW);
      const a = answer('reports.spending', { groupBy: 'envelope', topN }, data());
      expect(sortEnvelopeRows(asPageRows(a), 'name')).toEqual(page.byEnvelope);
    }
  });

  it('the Other row: count and value of the folded rest; null when nothing folds', () => {
    const top5 = answer('reports.spending', { groupBy: 'envelope', topN: 5 }, data());
    const all = answer('reports.spending', { groupBy: 'envelope', topN: 0 }, data());
    expect(all.other).toBeNull();
    expect(top5.rows).toEqual(all.rows.slice(0, 5));
    expect(top5.other).toEqual({ count: all.rows.length - 5, value: round2(all.rows.slice(5).reduce((s, r) => s + r.value, 0)) });
    expect(answer('reports.spending', { groupBy: 'envelope' }, data()).other.count).toBe(all.rows.length - 12);
  });

  it('labels: Category · Name, (Unknown) for a missing envelope, the archived one included', () => {
    const { rows } = answer('reports.spending', { groupBy: 'envelope', topN: 0 }, data());
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.label]));
    expect(byKey).toMatchObject({ groc: 'Food · Groceries', ghost: '(Unknown)', old: 'Misc · Old' });
  });

  it('loan principal is not spending; its interest is', () => {
    const { rows } = answer('reports.spending', { groupBy: 'payee', topN: 0, from: '2026-05-01', to: '2026-05-31' }, data());
    expect(rows.find(r => r.key === 'Bank').value).toBe(80);
  });

  it('a payee exclusion is a whole row; an envelope exclusion drops only that split line', () => {
    const range = { from: '2026-07-01', to: '2026-07-31' };
    const byPayee = (ex) => answer('reports.spending', { groupBy: 'payee', topN: 0, ...range, ...ex }, data()).rows;
    expect(byPayee({})).toEqual([{ key: 'Market', label: 'Market', value: 100 }]);
    expect(byPayee({ excludeEnvelopes: ['fun'] })).toEqual([{ key: 'Market', label: 'Market', value: 60 }]);
    expect(byPayee({ excludePayees: ['Market'] })).toEqual([]);
  });

  it('the exclude picker\'s ranking: every payee, no exclusions', () => {
    const range = { from: '2026-01-01', to: '2026-09-15' };
    // L459: aggregatePayeeSpending(state.transactions, range, 0, { accounts: state.accounts })
    const picker = aggregatePayeeSpending(data().transactions, range, 0, { accounts: data().accounts });
    const a = answer('reports.spending', { groupBy: 'payee', topN: 0, ...range }, data());
    expect(a.rows).toEqual(picker);
    expect(a.other).toBeNull();
  });

  it('an empty budget: no rows, no Other', () => {
    for (const groupBy of ['envelope', 'payee', 'month']) {
      expect(answer('reports.spending', { groupBy }, empty())).toEqual({ groupBy, rows: [], other: null });
    }
  });

  it('refuses a missing groupBy and a topN out of range', () => {
    expect(ask('reports.spending', {}, data()).error.code).toBe('bad_input');
    expect(ask('reports.spending', { groupBy: 'envelope', topN: 101 }, data()).error.code).toBe('bad_input');
  });
});

// ── reports.cashflow ───────────────────────────────────────────────────────

describe('reports.cashflow', () => {
  for (const [rName, range] of RANGES) {
    for (const [eName, ex] of EXCLUSIONS) {
      it(`${rName}, ${eName}: equals the page`, () => {
        const page = pageReports(data(), range, ex, { topN: 12, sort: 'amount' }, [], viewTxsOf(data()), NOW);
        const a = answer('reports.cashflow', { ...rangeInput(range), ...exclusionInput(ex) }, data());
        const series = (name) => points(page.ivs.series.find(s => s.name === name).points);
        expect(a.months).toEqual(page.ivs.months);
        expect(a.income).toEqual(series('Income'));
        expect(a.spending).toEqual(series('Spending'));
        expect(a.saving).toEqual(series('Saving'));
        expect(a.totals).toEqual({
          income: round2(page.totalIncome), spending: round2(page.totalSpending),
          saving: round2(page.totalSaving), net: round2(page.net),
        });
        expect(a.spendingByMonth).toEqual(points(page.byMonth));
        // The page's sparse series, every month of the answer filled with 0
        // (BACKLOG 2026-10-05: a month with no saving row was left out).
        const saved = new Map(page.bySaving.map(p => [p.label, p.value]));
        expect(a.savingByMonth).toEqual(page.bySaving.length
          ? [...new Set([...a.months, ...saved.keys()])].sort().map(month => ({ month, value: saved.get(month) ?? 0 }))
          : []);
        expect(a.averages).toEqual({
          window: page.range12,
          income: page.refLines.Income, spending: page.refLines.Spending, saving: page.refLines.Saving,
          spendingByMonth: page.spendRefLine,
        });
        jsonSafe(a);
      });
    }
  }

  it('sparse months: March 2026 has no row, so no point', () => {
    const a = answer('reports.cashflow', { from: '2026-01-01', to: '2026-06-30' }, data());
    expect(a.months).toEqual(['2026-01', '2026-02', '2026-04', '2026-05', '2026-06']);
    expect(a.income.map(p => p.month)).toEqual(a.months);
  });

  it('Saving by Month plots every month: a month with no saving row reads 0, a withdrawal month its negative', () => {
    const rows = [
      { id: 's1', type: 'account_transfer', date: '2026-07-03', amount: 400, from_account: 'chk', to_account: 'sav', status: 'posted' },
      { id: 'g1', type: 'expense', date: '2026-08-04', amount: 20, account: 'chk', envelope_id: 'food', status: 'posted' },
      { id: 's2', type: 'account_transfer', date: '2026-09-05', amount: 150, from_account: 'sav', to_account: 'chk', status: 'posted' },
    ];
    const d = data({ transactions: [...data().transactions.filter(tx => tx.date < '2026-07-01' || tx.date > '2026-09-30'), ...rows] });
    const a = answer('reports.cashflow', { from: '2026-07-01', to: '2026-09-30' }, d);
    expect(a.months).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(a.savingByMonth).toEqual([{ month: '2026-07', value: 400 }, { month: '2026-08', value: 0 }, { month: '2026-09', value: -150 }]);
    expect(a.savingByMonth.map(p => p.value)).toEqual(a.saving.map(p => p.value));
    // A range with no saving at all keeps the chart empty.
    expect(answer('reports.cashflow', { from: '2026-08-01', to: '2026-08-31' }, d).savingByMonth).toEqual([]);
  });

  it('loan principal is saving, not spending', () => {
    const a = answer('reports.cashflow', { from: '2026-05-01', to: '2026-05-31' }, data());
    expect(a.saving).toEqual([{ month: '2026-05', value: 500 }]);
    expect(a.savingByMonth).toEqual([{ month: '2026-05', value: 500 }]);
    expect(a.spending[0].value).toBe(round2(30 + 80 + EXTRAS.reduce((s, _, i) => s + i + 1.5, 0)));
  });

  it('the average window: a range ending before today ends there; one running to today ends at the last complete month', () => {
    expect(answer('reports.cashflow', { from: '2026-01-01', to: '2026-05-20' }, data()).averages.window)
      .toEqual({ from: '2025-06-01', to: '2026-05-20' });
    expect(answer('reports.cashflow', { from: '2026-01-01', to: '2026-09-15' }, data()).averages.window)
      .toEqual({ from: '2025-09-01', to: '2026-08-31' });
    expect(answer('reports.cashflow', {}, data()).averages.window)
      .toEqual({ from: '2025-09-01', to: '2026-08-31' });
  });

  it('date moves today, and with it the window of an open range', () => {
    const page = pageReports(data(), { from: null, to: null }, {}, { topN: 12, sort: 'amount' }, [], viewTxsOf(data()), at(2026, 4, 3));
    const a = answer('reports.cashflow', { date: '2026-04-03' }, data());
    expect(a.averages.window).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(a.averages.window).toEqual(page.range12);
    expect(a.averages.income).toBe(page.refLines.Income);
    expect(a.averages.spendingByMonth).toBe(page.spendRefLine);
  });

  it('a young budget averages from its first month; a window before it has no average', () => {
    const young = data({ transactions: data().transactions.filter(tx => tx.date >= '2026-05-01') });
    for (const range of [{ from: null, to: null }, { from: '2026-01-01', to: '2026-04-30' }]) {
      const page = pageReports(young, range, {}, { topN: 12, sort: 'amount' }, [], viewTxsOf(young), NOW);
      const a = answer('reports.cashflow', rangeInput(range), young);
      expect(a.averages).toEqual({ window: page.range12, income: page.refLines.Income, spending: page.refLines.Spending,
        saving: page.refLines.Saving, spendingByMonth: page.spendRefLine });
    }
    expect(answer('reports.cashflow', {}, young).averages.income).toBe(round2(2500 * 4 / 4));
    expect(answer('reports.cashflow', { to: '2026-04-30' }, young).averages)
      .toEqual({ window: { from: '2025-05-01', to: '2026-04-30' }, income: null, spending: null, saving: null, spendingByMonth: null });
  });

  it('an average whose window months are all zero has no line; one netting to zero over non-zero months keeps it', () => {
    const accounts = [{ id: 'chk', type: 'bank', initialBalance: 0 }, { id: 'sav', type: 'savings', initialBalance: 0 }];
    const tr = (id, date, from, to) => ({ id, type: 'account_transfer', date, amount: 100, from_account: from, to_account: to, status: 'posted' });
    const netZero = deepFreeze({ ...empty(), accounts, transactions: [salary('2026-04-01'), tr('a', '2026-04-02', 'chk', 'sav'), tr('b', '2026-05-02', 'sav', 'chk')] });
    const a = answer('reports.cashflow', {}, netZero);
    const page = pageReports(netZero, { from: null, to: null }, {}, { topN: 12, sort: 'amount' }, [], viewTxsOf(netZero), NOW);
    expect(a.averages.saving).toBe(0);
    expect(page.refLines.Saving).toBe(0);
    expect(a.averages.spending).toBeNull();
    expect(page.refLines.Spending).toBeNull();
    expect(a.averages.spendingByMonth).toBeNull();
  });

  it('an empty budget: no months, zero totals, no averages', () => {
    expect(answer('reports.cashflow', {}, empty())).toEqual({
      months: [], income: [], spending: [], saving: [],
      totals: { income: 0, spending: 0, saving: 0, net: 0 },
      spendingByMonth: [], savingByMonth: [],
      averages: { window: { from: '2025-09-01', to: '2026-08-31' }, income: null, spending: null, saving: null, spendingByMonth: null },
    });
  });
});

// ── reports.balances ───────────────────────────────────────────────────────

const LENS_CASES = [
  ['no lens (booked)', {}, { lens: 'booked' }],
  ['booked', { lens: 'booked' }, { lens: 'booked' }],
  ['today', { lens: 'today' }, { lens: 'today' }],
  ['forecast (default horizon)', { lens: 'forecast' }, { lens: 'forecast', horizon: '3m' }],
  ['forecast 12m', { lens: 'forecast', horizon: '12m' }, { lens: 'forecast', horizon: '12m' }],
];

describe('reports.balances', () => {
  for (const [lName, input, lens] of LENS_CASES) {
    for (const [eName, ex] of EXCLUSIONS.filter(([, e]) => !e.payees)) {
      it(`${lName}, ${eName}: equals the page (top 15)`, () => {
        const page = pageReports(data(), { from: null, to: null }, ex, { topN: 12, sort: 'amount' }, [], viewTxsOf(data(), lens), NOW);
        const a = answer('reports.balances', { ...input, ...(ex.envelopes ? { excludeEnvelopes: ex.envelopes } : {}) }, data());
        expect(a.rows).toEqual(page.balances);
        expect(a.lens).toBe(lens.lens);
        jsonSafe(a);
      });
    }
  }

  it('the forecast lens moves the balances (the rent item comes due)', () => {
    const booked = answer('reports.balances', {}, data());
    const forecast = answer('reports.balances', { lens: 'forecast', horizon: '6m' }, data());
    expect(forecast.horizon).toBe('2027-03-31'); // 6m resolves to a month end
    expect(booked.horizon).toBeNull();
    expect(forecast.rows.find(r => r.key === 'rent').value).not.toBe(booked.rows.find(r => r.key === 'rent').value);
  });

  it('archived and unknown envelopes keep their balance; topN 0 lists every one', () => {
    const { rows } = answer('reports.balances', { topN: 0 }, data());
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(byKey.old).toEqual({ key: 'old', label: 'Misc · Old', value: 30 });
    expect(byKey.ghost).toEqual({ key: 'ghost', label: '(Unknown)', value: -10 });
    expect(rows).toEqual(aggregateEnvelopeBalances(data().envelopes, data().transactions, 0));
    expect(answer('reports.balances', { topN: 3 }, data()).rows).toEqual(rows.slice(0, 3));
  });

  it('refuses a horizon without the forecast lens', () => {
    expect(ask('reports.balances', { lens: 'booked', horizon: '3m' }, data()).error.code).toBe('bad_input');
  });
});

// ── plan.allocation ────────────────────────────────────────────────────────

describe('plan.allocation', () => {
  for (const [eName, ex] of EXCLUSIONS.filter(([, e]) => !e.payees)) {
    it(`${eName}: equals the page (top 10, the dated plan)`, () => {
      const page = pageReports(data(), { from: null, to: null }, ex, { topN: 12, sort: 'amount' }, [], viewTxsOf(data()), NOW);
      const a = answer('plan.allocation', ex.envelopes ? { excludeEnvelopes: ex.envelopes } : {}, data());
      expect(asPageRows(a)).toEqual(page.allocation);
      jsonSafe(a);
    });
  }

  it('reads the dated plan: an ended item is out, one starting later counts its months in the window', () => {
    const { rows, other } = answer('plan.allocation', { top: 0 }, data());
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    expect(other).toBeNull();
    expect(byKey.gym).toBeUndefined();
    expect(byKey.car).toBe(150 * 6); // Mar–Aug 2027 of the window Sep 2026–Aug 2027
    expect(byKey.groc).toBe(400 * 12 + 100);
    expect(byKey.fun).toBeUndefined(); // include: false
    // The undated plan would count both in full.
    const undated = Object.fromEntries(aggregateBudgetAllocation(data().envelopes, data().budgetItems, 0).map(r => [r.key, r.value]));
    expect(undated.gym).toBe(600);
    expect(undated.car).toBe(1800);
  });

  it('date moves the dated plan', () => {
    const page = pageReports(data(), { from: null, to: null }, {}, { topN: 12, sort: 'amount' }, [], viewTxsOf(data()), at(2026, 3, 1));
    const a = answer('plan.allocation', { date: '2026-03-01' }, data());
    expect(asPageRows(a)).toEqual(page.allocation);
    expect(a.rows.find(r => r.key === 'gym').value).toBe(50 * 4); // Mar–Jun 2026
  });

  it('the Other row folds past top', () => {
    const all = answer('plan.allocation', { top: 0 }, data()).rows;
    const a = answer('plan.allocation', { top: 4 }, data());
    expect(a.rows).toEqual(all.slice(0, 4));
    expect(a.other).toEqual({ count: all.length - 4, value: round2(all.slice(4).reduce((s, r) => s + r.value, 0)) });
  });

  it('an empty budget: no rows', () => {
    expect(answer('plan.allocation', {}, empty())).toEqual({ rows: [], other: null });
  });
});

// ── envelopes.history ──────────────────────────────────────────────────────

describe('envelopes.history', () => {
  const PICKS = [['no picks', []], ['two picks', ['groc', 'rent']], ['six picks', ['groc', 'rent', 'fun', 'car', 'gym', 'gift']]];
  for (const [lName, input, lens] of LENS_CASES) {
    for (const [eName, ex] of EXCLUSIONS.filter(([, e]) => !e.payees)) {
      for (const [pName, picks] of PICKS) {
        it(`${lName}, ${eName}, ${pName}: equals the page`, () => {
          const page = pageReports(data(), { from: null, to: null }, ex, { topN: 12, sort: 'amount' }, picks, viewTxsOf(data(), lens), NOW);
          const a = answer('envelopes.history', {
            ...input, ...(ex.envelopes ? { excludeEnvelopes: ex.envelopes } : {}), ...(picks.length ? { envelopes: picks } : {}),
          }, data());
          expect(a.months).toEqual(page.balanceHistory.months);
          expect(a.totals).toEqual(points(page.balanceHistory.totals));
          expect(a.byEnvelope).toEqual(picks.map(id => ({ id, points: points(page.pickedHistory.byId.get(id)) })));
          jsonSafe(a);
        });
      }
    }
  }

  it('twelve months ending with today\'s, and months / date move them', () => {
    const a = answer('envelopes.history', {}, data());
    expect(a.months[0]).toBe('2025-10');
    expect(a.months.at(-1)).toBe('2026-09');
    const b = answer('envelopes.history', { months: 3, date: '2026-06-30' }, data());
    expect(b.months).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(b.totals).toEqual(points(computeEnvelopeBalanceHistory(data().transactions, 3, at(2026, 6, 30)).totals));
  });

  it('refuses more than six envelopes; a repeated one counts once', () => {
    const seven = ['groc', 'rent', 'fun', 'car', 'gym', 'gift', 'rest'];
    const r = ask('envelopes.history', { envelopes: seven }, data());
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'bad_input', params: { errors: [{ path: 'envelopes' }] } });
    const dup = answer('envelopes.history', { envelopes: ['groc', 'groc', 'rent'] }, data());
    expect(dup.byEnvelope.map(e => e.id)).toEqual(['groc', 'rent']);
    expect(dup.byEnvelope).toEqual(answer('envelopes.history', { envelopes: ['groc', 'rent'] }, data()).byEnvelope);
  });

  it('an empty budget: twelve zero months', () => {
    const a = answer('envelopes.history', {}, empty());
    expect(a.months).toHaveLength(12);
    expect(a.totals.every(p => p.value === 0)).toBe(true);
    expect(a.byEnvelope).toEqual([]);
  });
});

// ── A stale exclusion ──────────────────────────────────────────────────────

describe('an excluded id no envelope has (a page filter older than a delete) is ignored', () => {
  const CASES = [
    ['reports.spending', { groupBy: 'envelope' }],
    ['reports.spending', { groupBy: 'payee' }],
    ['reports.spending', { groupBy: 'month' }],
    ['reports.cashflow', {}],
    ['reports.balances', {}],
    ['plan.allocation', {}],
    ['envelopes.history', { envelopes: ['groc'] }],
  ];
  for (const [name, input] of CASES) {
    it(`${name} ${JSON.stringify(input)}: the stale id changes nothing; with a real one beside it, only the real one counts`, () => {
      expect(answer(name, { ...input, excludeEnvelopes: ['deleted-long-ago'] }, data())).toEqual(answer(name, input, data()));
      expect(answer(name, { ...input, excludeEnvelopes: ['deleted-long-ago', 'rent'] }, data()))
        .toEqual(answer(name, { ...input, excludeEnvelopes: ['rent'] }, data()));
    });
  }

  it('the exclusion is real where the id exists', () => {
    const all = answer('reports.balances', { topN: 0 }, data()).rows.map(r => r.key);
    const less = answer('reports.balances', { topN: 0, excludeEnvelopes: ['deleted-long-ago', 'rent'] }, data()).rows.map(r => r.key);
    expect(all).toContain('rent');
    expect(less).toEqual(all.filter(k => k !== 'rent'));
  });
});
