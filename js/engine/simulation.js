import { stressExpenseRows } from './stress-expenses.js';
// js/engine/simulation.js — the projection walk: 24 months of the Forecast
// lens's rows, stepped one day at a time, with the growth no lens can carry.
//
// Why a walk and not a lens (spec 2026-09-25, owner decision 2026-09-24):
// interest and value growth depend on the balance a day ends on, and a lens
// generator never reads balances. So this module takes the Forecast rows as
// they are, walks them in date order keeping every account and envelope
// balance, and after each day adds the balance-dependent rows — tiered
// interest accrued daily and paid on the account's schedule, value growth at
// each month-end — as `adjustment` rows tagged `sim`. They are never saved.
//
// Every balance rule is borrowed, not restated: `applyAccountEffects` for
// accounts (the bulk walkers' own rule), `txEnvelopeIds` + `txEnvelopeEffect`
// for envelopes. `tests/engine/simulation.test.js` holds each month-end to
// the Forecast lens's balances, so this card can never disagree with the
// Envelopes or Accounts page under Forecast.
//
// Pure. The clock is a required parameter.

import { resolveTargetTransfer, targetTransferOrder } from './target-transfers.js';
import { round2 } from '../utils.js';
import { requireClock } from './_constants.js';
import { lensTransactions, LENS_FORECAST } from './lens.js';
import {
  applyAccountEffects, netWorthFromBalances, computeUnallocated,
  txEnvelopeIds, txEnvelopeEffect, isSpendingAccount, isCrisisCashAccount,
  isAssetAccount, projectNetWorth,
} from './balances.js';
import { computeAnnualInterest } from './tx-amounts.js';
import { envelopeFloor } from './envelope-forecast.js';
import { computeEmergencyFundRequirement } from './monthly-review.js';
import { applyScenario } from './whatif.js';
import { resolveSetSourceLegs } from './scheduling.js';
import { withCardSettlements, cardFundingFor } from './card-settlement.js';

/**
 * @typedef {{ total: number, spending: number, savings: number, investment: number, pension: number, assets: number, loansGiven: number, debts: number, other: number }} NetWorthSplit
 * @typedef {{ date: string, accounts: Map<string, number>, envelopes: Map<string, number>, netWorth: NetWorthSplit, unallocated: number }} SimSnapshot
 * @typedef {{ firstDate: string, lowDate: string, low: number, threshold: number }} AlertTiming
 * @typedef {(AlertTiming & { kind: 'account-negative' | 'envelope-short', id: string })
 *   | (AlertTiming & { kind: 'unallocated-negative' | 'crisis-cash-below', id: null })} SimAlert
 * @typedef {{ month: number, accountId: string, amount: number }} Lump
 * @typedef {{
 *   startDate: string, endDate: string, rows: any[], opening: SimSnapshot,
 *   monthly: SimSnapshot[], alerts: SimAlert[],
 *   lastYearContribution: Map<string, number>, laterBooked: Lump[],
 *   accruedAtEnd: Map<string, number>,
 * }} Simulation
 */

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const ymd = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ─── Memoization ──────────────────────────────────────────────────────────
// The page runs three bands per render; a re-render with unchanged state must
// cost nothing. Same small-LRU shape as lens.js, keyed on input identity.
const CACHE_MAX = 6;
/** @type {Array<{ key: unknown[], value: Simulation }>} */
const cache = [];

/** @param {unknown[]} key */
function cacheGet(key) {
  for (let i = 0; i < cache.length; i++) {
    const entry = cache[i];
    if (entry.key.length !== key.length) continue;
    if (entry.key.every((v, j) => v === key[j])) {
      if (i > 0) { cache.splice(i, 1); cache.unshift(entry); }
      return entry.value;
    }
  }
  return undefined;
}

/** @param {unknown[]} key @param {Simulation} value */
function cachePut(key, value) {
  cache.unshift({ key, value });
  if (cache.length > CACHE_MAX) cache.length = CACHE_MAX;
  return value;
}

/** Test-only: drop every cached simulation. */
export function _resetSimulationCache() { cache.length = 0; }

/** @typedef {'monthly' | 'quarterly' | 'yearly'} InterestPayout */

/** @param {unknown} v @returns {InterestPayout} */
function normalizePayout(v) {
  return v === 'monthly' || v === 'quarterly' ? v : 'yearly';
}

/** @param {number} month0  0-based month of a month-end @param {InterestPayout} payout */
function paysIn(month0, payout) {
  if (payout === 'monthly') return true;
  if (payout === 'quarterly') return month0 % 3 === 2;
  return month0 === 11;
}

/**
 * Which accounts grow, and how. `expectedGrowth` wins over tiers, the order
 * the Net worth page's `growthFor` uses. The band shifts every positive tier
 * rate (floored at 0) and every expected rate; a 0 % tier stays 0 %, as an
 * account without a rate earns nothing in any line of `projectNetWorth`.
 *
 * @param {any[]} accounts
 * @param {number} shiftPct
 */
function growthPlans(accounts, shiftPct) {
  /** @type {Array<{ id: string, kind: 'growth', factor: number } | { id: string, kind: 'interest', tiers: any[], mode: 'progressive'|'full-balance', payout: InterestPayout, accrued: number }>} */
  const plans = [];
  for (const a of accounts) {
    if (a.archived) continue;
    if (Number.isFinite(a.expectedGrowth)) {
      plans.push({ id: a.id, kind: 'growth', factor: Math.pow(1 + (a.expectedGrowth + shiftPct) / 100, 1 / 12) });
    } else if (a.type === 'loan_given') {
      // A loan given's interest is paid in cash and booked as income when it
      // arrives (engine loan-terms.js): it never accrues onto the loan.
      continue;
    } else if (Array.isArray(a.interestTiers) && a.interestTiers.length) {
      const tiers = a.interestTiers.map((/** @type {any} */ tier) => {
        const rate = Number(tier?.rate);
        return { ...tier, rate: Number.isFinite(rate) && rate > 0 ? Math.max(0, rate + shiftPct) : 0 };
      });
      plans.push({ id: a.id, kind: 'interest', tiers, mode: a.interestTierMode === 'full-balance' ? 'full-balance' : 'progressive', payout: normalizePayout(a.interestPayout), accrued: 0 });
    }
  }
  return plans;
}

/**
 * Walk the Forecast lens's rows from today through `months` months, day by
 * day. See the module header; the return shape is `Simulation`.
 *
 * @param {object} input
 * @param {any} input.source   the shape of `state`: transactions, accounts,
 *   envelopes, budgetItems, envelopeTemplates, meta
 * @param {Date} input.today
 * @param {number} [input.months]
 * @param {number} [input.shiftPct]  moves growth rates only (the band)
 * @param {boolean} [input.trackAlerts]  false skips the dates to act on
 *   (`alerts` is then empty): the band runs show none, and the emergency
 *   requirement is a ledger walk of its own
 * @param {import('./whatif.js').WhatIfScenario | null} [input.scenario]  a
 *   what-if scenario: the lens rows pass through `applyScenario` before the
 *   walk. Absent, the walk is exactly the plan's.
 * @param {import('./whatif.js').StressCutFn} [input.stressCut]  the cut a
 *   Stress scenario makes to an item (0–1); without it `stress` changes do
 *   nothing
 * @returns {Simulation}
 */
export function simulate({ source, today, months = 24, shiftPct = 0, trackAlerts = true, scenario, stressCut }) {
  const clock = requireClock(today, 'simulate');
  // A NaN or string `months` would make `endDate` unreachable ("NaN-NaN-NaN")
  // or absurd ("24" concatenates), and the day loop below would never end.
  if (!Number.isInteger(months) || months < 0) {
    throw new TypeError(`simulate: months must be a non-negative integer, got ${String(months)}`);
  }
  const todayIso = ymd(clock);
  const y0 = clock.getFullYear();
  const m0 = clock.getMonth();
  const endDate = ymd(new Date(y0, m0 + months + 1, 0));

  const key = [source?.transactions, source?.accounts, source?.envelopes, source?.budgetItems,
    source?.envelopeTemplates, source?.meta, todayIso, months, shiftPct, trackAlerts, scenario, stressCut];
  const hit = cacheGet(key);
  if (hit) return hit;

  const accounts = (source?.accounts || []).filter(Boolean);

  // With a scenario, the sourced set-mode fills are resolved only after it
  // is applied: a fill's source leg is the delta that lands its target, and
  // a cut or scaled row ahead of it changes the balance it meets. Resolved
  // before, the fill would no longer be net-zero and Unallocated would drift.
  // The cards' settlements (`settledFrom`, card-settlement.js) come last for
  // the same reason: a card's settlement is its balance.
  const lensRows = scenario
    ? withCardSettlements(accounts, resolveSetSourceLegs([...applyScenario(
      lensTransactions(source, { lens: LENS_FORECAST, horizon: endDate, today: clock, pendingSetSources: true }),
      scenario,
      { budgetItems: source?.budgetItems || [], accounts, startIso: todayIso, endIso: endDate, stressCut },
    ), ...stressExpenseRows(source?.meta?.stressExpenses, scenario, todayIso, endDate)]),
    { todayIso, endIso: endDate, booked: source?.transactions || [], budgetItems: source?.budgetItems || [], country: source?.meta?.country || 'FI' })
    : lensTransactions(source, { lens: LENS_FORECAST, horizon: endDate, today: clock });
  // Date order with the array index as a stable tiebreaker: a set-mode fill
  // is order-sensitive (see `txEnvelopeEffect`), and the lens resolved its
  // source legs in exactly this order.
  const order = lensRows
    .map((tx, i) => ({ tx, i, d: typeof tx?.date === 'string' ? tx.date.slice(0, 10) : '' }))
    .sort((a, b) => targetTransferOrder(a.tx, b.tx) || a.i - b.i);

  /** @type {Map<string, number>} */
  const acc = new Map();
  for (const a of accounts) acc.set(a.id, Number(a.initialBalance) || 0);
  const addAcc = (/** @type {string} */ id, /** @type {number} */ delta) => acc.set(id, (acc.get(id) ?? 0) + delta);

  /** @type {Map<string, number>} */
  const env = new Map();

  // The contribution window: the walk's last 12 months (13–24 for 24).
  const windowMonths = Math.min(12, months);
  const contribFrom = ymd(new Date(y0, m0 + months - windowMonths + 1, 0));
  /** @type {Map<string, number>} */
  const contrib = new Map(accounts.map(a => [a.id, 0]));
  const addContrib = (/** @type {string} */ id, /** @type {number} */ delta) => {
    if (contrib.has(id)) contrib.set(id, (contrib.get(id) ?? 0) + delta);
  };

  /** @type {any[]} */
  const rows = [];
  const apply = (/** @type {any} */ tx) => {
    tx = resolveTargetTransfer(tx, acc);
    applyAccountEffects(tx, addAcc);
    for (const id of txEnvelopeIds(tx)) {
      const eff = txEnvelopeEffect(tx, id);
      if (!eff) continue;
      if (eff.mode === 'set') env.set(id, eff.value);
      else env.set(id, (env.get(id) ?? 0) + eff.amount);
    }
    rows.push(tx);
    const d = typeof tx?.date === 'string' ? tx.date.slice(0, 10) : '';
    // Only the plan's generated rows recur, so only they are a monthly
    // contribution. A booked row is already in the month-24 balance, once;
    // counting it here would repeat it every month for decades. Growth is not
    // money put in either; the long projection has its own rates. A what-if
    // one-off does not recur either, so it is not one; its monthly amounts are.
    if (tx?.is_forecast && !tx?.sim && !tx?.whatif_once && d > contribFrom && d <= endDate) {
      applyAccountEffects(tx, addContrib);
    }
  };

  /** @returns {SimSnapshot} */
  const snapshot = (/** @type {string} */ d) => ({
    date: d,
    accounts: new Map(acc),
    envelopes: new Map(env),
    netWorth: netWorthFromBalances(accounts, acc),
    unallocated: computeUnallocated(acc, env, accounts),
  });

  const plans = growthPlans(accounts, shiftPct);
  const daysInFirstMonth = new Date(y0, m0 + 1, 0).getDate();
  // Today's month is only partly ahead: its month-end growth covers the
  // days from today on, so month 12 is not a year and a bit of growth.
  const firstMonthShare = (daysInFirstMonth - clock.getDate() + 1) / daysInFirstMonth;
  const credit = (/** @type {string} */ id, /** @type {number} */ raw, /** @type {string} */ d, /** @type {'interest' | 'growth'} */ kind) => {
    const amount = round2(raw);
    if (amount === 0) return;
    apply({ id: `sim:${kind}:${id}:${d}`, type: 'adjustment', target: 'account', target_id: id,
      amount, date: d, is_forecast: true, sim: kind });
  };

  // ── Dates to act on ────────────────────────────────────────────────────
  const envelopes = (source?.envelopes || []).filter((/** @type {any} */ e) => e && !e.archived);
  const budgetItems = source?.budgetItems || [];
  const floors = new Map(trackAlerts ? envelopes.map((/** @type {any} */ e) => [e.id, envelopeFloor(budgetItems, e.id)]) : []);
  // Credit cards live below zero; that is not a date to act on. Nor is an
  // account settled like one (`settledFrom`, card-settlement.js): it dips
  // between top-ups by design, and its paying account is watched instead.
  const watched = trackAlerts
    ? accounts.filter(a => !a.archived && isSpendingAccount(a) && a.type !== 'credit_card' && !cardFundingFor(a, accounts)) : [];
  const crisisIds = accounts.filter(a => !a.archived && isCrisisCashAccount(a)).map(a => a.id);
  // The full target (months of essentials × duration, plus the buffer), not
  // `required`, which is already reduced by money set aside elsewhere.
  const req = trackAlerts ? computeEmergencyFundRequirement({
    envelopes: source?.envelopes || [], budgetItems, transactions: source?.transactions || [],
    month: todayIso.slice(0, 7), meta: source?.meta, _refDate: clock,
  }) : null;
  const crisisTarget = req ? round2((Number(req.subtotal) || 0) + (Number(req.buffer) || 0)) : 0;

  /** @type {Map<string, { kind: SimAlert['kind'], id: string | null, threshold: number, firstDate: string, low: number, lowDate: string }>} */
  const trackers = new Map();
  const watch = (/** @type {SimAlert['kind']} */ kind, /** @type {string | null} */ id, /** @type {number} */ threshold, /** @type {number} */ value, /** @type {string} */ d) => {
    const tk = `${kind}:${id ?? ''}`;
    let tr = trackers.get(tk);
    if (!tr) { tr = { kind, id, threshold, firstDate: '', low: Infinity, lowDate: '' }; trackers.set(tk, tr); }
    if (value < tr.low) { tr.low = value; tr.lowDate = d; }
    if (!tr.firstDate && value < threshold - 0.005) tr.firstDate = d;
  };

  // Everything dated before today (undated rows included) is the opening.
  let k = 0;
  while (k < order.length && order[k].d < todayIso) apply(order[k++].tx);

  /** @type {SimSnapshot | null} */
  let opening = null;
  /** @type {SimSnapshot[]} */
  const monthly = [];
  // Local-date construction per step, never +86 400 000 ms: a DST day is
  // 23 or 25 hours long.
  for (let day = new Date(y0, m0, clock.getDate()); ; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const d = ymd(day);
    if (d > endDate) break;
    while (k < order.length && order[k].d <= d) apply(order[k++].tx);
    if (d === todayIso) opening = snapshot(d);
    const monthEnd = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate() === day.getDate();
    const firstMonth = day.getFullYear() === y0 && day.getMonth() === m0;
    for (const p of plans) {
      if (p.kind === 'interest') {
        // Accrues on the balance the day ends on, from today: interest
        // earned before today is not known, and is not counted.
        p.accrued += computeAnnualInterest(acc.get(p.id) ?? 0, p.tiers, p.mode) / 365;
        if (monthEnd && paysIn(day.getMonth(), p.payout)) {
          credit(p.id, p.accrued, d, 'interest');
          p.accrued = 0;
        }
      } else if (monthEnd) {
        const factor = firstMonth ? Math.pow(p.factor, firstMonthShare) : p.factor;
        credit(p.id, (acc.get(p.id) ?? 0) * (factor - 1), d, 'growth');
      }
    }
    if (trackAlerts) {
      for (const a of watched) watch('account-negative', a.id, 0, acc.get(a.id) ?? 0, d);
      for (const e of envelopes) watch('envelope-short', e.id, floors.get(e.id) ?? 0, env.get(e.id) ?? 0, d);
      watch('unallocated-negative', null, 0, computeUnallocated(acc, env, accounts), d);
      if (crisisTarget > 0) {
        watch('crisis-cash-below', null, crisisTarget, crisisIds.reduce((s, id) => s + (acc.get(id) ?? 0), 0), d);
      }
    }
    if (monthEnd) monthly.push(snapshot(d));
  }

  const alerts = [...trackers.values()]
    .filter(tr => tr.firstDate)
    .map(tr => /** @type {SimAlert} */ ({
      kind: tr.kind, id: tr.id, firstDate: tr.firstDate, lowDate: tr.lowDate,
      low: round2(tr.low), threshold: tr.threshold,
    }))
    .sort((a, b) => (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : 0));

  // Interest earned since each account's last payout: not paid by the walk's
  // end, so not in `monthly`, but the long projection starts from it.
  /** @type {Map<string, number>} */
  const accruedAtEnd = new Map();
  for (const p of plans) {
    if (p.kind !== 'interest') continue;
    const amount = round2(p.accrued);
    if (amount !== 0) accruedAtEnd.set(p.id, amount);
  }

  /** @type {Map<string, number>} */
  const lastYearContribution = new Map();
  for (const a of accounts) {
    lastYearContribution.set(a.id, isAssetAccount(a) ? 0 : round2((contrib.get(a.id) ?? 0) / windowMonths));
  }

  return cachePut(key, {
    startDate: todayIso,
    endDate,
    rows,
    opening: opening ?? snapshot(todayIso),
    monthly,
    alerts,
    lastYearContribution,
    laterBooked: laterBookedLumps(source?.transactions || [], endDate),
    accruedAtEnd,
  });
}

/**
 * Booked rows dated after the walk, as per-account amounts by month after
 * `endDate`'s month. The lens caps booked rows at its horizon, so without
 * these a known inflow years out (a scheduled inheritance) would be in
 * neither the walk nor the compounding after it.
 *
 * @param {any[]} transactions
 * @param {string} endDate
 * @returns {Lump[]}
 */
function laterBookedLumps(transactions, endDate) {
  const endY = Number(endDate.slice(0, 4));
  const endM = Number(endDate.slice(5, 7));
  /** @type {Lump[]} */
  const out = [];
  for (const tx of transactions) {
    if (!tx || tx.is_forecast) continue;
    const d = typeof tx.date === 'string' ? tx.date.slice(0, 10) : '';
    if (!d || d <= endDate) continue;
    const month = (Number(d.slice(0, 4)) - endY) * 12 + (Number(d.slice(5, 7)) - endM);
    applyAccountEffects(tx, (accountId, delta) => {
      const amount = round2(delta);
      if (amount !== 0) out.push({ month, accountId, amount });
    });
  }
  return out;
}

/**
 * The long net-worth line, joined to a simulation run: year 0 is today,
 * years 1 and 2 are the walk's month 12 and 24, and later years compound
 * from month 24 with `projectNetWorth`, the walk's later booked rows added
 * as lumps and the interest accrued but not yet paid at month 24 added to
 * where it starts. Pass the run and the `shiftPct` of the same band.
 *
 * @param {object} input
 * @param {any[]} input.accounts           whose line this is (non-archived are summed)
 * @param {Simulation} input.sim
 * @param {Map<string, number | null>} input.growthPct
 * @param {Map<string, number>} input.contribution
 * @param {number} input.years
 * @param {number} [input.shiftPct]
 * @param {Map<string, number[]> | null} [input.scheduled]  an account's balance at each
 *   month end, indexed like `sim.monthly` (a loan's repayment schedule,
 *   `loanBalancePath`): past the simulated years that account follows it
 *   instead of growing and receiving its contribution
 * @returns {Array<{ year: number, total: number }>}
 */
export function projectFromSimulation({ accounts, sim, growthPct, contribution, years, shiftPct = 0, scheduled = null }) {
  const live = (accounts || []).filter(a => a && !a.archived);
  const sum = (/** @type {SimSnapshot} */ snap) => round2(live.reduce((s, a) => s + (snap.accounts.get(a.id) ?? 0), 0));
  const simYears = Math.floor((sim.monthly.length - 1) / 12);
  const out = [{ year: 0, total: sum(sim.opening) }];
  for (let y = 1; y <= Math.min(years, simYears); y++) out.push({ year: y, total: sum(sim.monthly[y * 12]) });
  if (years > simYears) {
    // A copy: `monthly` is money actually paid, and stays that way. The
    // accrual is the walk's last day's, so it belongs only on its last month.
    const start = new Map(sim.monthly[simYears * 12].accounts);
    if (simYears * 12 === sim.monthly.length - 1) {
      for (const [id, amount] of sim.accruedAtEnd ?? []) start.set(id, (start.get(id) ?? 0) + amount);
    }
    const rest = projectNetWorth({
      accounts: live, balances: start, growthPct, contribution,
      years: years - simYears, shiftPct, lumps: sim.laterBooked,
      paths: scheduled, pathOffset: simYears * 12,
    });
    for (const p of rest.slice(1)) out.push({ year: p.year + simYears, total: p.total });
  }
  return out;
}
