// tests/core-query-dashboard-balances.test.js — the Dashboard's balance
// figures as queries: `balances.totals` (the hero), `netWorth.current`,
// `cash.position` and `cards.due`, plus the core helpers they stand on
// (lens-input, operational, portfolio).
//
// Each equivalence helper below copies the Dashboard's current formula from
// js/pages/dashboard.js verbatim, with `state` → the fixture, `viewTxs()` →
// the lens rows, `todayTxs()` → the Today lens rows and `now()` → the fixed
// clock, and the query must equal it (after round2 where the answer rounds).
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { LENS_INPUT, lensRows, isHorizon, refDate, monthOf, todayRows, MONTH_RE, badMonth } from '../js/core/lens-input.js';
import { operationalAccountIds, operationalAccounts, operationalTransactions } from '../js/core/operational.js';
import * as corePortfolio from '../js/core/portfolio.js';
import * as stateInvestments from '../js/state/investments.js';
import { lensTransactions } from '../js/engine/lens.js';
import {
  computeEnvelopeBalances, computeAccountBalances, computeAccountBalancesAtDates, computeUnallocated,
  identityAccountTotal, computeNetWorth, isSpendingAccount,
} from '../js/engine/balances.js';
import { computeCreditCardPaymentDue } from '../js/engine/insights.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 10, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

// A budget with every case the four figures treat differently:
//   - archived accounts: a spending one (oldchk, oldcard) and others (oldsav, oldinv)
//   - a scheduled row dated in the past (e3, 5 Oct) and a future posted row (e2, 20 Oct)
//   - an investment account with a priced holding (inv), and an archived one (oldinv)
//   - credit cards with posted and scheduled charges (visa), posted only (amex)
//   - a rent item on the 25th and a template fill on the 28th, forecast only
const data = (extra = {}) => deepFreeze({
  meta: { investments: { prices: { ABC: { price: 45.123, asOf: '2026-10-14' } } } },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 },
    { id: 'visa', name: 'Visa', type: 'credit_card', initialBalance: 0 },
    { id: 'amex', name: 'Amex', type: 'credit_card', initialBalance: 0 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
    { id: 'inv', name: 'Broker', type: 'investment', initialBalance: 0 },
    { id: 'house', name: 'House', type: 'asset', initialBalance: 150000 },
    { id: 'oldchk', name: 'Old checking', type: 'bank', initialBalance: 50, archived: true },
    { id: 'oldcard', name: 'Old card', type: 'credit_card', initialBalance: 0, archived: true },
    { id: 'oldsav', name: 'Old savings', type: 'savings', initialBalance: 77, archived: true },
    { id: 'oldinv', name: 'Old broker', type: 'investment', initialBalance: 0, archived: true },
  ],
  envelopes: [
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'gone', name: 'Gone', category: 'Misc', archived: true },
  ],
  budgetItems: [{
    id: 'rentItem', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
    default_amount: -100, payment_day: 25, schedule_day_type: 'exact', include: true,
    as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
  }],
  envelopeTemplates: [{
    id: 'tpl', name: 'Month end', kind: 'manual',
    lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }],
    schedule: { enabled: true, payment_day: 28, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS },
  }],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Pay', amount: 2000, account: 'chk', status: 'posted' },
    { id: 'i2', type: 'income', date: '2026-09-05', payee: 'Interest', amount: 50, account: 'sav', status: 'posted' },
    { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 300, lines: [{ envelope_id: 'groc', amount: 300 }], status: 'posted' },
    { id: 'f2', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 40, lines: [{ envelope_id: 'gone', amount: 40 }], status: 'posted' },
    { id: 'e1', type: 'expense', date: '2026-09-02', payee: 'A', amount: 100, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-10-20', payee: 'B', amount: 40, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'e3', type: 'expense', date: '2026-10-05', payee: 'C', amount: 10.5, account: 'chk', envelope_id: 'groc', status: 'scheduled' },
    { id: 'c1', type: 'expense', date: '2026-10-03', payee: 'Shop', amount: 60, account: 'visa', envelope_id: 'groc', status: 'posted' },
    { id: 'c2', type: 'expense', date: '2026-10-25', payee: 'Shop', amount: 15, account: 'visa', envelope_id: 'groc', status: 'scheduled' },
    { id: 'a1', type: 'expense', date: '2026-09-10', payee: 'Cafe', amount: 25.255, account: 'amex', envelope_id: 'groc', status: 'posted' },
    { id: 'o1', type: 'expense', date: '2026-07-10', payee: 'Old', amount: 20, account: 'oldchk', envelope_id: 'groc', status: 'posted' },
    { id: 'o2', type: 'expense', date: '2026-08-10', payee: 'Old', amount: 30, account: 'oldcard', envelope_id: 'groc', status: 'posted' },
    { id: 'b1', type: 'investment_transfer', direction: 'buy', date: '2026-08-15', payee: 'Broker', amount: 300, units: 7, symbol: 'ABC', from_account: 'chk', to_account: 'inv', status: 'posted' },
    { id: 'b2', type: 'investment_transfer', direction: 'buy', date: '2026-08-16', payee: 'Broker', amount: 100, units: 2, symbol: 'ABC', from_account: 'chk', to_account: 'oldinv', status: 'posted' },
  ],
  ...extra,
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

const LENS_CASES = [
  ['no lens (booked)', {}, { lens: 'booked' }],
  ['booked', { lens: 'booked' }, { lens: 'booked' }],
  ['today', { lens: 'today' }, { lens: 'today' }],
  ['forecast (default horizon)', { lens: 'forecast' }, { lens: 'forecast', horizon: '3m' }],
  ['forecast eom', { lens: 'forecast', horizon: 'eom' }, { lens: 'forecast', horizon: 'eom' }],
  ['forecast 6m', { lens: 'forecast', horizon: '6m' }, { lens: 'forecast', horizon: '6m' }],
];

// The page's `viewTxs()` / `todayTxs()` for a fixture and a lens.
const viewTxsOf = (d, opts) => lensTransactions(d, { lens: opts.lens, horizon: opts.horizon, today: NOW });
const todayTxsOf = (d) => lensTransactions(d, { lens: 'today', today: NOW });

// ── The page's formulas, copied from js/pages/dashboard.js ─────────────────

// buildHero (§2.1)
function pageHero(state, lensTxs) {
  const envBalances = computeEnvelopeBalances(lensTxs);
  const acctBalances = computeAccountBalances(state.accounts, lensTxs);
  const unallocated = computeUnallocated(acctBalances, envBalances, state.accounts);
  const isBalanced = Math.abs(unallocated) < 0.01;
  const envTotal = Array.from(envBalances.values()).reduce((s, v) => s + v, 0);
  const acctTotal = identityAccountTotal(acctBalances, state.accounts);
  const assignedPct = acctTotal > 0.01 ? Math.max(0, Math.min(100, Math.round((envTotal / acctTotal) * 100))) : (isBalanced ? 100 : 0);
  return { envTotal, acctTotal, assignedPct };
}

// buildKpiRow, net worth (§2.6), and investmentUnrealizedPL
function pageNetWorth(state, viewTxs, todayTxs) {
  const worth = computeNetWorth(state.accounts, viewTxs);
  const shown = (state.accounts || []).some(a => !a.archived);
  const notYet = worth.total - computeNetWorth(state.accounts, todayTxs).total;
  return { worth, shown, notYet };
}
function investmentUnrealizedPL(state) {
  const tracked = (state.accounts || []).filter(a => !a.archived);
  const sum = stateInvestments.portfolioSummary(state, tracked);
  return { pl: sum.unrealized, pct: sum.unrealizedPct, hasData: sum.priced > 0 };
}

// isOperationalAccount / operationalAccountIds / operationalAccounts /
// operationalTransactions, without the memo (§2.7)
function isOperationalAccount(a) {
  return isSpendingAccount(a);
}
function pageOperationalAccountIds(state) {
  const ids = new Set();
  for (const a of state.accounts || []) {
    if (isOperationalAccount(a)) ids.add(a.id);
  }
  return ids;
}
function pageOperationalAccounts(state) {
  return (state.accounts || []).filter(isOperationalAccount);
}
function pageOperationalTransactions(state) {
  const opIds = pageOperationalAccountIds(state);
  return (state.transactions || []).filter(tx => {
    if (tx.type === 'income' || tx.type === 'expense') {
      return opIds.has(tx.account);
    }
    return true;
  });
}

// buildKpiRow, spending accounts (§2.7), and recentBalanceSeries
function recentBalanceSeries(state, today) {
  const series = [];
  const opIds = pageOperationalAccountIds(state);
  const eoms = [];
  for (let i = 5; i >= 0; i--) eoms.push(new Date(today.getFullYear(), today.getMonth() - i + 1, 0));
  const balances = computeAccountBalancesAtDates(
    state.accounts, state.transactions, { onlyPosted: true, dates: eoms },
  );
  eoms.forEach((eom, k) => {
    let total = 0;
    for (const [id, v] of balances[k]) if (opIds.has(id)) total += v;
    series.push(total);
  });
  return { series, eoms };
}
function pageCashPosition(state, viewTxs, todayTxs, today) {
  const totalBalance = computeNetWorth(state.accounts, viewTxs).spending;
  const active = { ...state, accounts: state.accounts.filter(a => !a.archived) };
  const { series: sparkData, eoms } = recentBalanceSeries(active, today);
  const accountCount = pageOperationalAccounts(active).length;
  let delta = null;
  if (sparkData.length >= 2) {
    delta = sparkData[sparkData.length - 1] - sparkData[sparkData.length - 2];
  }
  const notYetCleared = totalBalance - computeNetWorth(state.accounts, todayTxs).spending;
  return { totalBalance, sparkData, eoms, accountCount, delta, notYetCleared };
}

// buildCreditCardsToPayCard (§2.9)
function pageCardsDue(state, viewTxs) {
  const dueMap = computeCreditCardPaymentDue(state.accounts || [], viewTxs);
  let totalDue = 0;
  const rows = [];
  for (const { account, paymentDue, postedDue } of dueMap.values()) {
    totalDue += paymentDue;
    rows.push({ account, paymentDue, postedDue });
  }
  return { rows, totalDue };
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

// ── Helpers ────────────────────────────────────────────────────────────────

describe('lens-input', () => {
  it('declares an optional lens and a horizon', () => {
    expect(Object.keys(LENS_INPUT)).toEqual(['lens', 'horizon']);
    expect(LENS_INPUT.lens.enum).toEqual(['today', 'booked', 'forecast']);
    expect(LENS_INPUT.horizon.type).toBe('string');
  });

  it('isHorizon takes a preset or a real date only', () => {
    for (const h of ['eom', '3m', '6m', '12m', '2026-12-15', '2028-02-29']) expect(isHorizon(h), h).toBe(true);
    for (const h of ['soon', '2026-02-30', '2026-13-01', '3M', '', undefined, 3]) expect(isHorizon(h), String(h)).toBe(false);
  });

  it('lensRows defaults to booked (the data\'s own array) and resolves a forecast horizon', () => {
    const d = data();
    const booked = lensRows(d, {}, ctxAt(NOW));
    expect(booked.ok).toBe(true);
    expect(booked.value.lens).toBe('booked');
    expect(booked.value.horizon).toBeNull();
    expect(booked.value.txs).toBe(d.transactions);
    expect(lensRows(d, { lens: 'forecast' }, ctxAt(NOW)).value.horizon).toBe('2027-01-31');
    expect(lensRows(d, { lens: 'forecast', horizon: 'eom' }, ctxAt(NOW)).value.horizon).toBe('2026-10-31');
    expect(lensRows(d, { lens: 'today' }, ctxAt(NOW)).value.txs).toBe(todayTxsOf(d));
  });

  it('lensRows refuses a horizon without forecast, and a bad horizon', () => {
    expect(lensRows(data(), { lens: 'booked', horizon: 'eom' }, ctxAt(NOW)).error)
      .toEqual({ code: 'bad_input', params: { errors: [{ path: 'horizon', message: 'only allowed with lens forecast' }] } });
    expect(lensRows(data(), { horizon: 'eom' }, ctxAt(NOW)).error.code).toBe('bad_input');
    expect(lensRows(data(), { lens: 'forecast', horizon: 'soon' }, ctxAt(NOW)).error)
      .toEqual({ code: 'bad_input', params: { errors: [{ path: 'horizon', message: 'must be one of: eom, 3m, 6m, 12m, or a real date (YYYY-MM-DD)' }] } });
  });

  it('refDate is local noon of the given day or of today; monthOf is its month', () => {
    const ctx = ctxAt(NOW);
    const today = refDate({}, ctx);
    expect([today.getFullYear(), today.getMonth(), today.getDate(), today.getHours()]).toEqual([2026, 9, 15, 12]);
    const given = refDate({ date: '2026-03-29' }, ctx);
    expect([given.getFullYear(), given.getMonth(), given.getDate(), given.getHours()]).toEqual([2026, 2, 29, 12]);
    expect(monthOf('2026-03-29')).toBe('2026-03');
  });

  it('todayRows is the Today lens at the context\'s clock', () => {
    const d = data();
    expect(todayRows(d, ctxAt(NOW))).toEqual(todayTxsOf(d));
  });

  it('MONTH_RE takes YYYY-MM only; badMonth is the bad_input on `month`', () => {
    for (const ok of ['2026-01', '2026-12']) expect(MONTH_RE.test(ok), ok).toBe(true);
    for (const bad of ['2026-00', '2026-13', '2026-1', '2026-10-01', '26-10']) expect(MONTH_RE.test(bad), bad).toBe(false);
    expect(badMonth()).toEqual({ ok: false, error: { code: 'bad_input', params: { errors: [{ path: 'month', message: 'must be a month, YYYY-MM' }] } } });
  });
});

describe('operational accounts and rows', () => {
  it('match the page\'s rules: spending accounts, archived included', () => {
    const d = data();
    expect([...operationalAccountIds(d.accounts)]).toEqual([...pageOperationalAccountIds(d)]);
    expect([...operationalAccountIds(d.accounts)]).toEqual(['chk', 'visa', 'amex', 'oldchk', 'oldcard']);
    expect(operationalAccounts(d.accounts)).toEqual(pageOperationalAccounts(d));
    expect(operationalTransactions(d.accounts, d.transactions)).toEqual(pageOperationalTransactions(d));
    // The savings interest is dropped; transfers and fills are kept.
    expect(operationalTransactions(d.accounts, d.transactions).map(t => t.id)).not.toContain('i2');
    expect(operationalTransactions(d.accounts, d.transactions).map(t => t.id)).toEqual(expect.arrayContaining(['f1', 'b1', 'b2']));
  });

  it('memoise on array identity', () => {
    const d = data();
    expect(operationalAccountIds(d.accounts)).toBe(operationalAccountIds(d.accounts));
    expect(operationalAccounts(d.accounts)).toBe(operationalAccounts(d.accounts));
    expect(operationalTransactions(d.accounts, d.transactions)).toBe(operationalTransactions(d.accounts, d.transactions));
    const other = data();
    expect(operationalAccounts(other.accounts)).not.toBe(operationalAccounts(d.accounts));
  });

  it('read a missing list as empty', () => {
    expect(operationalAccountIds(undefined).size).toBe(0);
    expect(operationalAccounts(null)).toEqual([]);
    expect(operationalTransactions(undefined, undefined)).toEqual([]);
  });
});

describe('portfolio helpers', () => {
  it('js/state/investments.js re-exports the core functions', () => {
    for (const name of ['trackedInvestmentAccounts', 'trackedHoldings', 'portfolioByAccount', 'portfolioSummary']) {
      expect(stateInvestments[name], name).toBe(corePortfolio[name]);
    }
  });

  it('value the tracked holdings of the accounts given', () => {
    const d = data();
    const all = corePortfolio.portfolioSummary(d);
    const active = corePortfolio.portfolioSummary(d, d.accounts.filter(a => !a.archived));
    expect(all.cost).toBe(400);
    expect(active.cost).toBe(300);
    expect([...corePortfolio.portfolioByAccount(d).keys()]).toEqual(['inv', 'oldinv']);
  });
});

// ── balances.totals ────────────────────────────────────────────────────────

describe('balances totals (the hero)', () => {
  for (const [label, input, opts] of LENS_CASES.filter(c => c[1].lens)) {
    it(`${label} equals the hero's formula`, () => {
      const d = data();
      const r = ask('balances', input, d);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      const hero = pageHero(d, viewTxsOf(d, opts));
      expect(r.value.totals).toEqual({ envelopes: round2(hero.envTotal), accounts: round2(hero.acctTotal), assignedPct: hero.assignedPct });
    });
  }

  it('counts archived envelopes in the envelope total', () => {
    const t = ask('balances', { lens: 'booked' }, data()).value.totals;
    // groc 300 - 100 - 40 - 10.5 - 60 - 15 - 25.255 - 20 - 30, plus gone 40.
    expect(t.envelopes).toBe(round2(300 - 100 - 40 - 10.5 - 60 - 15 - 25.255 - 20 - 30 + 40));
  });

  it('an empty budget is fully assigned', () => {
    expect(ask('balances', { lens: 'booked' }, empty()).value.totals).toEqual({ envelopes: 0, accounts: 0, assignedPct: 100 });
  });
});

// ── netWorth.current ───────────────────────────────────────────────────────

describe('netWorth.current', () => {
  const PARTS = ['spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts', 'other'];

  for (const [label, input, opts] of LENS_CASES) {
    it(`${label} equals the page's net worth KPI`, () => {
      const d = data();
      const r = ask('netWorth.current', input, d);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      const page = pageNetWorth(d, viewTxsOf(d, opts), todayTxsOf(d));
      const pl = investmentUnrealizedPL(d);
      const a = r.value;
      expect(a.lens).toBe(opts.lens);
      expect(a.total).toBe(round2(page.worth.total));
      expect(Object.keys(a.parts)).toEqual(PARTS);
      for (const k of PARTS) expect(a.parts[k], k).toBe(round2(page.worth[k]));
      expect(a.notYetCleared).toBe(round2(page.notYet));
      expect(a.hasActiveAccounts).toBe(page.shown);
      expect(a.unrealized).toEqual({ pl: round2(pl.pl), pct: round2(pl.pct), hasData: pl.hasData });
    });
  }

  it('reads the fixture as expected: archived accounts out, the unrealized gain of the active holding', () => {
    const a = ask('netWorth.current', {}, data()).value;
    expect(a.horizon).toBeNull();
    expect(a.parts.savings).toBe(550);          // oldsav left out
    expect(a.parts.assets).toBe(150000);
    // 7 units at 45.123 = 315.861 against a cost of 300; the archived broker is not counted.
    expect(a.unrealized).toEqual({ pl: 15.86, pct: 5.29, hasData: true });
    // Booked has e2 (future) and e3, c2 (scheduled) that Today does not.
    expect(a.notYetCleared).toBe(round2(-(40 + 10.5 + 15)));
    expect(ask('netWorth.current', { lens: 'today' }, data()).value.notYetCleared).toBe(0);
  });

  it('an empty budget has no active accounts and no P/L', () => {
    const a = ask('netWorth.current', {}, empty()).value;
    expect(a).toMatchObject({ total: 0, notYetCleared: 0, hasActiveAccounts: false, unrealized: { pl: 0, pct: 0, hasData: false } });
  });
});

// ── cash.position ──────────────────────────────────────────────────────────

describe('cash.position', () => {
  for (const [label, input, opts] of LENS_CASES) {
    it(`${label} equals the page's spending accounts KPI`, () => {
      const d = data();
      const r = ask('cash.position', input, d);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      const page = pageCashPosition(d, viewTxsOf(d, opts), todayTxsOf(d), NOW);
      const a = r.value;
      expect(a.lens).toBe(opts.lens);
      expect(a.balance).toBe(round2(page.totalBalance));
      expect(a.notYetCleared).toBe(round2(page.notYetCleared));
      expect(a.accountCount).toBe(page.accountCount);
      expect(a.series).toEqual(page.eoms.map((eom, k) => ({ date: iso(eom), balance: round2(page.sparkData[k]) })));
      expect(a.delta).toBe(round2(page.delta));
    });
  }

  it('uses active accounts for the headline, series and count', () => {
    const a = ask('cash.position', {}, data()).value;
    expect(a.accountCount).toBe(3);
    expect(a.series.map(p => p.date)).toEqual(['2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31']);
    // Posted rows on active accounts only, including the posted 20 Oct row.
    expect(a.series[0].balance).toBe(1000);
    expect(a.series[2].balance).toBe(1000);
    const last = 1000 + 2000 - 300 - 100 - 100 - 25.255 - 40 - 60;
    expect(a.series[5].balance).toBe(round2(last));
    expect(a.delta).toBe(round2(-40 - 60));
  });

  it('counts a posted row dated on a month\'s last day in that month\'s point', () => {
    const base = data();
    const d = data({ transactions: [
      ...base.transactions,
      { id: 'm1', type: 'expense', date: '2026-09-30', payee: 'End', amount: 7, account: 'chk', envelope_id: 'groc', status: 'posted' },
      { id: 'm2', type: 'expense', date: '2026-10-31', payee: 'End', amount: 3, account: 'chk', envelope_id: 'groc', status: 'posted' },
    ] });
    const before = ask('cash.position', {}, base).value;
    const a = ask('cash.position', {}, d).value;
    expect(a.series[4].balance).toBe(round2(before.series[4].balance - 7));
    expect(a.series[5].balance).toBe(round2(before.series[5].balance - 10));
    const page = pageCashPosition(d, viewTxsOf(d, { lens: 'booked' }), todayTxsOf(d), NOW);
    expect(a.series).toEqual(page.eoms.map((eom, k) => ({ date: iso(eom), balance: round2(page.sparkData[k]) })));
    expect(a.delta).toBe(round2(page.delta));
  });

  it('takes the number of months and the date the series ends on', () => {
    const a = ask('cash.position', { months: 3, date: '2026-08-10' }, data()).value;
    expect(a.series.map(p => p.date)).toEqual(['2026-06-30', '2026-07-31', '2026-08-31']);
    const one = ask('cash.position', { months: 1 }, data()).value;
    expect(one.series.map(p => p.date)).toEqual(['2026-10-31']);
    expect(one.delta).toBeNull();
  });

  it('refuses months out of range', () => {
    for (const months of [0, 25, 1.5]) {
      const r = ask('cash.position', { months }, data());
      expect(r.ok, String(months)).toBe(false);
      expect(r.error.code).toBe('bad_input');
    }
  });

  it('an empty budget is zero throughout', () => {
    const a = ask('cash.position', {}, empty()).value;
    expect(a).toMatchObject({ balance: 0, notYetCleared: 0, accountCount: 0, delta: 0 });
    expect(a.series).toHaveLength(6);
    expect(a.series.every(p => p.balance === 0)).toBe(true);
  });
});

// ── cards.due ──────────────────────────────────────────────────────────────

describe('cards.due', () => {
  for (const [label, input, opts] of LENS_CASES) {
    it(`${label} equals the page's cards card`, () => {
      const d = data();
      const r = ask('cards.due', input, d);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      const page = pageCardsDue(d, viewTxsOf(d, opts));
      const a = r.value;
      expect(a.lens).toBe(opts.lens);
      expect(a.cards).toEqual(page.rows.map(({ account, paymentDue, postedDue }) => ({ account: account.id, name: account.name, paymentDue, postedDue })));
      expect(a.total).toBe(round2(page.totalDue));
    });
  }

  it('the posted and the scheduled charge, the archived card left out', () => {
    const a = ask('cards.due', {}, data()).value;
    expect(a.cards).toEqual([
      { account: 'visa', name: 'Visa', paymentDue: 75, postedDue: 60 },
      // The engine keeps the balance in whole cents: 25.255 is 2525 of them.
      { account: 'amex', name: 'Amex', paymentDue: 25.25, postedDue: 25.25 },
    ]);
    expect(a.total).toBe(100.25);
    expect(ask('cards.due', { lens: 'today' }, data()).value.cards[0]).toEqual({ account: 'visa', name: 'Visa', paymentDue: 60, postedDue: 60 });
  });

  it('an empty budget has no cards', () => {
    expect(ask('cards.due', {}, empty()).value).toEqual({ lens: 'booked', horizon: null, cards: [], total: 0 });
  });
});

// ── Shared contract ────────────────────────────────────────────────────────

describe('the new queries share the lens contract', () => {
  const NAMES = ['netWorth.current', 'cash.position', 'cards.due'];

  for (const name of NAMES) {
    it(`${name}: no lens means booked, and forecast resolves its horizon`, () => {
      const booked = ask(name, {}, data()).value;
      expect(booked.lens).toBe('booked');
      expect(booked.horizon).toBeNull();
      expect(ask(name, { lens: 'forecast', horizon: 'eom' }, data()).value.horizon).toBe('2026-10-31');
    });

    it(`${name}: refuses a horizon without forecast, a bad horizon and an unknown lens`, () => {
      for (const input of [{ horizon: 'eom' }, { lens: 'today', horizon: 'eom' }]) {
        expect(ask(name, input, data()).error)
          .toEqual({ code: 'bad_input', params: { errors: [{ path: 'horizon', message: 'only allowed with lens forecast' }] } });
      }
      expect(ask(name, { lens: 'forecast', horizon: '2026-02-30' }, data()).error.code).toBe('bad_input');
      expect(ask(name, { lens: 'nope' }, data()).error.code).toBe('bad_input');
    });

    it(`${name}: answers JSON-safe without mutating the frozen data`, () => {
      const d = data();
      const before = JSON.stringify(d);
      for (const input of [{}, { lens: 'today' }, { lens: 'forecast', horizon: '6m' }]) {
        const r = ask(name, input, d);
        expect(r.ok).toBe(true);
        jsonSafe(r.value);
      }
      expect(JSON.stringify(d)).toBe(before);
    });
  }

  it('balances keeps its answer and gains totals only', () => {
    const d = data();
    const a = ask('balances', { lens: 'forecast', horizon: 'eom', includeArchived: true }, d).value;
    expect(Object.keys(a)).toEqual(['lens', 'horizon', 'accounts', 'envelopes', 'unallocated', 'totals']);
    jsonSafe(a);
  });
});
