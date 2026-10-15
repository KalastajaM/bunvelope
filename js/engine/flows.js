// js/engine/flows.js — the Money flow page's Sankey data: where the money
// comes from and where it goes, for the plan (budget items over a month or a
// year) or the actuals (posted transactions in a date range). Pure; no clock,
// no DOM.
//
// The rules are the ones the Charts page already uses, so the two cannot
// disagree: spending is `txConsumptionPairs`, saving is the saving-boundary
// rule (`savingEffect`), split into Saving and Debt repayment by the saving
// side's account (`savingBoundary`). Plan items take the same boundary on
// their own from/to accounts. A negative net in either bucket is money that
// came OUT of savings or a loan, so it is drawn as a source on the left.
//
// Design: docs/superpowers/specs/2026-10-02-money-flow-sankey-design.md

import { round2 } from '../utils.js';
import { MONTH_NAMES, isIncomeLikeItem } from './_constants.js';
import { computeAnnual } from './monthly-review.js';
import { txConsumptionPairs, loanAccountIds } from './balances.js';
import { txAbsAmount, isPostedTx } from './tx-amounts.js';
import { savingBoundary, txSavingFlow, txPayeeLabel } from './reports.js';

/**
 * @typedef {'source'|'fromSavings'|'borrowed'|'shortfall'|'budget'|'category'|'envelope'|'saving'|'debt'|'unspent'} FlowNodeKind
 */
/**
 * A node. `label` is raw data (payee, item description, envelope name,
 * category id), or null where the page supplies the name; the page
 * translates. `other` is the number of rows folded into an "Other" node.
 * Envelope nodes carry `key` (the envelope id, null when folded) and
 * `category`; category nodes carry `category`.
 * @typedef {{
 *   id: string, kind: FlowNodeKind, column: number, label: string | null, value: number,
 *   key?: string | null, category?: string, other?: number,
 * }} FlowNode
 */
/** @typedef {{ source: string, target: string, value: number }} FlowLink */
/** @typedef {{ nodes: FlowNode[], links: FlowLink[], totals: { in: number, out: number } }} Flow */
/**
 * @typedef {{ excludeEnvelopes?: Set<string>, topSources?: number, topPerCategory?: number, loanSplits?: Map<string, { principal: number, expense: number }> }} FlowOptions
 * `topSources` (default 8) and `topPerCategory` (default 6; Infinity for no
 * folding) cap the income sources and the envelopes per category.
 */
/** @typedef {{ period: 'year' } | { period: 'month', month: string }} PlanPeriod */
/**
 * @typedef {{ sources: Map<string, number>, spending: Map<string, number>, saving: number, debt: number }} FlowSums
 */

const EPS = 0.005;

/** @returns {FlowSums} */
function emptySums() {
  return { sources: new Map(), spending: new Map(), saving: 0, debt: 0 };
}

/**
 * @param {Map<string, number>} map
 * @param {string} key
 * @param {number} v
 */
function bump(map, key, v) {
  map.set(key, (map.get(key) || 0) + v);
}

/**
 * A plan item's magnitude for the period: the year as `computeAnnual` counts
 * it (buffer included, so it matches the Plan page's annual totals), or one
 * month's schedule entry (no buffer).
 * @param {any} item
 * @param {string | undefined} mon  a `MONTH_NAMES` entry, or undefined for the year
 * @returns {number}
 */
function planAmount(item, mon) {
  if (!mon) return computeAnnual(item);
  const v = item?.monthly_schedule?.[mon];
  if (v === true) return Math.abs(item.default_amount ?? 0);
  return typeof v === 'number' ? Math.abs(v) : 0;
}

/**
 * The accounts a transfer-shaped plan item moves money between, as the rows
 * it posts do (`scheduling.js`); null for every other kind.
 * @param {any} item
 * @returns {[string | undefined, string | undefined] | null}
 */
function planMove(item) {
  if (item.kind === 'investment_transfer') return [item.account_id, item.investment_account_id];
  if (item.kind === 'account_transfer' || item.kind === 'loan_payment') return [item.account_id, item.to_account_id];
  return null;
}

/**
 * The flow the plan describes for one month or the year. Income items and
 * dividends are the sources; expense items land in their envelopes; buys,
 * transfers and loan payments that cross the saving boundary are Saving,
 * Debt repayment or From savings.
 *
 * @param {any[]} budgetItems
 * @param {any[]} envelopes
 * @param {any[]} accounts
 * @param {PlanPeriod} period
 * @param {FlowOptions} [opts]
 * @returns {Flow}
 */
export function buildPlanFlow(budgetItems, envelopes, accounts, period, opts = {}) {
  const isYear = period?.period === 'year';
  const month = period?.period === 'month' ? period.month : '';
  if (!isYear && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('buildPlanFlow: period must be { period: "year" } or { period: "month", month: "YYYY-MM" }');
  }
  const mon = isYear ? undefined : MONTH_NAMES[Number(month.slice(5, 7)) - 1];
  const byId = new Map((accounts || []).map(a => [a.id, a]));
  const sums = emptySums();
  for (const item of budgetItems || []) {
    if (!item || item.include === false) continue;
    const amt = planAmount(item, mon);
    if (!(amt > 0)) continue;
    if (isIncomeLikeItem(item)) {
      bump(sums.sources, item.description || '', amt);
      continue;
    }
    const split = item.kind === 'loan_payment' ? opts.loanSplits?.get(item.id) : null;
    if (split) {
      const boundary = savingBoundary(byId.get(item.account_id), byId.get(item.to_account_id));
      if (boundary) sums[boundary.bucket] += boundary.direction === 'in' ? split.principal : -split.principal;
      const envId = item.envelope_id || '';
      if (!opts.excludeEnvelopes?.has(envId)) bump(sums.spending, envId, split.expense);
      continue;
    }
    const move = planMove(item);
    if (move) {
      const b = savingBoundary(byId.get(move[0]), byId.get(move[1]));
      if (b) sums[b.bucket] += b.direction === 'in' ? amt : -amt;
      continue;
    }
    const envId = item.envelope_id || '';
    if (opts.excludeEnvelopes?.has(envId)) continue;
    bump(sums.spending, envId, amt);
  }
  return assemble(sums, envelopes, opts);
}

/**
 * The flow the posted transactions in `range` made. Income rows, grouped by
 * payee, are the sources; spending is `txConsumptionPairs` per envelope; the
 * saving boundary nets into Saving / From savings and Debt repayment /
 * Borrowed.
 *
 * @param {any[]} transactions
 * @param {any[]} accounts
 * @param {any[]} envelopes
 * @param {{ from: string | null, to: string | null }} range  inclusive ISO dates; either may be null
 * @param {FlowOptions} [opts]
 * @returns {Flow}
 */
export function buildActualFlow(transactions, accounts, envelopes, range, opts = {}) {
  if (!range) throw new Error('buildActualFlow: range { from, to } is required');
  const byId = new Map((accounts || []).map(a => [a.id, a]));
  const loans = loanAccountIds(accounts);
  const sums = emptySums();
  for (const tx of transactions || []) {
    if (!tx?.date || (range.from && tx.date < range.from) || (range.to && tx.date > range.to)) continue;
    // Actual means posted: a scheduled or forecast row has moved no money.
    // (Spending already applies this through txSpendPairs.)
    if (!isPostedTx(tx)) continue;
    if (tx.type === 'income') {
      bump(sums.sources, txPayeeLabel(tx), txAbsAmount(tx));
      continue;
    }
    for (const [envId, amt] of txConsumptionPairs(tx, loans)) {
      if (opts.excludeEnvelopes?.has(envId)) continue;
      bump(sums.spending, envId || '', amt);
    }
    const s = txSavingFlow(tx, byId);
    if (s) sums[s.bucket] += s.amount;
  }
  return assemble(sums, envelopes, opts);
}

/**
 * Top `n` of `rows` (already sorted), the rest folded into one row by
 * `fold(rest)`. A fold of a single row is no fold: that row is shown.
 * @template T
 * @param {T[]} rows
 * @param {number} n
 * @param {(rest: T[]) => T} fold
 * @returns {T[]}
 */
function topN(rows, n, fold) {
  if (!(n >= 0) || rows.length <= n + 1) return rows;
  return [...rows.slice(0, n), fold(rows.slice(n))];
}

/** @param {{ value: number, label?: string | null }} a @param {{ value: number, label?: string | null }} b */
const byValueDesc = (a, b) => b.value - a.value || String(a.label ?? '').localeCompare(String(b.label ?? ''));

/** @param {{ value: number }[]} rows */
const sumOf = rows => round2(rows.reduce((s, r) => s + r.value, 0));

/**
 * Shape the raw sums into nodes and links. Values are rounded first and every
 * total is a sum of rounded values, so each node's inflow equals its outflow
 * exactly; Unspent or Shortfall is what makes the two sides meet.
 * @param {FlowSums} sums
 * @param {any[]} envelopes
 * @param {FlowOptions} opts
 * @returns {Flow}
 */
function assemble(sums, envelopes, opts) {
  const topSources = opts.topSources ?? 8;
  const topPerCategory = opts.topPerCategory ?? 6;
  const envById = new Map((envelopes || []).map(e => [e.id, e]));

  /** @type {FlowNode[]} */
  const sourceRows = [...sums.sources]
    .map(([label, v]) => ({ id: `src:${label}`, kind: /** @type {FlowNodeKind} */ ('source'), column: 0, label, value: round2(v) }));
  const sources = topN(
    sourceRows.filter(n => n.value > EPS).sort(byValueDesc),
    topSources,
    /** @returns {FlowNode} */
    rest => ({ id: 'src:other', kind: 'source', column: 0, label: null, value: sumOf(rest), other: rest.length }),
  );

  const refunds = [...sums.spending].filter(([, v]) => round2(v) < -EPS).map(([envId, v]) => ({
    id: `refund:${envId}`, kind: /** @type {FlowNodeKind} */ ('envelope'), column: 0,
    label: envById.get(envId)?.name ?? null, value: -round2(v), key: envId || null,
    category: envById.get(envId)?.category || 'other',
  }));
  const fromSavings = round2(Math.max(0, -sums.saving));
  const borrowed = round2(Math.max(0, -sums.debt));
  const saving = round2(Math.max(0, sums.saving));
  const debt = round2(Math.max(0, sums.debt));

  /** @type {Map<string, FlowNode[]>} */
  const envsByCat = new Map();
  for (const [envId, v] of sums.spending) {
    const value = round2(v);
    if (value <= EPS) continue;
    const env = envById.get(envId);
    const category = env?.category || 'other';
    if (!envsByCat.has(category)) envsByCat.set(category, []);
    /** @type {FlowNode[]} */ (envsByCat.get(category)).push({
      id: `env:${envId}`, kind: 'envelope', column: 3, label: env?.name ?? null, value, key: envId || null, category,
    });
  }
  const categories = [...envsByCat].map(([category, envs]) => {
    const sorted = envs.sort(byValueDesc);
    /** @type {FlowNode[]} */
    const shown = topN(sorted, topPerCategory, /** @returns {FlowNode} */ rest => ({
      id: `env-other:${category}`, kind: 'envelope', column: 3, label: null,
      value: sumOf(rest), key: null, category, other: rest.length,
    }));
    /** @type {FlowNode} */
    const node = { id: `cat:${category}`, kind: 'category', column: 2, label: category, value: sumOf(sorted), category };
    return { node, envs: shown };
  }).sort((a, b) => byValueDesc(a.node, b.node));

  const totalIn = round2(sumOf(sources) + sumOf(refunds) + fromSavings + borrowed);
  const totalOut = round2(categories.reduce((s, c) => s + c.node.value, 0) + saving + debt);
  const diff = round2(totalIn - totalOut);

  /** @type {FlowNode[]} */
  const left = [...sources, ...refunds];
  if (fromSavings > EPS) left.push({ id: 'fromSavings', kind: 'fromSavings', column: 0, label: null, value: fromSavings });
  if (borrowed > EPS) left.push({ id: 'borrowed', kind: 'borrowed', column: 0, label: null, value: borrowed });
  if (diff < -EPS) left.push({ id: 'shortfall', kind: 'shortfall', column: 0, label: null, value: -diff });

  /** @type {FlowNode[]} */
  const middle = categories.map(c => c.node);
  if (saving > EPS) middle.push({ id: 'saving', kind: 'saving', column: 2, label: null, value: saving });
  if (debt > EPS) middle.push({ id: 'debt', kind: 'debt', column: 2, label: null, value: debt });
  if (diff > EPS) middle.push({ id: 'unspent', kind: 'unspent', column: 2, label: null, value: diff });

  const inTotal = round2(left.reduce((s, n) => s + n.value, 0));
  if (inTotal <= EPS) return { nodes: [], links: [], totals: { in: 0, out: 0 } };

  /** @type {FlowNode} */
  const budget = { id: 'budget', kind: 'budget', column: 1, label: null, value: inTotal };
  /** @type {FlowLink[]} */
  const links = [
    ...left.map(n => ({ source: n.id, target: 'budget', value: n.value })),
    ...middle.map(n => ({ source: 'budget', target: n.id, value: n.value })),
    ...categories.flatMap(c => c.envs.map(e => ({ source: c.node.id, target: e.id, value: e.value }))),
  ];
  return {
    nodes: [...left, budget, ...middle, ...categories.flatMap(c => c.envs)],
    links,
    totals: { in: inTotal, out: round2(middle.reduce((s, n) => s + n.value, 0)) },
  };
}
