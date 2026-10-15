import { stressExpenses, stressExpenseAnnual } from '../../engine/stress-expenses.js';
// js/core/queries/stress-runway.js — the Stress page's figures: the cash a
// household could live on, the buffer floor reserved out of it, and per
// scenario (Baseline, then A..E) the plan's income, expense and net with the
// runway the usable cash gives.
//
// The plan is the dated view (`planItemsAsOf`, as of `date`; see
// tests/dated-plan-readers.test.js): an ended item counts nothing. Unsaved
// edits come as `itemOverrides`, laid over the stored item as the page's
// `viewOf` does (`{ ...item, ...fields }`, later entries for one id winning a
// field both set); an id no item has is ignored, since the item may have been
// deleted while the edit was queued. The cash follows the lens, read today.
//
// Money is round2'd on output, but what the page decides from it is computed
// here from the unrounded figures: `deltaSign` (beyond half a cent),
// `netNegative`, and `runway` ('unlimited' when the plan burns nothing, 'none'
// when there is no usable cash, else 'months' with `months` unrounded); with
// `detail`, each item's `impactSign` from its unrounded impact likewise.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows, refDate } from '../lens-input.js';
import { ITEM_OVERRIDES_INPUT, overlaid } from '../item-overrides.js';
import { computeAccountBalances, isCrisisCashAccount } from '../../engine/balances.js';
import { isIncomeLikeItem } from '../../engine/_constants.js';
import { planItemsAsOf, itemDateStatus } from '../../engine/item-dates.js';
import { SCENARIOS, isTransferItem, annualAmount, adjustedAnnual, itemsWithFlatLadder } from '../../engine/stress.js';
import { round2 } from '../../utils.js';

const COLUMNS = /** @type {const} */ (['Baseline', ...SCENARIOS]);

/** -1, 0 or 1: beyond half a cent either way, as the page colours a difference. @param {number} v */
const signOf = (v) => (v < -0.005 ? -1 : v > 0.005 ? 1 : 0);

/**
 * The plan's year in one column: adjusted income and expense of the included,
 * non-transfer items.
 * @param {any[]} items
 * @param {string} scenario
 */
function totalsFor(items, scenario) {
  let income = 0, expense = 0;
  for (const it of items) {
    if (it.include === false) continue;
    if (isTransferItem(it)) continue;
    const amt = adjustedAnnual(it, scenario);
    if (isIncomeLikeItem(it)) income += amt;
    else expense += amt;
  }
  return { income, expense, net: income - expense };
}

/**
 * The reserve the included expense items keep (their `extra_buffer`): cash
 * below it does not extend the runway.
 * @param {any[]} items
 */
function bufferFloorOf(items) {
  let total = 0;
  for (const it of items) {
    if (it.include === false) continue;
    if (isIncomeLikeItem(it)) continue;
    if (isTransferItem(it)) continue;
    total += Math.abs(it.extra_buffer ?? 0);
  }
  return total;
}

/**
 * The non-archived crisis-cash accounts' balance through the lens.
 * @param {any[]} accounts
 * @param {any[]} txs
 */
function liquidOf(accounts, txs) {
  if (!accounts.length) return 0;
  const balances = computeAccountBalances(accounts, txs);
  let total = 0;
  for (const acc of accounts) {
    if (acc.archived || !isCrisisCashAccount(acc)) continue;
    total += balances.get(acc.id) ?? 0;
  }
  return total;
}

export default {
  name: 'stress.runway',
  summary: 'The Stress table: liquid (the non-archived crisis-cash accounts through a lens), bufferFloor (the included expense items\' buffers), usableCash (liquid minus the floor, at least 0), and per scenario (Baseline, then A..E, A the most severe) the plan\'s coming 12 months after that scenario\'s cuts: income, expense (including scenario-only costs), extraExpense, net, netNegative, delta (net minus Baseline\'s) with deltaSign, and runway: unlimited when nothing is burned, none without usable cash, else months of usable cash at that burn. extraExpenses lists configured scenario-only costs and annual amounts. itemOverrides lays unsaved plan-item edits over the stored items. With detail, also every plan item\'s annual and stressed amounts, impact (stressed minus annual) and impactSign per scenario, and flatLadder: the items with one same cut in every scenario they take (items worth nothing a year left out), largest first.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      date: { type: 'date', description: 'Today for the plan: its 12 months start here and items that ended before are out (YYYY-MM-DD, default today). The lens reads today.' },
      itemOverrides: ITEM_OVERRIDES_INPUT,
      detail: { type: 'boolean', default: false, description: 'Also list each plan item\'s annual and stressed amounts with the impact (stressed minus annual) and its sign, and the flat-ladder items' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, date?: string,
   *           itemOverrides?: { id: string, fields: Record<string, any> }[], detail: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const { lens, horizon, txs } = rows.value;
    const ref = refDate(input, ctx);
    const items = planItemsAsOf(overlaid(data.budgetItems || [], input.itemOverrides), ref);

    const liquid = liquidOf(data.accounts || [], txs);
    const bufferFloor = bufferFloorOf(items);
    const usableCash = Math.max(0, liquid - bufferFloor);
    const extras = stressExpenses(data.meta?.stressExpenses);
    const baseline = totalsFor(items, 'Baseline');

    const scenarios = COLUMNS.map((scenario) => {
      const totals = scenario === 'Baseline' ? baseline : totalsFor(items, scenario);
      const extraExpense = scenario === 'Baseline' ? 0 : extras.reduce((sum, e) => sum + stressExpenseAnnual(e, scenario), 0);
      const income = totals.income, expense = totals.expense + extraExpense, net = income - expense;
      const delta = net - baseline.net;
      const burn = expense - income;
      const runway = burn <= 0 ? 'unlimited' : usableCash <= 0 ? 'none' : 'months';
      return {
        scenario,
        extraExpense: round2(extraExpense),
        income: round2(income),
        expense: round2(expense),
        net: round2(net),
        netNegative: net < 0,
        delta: round2(delta),
        deltaSign: signOf(delta),
        runway,
        months: runway === 'months' ? usableCash / (burn / 12) : null,
      };
    });

    /** @type {Record<string, any>} */
    const answer = { lens, horizon, liquid: round2(liquid), bufferFloor: round2(bufferFloor), usableCash: round2(usableCash), scenarios };
    answer.extraExpenses = extras.map(e => ({ ...e, amounts: { ...e.amounts }, months: { ...e.months },
      annual: Object.fromEntries(SCENARIOS.map(s => [s, stressExpenseAnnual(e, s)])) }));
    if (input.detail) {
      answer.items = items.map((it) => {
        const annual = annualAmount(it);
        const adjusted = SCENARIOS.map(s => adjustedAnnual(it, s));
        const bySc = (/** @type {(v: number) => number} */ f) => Object.fromEntries(SCENARIOS.map((s, k) => [s, f(adjusted[k])]));
        return {
          id: it.id,
          annual: round2(annual),
          adjusted: bySc(v => round2(v)),
          impact: bySc(v => round2(v - annual)),
          impactSign: bySc(v => signOf(v - annual)),
        };
      });
      // An item worth nothing a year has no cut to decide: left out.
      answer.flatLadder = itemsWithFlatLadder(items.filter(it => itemDateStatus(it, ref).status !== 'ended'
        && Math.abs(annualAmount(it)) >= 0.005)).map(it => it.id);
    }
    return ok(answer);
  },
};
