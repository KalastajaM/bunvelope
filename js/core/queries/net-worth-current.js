// js/core/queries/net-worth-current.js — net worth across the budget's
// accounts through a lens, split into its parts, as the Dashboard's Net worth
// KPI shows it: every non-archived account (computeNetWorth), how much of the
// total the bank does not show yet (the lens minus Today), and the unrealized
// P/L of the tracked, unarchived investment holdings.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows, todayRows } from '../lens-input.js';
import { portfolioSummary } from '../portfolio.js';
import { computeNetWorth } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

const PARTS = /** @type {const} */ (['spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts', 'other']);

export default {
  name: 'netWorth.current',
  summary: 'Net worth across the non-archived accounts through a lens, with its parts (spending, savings, investment, pension, assets, loansGiven, debts, other) and notYetCleared, the part the bank does not show yet (the lens minus today). Also the unrealized P/L of the tracked investment holdings at their last prices, which does not follow the lens. total, parts and notYetCleared follow the lens.',
  input: {
    type: 'object',
    properties: { ...LENS_INPUT },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const { lens, horizon, txs } = rows.value;
    const accounts = data.accounts || [];
    const worth = computeNetWorth(accounts, txs);
    const cleared = computeNetWorth(accounts, todayRows(data, ctx));
    const sum = portfolioSummary(data, accounts.filter(a => a && !a.archived));
    return ok({
      lens,
      horizon,
      total: round2(worth.total),
      parts: Object.fromEntries(PARTS.map(k => [k, round2(worth[k])])),
      notYetCleared: round2(worth.total - cleared.total),
      hasActiveAccounts: accounts.some(a => a && !a.archived),
      unrealized: { pl: round2(sum.unrealized), pct: round2(sum.unrealizedPct), hasData: sum.priced > 0 },
    });
  },
};
