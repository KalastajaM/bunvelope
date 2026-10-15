// js/core/queries/emergency-requirement.js — how much the emergency envelope
// needs, with the whole calculation: the Envelopes page's emergency card
// dialog (computeEmergencyFundRequirement over the lens rows).
//
// The essentials are the plan items flagged for the emergency budget, as the
// coming 12 months from `month` see them; the other envelopes' balances
// credited against them are read through the lens. `review.month` reads the
// same function over the stored rows and keeps only `required`.
//
// The answer is the engine's breakdown with its money in cents, or null when
// no emergency envelope is set.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows, MONTH_RE, badMonth } from '../lens-input.js';
import { computeEmergencyFundRequirement } from '../../engine/monthly-review.js';
import { round2 } from '../../utils.js';

export default {
  name: 'emergency.requirement',
  summary: 'What the emergency envelope needs and how: the monthly essentials (plan items flagged for the emergency budget, averaged over the coming 12 months from month) times the duration, less the other envelopes\' balances credited towards it (through the lens), plus the envelope\'s extra buffer; with the items and the credited envelopes. Null when no emergency envelope is set.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      month: { type: 'string', description: 'The month whose plan counts, YYYY-MM (default this month)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, month?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    if (input.month !== undefined && !MONTH_RE.test(input.month)) return badMonth();
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const calc = computeEmergencyFundRequirement({
      envelopes: data.envelopes || [],
      budgetItems: data.budgetItems || [],
      transactions: rows.value.txs,
      month: input.month ?? ctx.todayIso.slice(0, 7),
      meta: data.meta,
    });
    if (!calc) return ok(null);
    return ok({
      emergencyId: calc.emergencyId,
      required: round2(calc.required),
      monthlyEssentials: round2(calc.monthlyEssentials),
      duration: calc.duration,
      subtotal: round2(calc.subtotal),
      sumOtherBalance: round2(calc.sumOtherBalance),
      buffer: round2(calc.buffer),
      items: calc.items.map((/** @type {any} */ i) => ({
        envelope_id: i.envelope_id, envName: i.envName, description: i.description, monthlyAmount: round2(i.monthlyAmount),
      })),
      contributors: calc.contributors.map((/** @type {any} */ c) => ({
        envelope_id: c.envelope_id, envName: c.envName, balance: round2(c.balance), contribution: round2(c.contribution), clamped: c.clamped,
      })),
      creditMode: calc.creditMode,
    });
  },
};
