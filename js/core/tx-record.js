// js/core/tx-record.js — how a recorded row is built from a transaction.record
// input. transaction.record and transaction.import both build rows here, so a
// row recorded alone and the same row imported in bulk cannot differ.

import { ok, fail } from './result.js';
import { TX_TYPES_RECORDABLE, TX_INPUT_PROPERTIES, applyTxInput, checkTxRow, checkTxLinks, defaultTypeFields } from './tx-fields.js';

/** The input properties of one recorded row (transaction.record's whole input). */
export const RECORD_INPUT_PROPERTIES = Object.freeze({
  type: { enum: [...TX_TYPES_RECORDABLE] },
  scheduled: { type: 'boolean', description: 'A future one-off: stored as scheduled, posted later with transaction.post' },
  ...TX_INPUT_PROPERTIES,
});

/**
 * Build and check one new row. Pure: the id and both timestamps come from ctx.
 * @param {Record<string, any>} input  a validated transaction.record input
 * @param {import('./context.js').Ctx} ctx
 * @param {{ accounts?: any[] }} data  the budget, for the checks that read it
 * @returns {{ ok: true, value: Record<string, any> } | { ok: false, error: { code: string, params: Record<string, any> } }}
 */
export function buildRecordedRow(input, ctx, data) {
  const at = ctx.now.toISOString();
  /** @type {Record<string, any>} */
  let row = { id: ctx.newId(), type: input.type, date: ctx.todayIso, payee: '', amount: input.amount, note: null };
  row = defaultTypeFields(row);
  const { type: _t, scheduled, force: _f, ...fields } = input;
  row = applyTxInput(row, fields);
  if (scheduled) { row.status = 'scheduled'; delete row.cleared; }
  // A row that settles a plan occurrence is a posted payment; say so, as the
  // edit sheet always did when it posted one.
  else if (typeof row.from_budget === 'string' && row.from_budget) row.status = 'posted';
  row.created_at = at;
  row.modified_at = at;
  const bad = checkTxRow(row) || checkTxLinks(row, data);
  if (bad) return fail(bad.code, bad.params);
  return ok(row);
}
