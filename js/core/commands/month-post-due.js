// month.postDue — post every scheduled budget item and template fill that has
// come due, exactly as the app does on load. Idempotent: occurrences already
// posted, tombstoned, or settled by a hand-recorded payment are skipped.

import { ok } from '../result.js';
import { materializeDueBudgetItems, materializeDueTemplateFills } from '../../engine/scheduling.js';
import { findUnlinkedScheduledPayments } from '../../engine/envelope-forecast.js';
import { MONTH_INPUT_PROPERTIES, monthRefDate, monthCountry, monthTombstones, markCleared } from '../month-fields.js';

/**
 * The rows month.postDue would add. Exported for month.start.
 * @param {Record<string, any>} data
 * @param {{ date?: string, cleared?: boolean }} input
 * @param {import('../context.js').Ctx} ctx
 * @returns {Record<string, any>[]}
 */
export function postDueRows(data, input, ctx) {
  const refDate = monthRefDate(input, ctx);
  const country = monthCountry(data);
  const tombstones = monthTombstones(data);
  const { budgetItems = [], accounts, envelopes, transactions, envelopeTemplates = [] } = data;
  // An occurrence a hand-recorded payment already settles is not posted: the
  // user paid early and a second row would double-count it.
  const settledByHand = findUnlinkedScheduledPayments({
    budgetItems, envelopes, transactions, today: refDate, tombstones, country, accounts,
  }).map(p => p.key);
  const { newTxs: due } = materializeDueBudgetItems(
    budgetItems, accounts, envelopes, transactions, refDate, ctx.newId,
    envelopeTemplates, country, [...tombstones, ...settledByHand],
  );
  const { newTxs: fills } = materializeDueTemplateFills(
    envelopeTemplates, budgetItems, envelopes, [...transactions, ...due], refDate, ctx.newId,
    country, tombstones,
  );
  return markCleared([...due, ...fills], input);
}

export default {
  name: 'month.postDue',
  summary: 'Post the scheduled budget items and template fills that have come due. Skips occurrences already posted, deleted, or paid by hand. Returns { posted, rows }.',
  payeeAliases: false,
  input: { type: 'object', properties: MONTH_INPUT_PROPERTIES },
  execute(data, input, ctx) {
    const rows = postDueRows(data, input, ctx);
    return ok({
      changes: rows.length ? { transactions: [...data.transactions, ...rows] } : {},
      value: { posted: rows.length, rows },
    });
  },
};
