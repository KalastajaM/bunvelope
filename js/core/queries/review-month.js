// js/core/queries/review-month.js — the Review page's numbers as a query:
// one row per active envelope for a month (runMonthlyReview), the emergency
// envelope's required reserve, and optionally one envelope's transactions in
// the month, classified as the page's detail row shows them.
//
// Composed exactly as js/pages/review.js did: the effective transactions are
// the real rows plus the forecast rows for the month (netted against hand
// payments, tombstones honoured), balances are as of now, and a future month
// rolls the balances forward through the months in between. The clock is
// `ctx.now`, the instant the page read from appNow().
//
// The page's sums come with the rows: `totals` (the footer), `categoryTotals`
// (a subtotal per category, in row order), per row `consolidateDelta` (the
// amount that brings the surplus to zero) and `available` (the envelope's
// booked balance over every row, the consolidate popover's figure),
// `negativeCount` (rows below zero, the close-month confirmation) and, in
// `detail`, each section's total. Sums are of the unrounded rows, rounded on
// output. Each row also carries `need`: the gap to fill, the amount that
// brings its projected end-of-month balance up to the required reserve (zero
// when there is a surplus), which Fill envelopes offers as "fill to need".
//
// A past month (`isPast`) is reviewed as it stood at its end: the ledger is
// the rows dated on or before its last day, balances are as of that day, and
// that day is the review's clock (`asOf`). Rows booked later, and anything
// the forecast would add, are not part of it. The current and future months
// are unchanged.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { MONTH_RE, badMonth } from '../lens-input.js';
import { round2 } from '../../utils.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { buildEffectiveTxList } from '../effective-txs.js';
import { computeEnvelopeBalances, filterTransactions } from '../../engine/balances.js';
import { runMonthlyReview, computeEmergencyFundRequirement, rollForwardEnvelopeBalances } from '../../engine/monthly-review.js';

/** The local calendar month of `d` as YYYY-MM. @param {Date} d */
const monthKey = (d) => isoDate(d).slice(0, 7);

/** First and last day of `month` (YYYY-MM), YYYY-MM-DD. @param {string} month */
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: isoDate(new Date(y, m, 0)) };
}

/**
 * Real rows plus forecast rows from tomorrow through `end` (from `start` when
 * given). A month already over yields the real rows alone: the forecast
 * helpers start at tomorrow.
 * @param {any} data
 * @param {Date} today  the clock, an instant
 * @param {string} end
 * @param {string} [start]
 */
function effectiveTxs(data, today, end, start) {
  if (isoDate(today) > end) return data.transactions || [];
  return buildEffectiveTxList({
    transactions:      data.transactions || [],
    budgetItems:       data.budgetItems || [],
    envelopeTemplates: data.envelopeTemplates || [],
    accounts:          data.accounts || [],
    envelopes:         data.envelopes || [],
    today,
    endStr: end,
    ...(start ? { fromStr: start } : {}),
    country: monthCountry(data),
    tombstones: monthTombstones(data),
  });
}

/** The footer's columns, summed over a set of rows. */
const TOTAL_KEYS = /** @type {const} */ (['balance', 'actual', 'scheduled', 'planned', 'projected', 'D', 'required', 'startNext', 'surplus']);

/**
 * The column sums of `rows`, summed unrounded as the page did, rounded.
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, number>}
 */
function columnTotals(rows) {
  /** @type {Record<string, number>} */
  const acc = Object.fromEntries(TOTAL_KEYS.map(k => [k, 0]));
  for (const r of rows) for (const k of TOTAL_KEYS) acc[k] += r[k];
  return Object.fromEntries(TOTAL_KEYS.map(k => [k, round2(acc[k])]));
}

/**
 * A subtotal per category, the categories in the order their first row has.
 * An envelope without a category groups under null (undefined would vanish
 * from the answer's JSON).
 * @param {Record<string, any>[]} rows
 */
function categoryTotals(rows) {
  /** @type {Map<string | null, Record<string, any>[]>} */
  const byCategory = new Map();
  for (const row of rows) {
    const category = row.category ?? null;
    if (!byCategory.has(category)) byCategory.set(category, []);
    /** @type {Record<string, any>[]} */ (byCategory.get(category)).push(row);
  }
  return [...byCategory].map(([category, catRows]) => ({ category, totals: columnTotals(catRows) }));
}

/**
 * A detail section's total: the rows' stored amounts, unsigned, as the page
 * summed them (a split counts whole; a row without an amount adds nothing).
 * @param {any[]} rows
 */
const sectionTotal = (rows) => round2(rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0));

/** A local Date for a YYYY-MM-DD(…) string, or null. @param {any} s */
function parseLocalDate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** A copy of `tx` without the `__`-prefixed properties a page may have left on it. */
const cleanRow = (tx) => Object.fromEntries(Object.entries(tx).filter(([k]) => !k.startsWith('__')));

/**
 * The envelope's rows dated in `month`: any row touching it (envelope,
 * transfer source or destination, a split), classified as the page's detail
 * row does. Scheduled or forecast rows are overdue before today and coming
 * from today; other rows dated after today are future; the rest are actual.
 * @param {any[]} effective
 * @param {string} envelopeId
 * @param {string} month
 * @param {Date} today  local midnight
 */
function envelopeDetail(effective, envelopeId, month, today) {
  const [y, m] = month.split('-').map(Number);
  const touchesEnvelope = (tx) => tx.envelope_id === envelopeId
    || tx.from_envelope_id === envelopeId
    || tx.to_envelope_id === envelopeId
    || (Array.isArray(tx.envelope_splits) && tx.envelope_splits.some(s => s.envelope_id === envelopeId));
  const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
  const txs = effective
    .filter(touchesEnvelope)
    .filter(tx => {
      const d = parseLocalDate(tx.date);
      return d && d.getFullYear() === y && d.getMonth() + 1 === m;
    })
    .sort(byDate);

  /** @type {{ actual: any[], overdue: any[], coming: any[], future: any[] }} */
  const sections = { actual: [], overdue: [], coming: [], future: [] };
  for (const tx of txs) {
    const d = parseLocalDate(tx.date);
    const isScheduled = (tx.status || '') === 'scheduled' || !!tx.is_forecast;
    const list = isScheduled
      ? (d && d < today ? sections.overdue : sections.coming)
      : (d && d > today ? sections.future : sections.actual);
    list.push(cleanRow(tx));
  }
  /** @type {{ envelope: string, actual: any[], overdue: any[], coming: any[], future: any[], totals: { actual: number, overdue: number, coming: number, future: number } }} */
  const detail = {
    envelope: envelopeId,
    ...sections,
    totals: {
      actual: sectionTotal(sections.actual),
      overdue: sectionTotal(sections.overdue),
      coming: sectionTotal(sections.coming),
      future: sectionTotal(sections.future),
    },
  };
  return detail;
}

export default {
  name: 'review.month',
  summary: 'The monthly envelope review (a past month as it stood at its last day, isPast and asOf saying so): per active envelope (with includeArchived, archived ones too) the balance, actual and scheduled spend, plan, projected end-of-month balance, required reserve and surplus, as the Review page shows them, each with need (the gap to the required reserve, zero on a surplus), consolidateDelta (the move that zeroes the surplus) and available (its booked balance over every row); totals and categoryTotals (the column sums, overall and per category in row order) and negativeCount (rows below zero). With envelope, also that envelope\'s transactions in the month (actual, overdue, coming, future) and each section\'s total.',
  input: {
    type: 'object',
    properties: {
      month: { type: 'string', description: 'The month to review, YYYY-MM (default this month)' },
      envelope: { type: 'ref', kind: 'envelope', description: 'Also list this envelope\'s transactions in the month' },
      includeArchived: { type: 'boolean', default: false, description: 'Review archived envelopes too (each row says whether it is archived)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ month?: string, envelope?: string, includeArchived?: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, { month: monthInput, envelope, includeArchived = false }, ctx) {
    if (monthInput !== undefined && !MONTH_RE.test(monthInput)) return badMonth();
    const currentMonth = monthKey(ctx.now);
    const month = monthInput ?? currentMonth;
    const isFuture = month > currentMonth;
    const isCurrent = month === currentMonth;
    const isPast = month < currentMonth;
    const { start, end } = monthBounds(month);
    const budgetItems = data.budgetItems || [];
    // A past month's clock is its last day, late enough that every row dated
    // that day counts as happened; its ledger is what was dated by then.
    const [endY, endM, endD] = end.split('-').map(Number);
    const today = isPast ? new Date(endY, endM - 1, endD, 23, 59, 59) : ctx.now;
    const transactions = isPast
      ? filterTransactions(data.transactions || [], { asOf: end })
      : (data.transactions || []);
    // A month already over adds no forecast rows (see effectiveTxs).
    const effective = isPast ? transactions : effectiveTxs(data, today, end, start);
    // As of the review's clock: runMonthlyReview subtracts the future-dated and forecast
    // rows itself (`scheduled`), so they must not be in the balance too.
    const todaysBalances = computeEnvelopeBalances(transactions, { asOf: today });
    const activeEnvelopes = (data.envelopes || []).filter(e =>
      (includeArchived || !e.archived) && !(e.name || '').startsWith('(deleted:'));
    const archivedIds = new Set(activeEnvelopes.filter(e => e.archived).map(e => e.id));
    const activeIds = new Set(activeEnvelopes.map(e => e.id));

    let envelopeBalances = todaysBalances;
    if (isFuture) {
      const spanTxs = effectiveTxs(data, today, end);
      envelopeBalances = rollForwardEnvelopeBalances(activeEnvelopes, budgetItems, todaysBalances, spanTxs, month, today);
    }

    // Every booked row, whatever its date: what consolidating moves money from.
    const bookedBalances = computeEnvelopeBalances(data.transactions || []);
    const emergency = computeEmergencyFundRequirement({
      envelopes: data.envelopes,
      budgetItems,
      transactions,
      month,
      meta: data.meta,
    });
    // Copies: the engine's rows are never written to.
    const rows = runMonthlyReview(activeEnvelopes, budgetItems, envelopeBalances, effective, month, today)
      .filter(r => activeIds.has(r.envelope_id))
      .map(r => (emergency && r.envelope_id === emergency.emergencyId
        ? {
          ...r,
          required: emergency.required,
          surplus: Math.round((r.projected - emergency.required) * 100) / 100,
          isEmergency: true,
        }
        : { ...r, isEmergency: false }))
      .map(r => ({
        ...r,
        // null, not undefined, for an envelope without one: it stays in the JSON.
        category: r.category ?? null,
        archived: archivedIds.has(r.envelope_id),
        consolidateDelta: Math.round(-r.surplus * 100) / 100,
        need: r.surplus < -0.005 ? round2(-r.surplus) : 0,
        available: round2(bookedBalances.get(r.envelope_id) ?? 0),
      }));

    /** @type {Record<string, any>} */
    const answer = {
      month,
      isCurrent,
      isFuture,
      isPast,
      asOf: isoDate(today),
      rows,
      emergencyEnvelopeId: emergency ? emergency.emergencyId : null,
      totals: columnTotals(rows),
      categoryTotals: categoryTotals(rows),
      negativeCount: rows.filter(r => r.balance < -0.005).length,
    };
    if (envelope !== undefined) answer.detail = envelopeDetail(effective, envelope, month,
      isPast ? new Date(endY, endM - 1, endD) : ctx.today);
    return ok(answer);
  },
};
