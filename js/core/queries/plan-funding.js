// js/core/queries/plan-funding.js — every plan item's fill % across the whole
// budget, for the surfaces that list items rather than envelopes: the Plan
// page's "Not on track" filter and chip, and the Dashboard's attention line.
//
//   items  per funded plan item, in envelope order then item order: the
//          envelope's funding row for it (as `envelopes.month` and
//          `envelope.health` answer it) plus `envelopeId`
//
// One projection per non-archived envelope that has funded items, judged as
// the Envelopes page judges it: every non-archived envelope is in the walk's
// envelope set (a set-mode template finds its target there), only the funded
// ones are projected. The balance is as of `date` over the stored rows.
//
// The projection is not free and the Plan page asks on every repaint (a
// search keystroke included), so the answer is memoized on the identity of
// what it reads: a write replaces the arrays it changes, never mutates them.

import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { computeEnvelopeBalances } from '../../engine/balances.js';
import { computeSpareByEnvelope } from '../../engine/envelope-forecast.js';
import { computeItemFundingByEnvelope, envelopeFundingItems } from '../../engine/item-funding.js';
import { fundingAnswer } from '../envelope-answer.js';

/** @type {{ key: any[], value: any } | null} */
let memo = null;

export default {
  name: 'plan.funding',
  summary: 'Every funded plan item\'s fill % across the budget (what the Plan page\'s "Not on track" filter reads): per item, in envelope order, its envelope\'s funding row (planThisMonth, spent, remaining, overspent, allocated, pct, status, shortBy, shortDate, nextDue) plus envelopeId. Each envelope with funded items costs one 12-month projection from date; the balance is the stored rows as of date.',
  input: {
    type: 'object',
    properties: {
      date: { type: 'date', description: 'Today for the projection, the balance and the month judged (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const ref = refDate(input, ctx);
    const day = isoDate(ref);
    const country = monthCountry(data);
    const tombstones = monthTombstones(data);
    const transactions = data.transactions || [];
    const budgetItems = data.budgetItems || [];
    // The raw meta fields, not monthTombstones' fresh [] for a budget without any.
    const key = [day, data.meta?.country, data.meta?.scheduledTombstones, transactions, budgetItems, data.envelopes, data.envelopeTemplates, data.accounts];
    if (memo && memo.key.every((v, i) => v === key[i])) return ok(memo.value);

    const active = (data.envelopes || []).filter((/** @type {any} */ e) => e && !e.archived);
    const funded = active.filter((/** @type {any} */ e) => envelopeFundingItems(budgetItems, e.id).length > 0);
    /** @type {any[]} */
    const items = [];
    if (funded.length) {
      const spares = computeSpareByEnvelope({
        transactions,
        budgetItems,
        envelopeTemplates: data.envelopeTemplates || [],
        accounts: data.accounts || [],
        envelopes: active,
        only: new Set(funded.map((/** @type {any} */ e) => e.id)),
        today: ref,
        months: 12,
        country,
        tombstones,
      });
      const byEnvelope = computeItemFundingByEnvelope({
        envelopes: funded,
        budgetItems,
        transactions,
        balances: computeEnvelopeBalances(transactions, { asOf: ref }),
        today: ref,
        country,
        tombstones,
        dailyByEnvelope: new Map([...spares].map(([id, sp]) => [id, sp.daily])),
      });
      for (const [envelopeId, funding] of byEnvelope) {
        const answer = fundingAnswer(funding);
        if (!answer) continue;
        for (const item of answer.items) items.push({ ...item, envelopeId });
      }
    }
    const value = { items };
    memo = { key, value };
    return ok(value);
  },
};
