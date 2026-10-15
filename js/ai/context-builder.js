// js/ai/context-builder.js — pure functions producing compact, PII-light
// JSON payloads for each AI feature. We reuse engine.js helpers wherever
// possible so we never recompute aggregates the rest of the app already
// computes.
//
// Every builder takes the clock as a required argument (dispatch passes the
// app's `now`) and reads it once; none reads the wall clock itself. The
// figures come from the core queries (js/ai/query.js), run with that clock.
//
// Contract for every builder:
//   - all money fields rounded to 2 decimals
//   - never include free-text `notes` (PII reduction)
//   - cap arrays (top-N) so payloads stay under ~40 KB
//   - reference entities by id; provide `refs: { envelopes, accounts }`
//   - return an object the renderer can also use for id lookup

import {
  fillDisplayTotal,
  fillSetLineCount,
  txAbsAmount,
  txAccountDelta,
  isPostedTx,
  txPayeeLabel,
} from '../engine.js';
import { queryAnswer } from './query.js';
import { getPayeeAliases, withAliasTargets } from '../state/payee-aliases.js';

// ── Dismissed-item helpers ──────────────────────────────────────────────

function readDismissedKeys(state, feature) {
  const map = state?.meta?.ai?.dismissed?.[feature];
  if (!map || typeof map !== 'object') return new Set();
  return new Set(Object.keys(map));
}

function anomalyKey(envelopeId, payee, amount) {
  const env = envelopeId ? String(envelopeId) : '';
  const p = (payee && String(payee).trim()) || '';
  const amt = Number(amount);
  const rounded = Number.isFinite(amt) ? (Math.round(amt * 100) / 100) : 0;
  return `${env}|${p}|${rounded}`;
}

// Exported so the renderer can compute the same key when the user clicks ×.
export { anomalyKey };

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function refsFromState(state) {
  const envs = {};
  for (const e of state.envelopes || []) envs[e.id] = e.name;
  const accs = {};
  for (const a of state.accounts || []) accs[a.id] = a.name;
  return { envelopes: envs, accounts: accs };
}

function todayIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The five figures the briefing and the what-if context lead with, as the core
 * queries answer them (the Booked view): the `balances` totals and unallocated,
 * and the month's `spending.month`.
 *
 *   totalAccountBalance  the identity accounts (no investment, asset or loan accounts)
 *   plannedThisMonth     the plan's annual total / 12, not the month's own calendar entry
 */
function dashboardSummary(state, monthIso, date, clock) {
  const balances = queryAnswer(state, 'balances', { lens: 'booked' }, clock);
  const spending = queryAnswer(state, 'spending.month', { month: monthIso, date }, clock);
  return {
    totalEnvelopeBalance: r2(balances.totals.envelopes),
    totalAccountBalance: r2(balances.totals.accounts),
    unallocated: r2(balances.unallocated),
    spentThisMonth: r2(spending.spent),
    plannedThisMonth: r2(spending.planned),
  };
}

/**
 * The biggest payees of the last `days` days, from `reports.spending`. The
 * query's folded-rest total (`other`) is not a payee and is left out, as are
 * rows without one.
 */
function topPayees(state, days, topN, today, clock) {
  const from = new Date(today.getTime() - days * 86_400_000);
  const { rows } = queryAnswer(state, 'reports.spending', {
    groupBy: 'payee', from: todayIso(from), to: todayIso(today), topN,
  }, clock);
  return rows.filter((r) => r.label !== '(no payee)').map((r) => ({
    payee: r.label, total: r2(r.value),
  }));
}

// ── Monthly briefing ─────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {string | undefined} monthArg  YYYY-MM, default the month of `clock()`
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildMonthlyBriefingCtx(state, monthArg, clock) {
  // One read of the clock: the date, the month and every query below see the
  // same instant, so a build that straddles midnight cannot mix two days.
  const today = clock();
  const date = todayIso(today);
  const fixed = () => today;
  const monthIso = monthArg ?? date.slice(0, 7);
  const summary = dashboardSummary(state, monthIso, date, fixed);
  const from = new Date(today.getFullYear(), today.getMonth() - 5, 1);
  // The six months' income, spending and saving: the Reports page's cash flow
  // (loan principal counts as saving there, so it is not spending here).
  const cash = queryAnswer(state, 'reports.cashflow', { from: todayIso(from), to: date, date }, fixed);

  // Balances and the plan as the coming 12 months from this month see it.
  const lowEnvelopes = queryAnswer(state, 'envelopes.month', {
    lens: 'booked', spare: false, date: `${monthIso}-01`,
  }, fixed).envelopes
    .map((e) => ({
      id: e.id,
      balance: r2(e.balance),
      planned: r2(e.planned),
    }))
    .filter((e) => e.balance < 0 || (e.planned > 0 && e.balance < e.planned * 0.25))
    .slice(0, 10);

  return {
    month: monthIso,
    summary,
    incomeVsSpend6mo: [['Income', cash.income], ['Spending', cash.spending], ['Saving', cash.saving]]
      .map(([name, points]) => ({
        name,
        points: points.map((p) => ({ month: p.month, value: r2(p.value) })),
      })),
    lowEnvelopes,
    topPayees90d: topPayees(state, 90, 8, today, fixed),
    refs: refsFromState(state),
  };
}


/**
 * Stamp the budget's currency onto a context.
 *
 * The model writes prose containing amounts ("spend $5,031 of $5,379"), so it
 * has to be told which currency it is looking at or it defaults to dollars —
 * which is exactly what a euro budget was getting. Applied at the call
 * boundary in js/ai/client.js rather than inside each builder, so a feature
 * added later cannot forget it.
 *
 * @param {object} context
 * @param {object} state
 * @returns {object} a shallow copy carrying `currency` and `currency_symbol`
 */
export function withCurrency(context, state) {
  const code = state?.meta?.currency || 'EUR';
  return { ...context, currency: code, currency_symbol: currencySymbolFor(code) };
}

/** Symbol for an ISO currency code, falling back to the code itself. */
export function currencySymbolFor(code) {
  const known = {
    EUR: '\u20ac', USD: '$', GBP: '\u00a3', SEK: 'kr', NOK: 'kr', DKK: 'kr',
    CHF: 'CHF', JPY: '\u00a5', AUD: 'A$', CAD: 'C$',
  };
  return known[code] || code || '\u20ac';
}

// ── Anomaly alerts ───────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {string | undefined} monthArg  YYYY-MM, default the month of `clock()`
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildAnomalyCtx(state, monthArg, clock) {
  const { transactions = [] } = state;
  const today = clock();
  const monthIso = monthArg ?? todayIso(today).slice(0, 7);
  const since = new Date(today.getTime() - 90 * 86_400_000);
  const sinceIso = todayIso(since);

  // Per-payee mean + stddev from last 180 days, used as baseline.
  const baselineFrom = new Date(today.getTime() - 180 * 86_400_000);
  const byPayee = new Map();
  for (const tx of transactions) {
    if (tx.type !== 'expense' || !isPostedTx(tx)) continue;
    if (!tx.date || tx.date < todayIso(baselineFrom)) continue;
    const key = txPayeeLabel(tx);
    const amt = txAbsAmount(tx);
    if (!Number.isFinite(amt)) continue;
    const arr = byPayee.get(key) || [];
    arr.push(amt);
    byPayee.set(key, arr);
  }
  const baseline = {};
  for (const [k, arr] of byPayee.entries()) {
    if (arr.length < 3) continue;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    baseline[k] = { mean: r2(mean), stddev: r2(Math.sqrt(variance)), n: arr.length };
  }

  // Recent transactions (last 90d, posted, expenses, ≥5 currency, no transfers).
  const dismissedKeys = readDismissedKeys(state, 'anomaly');
  const recent = [];
  for (const tx of transactions) {
    if (tx.type !== 'expense' || !isPostedTx(tx)) continue;
    if (!tx.date || tx.date < sinceIso) continue;
    const amt = txAbsAmount(tx);
    if (!Number.isFinite(amt) || amt < 5) continue;
    const k = anomalyKey(tx.envelope_id, tx.payee, amt);
    if (dismissedKeys.has(k)) continue;
    recent.push({
      id: tx.id,
      date: tx.date,
      payee: (tx.payee && String(tx.payee).trim()) || null,
      amount: r2(amt),
      envelope_id: tx.envelope_id || null,
    });
  }
  recent.sort((a, b) => b.date.localeCompare(a.date));
  return {
    month: monthIso,
    transactions: recent.slice(0, 200),
    baseline,
    refs: refsFromState(state),
  };
}

// ── Envelope health ──────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {string | undefined} monthArg  YYYY-MM, default the month of `clock()`
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildEnvelopeHealthCtx(state, monthArg, clock) {
  const { envelopes = [], transactions = [] } = state;
  const today = clock();
  const fixed = () => today;
  const monthIso = monthArg ?? todayIso(today).slice(0, 7);
  // Balance, plan and buffer per envelope: the `envelopes.month` card figures,
  // the plan as the coming 12 months from this month see it.
  const cards = new Map(queryAnswer(state, 'envelopes.month', {
    lens: 'booked', spare: false, date: `${monthIso}-01`,
  }, fixed).envelopes.map((c) => [c.id, c]));

  // Last activity per envelope.
  const lastActivity = new Map();
  for (const tx of transactions) {
    if (!tx.envelope_id || !tx.date || !isPostedTx(tx)) continue;
    const cur = lastActivity.get(tx.envelope_id);
    if (!cur || tx.date > cur) lastActivity.set(tx.envelope_id, tx.date);
  }

  const rows = [];
  const dismissedHealth = readDismissedKeys(state, 'envelope_health');
  for (const e of envelopes) {
    if (e.archived) continue;
    if (dismissedHealth.has(e.id)) continue;
    rows.push({
      id: e.id,
      name: e.name,
      category: e.category || null,
      balance: r2(cards.get(e.id)?.balance),
      monthly_plan: r2(cards.get(e.id)?.planned),
      buffer: r2(cards.get(e.id)?.buffer),
      last_activity: lastActivity.get(e.id) || null,
    });
  }
  rows.sort((a, b) => a.balance - b.balance);
  return {
    month: monthIso,
    today: todayIso(today),
    envelopes: rows.slice(0, 30),
    refs: refsFromState(state),
  };
}

// ── Subscription detection ──────────────────────────────────────────────

/**
 * @param {any} state
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildSubscriptionCtx(state, clock) {
  const { transactions = [], budgetItems = [] } = state;
  const today = clock();
  const sinceIso = todayIso(new Date(today.getTime() - 180 * 86_400_000));

  // Payees we should NOT suggest because they're already on the user's budget.
  // Two signals:
  //   1. Any past tx with `from_budget` set was materialized from a scheduled
  //      budget item — that payee is already templated. (engine.js writes
  //      `from_budget = "<budgetItemId>:<monthKey>"` for those.)
  //   2. Any scheduled budget item whose description matches the payee
  //      (loose case-insensitive substring match either direction). Catches
  //      newly-created items that haven't materialized yet.
  const templatedPayees = new Set();
  for (const tx of transactions) {
    if (!tx?.from_budget) continue;
    const p = (tx.payee && String(tx.payee).trim()) || '';
    if (p) templatedPayees.add(p.toLowerCase());
  }
  const scheduledDescriptions = budgetItems
    .filter((b) => b && b.as_schedule)
    .map((b) => String(b.description || '').trim().toLowerCase())
    .filter(Boolean);

  function isTemplated(payee) {
    const lower = payee.toLowerCase();
    if (templatedPayees.has(lower)) return true;
    for (const d of scheduledDescriptions) {
      if (lower === d || lower.includes(d) || d.includes(lower)) return true;
    }
    return false;
  }

  const byPayee = new Map();
  for (const tx of transactions) {
    if (tx.type !== 'expense' || !isPostedTx(tx)) continue;
    if (!tx.date || tx.date < sinceIso) continue;
    const key = (tx.payee && String(tx.payee).trim()) || '';
    if (!key) continue;
    const amt = txAbsAmount(tx);
    if (!Number.isFinite(amt) || amt < 1) continue;
    const arr = byPayee.get(key) || [];
    arr.push({ date: tx.date, amount: amt, envelope_id: tx.envelope_id || null });
    byPayee.set(key, arr);
  }

  // Honour dismissals from both the new map and the legacy array. Compared
  // lowercased, and a dismissed spelling later merged away in the tidy-up
  // sheet also dismisses the name it was merged into (its alias target).
  const dismissed = withAliasTargets(
    [...(state.meta?.ai?.dismissedSubs || []), ...readDismissedKeys(state, 'subscription')],
    getPayeeAliases(state.meta),
  );
  const candidates = [];
  for (const [payee, arr] of byPayee.entries()) {
    if (dismissed.has(payee.toLowerCase())) continue;
    if (isTemplated(payee)) continue;
    if (arr.length < 3) continue;
    arr.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = arr.map((x) => x.amount);
    const mean = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    if (!mean) continue;
    const variance = amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / amounts.length;
    const cov = Math.sqrt(variance) / mean;
    if (cov > 0.15) continue;
    // Average inter-occurrence days.
    const gaps = [];
    for (let i = 1; i < arr.length; i++) {
      const a = new Date(arr[i - 1].date).getTime();
      const b = new Date(arr[i].date).getTime();
      gaps.push((b - a) / 86_400_000);
    }
    const avgGap = gaps.reduce((s, v) => s + v, 0) / gaps.length;
    candidates.push({
      payee,
      sample_amount: r2(mean),
      occurrences: arr.length,
      avg_gap_days: r2(avgGap),
      last_date: arr[arr.length - 1].date,
      last_envelope_id: arr[arr.length - 1].envelope_id,
    });
  }
  candidates.sort((a, b) => b.occurrences - a.occurrences);
  return {
    today: todayIso(today),
    candidates: candidates.slice(0, 25),
    refs: refsFromState(state),
  };
}

// ── What-if Q&A ──────────────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {string | undefined} monthArg  YYYY-MM, default the month of `clock()`
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildWhatifCtx(state, monthArg, clock) {
  const { envelopes = [] } = state;
  // One read of the clock, as in the briefing.
  const today = clock();
  const date = todayIso(today);
  const fixed = () => today;
  const monthIso = monthArg ?? date.slice(0, 7);
  const summary = dashboardSummary(state, monthIso, date, fixed);
  // The next 90 days, from the `upcoming` query: its forecast rows, without
  // the ones already overdue this month and without real future-dated rows.
  // Fills are included, or the model sees only money leaving envelopes over the
  // next 90 days and reasons about a budget that never gets funded. The query
  // orders by date because the 60-row cap below would otherwise truncate by
  // source order — every expense, then whatever fills happened to fit.
  const forecast = queryAnswer(state, 'upcoming', { days: 90, date }, fixed).coming
    .filter((row) => row.origin === 'forecast' && !row.overdue);
  // The plan per envelope (archived ones too) as the coming 12 months from
  // this month see it. Only rows with an id are asked for: one malformed row
  // must not fail the whole context (the query refuses a ref that is no id).
  const monthlyPlan = queryAnswer(state, 'envelopes.month', {
    spare: false, date: `${monthIso}-01`,
    envelopes: envelopes.filter((e) => e && typeof e.id === 'string' && e.id).map((e) => e.id),
  }, fixed).envelopes;

  // What has cleared as of today (the Today view), not everything entered.
  const accBal = queryAnswer(state, 'balances', { lens: 'today' }, fixed).accounts;
  return {
    month: monthIso,
    today: date,
    summary,
    accounts: accBal.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type || null,
      balance: r2(a.balance),
    })),
    monthlyPlan: monthlyPlan
      .filter((e) => e.planned !== 0)
      .map((e) => ({ envelope_id: e.id, monthly_plan: r2(e.planned) }))
      .slice(0, 50),
    forecast90d: forecast.slice(0, 60).map((tx) => {
      // A fill has `lines`, not `amount`, and touches no account — serialising
      // it through the generic path would hand the model `amount: 0`.
      if (tx.type === 'fill') {
        return {
          date: tx.date,
          type: 'fill',
          amount: r2(fillDisplayTotal(tx)),
          // `amount` leaves out lines that set an envelope to a value.
          ...(fillSetLineCount(tx) ? { sets_envelopes: fillSetLineCount(tx) } : {}),
          envelope_id: null,
          envelope_ids: (tx.lines || []).map((l) => l.envelope_id).filter(Boolean).slice(0, 20),
          account_id: null,
          payee: tx.payee || null,
        };
      }
      // account_transfer / investment_transfer rows carry no `account` (they
      // move money between two accounts, identified by from/to) — serialise
      // both ends instead, or the model sees a transfer with no account at
      // all and no way to tell it apart from a dangling row.
      const isTransfer = tx.type === 'account_transfer' || tx.type === 'investment_transfer';
      return {
        date: tx.date,
        type: tx.type,
        amount: r2(txAbsAmount(tx)),
        envelope_id: tx.envelope_id || null,
        account_id: tx.account || null,
        ...(isTransfer ? {
          from_account_id: tx.from_account || null,
          to_account_id: tx.to_account || null,
        } : {}),
        payee: tx.payee || null,
      };
    }),
    refs: refsFromState(state),
  };
}

// ── Reconcile assistant ──────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {string} accountId
 * @param {string | undefined} monthArg  YYYY-MM, default the month of `clock()`
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildReconcileCtx(state, accountId, monthArg, clock) {
  const { accounts = [], transactions = [] } = state;
  const today = clock();
  const monthIso = monthArg ?? todayIso(today).slice(0, 7);
  const account = (accounts || []).find((a) => a.id === accountId) || null;

  const monthStart = `${monthIso}-01`;
  const yyyymm = monthIso.split('-');
  const lastDay = new Date(Number(yyyymm[0]), Number(yyyymm[1]), 0).getDate();
  const monthEnd = `${monthIso}-${String(lastDay).padStart(2, '0')}`;

  const recent = [];
  for (const tx of transactions) {
    if (!tx.date || tx.date < monthStart || tx.date > monthEnd) continue;
    const delta = txAccountDelta(tx, accountId);
    if (delta === 0 && tx.account !== accountId
        && tx.from_account !== accountId && tx.to_account !== accountId) continue;
    if (tx.account !== accountId && tx.from_account !== accountId
        && tx.to_account !== accountId) continue;
    recent.push({
      id: tx.id,
      date: tx.date,
      type: tx.type,
      amount: r2(txAbsAmount(tx)),
      delta: r2(delta),
      payee: tx.payee || null,
      envelope_id: tx.envelope_id || null,
      cleared: !!tx.cleared,
      status: tx.status,
      flagged: !!tx.flagged,
      splits: Array.isArray(tx.envelope_splits) && tx.envelope_splits.length
        ? tx.envelope_splits.map((s) => ({ envelope_id: s.envelope_id, amount: r2(s.amount) }))
        : null,
    });
  }
  recent.sort((a, b) => a.date.localeCompare(b.date));

  // Every row dated on or before the month's end (the Booked view as of that day).
  const expectedBalance = queryAnswer(state, 'balances', {
    lens: 'booked', asOf: monthEnd, includeArchived: true,
  }, () => today).accounts.find((a) => a.id === accountId)?.balance || 0;

  return {
    month: monthIso,
    today: todayIso(today),
    account: account ? {
      id: account.id,
      name: account.name,
      type: account.type || null,
      lastReconciledAt: account.lastReconciledAt || null,
      lastReconciledBalance: r2(account.lastReconciledBalance || 0),
    } : null,
    expected_balance: r2(expectedBalance),
    transactions: recent.slice(0, 200),
    refs: refsFromState(state),
  };
}

// ── Onboarding copilot ───────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {string | undefined} step
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildOnboardingCtx(state, step = 'envelopes', clock) {
  return {
    today: todayIso(clock()),
    step,
    counts: {
      envelopes: (state.envelopes || []).length,
      accounts: (state.accounts || []).length,
      budgetItems: (state.budgetItems || []).length,
      transactions: (state.transactions || []).length,
    },
    meta: {
      currency: state.meta?.currency || null,
      locale: state.meta?.locale || null,
      name: state.meta?.name || null,
    },
  };
}

// ── Portfolio insight ────────────────────────────────────────────────────
// Cost-basis-only summary of investment holdings + 12-month contribution
// pace + idle-cash detection. Deliberately omits live prices so the model
// cannot fabricate "performance" or "current value" — the prompt restates
// this explicitly.

function units6(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e6) / 1e6;
}

/**
 * @param {any} state
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildPortfolioInsightCtx(state, clock) {
  const { accounts = [], transactions = [], meta = {} } = state;
  const today = clock();
  const fixed = () => today;

  const investmentAccounts = (accounts || []).filter((a) =>
    a && a.type === 'investment' && !a.archived && a.trackInvestments !== false,
  );

  // The tracked accounts' holdings, sold-out ones too (the Investments page's
  // rows, with the zero holdings listed), and what has cleared in each account.
  const portfolio = queryAnswer(state, 'investments.holdings', { includeZero: true }, fixed);
  const allHoldings = portfolio.holdings;
  const postedBalance = new Map(queryAnswer(state, 'balances', { lens: 'today' }, fixed).accounts
    .map((a) => [a.id, a.balance]));

  const holdings = allHoldings.slice(0, 50).map((h) => {
    const row = {
      account_id: h.accountId,
      symbol: h.symbol,
      units: units6(h.units),
      cost_basis: h.valuationOnly ? null : r2(h.costBasis),
      ...(h.valuationOnly ? { valuation_only: true } : {}),
      realized: h.valuationOnly ? null : r2(h.realized || 0),
      distributions: r2(h.distributions || 0),
      overridden: !!h.overridden,
    };
    if (h.name) row.name = h.name;
    return row;
  });

  // Per-symbol concentration (shareable across accounts).
  const bySymbol = new Map();
  const totalCost = portfolio.totals.cost;
  for (const h of allHoldings) {
    if (h.valuationOnly) continue;
    bySymbol.set(h.symbol, (bySymbol.get(h.symbol) || 0) + (Number(h.costBasis) || 0));
  }
  const symbolMix = [...bySymbol.entries()]
    .map(([symbol, cost]) => ({
      symbol,
      cost_basis: r2(cost),
      pct: totalCost > 0 ? r2((cost / totalCost) * 100) : 0,
    }))
    .sort((a, b) => b.cost_basis - a.cost_basis)
    .slice(0, 20);

  // 12-month contribution pace from posted investment_transfer rows.
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const monthIdx = new Map(months.map((m, i) => [m, i]));
  const buckets = months.map((m) => ({
    month: m, net: 0, buys: 0, sells: 0, dividends: 0,
  }));

  for (const tx of transactions || []) {
    if (!tx || tx.type !== 'investment_transfer') continue;
    if (tx.status && tx.status !== 'posted') continue;
    if (!tx.date) continue;
    const idx = monthIdx.get(tx.date.slice(0, 7));
    if (idx === undefined) continue;
    const cash = txAbsAmount(tx);
    if (!Number.isFinite(cash) || cash <= 0) continue;
    const dir = tx.direction === 'sell' ? 'sell'
      : tx.direction === 'dividend' ? 'dividend'
      : tx.direction === 'adjust' ? 'adjust' : 'buy';
    if (dir === 'buy')      { buckets[idx].buys     += cash; buckets[idx].net += cash; }
    else if (dir === 'sell'){ buckets[idx].sells    += cash; buckets[idx].net -= cash; }
    else if (dir === 'dividend') { buckets[idx].dividends += cash; }
    // 'adjust' has no cash leg — intentionally skipped.
  }
  for (const b of buckets) {
    b.net = r2(b.net);
    b.buys = r2(b.buys);
    b.sells = r2(b.sells);
    b.dividends = r2(b.dividends);
  }

  const last12mNetContrib  = buckets.reduce((s, b) => s + b.net, 0);
  const last12mDistribOnly = buckets.reduce((s, b) => s + b.dividends, 0);

  // Idle cash: investment accounts with positive balance but no live units.
  // What has cleared — scheduled rows aren't real cash yet.
  const unitsByAcct = new Map();
  for (const h of allHoldings) {
    unitsByAcct.set(h.accountId, (unitsByAcct.get(h.accountId) || 0) + (Number(h.units) || 0));
  }
  const idleCash = [];
  for (const acc of investmentAccounts) {
    const bal = Number(postedBalance.get(acc.id)) || 0;
    const units = unitsByAcct.get(acc.id) || 0;
    if (bal > 0 && Math.abs(units) < 1e-6) {
      idleCash.push({ account_id: acc.id, balance: r2(bal) });
    }
  }

  const totalDistributions = allHoldings.reduce((s, h) => s + (Number(h.distributions) || 0), 0);
  const totalRealized = allHoldings.reduce((s, h) => s + (h.valuationOnly ? 0 : Number(h.realized) || 0), 0);

  return {
    today: todayIso(today),
    currency: meta?.currency || null,
    accounts: investmentAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      balance: r2(postedBalance.get(a.id) || 0),
    })),
    holdings,
    symbol_mix: symbolMix,
    contributions: {
      monthly: buckets,
      last12m_net_contrib:  r2(last12mNetContrib),
      last12m_dividend_total: r2(last12mDistribOnly),
    },
    idle_cash: idleCash,
    totals: {
      cost_basis:    r2(totalCost),
      distributions: r2(totalDistributions),
      realized:      r2(totalRealized),
      symbols: bySymbol.size,
    },
    refs: refsFromState(state),
  };
}

// ── Conversational search ────────────────────────────────────────────────

/**
 * @param {any} state
 * @param {() => Date} clock  required: the one read of "now" for this build
 */
export function buildSearchCtx(state, clock) {
  return {
    today: todayIso(clock()),
    envelopes: (state.envelopes || []).filter((e) => !e.archived).map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category || null,
    })),
    accounts: (state.accounts || []).filter((a) => !a.archived).map((a) => ({
      id: a.id,
      name: a.name,
    })),
  };
}
