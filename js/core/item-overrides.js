// js/core/item-overrides.js — unsaved plan-item edits as a query takes them.
//
// The Plan and Stress pages' live controls queue edits in one queue
// (js/ui/plan-item-live.js) and show the stored item with the pending fields
// over it until the update lands. A query that answers for what those pages
// show takes the same edits as `itemOverrides: [{ id, fields }]` and lays them
// over the stored items as the pages' `viewOf` does (`{ ...item, ...fields }`,
// a later entry for one id winning a field both set). An id no item has is
// ignored: the item may have been deleted while the edit was queued.

import { ITEM_FIELD_PROPERTIES } from './entity-fields.js';
import { MONTHS } from '../engine/stress.js';

/** The plan-item fields the live queue can carry: what an override may set. */
export const OVERRIDE_FIELDS = /** @type {const} */ ([
  'stress_cut_pcts', 'stress_category', 'stress_cut_pct', 'monthly_schedule', 'include', 'include_in_emergency_budget',
]);

/**
 * A plan item's months as stored: true/false or any number, 0 and negatives
 * included. The Plan page's schedule popover queues stored-shaped values, and
 * refusing one would freeze the figures that read it.
 */
export const STORED_MONTHLY_SCHEDULE = Object.freeze({
  type: 'object', description: 'Active months as stored: true = the default amount, a number = that month\'s amount, false = off',
  properties: Object.fromEntries(MONTHS.map(m => [m, { anyOf: [{ enum: [true, false] }, { type: 'number' }] }])),
});

/** The override schema per field: the plan-item field's own, the months as stored. */
const OVERRIDE_PROPERTIES = Object.freeze({
  ...Object.fromEntries(OVERRIDE_FIELDS.map(k => [k, ITEM_FIELD_PROPERTIES[k]])),
  monthly_schedule: STORED_MONTHLY_SCHEDULE,
});

/** The `itemOverrides` input property. */
export const ITEM_OVERRIDES_INPUT = Object.freeze({
  type: 'array',
  description: 'Unsaved plan-item edits, laid over the stored item in order (a later entry for one id wins a field both set). An unknown id is ignored.',
  items: {
    type: 'object',
    required: ['id', 'fields'],
    properties: {
      id: { type: 'string', description: 'Plan item id' },
      fields: {
        type: 'object',
        properties: OVERRIDE_PROPERTIES,
      },
    },
  },
});

/**
 * The stored items with the overrides over them. Items without one are kept
 * by reference.
 * @param {any[]} items
 * @param {{ id: string, fields: Record<string, any> }[] | undefined} overrides
 * @returns {any[]}
 */
export function overlaid(items, overrides) {
  if (!overrides?.length) return items;
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const { id, fields } of overrides) byId.set(id, { ...byId.get(id), ...fields });
  return items.map(it => (it && byId.has(it.id) ? { ...it, ...byId.get(it.id) } : it));
}
