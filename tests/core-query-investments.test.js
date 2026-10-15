// tests/core-query-investments.test.js — the Investments page's figures as
// queries: `investments.holdings` (the holdings, their totals, the allocation
// and invested-over-time cards and each account's gap) and `investments.tax`
// (the realised-gains card).
//
// `pageInvestments` copies the page's composition from js/pages/investments.js
// verbatim (render L82-100 and L110-128, the allocation aggregation L325-357,
// the invested-over-time walk L373-411, the per-account rows and balance
// L185-192 and the account card's value and gap L439-450), with `state` → the
// fixture, `viewTxs()` → the lens rows, `appNow()` → the fixed clock and
// `showZeroBalance` → a parameter. Its helpers (`isZeroBalance`,
// `trackedInvestmentAccounts` from investments-shared.js) are copied too.
// `pageTax` copies js/pages/investments-tax.js L27-31 and L40-49, plus the
// cost cell's sum (L136). Every query answer must equal the copy.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { lensTransactions } from '../js/engine/lens.js';
import {
  listHoldings, computeAccountBalances, holdingValue, holdingPrice, holdingMarkPrice, summarizeHoldings,
  txAbsAmount, computeRealizedSales, summarizeTaxYear,
} from '../js/engine.js';
import { getInvestmentsMeta } from '../js/core/investments-meta.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};

// ── The page's composition, copied from js/pages/investments.js ────────────

// copied: js/pages/investments-shared.js
function trackedInvestmentAccounts(accounts) {
  return (accounts || []).filter(a =>
    a && a.type === 'investment' && !a.archived && a.trackInvestments !== false,
  );
}
// copied: js/pages/investments.js L46-53
function holdingValueForDisplay(h, prices) {
  return holdingValue(h, prices);
}
function isZeroBalance(h, prices) {
  return Math.abs(holdingValueForDisplay(h, prices)) < 0.005
    && Math.abs(h.units) < 1e-6;
}

/**
 * @param {any} state
 * @param {any[]} lensRows  viewTxs()
 * @param {boolean} showZeroBalance
 * @param {Date} nowDate  appNow()
 */
function pageInvestments(state, lensRows, showZeroBalance, nowDate) {
  const viewTxs = () => lensRows;
  const appNow = () => nowDate;
  // ── copied: render L82-100 ──
  const accounts = trackedInvestmentAccounts(state.accounts);
  const accountById = new Map(accounts.map(a => [a.id, a]));
  const inv = getInvestmentsMeta(state.meta);
  const allHoldings = listHoldings(state.transactions || [], inv.holdingOverrides, inv.manualRows)
    .filter(h => accountById.has(h.accountId));
  const totals = summarizeHoldings(allHoldings, inv.prices);
  const totalCost = totals.cost;
  const totalValue = totals.valuePriced;
  const priceMissing = totals.missingPrice;
  const unrealized = totals.unrealized;
  const unrealizedPct = totals.unrealizedPct;
  // ── copied: L110 and L128 ──
  const activeHoldings = allHoldings.filter(h => !isZeroBalance(h, inv.prices));
  const zeroCount = allHoldings.filter(h => isZeroBalance(h, inv.prices)).length;

  // ── copied: buildAllocationCard(allHoldings, inv.prices), L325-357 ──
  const allocation = (holdings, prices) => {
    const bySymbol = new Map();
    for (const h of holdings) {
      const price = holdingPrice(h, prices);
      if (price === null) continue;
      const v = h.units * price;
      if (v <= 0) continue;
      const cur = bySymbol.get(h.symbol) || { value: 0, label: h.symbol, symbol: h.symbol };
      cur.value += v;
      if (h.name && cur.label === cur.symbol) cur.label = h.name;
      bySymbol.set(h.symbol, cur);
    }
    if (bySymbol.size === 0) return [];
    return [...bySymbol.values()]
      .sort((x, y) => y.value - x.value)
      .map((entry) => ({
        key: entry.symbol,
        label: entry.label === entry.symbol ? entry.symbol : `${entry.label} (${entry.symbol})`,
        value: entry.value,
      }));
  };

  // ── copied: buildInvestedSparklineCard(state.transactions || []), L373-411 ──
  const invested = (transactions) => {
    const buckets = new Map(); // 'YYYY-MM' → cumulative net invested
    const ordered = (transactions || [])
      .filter(tx => tx?.type === 'investment_transfer' && tx.direction !== 'dividend')
      .slice()
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    let running = 0;
    for (const tx of ordered) {
      const cash = txAbsAmount(tx);
      if (tx.direction === 'sell') running -= cash;
      else running += cash;
      const key = (tx.date || '').slice(0, 7);
      if (key) buckets.set(key, running);
    }
    if (buckets.size === 0) return [];
    const now = appNow();
    const firstKey = [...buckets.keys()].sort()[0];
    const x = [];
    const values = [];
    let lastKnown = 0;
    for (let d = new Date(Number(firstKey.slice(0, 4)), Number(firstKey.slice(5, 7)) - 1, 1);
      d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (buckets.has(key)) lastKnown = buckets.get(key);
      x.push({ key });
      values.push(Math.max(0, lastKnown));
    }
    return x.map((p, i) => ({ month: p.key, value: values[i] }));
  };

  // ── copied: L185-192, then buildAccountCard's value and gap, L439-450 ──
  const perAccount = [];
  const accountBalances = computeAccountBalances(state.accounts, viewTxs());
  for (const acc of accounts) {
    const rows = allHoldings
      .filter(h => h.accountId === acc.id)
      .filter(h => showZeroBalance || !isZeroBalance(h, inv.prices));
    const balance = accountBalances.get(acc.id) || 0;
    const prices = inv.prices;
    const accountBalance = balance;
    let acctValue = 0;
    for (const h of rows) acctValue += holdingValue(h, prices);
    const gap = accountBalance - acctValue;
    perAccount.push({ id: acc.id, rows, balance, acctValue, gap });
  }

  return {
    allHoldings, prices: inv.prices, totalCost, totalValue, priceMissing, unrealized, unrealizedPct, totals,
    activeHoldings, zeroCount, allocation: allocation(allHoldings, inv.prices),
    invested: invested(state.transactions || []), perAccount,
  };
}

// ── copied: js/pages/investments-tax.js ────────────────────────────────────

function taxExemptAccountIds(accounts) {
  return new Set((accounts || [])
    .filter(a => a && (a.pensionInsurance === true || a.taxWrapped === true))
    .map(a => a.id));
}

function pageTax(state, pickedYear) {
  // ── copied: L40-49 ──
  const inv = getInvestmentsMeta(state.meta);
  const sales = computeRealizedSales(state.transactions || [], {
    manualRows: inv.manualRows,
    excludeAccountIds: taxExemptAccountIds(state.accounts),
  });
  if (!sales.length) return null;

  const newest = Number(sales[sales.length - 1].date.slice(0, 4));
  const allYears = summarizeTaxYear(sales, newest).years;
  const year = pickedYear !== null && allYears.includes(pickedYear) ? pickedYear : newest;
  const summary = summarizeTaxYear(sales, year);
  // ── end copy ──
  return { allYears, year, summary };
}

// ── Fixture ────────────────────────────────────────────────────────────────

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const trade = (id, direction, date, acct, symbol, units, amount, extra = {}) => ({
  id, type: 'investment_transfer', direction, date, symbol, units, amount, payee: 'Broker', status: 'posted',
  ...(direction === 'buy' ? { from_account: 'chk', to_account: acct } : { from_account: acct, to_account: 'chk' }),
  ...extra,
});
const buy = (id, date, acct, symbol, units, amount, extra) => trade(id, 'buy', date, acct, symbol, units, amount, extra);
const sell = (id, date, acct, symbol, units, amount, extra) => trade(id, 'sell', date, acct, symbol, units, amount, extra);

// The tracked account brk holds every case a figure treats differently:
//   VWCE  bought twice, partly sold, a dividend, priced
//   AAPL  no price on record (valued at cost; counts as missing a price)
//   ZZZ   bought and sold out: a zero holding, priced
//   NOU   a buy entered without units: has a price but cannot be marked
//   OVR   an override with no ledger history, named, priced
//   WATCH a zero-unit override (a watchlist entry): zero
//   MAN   a manual buy row, priced
//   BIG   a second account's VWCE-like symbol to sum allocation across accounts
// Elsewhere: isk (tax-wrapped, tracked), old (archived), untr (not tracked),
// all with holdings and sales; a scheduled buy after today (the lens moves
// brk's balance) and a planned monthly buy the forecast lens generates.
const META = {
  investments: {
    prices: {
      VWCE: { price: 120, asOf: '2026-09-14' }, ZZZ: { price: 10 }, NOU: { price: 50 }, OVR: { price: 40 },
      MAN: { price: 55 }, BIG: { price: 7.5 }, ISK1: { price: 30 }, OLD1: { price: 3 }, UNT1: { price: 9 },
    },
    holdingOverrides: {
      brk: { OVR: { units: 3, costBasis: 90, name: 'Overridden fund' }, WATCH: { units: 0, costBasis: 0, name: 'Watchlist' } },
    },
    manualRows: {
      brk: { MAN: [{ id: 'm1', date: '2026-03-03', direction: 'buy', units: 4, amount: 200 }] },
      old: { OLD1: [{ id: 'm2', date: '2025-02-02', direction: 'sell', units: 2, amount: 10 }] },
    },
  },
};
const data = (extra = {}) => deepFreeze({
  meta: META,
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 50000 },
    { id: 'brk', name: 'Broker', type: 'investment', initialBalance: 0 },
    { id: 'isk', name: 'Equity savings', type: 'investment', initialBalance: 0, taxWrapped: true },
    { id: 'old', name: 'Old broker', type: 'investment', initialBalance: 0, archived: true },
    { id: 'untr', name: 'Untracked', type: 'investment', initialBalance: 0, trackInvestments: false },
    { id: 'pen', name: 'Pension', type: 'investment', initialBalance: 0, pensionInsurance: true },
  ],
  envelopes: [{ id: 'inv', name: 'Investing', category: 'Saving' }],
  budgetItems: [
    { id: 'monthlyBuy', kind: 'investment_transfer', direction: 'buy', description: 'Monthly VWCE', default_amount: -250,
      account_id: 'chk', investment_account_id: 'brk', envelope_id: 'inv', payment_day: 20, schedule_day_type: 'exact',
      include: true, as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: ALL_MONTHS },
  ],
  envelopeTemplates: [],
  transactions: [
    buy('b1', '2024-11-04', 'brk', 'VWCE', 10, 1000),
    buy('b2', '2025-08-15', 'brk', 'VWCE', 5, 600),
    sell('s1', '2026-09-01', 'brk', 'VWCE', 3, 395, { fee: 5 }),
    trade('d1', 'dividend', '2026-06-30', 'brk', 'VWCE', 0, 42.5),
    buy('b3', '2025-08-20', 'brk', 'AAPL', 2, 300),
    buy('b4', '2025-01-10', 'brk', 'ZZZ', 4, 80),
    sell('s2', '2025-03-10', 'brk', 'ZZZ', 4, 60),
    buy('b5', '2026-02-02', 'brk', 'NOU', null, 100),
    buy('b6', '2026-04-04', 'brk', 'BIG', 100, 700.33),
    buy('b7', '2026-04-04', 'isk', 'BIG', 40, 280),
    buy('b8', '2025-05-05', 'isk', 'ISK1', 20, 500),
    sell('s3', '2026-05-05', 'isk', 'ISK1', 10, 400),
    buy('b9', '2024-06-06', 'old', 'OLD1', 50, 100),
    sell('s4', '2024-12-12', 'old', 'OLD1', 20, 1500),
    buy('b10', '2025-07-07', 'untr', 'UNT1', 10, 70),
    sell('s5', '2026-01-20', 'untr', 'UNT1', 12, 140),
    buy('b11', '2025-07-07', 'pen', 'PEN1', 10, 1000),
    sell('s6', '2026-01-21', 'pen', 'PEN1', 5, 700),
    buy('b12', '2026-10-01', 'brk', 'VWCE', 1, 125, { status: 'scheduled' }),
  ],
  ...extra,
});
const empty = () => deepFreeze({ meta: {}, accounts: [], envelopes: [], budgetItems: [], envelopeTemplates: [], transactions: [] });

const viewTxsOf = (d, lens = { lens: 'booked' }, now = NOW) => lensTransactions(d, { lens: lens.lens, horizon: lens.horizon, today: now });

/**
 * The query's answer, as the page's copy would build it. The holding rows are
 * row display, built here with the same engine helpers the query uses, so
 * their per-row fields are pinned by literal values in their own test below.
 */
function expected(d, lens, includeZero, now = NOW) {
  const p = pageInvestments(d, viewTxsOf(d, lens, now), includeZero, now);
  const shown = includeZero ? p.allHoldings : p.activeHoldings;
  return {
    holdings: shown.map(h => ({
      accountId: h.accountId, symbol: h.symbol, name: h.name ?? null, units: h.units,
      costBasis: round2(h.costBasis), realized: round2(h.realized ?? 0), distributions: round2(h.distributions ?? 0),
      oversoldUnits: h.oversoldUnits ?? 0, overridden: !!h.overridden,
      price: holdingPrice(h, p.prices), markPrice: holdingMarkPrice(h, p.prices), zero: isZeroBalance(h, p.prices),
    })),
    totals: {
      cost: round2(p.totalCost), costPriced: round2(p.totals.costPriced), value: round2(p.totals.value),
      valuePriced: round2(p.totalValue), unrealized: round2(p.unrealized), unrealizedPct: round2(p.unrealizedPct),
      priced: p.totals.priced, missingPrice: p.priceMissing,
      activeCount: p.activeHoldings.length, zeroCount: p.zeroCount,
    },
    allocation: p.allocation.map(a => ({ symbol: a.key, label: a.label, value: round2(a.value) })),
    accounts: p.perAccount.map(a => ({ id: a.id, balance: round2(a.balance), value: round2(a.acctValue), gap: round2(a.gap) })),
    invested: p.invested.map(v => ({ month: v.month, value: round2(v.value) })),
  };
}

// ── investments.holdings ─────────────────────────────────────────────────────

describe('investments.holdings ≡ the Investments page', () => {
  const LENSES = [
    ['booked (default)', {}, { lens: 'booked' }],
    ['today', { lens: 'today' }, { lens: 'today' }],
    ['forecast (default horizon)', { lens: 'forecast' }, { lens: 'forecast', horizon: '3m' }],
    ['forecast 12m', { lens: 'forecast', horizon: '12m' }, { lens: 'forecast', horizon: '12m' }],
  ];
  for (const [name, input, lens] of LENSES) {
    for (const includeZero of [false, true]) {
      it(`${name}, ${includeZero ? 'with' : 'without'} the zero holdings`, () => {
        const d = data();
        const got = answer('investments.holdings', { ...input, ...(includeZero ? { includeZero } : {}) }, d);
        const { lens: l, horizon, ...rest } = got;
        expect(l).toBe(lens.lens);
        expect(horizon === null).toBe(lens.lens !== 'forecast');
        expect(rest).toEqual(expected(d, lens, includeZero));
        jsonSafe(got);
      });
    }
  }

  it('reads the tracked, unarchived investment accounts only', () => {
    const got = answer('investments.holdings', { includeZero: true }, data());
    expect([...new Set(got.holdings.map(h => h.accountId))]).toEqual(['brk', 'isk', 'pen']);
    expect(got.accounts.map(a => a.id)).toEqual(['brk', 'isk', 'pen']);
  });

  it('the cases: unpriced, unit-less, override, watchlist zero, manual row, dividend, a sell', () => {
    const got = answer('investments.holdings', { includeZero: true }, data());
    const h = (sym) => got.holdings.find(x => x.accountId === 'brk' && x.symbol === sym);
    expect(h('AAPL')).toMatchObject({ price: null, markPrice: null, zero: false, costBasis: 300 });
    expect(h('NOU')).toMatchObject({ units: 0, price: 50, markPrice: null, zero: false, costBasis: 100 });
    expect(h('OVR')).toMatchObject({ units: 3, costBasis: 90, name: 'Overridden fund', overridden: true, markPrice: 40 });
    expect(h('WATCH')).toMatchObject({ units: 0, costBasis: 0, name: 'Watchlist', overridden: true, zero: true });
    expect(h('ZZZ')).toMatchObject({ units: 0, costBasis: 0, realized: -20, zero: true });
    expect(h('MAN')).toMatchObject({ units: 4, costBasis: 200 });
    // The stored rows, so the scheduled buy after today counts (12 + 1 units, 1280 + 125).
    expect(h('VWCE')).toMatchObject({ units: 13, costBasis: 1405, realized: 75, distributions: 42.5 });
    // brk 6 active + isk 2 + pen 1; AAPL and PEN1 lack a price (NOU has no units to price).
    expect(got.totals).toMatchObject({ activeCount: 9, zeroCount: 2, missingPrice: 2 });
    const hidden = answer('investments.holdings', {}, data());
    expect(hidden.holdings.some(x => x.zero)).toBe(false);
    expect(hidden.holdings).toHaveLength(got.holdings.length - 2);
  });

  it('pins every field of the broker\'s holding rows (literal values, not the helpers the query calls)', () => {
    const row = (symbol, fields) => ({
      accountId: 'brk', symbol, name: null, realized: 0, distributions: 0, oversoldUnits: 0, overridden: false, zero: false, ...fields,
    });
    const got = answer('investments.holdings', { includeZero: true }, data());
    expect(got.holdings.filter(h => h.accountId === 'brk')).toEqual([
      // No price on record: neither a price nor a mark.
      row('AAPL', { units: 2, costBasis: 300, price: null, markPrice: null }),
      row('BIG', { units: 100, costBasis: 700.33, price: 7.5, markPrice: 7.5 }),
      row('MAN', { units: 4, costBasis: 200, price: 55, markPrice: 55 }),
      // A price but no units: nothing to mark.
      row('NOU', { units: 0, costBasis: 100, price: 50, markPrice: null }),
      row('OVR', { name: 'Overridden fund', units: 3, costBasis: 90, overridden: true, price: 40, markPrice: 40 }),
      // 10 + 5 − 3 + the scheduled 1; cost 1600 less the 320 sold, plus 125.
      row('VWCE', { units: 13, costBasis: 1405, realized: 75, distributions: 42.5, price: 120, markPrice: 120 }),
      row('WATCH', { name: 'Watchlist', units: 0, costBasis: 0, overridden: true, price: null, markPrice: null, zero: true }),
      // Sold out: priced, nothing to mark, zero.
      row('ZZZ', { units: 0, costBasis: 0, realized: -20, price: 10, markPrice: null, zero: true }),
    ]);
  });

  it('the allocation sums a symbol across accounts, names it, and skips unpriced and unit-less holdings', () => {
    const got = answer('investments.holdings', {}, data());
    expect(got.allocation.map(a => a.symbol)).toEqual(['VWCE', 'BIG', 'ISK1', 'MAN', 'OVR']);
    expect(got.allocation.find(a => a.symbol === 'OVR').label).toBe('Overridden fund (OVR)');
    expect(got.allocation.find(a => a.symbol === 'BIG').value).toBe(1050);
  });

  it('the gap follows the lens; the holdings do not', () => {
    const booked = answer('investments.holdings', { lens: 'booked' }, data());
    const today = answer('investments.holdings', { lens: 'today' }, data());
    const brk = (a) => a.accounts.find(x => x.id === 'brk');
    expect(booked.holdings).toEqual(today.holdings);
    expect(brk(booked).balance).toBe(round2(brk(today).balance + 125));
    expect(brk(booked).gap).toBe(round2(brk(booked).balance - brk(booked).value));
  });

  it('the invested series runs from the first investment\'s month to today\'s', () => {
    const got = answer('investments.holdings', {}, data());
    expect(got.invested[0].month).toBe('2024-06');
    expect(got.invested.at(-1).month).toBe('2026-09');
    expect(got.invested.every(p => p.value >= 0)).toBe(true);
  });

  it('no tracked account, or no investments: empty figures', () => {
    expect(answer('investments.holdings', {}, empty())).toEqual({
      lens: 'booked', horizon: null, holdings: [],
      totals: { cost: 0, costPriced: 0, value: 0, valuePriced: 0, unrealized: 0, unrealizedPct: 0, priced: 0, missingPrice: 0, activeCount: 0, zeroCount: 0 },
      allocation: [], accounts: [], invested: [],
    });
  });

  it('refuses a horizon without the forecast lens', () => {
    expect(ask('investments.holdings', { horizon: '3m' }, data()).error.code).toBe('bad_input');
  });
});

// ── investments.tax ──────────────────────────────────────────────────────────

/** The query's answer, as the tax card's copy would build it. */
function expectedTax(d, pickedYear) {
  const p = pageTax(d, pickedYear);
  if (!p) return null;
  const s = p.summary;
  return {
    years: p.allYears, year: p.year,
    totals: { grossProceeds: s.grossProceeds, purchaseCost: s.purchaseCost, deductedCost: s.deductedCost, gains: s.gains, losses: s.losses, net: s.net },
    gainsExempt: s.gainsExempt, lossesDeductible: s.lossesDeductible, salesWithoutCost: s.salesWithoutCost,
    sales: s.sales.map(x => ({
      id: x.id, date: x.date, symbol: x.symbol, accountId: x.accountId, units: x.units,
      grossProceeds: x.grossProceeds, acquisitionCost: x.acquisitionCost, fee: x.fee,
      cost: round2(x.acquisitionCost + x.fee), // copied: L136, the cost cell
      actualGain: x.actualGain, deemedGain: x.deemedGain, taxableGain: x.taxableGain, method: x.method,
    })),
  };
}

describe('investments.tax ≡ the tax card', () => {
  for (const year of [undefined, 2026, 2025, 2024, 2019]) {
    it(`year ${year ?? '(newest)'}`, () => {
      const d = data();
      const got = answer('investments.tax', year === undefined ? {} : { year }, d);
      expect(got).toEqual(expectedTax(d, year ?? null));
      jsonSafe(got);
    });
  }

  it('a picked year not in the list reads the newest', () => {
    expect(answer('investments.tax', { year: 2019 }, data())).toEqual(answer('investments.tax', {}, data()));
    expect(answer('investments.tax', {}, data()).year).toBe(2026);
    expect(answer('investments.tax', {}, data()).years).toEqual([2026, 2025, 2024]);
  });

  it('leaves out tax-wrapped and pension accounts, keeps an archived one and an untracked one', () => {
    const accounts = new Set();
    for (const year of [2026, 2025, 2024]) for (const s of answer('investments.tax', { year }, data()).sales) accounts.add(s.accountId);
    expect([...accounts].sort()).toEqual(['brk', 'old', 'untr']);
  });

  it('the totals foot: grossProceeds − deductedCost = net, every year', () => {
    for (const year of [2026, 2025, 2024]) {
      const { totals } = answer('investments.tax', { year }, data());
      expect(round2(totals.grossProceeds - totals.deductedCost)).toBe(totals.net);
    }
  });

  it('the cost is the acquisition cost plus the fee', () => {
    const s1 = answer('investments.tax', { year: 2026 }, data()).sales.find(s => s.id === 's1');
    expect(s1.fee).toBe(5);
    expect(s1.cost).toBe(round2(s1.acquisitionCost + 5));
  });

  it('counts a sale without a cost (sold more than on record)', () => {
    expect(answer('investments.tax', { year: 2026 }, data()).salesWithoutCost).toBe(1);
  });

  it('no sales: an empty answer', () => {
    const none = { years: [], year: null, totals: { grossProceeds: 0, purchaseCost: 0, deductedCost: 0, gains: 0, losses: 0, net: 0 },
      gainsExempt: false, lossesDeductible: false, salesWithoutCost: 0, sales: [] };
    expect(answer('investments.tax', {}, empty())).toEqual(none);
    const buysOnly = data({ meta: { investments: { prices: META.investments.prices } },
      transactions: data().transactions.filter(t => t.direction !== 'sell') });
    expect(answer('investments.tax', { year: 2026 }, buysOnly)).toEqual(none);
    expect(pageTax(buysOnly, 2026)).toBeNull();
    expect(pageTax(empty(), null)).toBeNull();
  });

  it('refuses a year that is not a whole number', () => {
    expect(ask('investments.tax', { year: 2025.5 }, data()).error.code).toBe('bad_input');
  });
});


describe('value-only physical holdings', () => {
  it('preserves valuation, scopes the tax exclusion by account and symbol, and allows re-enabling', () => {
    const d = { accounts: [{ id: 'a', type: 'investment' }, { id: 'b', type: 'investment' }, { id: 'chk', type: 'bank' }],
      transactions: [buy('a-buy', '2026-01-01', 'a', 'GOLD', 2, 100), sell('a-sale', '2026-02-01', 'a', 'GOLD', 1, 100),
        buy('b-buy', '2026-01-01', 'b', 'GOLD', 2, 100), sell('b-sale', '2026-02-01', 'b', 'GOLD', 1, 100)],
      meta: { investments: { holdingOverrides: { a: { GOLD: { units: 1, costBasis: 50, valuationOnly: true },
        RING: { units: 10, costBasis: 0, valuationOnly: true } } }, prices: { GOLD: { price: 100 }, RING: { price: 20 } } } } };
    const holdings = answer('investments.holdings', {}, d);
    expect(holdings.holdings.find(h => h.symbol === 'RING')).toMatchObject({ valuationOnly: true, units: 10 });
    expect(holdings.holdings.find(h => h.accountId === 'a' && h.symbol === 'GOLD')).toMatchObject({ valuationOnly: true, overridden: false });
    expect(holdings.totals).toMatchObject({ cost: 50, valuePriced: 400, unrealized: 50 });
    expect(answer('investments.tax', { year: 2026 }, d).sales.map(s => s.id)).toEqual(['b-sale']);
    delete d.meta.investments.holdingOverrides.a.GOLD.valuationOnly;
    expect(answer('investments.tax', { year: 2026 }, d).sales.map(s => s.id)).toEqual(['a-sale', 'b-sale']);
  });
});
