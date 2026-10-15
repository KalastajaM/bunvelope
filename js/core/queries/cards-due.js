// js/core/queries/cards-due.js — what each non-archived credit card owes, as
// the Dashboard's cards card shows it (computeCreditCardPaymentDue): the
// balance owed through the lens and the posted-only part of it. Cards owing
// nothing are left out. There is no due date: the engine keeps none.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows } from '../lens-input.js';
import { computeCreditCardPaymentDue } from '../../engine/insights.js';
import { round2 } from '../../utils.js';

export default {
  name: 'cards.due',
  summary: 'What each non-archived credit card owes, in account order: paymentDue is the balance owed through the lens, postedDue the same over posted rows only; cards owing nothing are left out. total sums paymentDue. paymentDue and total follow the lens.',
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
    const dueMap = computeCreditCardPaymentDue(data.accounts || [], txs);
    const cards = [];
    let total = 0;
    for (const { account, paymentDue, postedDue } of dueMap.values()) {
      total += paymentDue;
      cards.push({ account: account.id, name: account.name ?? null, paymentDue, postedDue });
    }
    return ok({ lens, horizon, cards, total: round2(total) });
  },
};
