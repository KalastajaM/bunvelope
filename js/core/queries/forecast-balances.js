// js/core/queries/forecast-balances.js — balances on a date through the
// forecast lens, with the two assumptions Budget's forecast varies:
//
//   charge  'plan' (default) is the app's lens unchanged: the remaining plan
//           is charged, netted against this month's spend. 'none' drops the
//           planned rows, the ceiling where no planned spending happens.
//   cards   'settle-15th' pays every credit card's previous-month balance on
//           the 15th from `cardFundingAccount` (Budget's step 6). 'none'
//           (default) leaves card balances as the rows have them.
//
// No rollovers, top-ups or held-back fills: those stay in Budget (planning
// ruling 3). The answer shares its shape with `balances` (balance-answer.js).

import { ok, fail } from '../result.js';
import { balanceAnswer } from '../balance-answer.js';
import { lensTransactions } from '../../engine/lens.js';
import { resolveSetSourceLegs } from '../../engine/scheduling.js';
import { computeAccountBalances, computeEnvelopeBalances } from '../../engine/balances.js';
import { cardSettlementRows as engineCardSettlementRows, withCardSettlements } from '../../engine/card-settlement.js';

/**
 * The card settlements Budget's step 6 adds: every non-archived credit card's
 * previous-month balance paid on the 15th from `fundingAccount`. The rule
 * lives in the engine (js/engine/card-settlement.js), which also settles a
 * card from its own `settledFrom` account in the Forecast lens; a month the
 * lens already settled has a transfer into the card, so it is skipped here.
 *
 * @param {any[]} accounts
 * @param {any[]} rows  the forecast lens rows the balances are computed over
 * @param {{ fundingAccount: string, todayIso: string, endIso: string, booked?: any[], budgetItems?: any[], country?: string }} opts
 *   `booked` is every real transaction (`data.transactions`)
 * @returns {any[]} the settlement rows, in date order
 */
export function cardSettlementRows(accounts, rows, { fundingAccount, todayIso, endIso, booked = [], budgetItems = [], country = 'FI' }) {
  return engineCardSettlementRows(accounts, rows, { fundingFor: card => (card.type === 'credit_card' ? fundingAccount : null), todayIso, endIso, booked, budgetItems, country });
}

const fieldError = (message) => fail('bad_input', { errors: [{ path: 'cardFundingAccount', message }] });

export default {
  name: 'forecast.balances',
  summary: 'Account and envelope balances on a date through the forecast lens. charge: plan (default, the app\'s forecast) or none (planned spending dropped). cards: none (default) or settle-15th (each credit card\'s previous-month balance paid on the 15th from cardFundingAccount).',
  input: {
    type: 'object',
    required: ['date'],
    properties: {
      date: { type: 'date', description: 'The date to read balances on (YYYY-MM-DD)' },
      charge: { enum: ['plan', 'none'], default: 'plan', description: 'plan = charge the remaining plan, as the app\'s forecast does; none = drop planned spending' },
      cards: { enum: ['none', 'settle-15th'], default: 'none', description: 'settle-15th = pay each credit card\'s previous-month balance on the 15th' },
      cardFundingAccount: { type: 'ref', kind: 'account', description: 'The account card settlements are paid from; required with cards settle-15th' },
      includeArchived: { type: 'boolean', default: false, description: 'List archived accounts and envelopes too (unallocated always counts them)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ date: string, charge: 'plan' | 'none', cards: 'none' | 'settle-15th', cardFundingAccount?: string, includeArchived?: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, { date, charge, cards, cardFundingAccount, includeArchived = false }, ctx) {
    if (cards === 'settle-15th' && cardFundingAccount === undefined) return fieldError('required with cards settle-15th');
    if (cards !== 'settle-15th' && cardFundingAccount !== undefined) return fieldError('only allowed with cards settle-15th');

    // 'none' asks the lens to leave sourced set-mode fills pending and
    // resolves them after the planned rows are gone: a set line's source draw
    // is `value − target balance before the fill`, and a planned row ahead of
    // it changes that balance (the same seam simulation.js uses for a scenario).
    // Pending rows come back without the cards' own settlements as well
    // (`settledFrom`): they are added once the planned rows are gone.
    let txs = charge === 'none'
      ? withCardSettlements(data.accounts, resolveSetSourceLegs(
        lensTransactions(data, { lens: 'forecast', horizon: date, today: ctx.now, pendingSetSources: true })
          .filter(tx => !(tx && tx.is_planned)),
      ), { todayIso: ctx.todayIso, endIso: date, booked: data.transactions || [], budgetItems: data.budgetItems || [], country: data.meta?.country || 'FI' })
      : lensTransactions(data, { lens: 'forecast', horizon: date, today: ctx.now });
    /** @type {any[]} */
    let settled = [];
    if (cards === 'settle-15th') {
      settled = cardSettlementRows(data.accounts, txs, {
        fundingAccount: /** @type {string} */ (cardFundingAccount), todayIso: ctx.todayIso, endIso: date,
        booked: data.transactions || [], budgetItems: data.budgetItems || [], country: data.meta?.country || 'FI',
      });
      if (settled.length) txs = txs.concat(settled);
    }

    const accBal = computeAccountBalances(data.accounts, txs, { asOf: date });
    const envBal = computeEnvelopeBalances(txs, { asOf: date });
    return ok({
      date,
      assumptions: { charge, cards, cardFundingAccount: cardFundingAccount ?? null },
      ...balanceAnswer(data, accBal, envBal, { includeArchived }),
      settlements: settled.map(s => ({ account: s.to_account, date: s.date, amount: s.amount })),
    });
  },
};
