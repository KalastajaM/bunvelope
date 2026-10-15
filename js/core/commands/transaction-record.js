// transaction.record — a new expense, income, transfer, investment or loan
// payment row. One row per call; several rows (a loan payment's principal
// and interest) are a batch.

import { ok } from '../result.js';
import { RECORD_INPUT_PROPERTIES, buildRecordedRow } from '../tx-record.js';

export default {
  name: 'transaction.record',
  summary: 'Record one transaction (expense, income, account or envelope transfer, investment buy/sell/dividend, loan payment). Returns the new row. Amounts are positive; the type decides the direction.',
  input: {
    type: 'object',
    required: ['type', 'amount'],
    properties: RECORD_INPUT_PROPERTIES,
  },
  execute(data, input, ctx) {
    const built = buildRecordedRow(input, ctx, data);
    if (!built.ok) return built;
    return ok({ changes: { transactions: [...data.transactions, built.value] }, value: built.value });
  },
};
