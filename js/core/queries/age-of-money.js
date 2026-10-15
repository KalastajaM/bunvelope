// js/core/queries/age-of-money.js — Age of Money, as the Dashboard's tile and
// its detail sheet show it: the headline days with the money cushion behind
// them, the month-end trend (its last point is the date itself, as its month
// has not ended), and why the trend dropped where it did.
//
// Everything reads the operating money (js/core/operational.js): the spending
// accounts and the rows that move them, so a dividend landing on savings does
// not make money look older. Posted rows only, whatever the lens: the engine's
// Age of Money is a fact about cleared money.
//
// A drop is flagged where a month's AoM fell 7 days or more below the month
// before (the engine's threshold, which attributeAgeOfMoneyDrop applies
// itself; the check here only skips the detailed walks for the months that
// cannot qualify). Its kind is the engine's attribution: one big expense, a
// gap between incomes, or a broad shift.
//
// Transfers count where they cross the spending accounts' edge (owner decision
// 2026-10-06, the usual definition): money moved out (to savings, investments,
// a loan's principal) consumes the oldest money, money moved in is new money;
// a transfer between two spending accounts is neutral. Only spending is
// averaged, so the outflows change which money is left, not what is measured.
//
// One-off inflows are left out of the walk (engine AOM_ONE_OFF_FACTOR: an
// income row above 3x the median monthly income of the 12 months before it);
// the ones dated in the history's span are listed in `oneOffs`. `health` is
// green only when the runway agrees (AOM_HEALTHY_RUNWAY_DAYS, 90 days);
// `runwayLimited` says the runway held it at yellow.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { operationalAccounts, operationalAomTransactions } from '../operational.js';
import {
  computeAgeOfMoneyHistory, computeAgeOfMoneyDetailed, computeMoneyCushion, attributeAgeOfMoneyDrop,
  aomOneOffIncomes,
} from '../../engine/history.js';
import { round2 } from '../../utils.js';

// Below this many days a fall is not a drop. It mirrors the engine's private
// AOM_DROP_THRESHOLD_DAYS (js/engine/history.js), which attributeAgeOfMoneyDrop
// applies itself: this pre-check only skips the two detailed walks for a pair
// that cannot qualify, as the page did. tests/core-query-aom-upcoming.test.js
// pins the two together (a fall of 6 days and one of 7).
const DROP_DAYS = 7;

/**
 * The flagged drops along a history, oldest first, in the answer's shape.
 * @param {any[]} history  computeAgeOfMoneyHistory's samples
 * @param {any[]} txs      the operating rows
 * @param {any[]} allTxs   every row, for the payee of a big expense
 * @param {number} windowDays
 */
function drops(history, txs, allTxs, windowDays) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (a.aom == null || b.aom == null) continue;
    if (a.aom - b.aom < DROP_DAYS) continue;
    const r = attributeAgeOfMoneyDrop(
      computeAgeOfMoneyDetailed(txs, a.refDate, windowDays),
      computeAgeOfMoneyDetailed(txs, b.refDate, windowDays),
    );
    if (!r) continue;
    const base = { month: b.monthKey, kind: r.kind, drop: r.drop };
    if (r.kind === 'big_expense') {
      const tx = (allTxs || []).find((/** @type {any} */ t) => t.id === r.txId);
      out.push({ ...base, txId: r.txId, payee: tx?.payee || null, amount: round2(r.amount), ageDays: r.ageDays, share: r.share });
    } else if (r.kind === 'income_gap') {
      out.push({ ...base, gapStart: isoDate(r.gapStart), gapEnd: isoDate(r.gapEnd), gapDays: r.gapDays });
    } else {
      out.push(base);
    }
  }
  return out;
}

export default {
  name: 'ageOfMoney',
  summary: 'Age of Money over the spending accounts (posted rows, not the lens): days (how old the money spent in the last windowDays was) with its health, the cushion behind it (runwayDays, recentSpendPerDay, liquidBalance over the non-archived spending accounts), the month-end history ending with date\'s month (that month sampled at date itself, so its point is the headline), and drops: each month whose Age of Money fell 7 days or more, explained as a big_expense (with the row and its payee), an income_gap or a broad_shift. Money moved out of the spending accounts by transfer consumes the oldest money first (not averaged as spending); money moved in counts as income; transfers between spending accounts are neutral. One-off inflows (an income row above 3x the median monthly income of the 12 months before it) are left out; oneOffs lists those dated in the history\'s months (txId, date, payee, amount). health is green only with at least 90 days of runway; runwayLimited is true when the runway held it at yellow.',
  input: {
    type: 'object',
    properties: {
      date: { type: 'date', description: 'The day the headline is about; the history ends with its month (YYYY-MM-DD, default today)' },
      months: { type: 'integer', minimum: 1, maximum: 36, default: 12, description: 'How many months the history has (1-36, default 12)' },
      windowDays: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'The trailing window each figure looks back over, in days (1-365, default 30)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ date?: string, months: number, windowDays: number }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    const { months, windowDays } = input;
    const txs = operationalAomTransactions(data.accounts, data.transactions);
    const history = computeAgeOfMoneyHistory(txs, { refDate: ref, months, windowDays });
    const cushion = computeMoneyCushion(operationalAccounts(data.accounts), txs, ref, windowDays);
    const from = history.length ? `${history[0].monthKey}-01` : '';
    const through = isoDate(ref);
    const oneOffs = aomOneOffIncomes(txs)
      .filter(o => o.date >= from && o.date <= through)
      .map(o => ({
        txId: o.txId,
        date: o.date,
        payee: (data.transactions || []).find((/** @type {any} */ t) => t.id === o.txId)?.payee || null,
        amount: o.amount,
      }));
    return ok({
      days: cushion.aom,
      health: cushion.health,
      runwayLimited: cushion.runwayLimited,
      runwayDays: cushion.runwayDays,
      recentSpendPerDay: round2(cushion.recentSpendPerDay),
      liquidBalance: round2(cushion.liquidBalance),
      history: history.map(h => ({ month: h.monthKey, date: isoDate(h.refDate), days: h.aom })),
      drops: drops(history, txs, data.transactions, windowDays),
      oneOffs,
    });
  },
};
