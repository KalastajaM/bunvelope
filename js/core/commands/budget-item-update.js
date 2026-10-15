// budgetItem.update — set a plan item's fields. The stored item is the base,
// so fields the editor does not render survive (skipped_occurrences,
// as_schedule_until, template_id, loan_paid_off, loan_months_off). With `kind`
// given the whole record is normalised as the editor's save does; without it
// only the given fields and what derives from them change (applyItemFields).
// The result must pass the editor's checks (checkItem), but only for what the
// update itself introduces: a stored item that already breaks a rule (a zero
// amount, a dangling reference) can still be edited, so a live control never
// fails on data it did not touch. An update that changes nothing is ok, with
// no changes.

import { ok, fail } from '../result.js';
import { ITEM_FIELD_PROPERTIES, applyItemFields, checkItem } from '../entity-fields.js';
import { deepEqual } from '../diff.js';

export default {
  name: 'budgetItem.update',
  summary: 'Change a plan item\'s fields (null clears one where the field allows it). Giving kind re-normalises the whole item as the editor does; otherwise only the given fields change. default_amount takes any sign and is stored positive for income and dividends, negative otherwise.',
  input: {
    type: 'object',
    required: ['id', 'fields'],
    properties: {
      id: { type: 'ref', kind: 'budgetItem' },
      fields: { type: 'object', properties: ITEM_FIELD_PROPERTIES },
    },
  },
  execute(data, input, ctx) {
    const stored = data.budgetItems.find(it => it.id === input.id);
    const item = applyItemFields(stored, input.fields, { todayIso: ctx.todayIso, prev: stored });
    const key = (e) => `${e.path}\0${e.message}`;
    const had = new Set((checkItem(stored, data)?.params.errors ?? []).map(key));
    const added = (checkItem(item, data)?.params.errors ?? []).filter(e => !had.has(key(e)));
    if (added.length) return fail('bad_input', { errors: added.map(e => ({ ...e, path: `fields.${e.path}` })) });
    if (deepEqual(item, stored)) return ok({ changes: {}, value: { id: stored.id } });
    return ok({
      changes: { budgetItems: data.budgetItems.map(it => (it.id === stored.id ? item : it)) },
      value: { id: stored.id },
    });
  },
};
