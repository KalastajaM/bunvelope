// js/ui/plan-item-live.js — the one live-edit queue for plan items.
//
// The Plan page's row chips and popovers and the Stress page's cut controls
// edit the same items, often the same field (`stress_cut_pcts`, a whole map).
// They share this one queue, so an edit made on one page and still inside its
// quiet window is part of what the other page shows (viewOf) and sends: two
// edits of one item coalesce into one `budgetItem.update`, and neither page
// can send a map built without the other's pending fields.
//
// A stored item is never edited in place: the session diffs rows, and an
// in-place edit is invisible to it. The queue lives for the module's lifetime.
// A page subscribes once with onItemSettled and works on its page as it is now
// (its current render), not on the render that queued the edit.

import { state, session } from '../app.js';
import { createDebouncedDispatch } from './debounced-dispatch.js';
import { reportDispatchFailure, reportMetaFailure } from './save-error.js';
import { onBudgetSessionChange } from '../state/budget-session.js';
import { SCENARIOS } from '../engine/stress.js';

/** @type {Set<(id: string, result: any) => boolean | void>} */
const listeners = new Set();

const live = createDebouncedDispatch({
  session,
  command: 'budgetItem.update',
  currentFolder: () => state.budgetFolder,
  onSettled: settle,
});

// Pending edits belong to the budget they were made in: a switch (or a guest
// reset, which keeps the folder object) drops them all.
onBudgetSessionChange(() => live.dropAll());

function settle(id, r) {
  // The rows saved but the change-log entry did not: said once, by the queue.
  if (r.ok) reportMetaFailure(r);
  // Nothing was written: forget what is pending for the item, so every page
  // shows state again.
  if (!r.ok) live.drop(id);
  let reported = false;
  for (const listener of [...listeners]) {
    if (listener(id, r) === true) reported = true;
  }
  // A failure no mounted page told the user about still gets said.
  if (!r.ok && !reported) reportDispatchFailure(r.error);
}

/** Queue fields for item `id`; they go out after the quiet window, the last value per field winning. */
export function setItemFields(id, fields) {
  live.set(id, fields);
}

/** The unsaved live edits of item `id` (queued or in flight), or null. */
export function pendingFields(id) {
  return live.pending(id);
}

/** The stored item with the unsaved live edits over it. */
export function viewOf(item) {
  const pending = pendingFields(item.id);
  return pending ? { ...item, ...pending } : item;
}

/**
 * A cut map with the scenario keys only. A stored map can hold another key
 * (the controls copy whatever it has); no scenario reads one, and the plan
 * queries refuse it, which would freeze their figures.
 */
export function scenarioCuts(map) {
  if (!map || typeof map !== 'object') return map;
  return Object.fromEntries(Object.entries(map).filter(([s]) => SCENARIOS.includes(s)));
}

/**
 * The unsaved live edits of `items` as the plan queries take them
 * (`itemOverrides`, js/core/item-overrides.js): one entry per item with
 * pending fields, in item order, each cut map with its scenario keys only.
 */
export function pendingOverrides(items) {
  const out = [];
  for (const it of items) {
    const pending = pendingFields(it.id);
    if (!pending) continue;
    out.push({ id: it.id, fields: 'stress_cut_pcts' in pending ? { ...pending, stress_cut_pcts: scenarioCuts(pending.stress_cut_pcts) } : pending });
  }
  return out;
}

/** Send everything now; resolves when nothing is queued or in flight. */
export function flushItems() {
  return live.flush();
}

/** Forget item `id`'s queued fields. */
export function dropItem(id) {
  live.drop(id);
}

/**
 * Run `listener(id, result)` after each update lands. On a failure the queue
 * has already dropped the item's pending fields; a listener that told the user
 * (its page is mounted) returns true, and when none did the failure is reported
 * globally. Returns an unsubscribe function.
 * @param {(id: string, result: any) => boolean | void} listener
 */
export function onItemSettled(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
