// js/core/queries/envelope-health.js — everything the Envelope health sheet
// shows for one envelope:
//
//   projection       its balance projected forward (projectEnvelopeBalance):
//                    the opening (today's balance less any bill due and not
//                    yet posted, `dueUnposted`), the day-by-day series, per
//                    month opening, in, out, low, high and closing, the low
//                    and high points, the closing balance, the first day below
//                    zero, the monthly fill and where it comes from, and
//                    `unresolved` (an archived envelope cannot be projected:
//                    a flat zero, said so). The engine's events and Maps are
//                    left out.
//   recommendations  the engine's recommendations on that projection
//   funding          its plan items' share of the balance as of `date`, each
//                    judged against the projection (computeItemFunding)
//   lensBalance      its balance through the lens (the card the sheet opens from)
//   asOfBalance      its balance from the stored rows dated on or before `date`
//
// The projection reads the stored rows, as `envelope.forecast` and the sheet
// do: it generates its own scheduled rows and fills, so the Forecast lens's
// rows would count them twice. Only lensBalance follows the lens.

import { ok } from '../result.js';
import { LENS_INPUT, lensRows, refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { fundingAnswer } from '../envelope-answer.js';
import { computeEnvelopeBalances } from '../../engine/balances.js';
import { projectEnvelopeBalance, recommendEnvelopeActions } from '../../engine/envelope-forecast.js';
import { computeItemFunding } from '../../engine/item-funding.js';
import { round2 } from '../../utils.js';

/** @param {{ date: string, balance: number } | null | undefined} p */
const point = (p) => (p ? { date: p.date, balance: round2(p.balance) } : null);

/**
 * A recommendation's meta with its money in cents: every number is money (the
 * rest are strings, booleans or a dated point), and the low point is a point.
 * @param {Record<string, any>} meta
 */
function metaAnswer(meta) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = typeof v === 'number' ? round2(v)
      : v && typeof v === 'object' && typeof v.balance === 'number' ? point(v)
        : structuredClone(v);
  }
  return out;
}

export default {
  name: 'envelope.health',
  summary: 'One envelope\'s health: its balance projected forward through its scheduled spending, fills and plan (opening, the bill due and not yet posted, the day-by-day series, per month opening, in, out, low, high and closing, the low and high points, the closing balance, the first day below zero, the monthly fill and its source; unresolved for an archived envelope), the engine\'s recommendations (kind, severity, amount, date, details), its plan items\' funding as of date, its balance through the lens and its balance from the rows dated on or before date. The lens balances use the query clock; the goal pace, projection and funding use date.',
  input: {
    type: 'object',
    required: ['envelope'],
    properties: {
      envelope: { type: 'ref', kind: 'envelope', description: 'The envelope to check' },
      months: { type: 'integer', minimum: 1, maximum: 24, default: 12, description: 'How many months ahead to project (1-24, default 12)' },
      ...LENS_INPUT,
      date: { type: 'date', description: 'The day the projection starts, and the as-of day of the funding (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ envelope: string, months: number, lens?: 'today' | 'booked' | 'forecast', horizon?: string, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const today = refDate(input, ctx);
    const projectionInput = {
      envelopeId: input.envelope,
      transactions: data.transactions || [],
      budgetItems: data.budgetItems || [],
      envelopeTemplates: data.envelopeTemplates || [],
      accounts: data.accounts || [],
      envelopes: data.envelopes || [],
      today,
      months: input.months,
      country: monthCountry(data),
      tombstones: monthTombstones(data),
    };
    const p = projectEnvelopeBalance(projectionInput);
    // The engine's default parameter (null) types `projection` as null.
    const recs = recommendEnvelopeActions(projectionInput, /** @type {any} */ (p));
    const asOfBalance = computeEnvelopeBalances(data.transactions || [], { asOf: today }).get(input.envelope) ?? 0;
    const funding = computeItemFunding({
      envelopeId: input.envelope,
      budgetItems: data.budgetItems || [],
      transactions: data.transactions || [],
      balance: asOfBalance,
      today,
      country: projectionInput.country,
      tombstones: projectionInput.tombstones,
      daily: p.daily,
    });

    return ok({
      envelope: input.envelope,
      projection: {
        opening: round2(p.opening),
        dueUnposted: round2(p.dueUnposted ?? 0),
        daily: p.daily.map(point),
        months: p.months.map((/** @type {any} */ m) => ({
          key: m.key, opening: round2(m.opening), in: round2(m.in), out: round2(m.out),
          low: round2(m.low), high: round2(m.high), closing: round2(m.closing), partial: m.partial,
        })),
        low: point(p.low),
        high: point(p.high),
        closing: round2(p.closing),
        firstNegative: point(p.firstNegative),
        monthlyFill: round2(p.monthlyFill),
        fillSource: p.fillSource,
        unresolved: p.unresolved === true,
      },
      recommendations: recs.map((/** @type {any} */ r) => ({
        kind: r.kind,
        severity: r.severity,
        amount: r.amount == null ? null : round2(r.amount),
        date: r.date ?? null,
        meta: metaAnswer(r.meta ?? {}),
      })),
      funding: fundingAnswer(funding),
      lensBalance: round2(computeEnvelopeBalances(rows.value.txs).get(input.envelope) ?? 0),
      asOfBalance: round2(asOfBalance),
    });
  },
};
