// js/core/queries/envelope-history.js — money into and out of one envelope,
// per calendar month: the AI's get_envelope_history.
//
// The `months` calendar months ending with date's month, oldest first, each
// listed even when nothing moved. Stored rows only (no forecast rows), dated
// in the month. A row's additive effect on the envelope counts as in (above
// zero) or out (below); a set-mode fill line overwrites the balance and has
// no in or out, so it is left out.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { txEnvelopeEffect } from '../../engine/balances.js';
import { round2 } from '../../utils.js';

export default {
  name: 'envelope.history',
  summary: 'Month by month, the money into and out of one envelope: the months ending with date\'s month, oldest first, each { month, in, out } (out as a positive amount). Set-mode fill lines, which overwrite the balance, count as neither.',
  input: {
    type: 'object',
    required: ['envelope'],
    properties: {
      envelope: { type: 'ref', kind: 'envelope', description: 'The envelope' },
      months: { type: 'integer', minimum: 1, maximum: 36, default: 12, description: 'How many months, ending with date\'s month (1-36, default 12)' },
      date: { type: 'date', description: 'The day whose month is the last (YYYY-MM-DD, default today)' },
    },
  },
  /**
   * @param {any} data
   * @param {{ envelope: string, months: number, date?: string }} input
   * @param {import('../context.js').Ctx} ctx
   */
  run(data, input, ctx) {
    const now = refDate(input, ctx);
    /** @type {Map<string, { month: string, in: number, out: number }>} */
    const buckets = new Map();
    for (let i = input.months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets.set(key, { month: key, in: 0, out: 0 });
    }
    for (const tx of (data.transactions || [])) {
      if (tx.is_forecast) continue;
      const bucket = buckets.get(String(tx.date || '').slice(0, 7));
      if (!bucket) continue;
      const effect = txEnvelopeEffect(tx, input.envelope);
      if (!effect || effect.mode !== 'add') continue;
      const amount = effect.amount;
      if (!amount) continue;
      if (amount > 0) bucket.in = round2(bucket.in + amount);
      else bucket.out = round2(bucket.out - amount);
    }
    return ok([...buckets.values()]);
  },
};
