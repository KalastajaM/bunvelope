// js/core/queries/balances.js — account and envelope balances through one of
// the three lenses, composed exactly as the status bar and the Accounts page
// do: lensTransactions, then the engine's balance functions over those rows.
// `totals` are the Dashboard hero's figures over the same balances.

import { ok, fail } from '../result.js';
import { balanceAnswer } from '../balance-answer.js';
import { lensRows } from '../lens-input.js';
import { LENSES, DEFAULT_HORIZON } from '../../engine/lens.js';
import { computeAccountBalances, computeEnvelopeBalances, identityAccountTotal } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

/**
 * The hero's assigned / total balance pair and its percentage.
 *
 *   envelopes    every envelope balance, archived ones included
 *   accounts     the account side of the identity `unallocated` comes from
 *                (`identityAccountTotal`: no investment, asset or loan accounts)
 *   assignedPct  envelopes over accounts, 0..100; with no account money it is
 *                100 when nothing is left to assign, else 0
 *
 * Summed unrounded, rounded on output; the percentage reads the unrounded sums.
 *
 * @param {any[] | undefined} accounts
 * @param {Map<string, number>} accBal
 * @param {Map<string, number>} envBal
 * @param {number} unallocated
 */
function balanceTotals(accounts, accBal, envBal, unallocated) {
  const envTotal = Array.from(envBal.values()).reduce((s, v) => s + v, 0);
  const acctTotal = identityAccountTotal(accBal, accounts || null);
  const isBalanced = Math.abs(unallocated) < 0.01;
  const assignedPct = acctTotal > 0.01 ? Math.max(0, Math.min(100, Math.round((envTotal / acctTotal) * 100))) : (isBalanced ? 100 : 0);
  return { envelopes: round2(envTotal), accounts: round2(acctTotal), assignedPct };
}

export default {
  name: 'balances',
  summary: 'Account and envelope balances through a lens: today (cleared, as of today), booked (everything entered) or forecast (booked plus generated rows through a horizon). Also returns unallocated, the figure the status bar shows, and totals (envelopes, identity accounts, assigned %), the Dashboard hero\'s figures; all follow the lens. With asOf (booked only), the balances at the end of that day.',
  input: {
    type: 'object',
    required: ['lens'],
    properties: {
      lens: { enum: LENSES, description: 'today = cleared as of today; booked = everything entered; forecast = booked plus generated rows through the horizon' },
      horizon: { type: 'string', description: `Forecast only: eom, 3m, 6m, 12m or a date (YYYY-MM-DD). Default ${DEFAULT_HORIZON}` },
      includeArchived: { type: 'boolean', default: false, description: 'List archived accounts and envelopes too (unallocated always counts them)' },
      asOf: { type: 'date', description: 'Booked only: the balances at the end of this day, rows dated after it left out (YYYY-MM-DD)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens: 'today' | 'booked' | 'forecast', horizon?: string, includeArchived?: boolean, asOf?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, { lens, horizon, includeArchived = false, asOf }, ctx) {
    if (asOf !== undefined && lens !== 'booked') return fail('bad_input', { errors: [{ path: 'asOf', message: 'only allowed with lens booked' }] });
    const rows = lensRows(data, { lens, horizon }, ctx);
    if (!rows.ok) return rows;
    const { txs } = rows.value;
    // Without asOf, no options at all: the balance memo keys on them.
    const accBal = asOf === undefined ? computeAccountBalances(data.accounts, txs) : computeAccountBalances(data.accounts, txs, { asOf });
    const envBal = asOf === undefined ? computeEnvelopeBalances(txs) : computeEnvelopeBalances(txs, { asOf });
    const answer = balanceAnswer(data, accBal, envBal, { includeArchived });
    return ok({
      lens,
      horizon: rows.value.horizon,
      ...answer,
      totals: balanceTotals(data.accounts, accBal, envBal, answer.unallocated),
    });
  },
};
