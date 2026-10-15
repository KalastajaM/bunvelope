// allocation.fill — allocate money to envelopes: manual lines, or a template.
// A template fill mirrors Budget's `fill --template` and the scheduler's own
// row, so the manual run and the post-due run see each other (a scheduled
// template's fill carries the same `from_budget` key post-due dedups on).
// Stored lines are add-mode only; a template's set lines are resolved to add
// deltas against the balance as of the fill date. With skipTemplateMonth a
// scheduled template's fill also adds its occurrence month to the template's
// schedule.skipped, in the same commit (the templates page's "run early").
// `month` names the occurrence outright (an early run of a later one) and needs
// skipTemplateMonth: the twin and tombstone checks, the source leg and the skip
// then follow that occurrence rather than the one the fill date falls in. An
// early run carries no from_budget key: the skipped month records it, and a key
// dated weeks before its month would be a stale link to the invariant check.
// `adhoc` is a fill outside the schedule altogether (the page's "extra" and
// plain apply): no key, no source leg, no twin check.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';
import { monthRefDate, monthCountry, monthTombstones } from '../month-fields.js';
import { isoDate } from '../context.js';
import { withSkippedMonth } from '../entity-fields.js';
import { round2 } from '../../utils.js';
import { walkMonthlySchedule, templateFillKey, templateFillSourceId, liveTemplateLines, storedFillLines } from '../../engine/scheduling.js';
import { computeEnvelopeBalances } from '../../engine/balances.js';
import { monthStartDate } from '../../engine/item-dates.js';

const SOURCES = ['allocation', 'new_income', 'pool_distribute'];

/**
 * The schedule occurrence a scheduled template's fill stands in for. Usually
 * the date's own month, but a working-day adjustment can move a pay date
 * across a month boundary (prev_work_day on day 1), and post-due keys on the
 * RAW schedule month and judges source_since on the raw date, so ask the
 * schedule itself. Same window as Budget's ledger.
 * @param {Record<string, any>} tpl
 * @param {Record<string, any>} data
 * @param {string} dateIso
 * @param {Date} refDate
 * @returns {{ monthKey: string, rawDate: string }}
 */
function scheduleOccurrence(tpl, data, dateIso, refDate) {
  const monthKey = dateIso.slice(0, 7);
  if (tpl.schedule?.enabled !== true) return { monthKey, rawDate: dateIso };
  const from = isoDate(new Date(refDate.getFullYear(), refDate.getMonth() - 1, 15));
  const to = isoDate(new Date(refDate.getFullYear(), refDate.getMonth() + 1, 15));
  const s = tpl.schedule;
  const occs = walkMonthlySchedule(
    { months: s.months, payment_day: s.payment_day, since: s.since, until: s.until, skipped: s.skipped },
    from, to, { dayType: s.day_type, country: monthCountry(data) },
  );
  const hit = occs.find(o => o.date === dateIso) || occs.find(o => o.monthKey === monthKey);
  return { monthKey: hit ? hit.monthKey : monthKey, rawDate: hit?.rawDate ?? dateIso };
}

/**
 * The scheduled template's occurrence in `month` (membership by the raw
 * schedule date, as walkMonthlySchedule decides it), or null when the schedule
 * has none that month: inactive, before since, after until, or skipped.
 * @param {Record<string, any>} tpl
 * @param {Record<string, any>} data
 * @param {string} month  YYYY-MM
 * @returns {{ monthKey: string, rawDate: string } | null}
 */
function namedOccurrence(tpl, data, month) {
  const [y, m] = month.split('-').map(Number);
  const s = tpl.schedule;
  const occs = walkMonthlySchedule(
    { months: s.months, payment_day: s.payment_day, since: s.since, until: s.until, skipped: s.skipped },
    `${month}-01`, isoDate(new Date(y, m, 0)), { dayType: s.day_type, country: monthCountry(data) },
  );
  const hit = occs.find(o => o.monthKey === month);
  return hit ? { monthKey: hit.monthKey, rawDate: hit.rawDate } : null;
}

/**
 * The template's lines as the scheduler emits them (live envelopes only,
 * magnitudes), with set lines resolved to add deltas against the balance as of
 * the fill date (`storedFillLines`, the scheduler's own rule). A set line
 * already on its target stays as a zero line carrying `set_target`; a zero add
 * line is dropped.
 */
function templateLines(tpl, data, dateIso) {
  const envById = new Map(data.envelopes.map(e => [e.id, e]));
  // The plan as the fill's month sees it.
  const live = liveTemplateLines(tpl, data.budgetItems || [], envById, monthStartDate(dateIso.slice(0, 7))).filter(l => l.amount);
  const balances = live.some(l => l.mode === 'set') ? computeEnvelopeBalances(data.transactions, { asOf: dateIso }) : null;
  const out = storedFillLines(live, balances ? (id => balances.get(id) || 0) : null)
    .map(l => (l.set_target === undefined ? { envelope_id: l.envelope_id, mode: 'add', amount: round2(l.amount) } : l))
    .filter(l => l.amount || 'set_target' in l);
  return { live, lines: out };
}

export default {
  name: 'allocation.fill',
  summary: 'Fill envelopes from unallocated money: give lines, or a template. A scheduled template fill carries its occurrence key so post-due does not repeat it; skipTemplateMonth also skips that occurrence on the template\'s schedule (with month, an unkeyed early run of that occurrence); adhoc fills outside the schedule. Returns the new fill row.',
  input: {
    type: 'object',
    properties: {
      lines: {
        type: 'array', description: 'Manual lines; give this or template, not both',
        items: {
          type: 'object', required: ['envelope', 'amount'],
          properties: {
            envelope: { type: 'ref', kind: 'envelope' },
            amount: { type: 'money', description: 'Signed amount, not zero' },
            mode: { enum: ['add', 'set'], description: 'Only add is stored; set is refused' },
          },
        },
      },
      template: { type: 'ref', kind: 'template', description: 'Envelope template to fill from; give this or lines, not both' },
      date: TX_INPUT_PROPERTIES.date,
      payee: TX_INPUT_PROPERTIES.payee,
      note: TX_INPUT_PROPERTIES.note,
      source: { enum: SOURCES, default: 'allocation', description: 'allocation draws unallocated; new_income and pool_distribute name the account the money came from' },
      account: { type: 'ref', kind: 'account', nullable: true, description: 'Source account (required for new_income); null records none on a pool_distribute fill' },
      fromEnvelope: { type: 'ref', kind: 'envelope', description: 'Fund the fill from this envelope instead of unallocated' },
      force: { type: 'boolean', description: 'Fill a template again this month or a deleted occurrence; bypass the strict-ledger history and future-date rules' },
      month: { type: 'string', description: 'YYYY-MM: with a scheduled template, run that occurrence early (needs skipTemplateMonth); the fill is not keyed, the skip records it' },
      skipTemplateMonth: { type: 'boolean', description: 'With a scheduled template: also skip the occurrence month this fill stands in for on the template\'s schedule, in the same commit' },
      adhoc: { type: 'boolean', description: 'With a template: a fill outside its schedule, with no occurrence key, no source envelope leg and no once-a-month check' },
    },
  },
  execute(data, input, ctx) {
    if ((input.lines === undefined || input.lines.length === 0) === (input.template === undefined)) {
      return fail('fill_needs_lines_or_template');
    }
    const dateIso = input.date ?? ctx.todayIso;
    const source = input.source ?? 'allocation';
    const tpl = input.template === undefined ? null : data.envelopeTemplates.find(t => t.id === input.template);
    const skipMonth = input.skipTemplateMonth === true;
    const scheduled = tpl?.schedule?.enabled === true;
    const adhoc = input.adhoc === true;
    if (adhoc) {
      if (!tpl) return fail('bad_input', { errors: [{ path: 'adhoc', message: 'needs a template' }] });
      const clash = ['month', 'skipTemplateMonth'].filter(f => input[f] !== undefined && input[f] !== false)
        .map(f => ({ path: 'adhoc', message: `cannot be combined with ${f}` }));
      if (clash.length) return fail('bad_input', { errors: clash });
    }
    for (const field of ['month', 'skipTemplateMonth']) {
      if (input[field] !== undefined && input[field] !== false && !scheduled) {
        return fail('bad_input', { errors: [{ path: field, message: 'needs a template with an enabled schedule' }] });
      }
    }
    if (input.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
      return fail('bad_input', { errors: [{ path: 'month', message: 'must be a month, YYYY-MM' }] });
    }
    const early = input.month !== undefined;
    if (early && !skipMonth) {
      return fail('bad_input', { errors: [{ path: 'skipTemplateMonth', message: 'must be true with month (an early run)' }] });
    }

    /** @type {{ envelope_id: string, mode: string, amount: number }[]} */
    let lines;
    /** @type {string | null} */
    let scheduleSource = null;
    /** @type {string | null} */
    let fromBudget = null;
    /** @type {any[] | null} */
    let nextTemplates = null;

    if (!tpl) {
      const bad = [];
      lines = input.lines.map((l, i) => {
        const amount = round2(l.amount);
        if (!amount) bad.push({ path: `lines[${i}].amount`, message: 'must not be zero' });
        return { envelope_id: l.envelope, mode: 'add', amount };
      });
      const set = input.lines.find(l => l.mode === 'set');
      if (set) return fail('field_not_allowed', { field: 'mode', type: 'fill' });
      if (bad.length) return fail('bad_input', { errors: bad });
    } else if (adhoc) {
      lines = templateLines(tpl, data, dateIso).lines;
    } else {
      const occurrence = input.month === undefined
        ? scheduleOccurrence(tpl, data, dateIso, monthRefDate(input, ctx))
        : namedOccurrence(tpl, data, input.month);
      if (!occurrence) return fail('bad_input', { errors: [{ path: 'month', message: 'is not an occurrence of the template\'s schedule' }] });
      const { monthKey, rawDate } = occurrence;
      const key = templateFillKey(tpl.id, monthKey);
      const skipped = tpl.schedule?.skipped;
      if (skipMonth && !(Array.isArray(skipped) && skipped.includes(monthKey))) {
        nextTemplates = data.envelopeTemplates.map(x => (x.id === tpl.id ? withSkippedMonth(x, monthKey) : x));
      }
      // One fill per template per month: this and post-due could not see each
      // other once, and double-funded every envelope on the template. A named
      // month (an early run) checks that occurrence by its key only, the fill
      // the scheduler posts: an extra fill dated in the month does not stand in
      // for it, and an earlier early run left the month skipped, which is
      // already "no occurrence".
      const twin = data.transactions.find(x => x && x.type === 'fill' && x.template_id === tpl.id
        && !x.reversed_by && x.status !== 'scheduled'
        && ((x.from_budget && x.from_budget === key)
          || (!early && ((x.date || '').slice(0, 7) === monthKey
            || (x.date || '').slice(0, 7) === dateIso.slice(0, 7)))));
      if (twin && input.force !== true) return fail('fill_already_this_month', { template: tpl.id, id: twin.id, date: twin.date });
      if (scheduled) {
        if (monthTombstones(data).includes(key) && input.force !== true) return fail('occurrence_tombstoned', { key });
        if (!early) fromBudget = key;
      }
      const resolved = templateLines(tpl, data, dateIso);
      lines = resolved.lines;
      scheduleSource = templateFillSourceId(tpl, rawDate, resolved.live, new Map(data.envelopes.map(e => [e.id, e])));
    }

    // The template's own schedule can declare its funding envelope; a manual
    // run must produce the same row post-due would, so an explicit
    // fromEnvelope may only confirm it.
    let sourceEnvelope = input.fromEnvelope ?? null;
    if (input.fromEnvelope !== undefined) {
      if (source === 'new_income') return fail('fill_source_conflict', { reason: 'new_income', envelope: input.fromEnvelope });
      if (scheduleSource && input.fromEnvelope !== scheduleSource) {
        return fail('fill_source_conflict', { reason: 'schedule', envelope: input.fromEnvelope, schedule: scheduleSource, template: tpl.id });
      }
    } else if (scheduleSource) {
      if (source === 'new_income') return fail('fill_source_conflict', { reason: 'new_income', envelope: scheduleSource });
      sourceEnvelope = scheduleSource;
    }
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    if (sourceEnvelope) {
      if (lines.some(l => l.envelope_id === sourceEnvelope)) return fail('fill_source_conflict', { reason: 'target', envelope: sourceEnvelope });
      if (!total) return fail('fill_nothing_to_fund');
      lines = [...lines, { envelope_id: sourceEnvelope, mode: 'add', amount: -total }];
    }
    // Zero lines only record a met set target: they fund nothing on their own.
    if (!lines.some(l => l.amount)) return fail('fill_nothing_to_fund');

    if (source === 'new_income' && input.account == null) return fail('field_required', { field: 'account' });
    if (input.account !== undefined && source === 'allocation') return fail('field_not_allowed', { field: 'account', type: 'fill' });

    const at = ctx.now.toISOString();
    const payee = (input.payee ?? '').trim() || (tpl ? (tpl.name ?? '') : '');
    /** @type {Record<string, any>} */
    const row = {
      id: ctx.newId(), type: 'fill', date: dateIso, status: 'posted', source, lines,
      payee, note: typeof input.note === 'string' ? (input.note.trim() || null) : null,
      created_at: at, modified_at: at,
    };
    if (input.account !== undefined) row.source_account = input.account;
    if (tpl) row.template_id = tpl.id;
    if (fromBudget) row.from_budget = fromBudget;
    if (sourceEnvelope) row.source_envelope_id = sourceEnvelope;
    /** @type {Record<string, any>} */
    const changes = { transactions: [...data.transactions, row] };
    if (nextTemplates) changes.envelopeTemplates = nextTemplates;
    return ok({ changes, value: row });
  },
};
