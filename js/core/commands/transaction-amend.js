// transaction.amend — change fields of one existing row in place. Starts
// from the stored row, so omitted fields stay as they are; null clears a
// field (or stores "none" for the envelope keys and the note).

import { ok, fail } from '../result.js';
import { TX_TYPES_RECORDABLE, TYPE_FIELDS, TX_INPUT_PROPERTIES, applyTxInput, checkTxRow, checkTxLinks, defaultTypeFields, stripForeignFields } from '../tx-fields.js';

export default {
  name: 'transaction.amend',
  summary: 'Change fields of one existing transaction by id; omitted fields stay, null clears one. Changing the type drops the fields of the old type. Only an adjustment may carry a signed amount.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      type: { enum: [...TX_TYPES_RECORDABLE] },
      status: { enum: ['scheduled', 'posted'] },
      flagged: { type: 'boolean' },
      target: { enum: ['account', 'envelope'], description: 'Collection an adjustment corrects (adjustment only)' },
      targetId: { type: 'string', description: 'What an adjustment corrects (adjustment only)' },
      ...TX_INPUT_PROPERTIES,
      amount: { type: 'money', description: 'Amount, a positive magnitude (signed for an adjustment)' },
    },
  },
  execute(data, input, ctx) {
    const at = ctx.now.toISOString();
    const index = data.transactions.findIndex(t => t.id === input.id);
    if (index < 0) return fail('tx_not_found', { id: input.id });
    /** @type {Record<string, any>} */
    let row = { ...data.transactions[index] };
    if (row.type === 'adjustment' && input.type !== undefined) return fail('field_not_allowed', { field: 'type', type: 'adjustment' });
    const typeChanged = input.type !== undefined && input.type !== row.type;
    if (typeChanged) row.type = input.type;
    // Every amend drops the fields the resulting type does not carry, not only
    // a type change: legacy rows hold strays (the edit form always deleted
    // them on save), and refusing to save such a row would lock it. A type this
    // table does not describe (a fill, say) is left alone, not stripped bare.
    if (Object.hasOwn(TYPE_FIELDS, row.type)) row = defaultTypeFields(stripForeignFields(row));
    const { id: _id, type: _t, status, target, targetId, force: _f, ...fields } = input;
    if (Object.hasOwn(fields, 'envelope') && !Object.hasOwn(fields, 'splits')) delete row.envelope_splits;
    row = applyTxInput(row, fields);
    if (target !== undefined) {
      if (row.type !== 'adjustment') return fail('field_not_allowed', { field: 'target', type: row.type });
      row.target = target;
    }
    if (targetId !== undefined) {
      if (row.type !== 'adjustment') return fail('field_not_allowed', { field: 'target_id', type: row.type });
      row.target_id = targetId;
    }
    if (row.type === 'adjustment' && (target !== undefined || targetId !== undefined)) {
      const collection = row.target === 'account' ? data.accounts : row.target === 'envelope' ? data.envelopes : [];
      if (!collection.some(x => x.id === row.target_id)) return fail('ref_not_found', { kind: row.target, name: row.target_id });
    }
    if (status === 'scheduled') { row.status = 'scheduled'; delete row.cleared; }
    else if (status === 'posted') { row.status = 'posted'; if (row.cleared === undefined) row.cleared = true; }
    if (row.type !== 'adjustment' && (Object.hasOwn(fields, 'amount') || typeChanged) && !(row.amount > 0)) {
      return fail('bad_input', { errors: [{ path: 'amount', message: 'must be positive' }] });
    }
    row.modified_at = at;
    // The link is checked only when this amend sets it: a row whose loan has
    // since changed type must stay editable (the invariant check reports it).
    const bad = checkTxRow(row) || (Object.hasOwn(fields, 'interestOf') ? checkTxLinks(row, data) : null);
    if (bad) return fail(bad.code, bad.params);
    const transactions = data.transactions.slice();
    transactions[index] = row;
    return ok({ changes: { transactions }, value: row });
  },
};
