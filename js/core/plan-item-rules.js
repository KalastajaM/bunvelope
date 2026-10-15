// js/core/plan-item-rules.js — the plan-item rules a save applies: the
// `as_schedule_since` it stamps and the `account_id` it keeps.
//
// Pure and DOM-free. Moved from js/pages/budget-plan-since.js and
// js/pages/budget-plan-account-rules.js so the plan-item commands
// (js/core/entity-fields.js applyItemFields), the editor sheet and the list's
// Enabled/Disabled chip share one tested rule.

/**
 * The `as_schedule_since` to store when a plan item is saved.
 *
 * - Not posting on a schedule: `null`.
 * - New item, or scheduling just switched on: today.
 * - Kind changed: today. Earlier months' posts were the old kind (their
 *   `from_budget` keys are taken, so this month would silently not post), and
 *   months the old kind never posted must not be backfilled as the new one.
 * - Enabled again after being Disabled (`include` from explicit `false` to
 *   not-`false`): today. A disabled item posts nothing, and re-enabling
 *   resumes from the next occurrence rather than backfilling the paused
 *   months. A legacy item with no `include` was never disabled.
 * - Otherwise: the existing date, or today when there is none.
 *
 * @param {{
 *   prevItem: { kind?: string, as_schedule?: boolean, as_schedule_since?: string|null, include?: boolean } | null,
 *   nextInclude: boolean,
 *   nextKind: string,
 *   asSchedule: boolean,
 *   today: string,
 * }} args  `prevItem` is null for a new item; `today` is YYYY-MM-DD.
 * @returns {string|null}
 */
export function sinceOnSave({ prevItem, nextInclude, nextKind, asSchedule, today }) {
  if (!asSchedule) return null;
  if (!prevItem || !prevItem.as_schedule) return today;
  if (prevItem.kind !== nextKind) return today;
  if (prevItem.include === false && nextInclude !== false) return today;
  return prevItem.as_schedule_since || today;
}

/**
 * The `account_id` to persist for a plan item, given its kind, scheduling
 * state, and the picker's current value (already `|| null`).
 *
 * Expense items keep whatever the picker holds regardless of scheduling
 * (null when left on "from history"). Every other kind keeps today's rule:
 * the value only while scheduled, `null` otherwise. `account_transfer` is
 * always scheduled (forced by the editor), so this resolves the same as
 * "keep the picker's value" for it too.
 * @param {string} kind
 * @param {boolean} asSchedule
 * @param {string|null} accountIdVal
 * @returns {string|null}
 */
export function resolvePlanItemAccountId(kind, asSchedule, accountIdVal) {
  if (kind === 'expense') return accountIdVal;
  return asSchedule ? accountIdVal : null;
}
