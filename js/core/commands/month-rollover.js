// month.rollover — enact each envelope's rollover policy for the previous
// month (zero-monthly sweeps a surplus, cover-from-unallocated tops up a
// deficit). Idempotent through the rollover:<envelope>:<YYYY-MM> markers.

import { ok } from '../result.js';
import { applyEnvelopeRollovers } from '../../engine/policies.js';
import { MONTH_INPUT_PROPERTIES, monthRefDate, monthTombstones, markCleared } from '../month-fields.js';

/**
 * The rows month.rollover would add. Exported for month.start.
 * @param {Record<string, any>} data
 * @param {{ date?: string, cleared?: boolean }} input
 * @param {import('../context.js').Ctx} ctx
 * @param {string | null} [closingMonth]
 * @returns {Record<string, any>[]}
 */
export function rolloverRows(data, input, ctx, closingMonth = null) {
  const { newTxs } = applyEnvelopeRollovers(
    data.envelopes, data.transactions, monthRefDate(input, ctx), ctx.newId, monthTombstones(data), closingMonth,
  );
  return markCleared(newTxs, input);
}

export default {
  name: 'month.rollover',
  summary: "Apply each envelope's rollover policy for the previous month. Returns { adjusted, rows }.",
  payeeAliases: false,
  input: { type: 'object', properties: MONTH_INPUT_PROPERTIES },
  execute(data, input, ctx) {
    const rows = rolloverRows(data, input, ctx);
    return ok({
      changes: rows.length ? { transactions: [...data.transactions, ...rows] } : {},
      value: { adjusted: rows.length, rows },
    });
  },
};
