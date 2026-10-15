// transaction.setFields — shared or per-row fields: date, payee, envelope or
// the plan-occurrence key. A field-only patch like transaction.flag: rows are
// not stripped, defaulted or re-validated, so a legacy row that fails
// checkTxRow can still be edited, and every other field is kept as stored.
// modified_at is stamped only on rows whose stored value changes.

import { ok, fail } from '../result.js';
import { TX_INPUT_PROPERTIES } from '../tx-fields.js';

const ENVELOPE_TYPES = new Set(['expense', 'income']);
const bad = (path, message) => fail('bad_input', { errors: [{ path, message }] });

const FIELDS = {
  date: TX_INPUT_PROPERTIES.date,
  payee: { type: 'string', description: 'Payee, trimmed; not blank' },
  envelope: TX_INPUT_PROPERTIES.envelope,
  fromBudget: { type: 'string', nullable: true, description: 'Plan occurrence key (item:YYYY-MM); null removes it. Never touches status' },
};

export default {
  name: 'transaction.setFields',
  summary: 'Set date, payee, envelope and/or fromBudget on transactions. Use ids with shared fields, or rows with distinct fields per id; never both. The envelope applies to expenses and income only and drops the plan-item link and splits. fromBudget: null removes the occurrence key. Matching rows are left alone. Any invalid row refuses the whole command.',
  input: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Transaction ids for shared fields (at least one); cannot be combined with rows' },
      ...FIELDS,
      rows: {
        type: 'array',
        description: 'Distinct patches, each with an id and at least one field; ids must be unique. Cannot be combined with ids or shared fields',
        items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...FIELDS } },
      },
      force: TX_INPUT_PROPERTIES.force,
    },
  },
  execute(data, input, ctx) {
    const perRow = Object.hasOwn(input, 'rows');
    if (perRow && (Object.hasOwn(input, 'ids') || Object.keys(FIELDS).some(k => Object.hasOwn(input, k)))) {
      return bad('(input)', 'use either ids with shared fields or rows, not both');
    }
    if (!perRow && !input.ids?.length) return bad('ids', 'needs at least one id');
    if (perRow && input.rows.length === 0) return bad('rows', 'needs at least one row');
    const patches = perRow ? input.rows : [input];
    const byId = new Map(data.transactions.map(t => [t.id, t]));
    const target = new Map();
    for (const [i, patch] of patches.entries()) {
      const has = k => Object.hasOwn(patch, k);
      const path = k => perRow ? `rows[${i}]${k === '(input)' ? '' : `.${k}`}` : k;
      if (!Object.keys(FIELDS).some(has)) {
        return bad(path('(input)'), 'needs at least one of date, payee, envelope, fromBudget');
      }
      const payee = has('payee') ? patch.payee.trim() : null;
      if (has('payee') && !payee) return bad(path('payee'), 'must not be blank');
      if (has('fromBudget') && patch.fromBudget !== null && !patch.fromBudget.trim()) {
        return bad(path('fromBudget'), 'must not be blank (null removes it)');
      }
      const ids = perRow ? [patch.id] : input.ids;
      for (const id of ids) {
        if (!byId.has(id)) return fail('tx_not_found', { id });
        if (perRow && target.has(id)) return bad(path('id'), 'must be unique');
      }
      for (const id of ids) {
        if (has('envelope')) {
          const type = byId.get(id).type;
          if (!ENVELOPE_TYPES.has(type)) return fail('field_not_allowed', { field: 'envelope_id', type });
        }
        target.set(id, has('payee') ? { ...patch, payee } : patch);
      }
    }
    const at = ctx.now.toISOString();
    let changed = 0;
    const transactions = data.transactions.map(t => {
      const patch = target.get(t.id);
      if (!patch) return t;
      const has = k => Object.hasOwn(patch, k);
      /** @type {Record<string, any>} */
      const next = { ...t };
      if (has('date')) next.date = patch.date;
      if (has('payee')) next.payee = patch.payee;
      if (has('envelope')) {
        next.envelope_id = patch.envelope;
        delete next.budget_item_id;
        delete next.envelope_splits;
      }
      if (has('fromBudget')) {
        if (patch.fromBudget === null) delete next.from_budget;
        else next.from_budget = patch.fromBudget;
      }
      if (sameRow(t, next)) return t;
      changed++;
      next.modified_at = at;
      return next;
    });
    return ok({ changes: changed ? { transactions } : {}, value: { changed } });
  },
};

/** True when both rows hold the same keys with the same values (all JSON data). */
function sameRow(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(k => Object.hasOwn(b, k) && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}
