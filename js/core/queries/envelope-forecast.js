// js/core/queries/envelope-forecast.js — one envelope's balance projected
// forward: the Envelope health page's projection (projectEnvelopeBalance over
// the stored rows, the plan, the templates and the deleted occurrences), in
// the trimmed shape the AI's get_forecast answers with. The day-by-day series
// is left out.
//
// Lens-less, as the health page: the projection generates its own scheduled
// rows and fills, so the Forecast lens's rows would count them twice.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { projectEnvelopeBalance } from '../../engine/envelope-forecast.js';
import { round2 } from '../../utils.js';

/** @param {{ date: string, balance: number } | null | undefined} p */
const point = (p) => (p ? { date: p.date, balance: round2(p.balance) } : null);

export default {
  name: 'envelope.forecast',
  summary: 'One envelope\'s balance projected forward through its scheduled spending, fills and plan: opening, closing, the low and high points (date and balance), the first day below zero (or null), the monthly fill and where it comes from, and per month its opening, money in, money out and whether the month is partial.',
  input: {
    type: 'object',
    required: ['envelope'],
    properties: {
      envelope: { type: 'ref', kind: 'envelope', description: 'The envelope to project' },
      months: { type: 'integer', minimum: 1, maximum: 24, default: 3, description: 'How many months ahead (1-24, default 3)' },
      date: { type: 'date', description: 'The day the projection starts (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ envelope: string, months: number, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const projection = projectEnvelopeBalance({
      envelopeId: input.envelope,
      transactions: data.transactions || [],
      budgetItems: data.budgetItems || [],
      envelopeTemplates: data.envelopeTemplates || [],
      accounts: data.accounts || [],
      envelopes: data.envelopes || [],
      months: input.months,
      today: input.date === undefined ? ctx.now : refDate(input, ctx),
      country: monthCountry(data),
      tombstones: monthTombstones(data),
    });
    const money = (/** @type {any} */ n) => (n == null ? null : round2(n));
    return ok({
      envelope: (data.envelopes || []).find((/** @type {any} */ e) => e && e.id === input.envelope)?.name || null,
      months: input.months,
      opening: money(projection?.opening),
      closing: money(projection?.closing),
      low: point(projection?.low),
      high: point(projection?.high),
      firstNegative: point(projection?.firstNegative),
      monthlyFill: money(projection?.monthlyFill),
      fillSource: projection?.fillSource ?? null,
      months_detail: (projection?.months || []).map((/** @type {any} */ m) => ({
        month: m.key, opening: round2(m.opening), in: round2(m.in), out: round2(m.out), partial: m.partial,
      })),
    });
  },
};
