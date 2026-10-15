// js/core/queries/fill-preview.js — the Fill sheet's "after" figure: each
// asked envelope's spare (the lowest its 12-month projection goes above its
// floor) and the day of that low point, as they would read once `lines` are
// filled.
//
// The lines become one hypothetical posted allocation fill dated `date`,
// appended to the stored rows, and each asked envelope is re-projected over
// every non-archived envelope (an envelope funding a set-mode template
// projects its target to size the draw). Not `spare + amount`: a fill moves
// the opening balance and the monthly-fill estimate, and a later set-mode
// fill overwrites whatever it lands on. Nothing is written, and no line the
// sheet can hold is refused (`allocation.fill` checks the real write): a
// line may be negative, the delta of a Set below the balance.
//
// An envelope that cannot be projected (archived) answers spare and lowDate
// null.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { projectEnvelopeBalance, envelopeFloor } from '../../engine/envelope-forecast.js';
import { round2 } from '../../utils.js';

export default {
  name: 'fill.preview',
  summary: 'Each asked envelope\'s spare (the lowest its 12-month projection goes above its floor) and the date of that low point, as they would be after a fill of the given lines dated date; nothing is written. Null spare and lowDate for an envelope that cannot be projected (archived).',
  input: {
    type: 'object',
    required: ['lines', 'envelopes'],
    properties: {
      lines: {
        type: 'array',
        description: 'The fill\'s lines, each an amount added to an envelope (negative takes money out)',
        items: {
          type: 'object',
          required: ['envelope', 'amount'],
          properties: {
            envelope: { type: 'ref', kind: 'envelope', description: 'The envelope the line fills' },
            amount: { type: 'money', description: 'The amount added (negative takes money out)' },
            mode: { enum: ['add'], default: 'add', description: 'add (the only mode: a Set is sent as its delta)' },
          },
        },
      },
      envelopes: { type: 'array', items: { type: 'ref', kind: 'envelope' }, description: 'The envelopes to report, in this order' },
      date: { type: 'date', description: 'The fill\'s date and the projection\'s first day (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lines: { envelope: string, amount: number, mode: 'add' }[], envelopes: string[], date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const today = refDate(input, ctx);
    const hypothetical = {
      id: 'preview:fill',
      type: 'fill',
      date: isoDate(today),
      status: 'posted',
      source: 'allocation',
      lines: input.lines.map(l => ({ envelope_id: l.envelope, amount: l.amount, mode: 'add' })),
    };
    const base = {
      transactions: [...(data.transactions || []), hypothetical],
      budgetItems: data.budgetItems || [],
      envelopeTemplates: data.envelopeTemplates || [],
      accounts: data.accounts || [],
      envelopes: (data.envelopes || []).filter((/** @type {any} */ e) => e && !e.archived),
      today,
      months: 12,
      country: monthCountry(data),
      tombstones: monthTombstones(data),
    };
    return ok({
      envelopes: input.envelopes.map(id => {
        const projection = projectEnvelopeBalance({ ...base, envelopeId: id });
        if (projection.unresolved || !projection.low) return { id, spare: null, lowDate: null };
        const floor = envelopeFloor(base.budgetItems, id);
        return { id, spare: round2(projection.low.balance - floor), lowDate: projection.low.date };
      }),
    });
  },
};
