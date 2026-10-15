// js/core/queries/envelopes-month.js — the figures an envelope card shows, as
// the Dashboard's envelope snapshot reads them.
//
//   balance       through the lens (the balance view)
//   todayBalance  through the Today lens, whatever the lens; the card's
//                 "upcoming" hint is balance − todayBalance
//   planned       the plan's annual total / 12 for the envelope, over the plan
//                 items still in force on `date` (planItemsAsOf)
//   monthPlanned  what the plan sets aside for date's own calendar month (the
//                 same items, an occurrence skipped for that month left out):
//                 the card's "X of Y spent" line, so a bill due twice a year
//                 does not read as over a twelfth of it
//   fillPlanned   the monthly plan a dynamic template fills from on `date`
//                 (planItemsForDynamicFill): like planned, but an item still
//                 running counts in full until its end month
//   buffer        the plan's extra buffer for the envelope, over the same
//                 items in force on `date`
//   spent         what the stored rows dated from the first of date's month
//                 through `date` spent from it
//   spare         the lowest the envelope's projection goes over the next 12
//                 months above its floor, with the dates it is covered from,
//                 the floor (the plan's extra buffer) and the day of that low
//                 point; null for an archived envelope
//   fundsTemplates  the scheduled templates drawing from it on `date`, or null
//   goal          its goal progress on `date` against the lens balance, or
//                 null without a goal (the card's goal line)
//   funding       its plan items' share of the balance as of `date` (stored
//                 rows), each judged against the spare walk (the card's fill
//                 %); null for an envelope without funded items, an archived
//                 one, or with spare false
//
// Spare runs one projection per envelope, so the set is what the caller
// shows: the ids in `envelopes` (archived ones too when named), else every
// non-archived envelope, in array order either way; `spare: false` skips the
// projections (every spare and funding is then null). Asking for a few
// envelopes does not change their figures: every active envelope is in each
// walk. Spare reads the stored rows and the undated plan items, as the
// Envelopes page does.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { LENS_INPUT, lensRows, refDate, todayRows } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { computeEnvelopeBalances, computeSpentThisMonthByEnvelope } from '../../engine/balances.js';
import { computeMonthlyPlanByEnvelope, computeBufferByEnvelope, buildExpenseCalendar } from '../../engine/monthly-review.js';
import { planItemsAsOf, planItemsForDynamicFill } from '../../engine/item-dates.js';
import { computeSpareByEnvelope } from '../../engine/envelope-forecast.js';
import { computeTemplateSourceDraws } from '../../engine/scheduling.js';
import { computeItemFundingByEnvelope } from '../../engine/item-funding.js';
import { computeEnvelopeGoalProgress } from '../../engine/policies.js';
import { goalAnswer, fundingAnswer } from '../envelope-answer.js';
import { round2 } from '../../utils.js';

export default {
  name: 'envelopes.month',
  summary: 'Per envelope, what its card shows: balance (through the lens), todayBalance (Today lens), planned (the plan\'s annual total / 12, items in force on date), monthPlanned (the plan for date\'s own calendar month, skipped occurrences left out; what spent is compared with), fillPlanned (the monthly plan a dynamic template fills from on date: an item still running counts in full until its end month), buffer (the plan\'s extra buffer, the same items), spent (rows from the first of date\'s month through date), spare (the lowest its 12-month projection goes above its floor, with coveredDate, balanceCoveredDate, the floor, lowBalance (before subtracting the floor) and the low point\'s date; null when archived, or with spare false), fundsTemplates (scheduled templates drawing from it), goal (its goal progress against the lens balance, or null) and funding (its plan items\' share of the balance as of date, judged against the projection; null without funded items, when archived, or with spare false). For the envelopes named, else every non-archived one, in envelope order; each costs one projection unless spare is false. The balances (lens and Today) use the query clock; the goal pace, projection and funding use date.',
  input: {
    type: 'object',
    properties: {
      ...LENS_INPUT,
      date: { type: 'date', description: 'Today for this query: the month spent covers, the plan items in force, the templates still drawing (YYYY-MM-DD, default today)' },
      envelopes: { type: 'array', items: { type: 'ref', kind: 'envelope' }, description: 'The envelope ids to report, archived ones included (default every non-archived envelope)' },
      spare: { type: 'boolean', default: true, description: 'Run the 12-month projection for spare and funding (default true); false skips it and every spare and funding is null' },
    },
  },
  /**
   * @param {any} data
   * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string, date?: string, envelopes?: string[], spare?: boolean }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const rows = lensRows(data, input, ctx);
    if (!rows.ok) return rows;
    const { lens, horizon, txs } = rows.value;
    const ref = refDate(input, ctx);
    const wanted = input.envelopes ? new Set(input.envelopes) : null;
    const selected = (data.envelopes || []).filter((/** @type {any} */ e) => (wanted ? wanted.has(e.id) : !e.archived));

    const balances = computeEnvelopeBalances(txs);
    const todayBalances = computeEnvelopeBalances(todayRows(data, ctx));
    const datedPlan = planItemsAsOf(data.budgetItems || [], ref);
    const planned = computeMonthlyPlanByEnvelope(datedPlan);
    const refYM = isoDate(ref).slice(0, 7);
    const monthCal = buildExpenseCalendar(datedPlan.filter((/** @type {any} */ it) => !(it
      && Array.isArray(it.skipped_occurrences) && it.skipped_occurrences.includes(refYM))));
    const fillPlanned = computeMonthlyPlanByEnvelope(planItemsForDynamicFill(data.budgetItems || [], ref));
    const buffers = computeBufferByEnvelope(datedPlan);
    const spent = computeSpentThisMonthByEnvelope(data.transactions || [], ref);
    const draws = computeTemplateSourceDraws(data.envelopeTemplates || [], { asOf: isoDate(ref) });
    const spares = input.spare === false ? new Map() : computeSpareByEnvelope({
      transactions: data.transactions || [],
      budgetItems: data.budgetItems || [],
      envelopeTemplates: data.envelopeTemplates || [],
      accounts: data.accounts || [],
      // Every active envelope is in the walk (a set-mode template finds its
      // target there); only the ones asked are projected.
      envelopes: (data.envelopes || []).filter((/** @type {any} */ e) => e && !e.archived),
      only: new Set(selected.map((/** @type {any} */ e) => e.id)),
      today: ref,
      months: 12,
      country: monthCountry(data),
      tombstones: monthTombstones(data),
    });
    // Fill %: as the Envelopes page, the balance as of `date` (a future-dated
    // bill has not left yet) and the spare walk each item is judged against.
    const funding = input.spare === false ? new Map() : computeItemFundingByEnvelope({
      envelopes: selected,
      budgetItems: data.budgetItems || [],
      transactions: data.transactions || [],
      balances: computeEnvelopeBalances(data.transactions || [], { asOf: ref }),
      today: ref,
      country: monthCountry(data),
      tombstones: monthTombstones(data),
      dailyByEnvelope: new Map([...spares].map(([id, sp]) => [id, sp.daily])),
    });

    return ok({
      lens,
      horizon,
      envelopes: selected.map((/** @type {any} */ e) => {
        const s = spares.get(e.id);
        const funds = draws.get(e.id);
        return {
          id: e.id,
          name: e.name ?? null,
          balance: round2(balances.get(e.id) || 0),
          todayBalance: round2(todayBalances.get(e.id) || 0),
          planned: round2(planned.get(e.id) || 0),
          monthPlanned: round2(monthCal.get(e.id)?.[ref.getMonth() + 1] || 0),
          fillPlanned: round2(fillPlanned.get(e.id) || 0),
          buffer: round2(buffers.get(e.id) || 0),
          spent: round2(spent.get(e.id) || 0),
          spare: s ? {
            spare: round2(s.spare), coveredDate: s.coveredDate, balanceCoveredDate: s.balanceCoveredDate,
            floor: round2(s.floor), lowDate: s.lowDate, lowBalance: round2(s.spare + s.floor),
          } : null,
          fundsTemplates: funds ? funds.map((/** @type {any} */ f) => ({ id: f.id, name: f.name, sourceSince: f.sourceSince })) : null,
          goal: goalAnswer(computeEnvelopeGoalProgress(e, balances.get(e.id) || 0, ref)),
          funding: fundingAnswer(funding.get(e.id)),
        };
      }),
    });
  },
};
