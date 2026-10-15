// allocation.consolidate — the month review's "consolidate": move an
// envelope's surplus (or shortfall) with a line on the day's single
// consolidation fill. The merge rule is the Review page's consolidateEnvelope
// (js/pages/review.js), unchanged: the first `type: 'fill'`,
// `source: 'consolidation'` row dated that day takes one line per envelope; a
// repeat REPLACES the envelope's line (it never stacks), a zero amount removes
// it, and the fill goes once its last line does. With no such row a new one is
// created (a zero amount then changes nothing). Lines apply in order, each as
// its own consolidation. Transactions only.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';

/** The page's own label, in English; the page passes its translation. */
const DEFAULT_PAYEE = 'Envelope consolidation';

/**
 * One envelope's consolidation, as consolidateEnvelope applies it.
 * @param {any[]} txs
 * @param {string} date
 * @param {string} envelopeId
 * @param {number} amount
 * @param {() => Record<string, any>} newRow  builds the day's fill when there is none
 * @returns {any[]} the next transactions, or `txs` itself when nothing changes
 */
function consolidateOne(txs, date, envelopeId, amount, newRow) {
  const delta = Math.round(amount * 100) / 100;
  const zero = Math.abs(delta) < 0.005;
  const idx = txs.findIndex(tx => tx.type === 'fill' && tx.source === 'consolidation' && tx.date === date);
  if (idx < 0) {
    if (zero) return txs;
    return txs.concat([{ ...newRow(), lines: [{ envelope_id: envelopeId, amount: delta, mode: 'add' }] }]);
  }
  const existing = txs[idx];
  const lines = Array.isArray(existing.lines) ? existing.lines : [];
  const lineIdx = lines.findIndex(l => l.envelope_id === envelopeId);
  let nextLines;
  if (lineIdx >= 0) {
    nextLines = zero
      ? lines.filter((_, i) => i !== lineIdx)
      : lines.map((l, i) => (i === lineIdx ? { ...l, amount: delta, mode: 'add' } : l));
  } else {
    if (zero) return lines.length ? txs : txs.filter((_, i) => i !== idx);
    nextLines = lines.concat([{ envelope_id: envelopeId, amount: delta, mode: 'add' }]);
  }
  if (!nextLines.length) return txs.filter((_, i) => i !== idx);
  return txs.map((tx, i) => (i === idx ? { ...existing, lines: nextLines } : tx));
}

export default {
  name: 'allocation.consolidate',
  summary: 'Consolidate envelopes on the month review: each line sets that envelope\'s line on the day\'s single consolidation fill (a repeat replaces it, zero removes it), creating the fill if there is none. Returns the fill row, or null when none is left.',
  payeeAliases: false,
  input: {
    type: 'object',
    required: ['lines'],
    properties: {
      lines: {
        type: 'array', description: 'One line per envelope, applied in order',
        items: {
          type: 'object', required: ['envelope', 'amount'],
          properties: {
            envelope: { type: 'ref', kind: 'envelope' },
            amount: { type: 'money', description: 'Signed amount moved into the envelope (negative moves its surplus out); zero removes its line' },
          },
        },
      },
      date: TX_INPUT_PROPERTIES.date,
      payee: { type: 'string', description: `Payee of a newly created fill (default "${DEFAULT_PAYEE}")` },
    },
  },
  execute(data, input, ctx) {
    if (input.lines.length === 0) return fail('bad_input', { errors: [{ path: 'lines', message: 'needs at least one line' }] });
    const date = input.date ?? ctx.todayIso;
    const newRow = () => ({
      id: ctx.newId(), type: 'fill', date, status: 'posted', source: 'consolidation',
      payee: (input.payee ?? '').trim() || DEFAULT_PAYEE,
    });
    let txs = data.transactions;
    for (const l of input.lines) txs = consolidateOne(txs, date, l.envelope, l.amount, newRow);
    const row = txs.find(tx => tx.type === 'fill' && tx.source === 'consolidation' && tx.date === date) ?? null;
    if (txs === data.transactions) return ok({ changes: {}, value: row });
    return ok({ changes: { transactions: txs }, value: row });
  },
};
