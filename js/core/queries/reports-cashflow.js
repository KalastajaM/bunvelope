// js/core/queries/reports-cashflow.js — income, spending and saving per month
// over a date range, their totals, and the 12-month averages: the Reports
// page's KPI strip, its income-vs-spending chart and its spending and saving
// bar charts.
//
// The stored rows, not a lens (a range of history). The months are those with
// any row in the range (sparse, not zero-filled). Saving is money moved
// across the saving boundary (savings, investment and loan accounts; loan
// principal included); excludeEnvelopes changes Spending only.
//
// The averages are over the 12 calendar months ending with the range's end,
// whatever range is asked: a range ending before `date` ends there, one
// running to `date` (or past it, or open) ends with the last COMPLETE month,
// since the month under way has only part of its spending yet. The averages
// count from the budget's first month with data when that is later; the
// answer's `window` is the 12 calendar months, before that clamp. An average is
// null where there is none to draw: no row in the window, or (income,
// spending, saving) every month in it zero, or (spendingByMonth) exactly zero.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { RANGE_INPUT, EXCLUDE_ENVELOPES, EXCLUDE_PAYEES, reportFlow, monthPoints } from '../report-input.js';
import {
  aggregateIncomeVsSpending, aggregateSpendingByMonth, aggregateSavingByMonth,
  trailingWindowStart, trailingMonthlyAverage,
} from '../../engine/reports.js';
import { round2 } from '../../utils.js';

/** The engine's series names, and the keys the answer gives them. */
const SERIES = /** @type {const} */ ([['income', 'Income'], ['spending', 'Spending'], ['saving', 'Saving']]);

/**
 * Where the 12-month averages' window ends: a range ending before `today`
 * ends there; one that runs to `today` (or later, or open-ended) ends at the
 * last day of the month before today's.
 * @param {string | null} rangeTo  'YYYY-MM-DD'
 * @param {string} today  'YYYY-MM-DD'
 * @returns {{ endYm: string, endIso: string }}
 */
export function averageWindowEnd(rangeTo, today) {
  if (rangeTo && rangeTo < today) return { endYm: rangeTo.slice(0, 7), endIso: rangeTo };
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, 0)); // last day of the month before
  const endIso = prev.toISOString().slice(0, 10);
  return { endYm: endIso.slice(0, 7), endIso };
}

/**
 * Saving per month over every month of the answer, zero where no row crossed
 * the saving boundary: the engine's series has only the months with saving
 * rows, so a month without one dropped out of the Saving by Month chart (the
 * owner's September 2026) while the KPI series read 0 for it. Empty when the
 * range has no saving at all, so a budget with no savings accounts keeps its
 * empty chart.
 * @param {string[]} months  'YYYY-MM', the answer's months
 * @param {{ label: string, value: number }[]} points  aggregateSavingByMonth's
 * @returns {{ month: string, value: number }[]}
 */
export function savingMonths(months, points) {
  if (!points.length) return [];
  const byMonth = new Map(points.map(p => [p.label, p.value]));
  const all = [...new Set([...months, ...byMonth.keys()])].sort();
  return all.map(month => ({ month, value: byMonth.get(month) ?? 0 }));
}

export default {
  name: 'reports.cashflow',
  summary: 'Per month of the range (only months with rows): income, spending and saving (money moved into savings, investment or loan accounts, less what came back out), their totals and net (income minus spending); spendingByMonth (months with spending) and savingByMonth (every month of the answer, 0 where nothing was saved; empty when the range has no saving rows); and averages: per calendar month over the 12 months ending with the range\'s end (or with the last complete month, when the range runs to date), counted from the later of window.from and the budget\'s first month (window is the 12 calendar months, before that clamp); null where there is no average to draw. excludeEnvelopes changes spending only; excludePayees drops whole rows.',
  input: {
    type: 'object',
    properties: {
      ...RANGE_INPUT,
      date: { type: 'date', description: 'Today for this query: a range running to it averages up to the month before (YYYY-MM-DD, default today)' },
      excludeEnvelopes: EXCLUDE_ENVELOPES,
      excludePayees: EXCLUDE_PAYEES,
    },
  },
  /**
   * @param {any} data
   * @param {{ from?: string, to?: string, date?: string, excludeEnvelopes?: string[], excludePayees?: string[] }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const { txs, range, opts } = reportFlow(data, input);
    const accounts = opts.accounts;
    const ivs = aggregateIncomeVsSpending(txs, accounts, range, opts);
    const seriesOf = (/** @type {any} */ result, /** @type {string} */ name) => result.series.find((/** @type {any} */ s) => s.name === name).points;

    /** @type {Record<string, number>} */
    const sums = {};
    for (const [key, name] of SERIES) sums[key] = seriesOf(ivs, name).reduce((/** @type {number} */ s, /** @type {any} */ p) => s + p.value, 0);

    const { endYm, endIso } = averageWindowEnd(range.to, isoDate(refDate(input, ctx)));
    const window = { from: `${trailingWindowStart(endYm, 12)}-01`, to: endIso };
    const firstYm = (data.transactions || []).reduce((/** @type {string} */ m, /** @type {any} */ tx) => (tx.date && (!m || tx.date < m) ? tx.date : m), '').slice(0, 7) || null;
    const avgOf = (/** @type {{ label: string, value: number }[]} */ points) => trailingMonthlyAverage(points, endYm, 12, firstYm);
    const ivs12 = aggregateIncomeVsSpending(txs, accounts, window, opts);
    /** @type {Record<string, number | null>} */
    const averages = {};
    for (const [key, name] of SERIES) {
      const points = seriesOf(ivs12, name);
      const value = avgOf(points);
      averages[key] = value == null || points.every((/** @type {any} */ p) => p.value === 0) ? null : value;
    }
    const avgSpend = avgOf(aggregateSpendingByMonth(txs, window, opts));

    return ok({
      months: ivs.months,
      income: monthPoints(seriesOf(ivs, 'Income')),
      spending: monthPoints(seriesOf(ivs, 'Spending')),
      saving: monthPoints(seriesOf(ivs, 'Saving')),
      totals: {
        income: round2(sums.income),
        spending: round2(sums.spending),
        saving: round2(sums.saving),
        net: round2(sums.income - sums.spending),
      },
      spendingByMonth: monthPoints(aggregateSpendingByMonth(txs, range, opts)),
      savingByMonth: savingMonths(ivs.months, aggregateSavingByMonth(txs, accounts, range)),
      averages: {
        window,
        income: averages.income,
        spending: averages.spending,
        saving: averages.saving,
        spendingByMonth: avgSpend == null || avgSpend === 0 ? null : avgSpend,
      },
    });
  },
};
