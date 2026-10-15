// envelope.move — move funds between envelopes. Stores exactly what
// transaction.record stores for type 'envelope_transfer'.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES, applyTxInput, checkTxRow, defaultTypeFields } from '../tx-fields.js';

export default {
  name: 'envelope.move',
  summary: 'Move funds between envelopes. Returns the new transaction row.',
  input: {
    type: 'object',
    required: ['fromEnvelope', 'toEnvelope', 'amount'],
    properties: {
      fromEnvelope: { type: 'ref', kind: 'envelope', nullable: true, description: 'Source envelope; null = unallocated' },
      toEnvelope: { type: 'ref', kind: 'envelope', nullable: true, description: 'Destination envelope; null = unallocated' },
      amount: TX_INPUT_PROPERTIES.amount,
      date: TX_INPUT_PROPERTIES.date,
      payee: TX_INPUT_PROPERTIES.payee,
      note: TX_INPUT_PROPERTIES.note,
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input, ctx) {
    const at = ctx.now.toISOString();
    /** @type {Record<string, any>} */
    let row = { id: ctx.newId(), type: 'envelope_transfer', date: ctx.todayIso, payee: '', amount: input.amount, note: null };
    row = defaultTypeFields(row);
    const { force: _f, ...fields } = input;
    row = applyTxInput(row, fields);
    row.created_at = at;
    row.modified_at = at;
    const bad = checkTxRow(row);
    if (bad) return fail(bad.code, bad.params);
    return ok({ changes: { transactions: [...data.transactions, row] }, value: row });
  },
};
