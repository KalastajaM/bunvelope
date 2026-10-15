// js/core/migrate-income-templates.js — one-time conversion of the
// income→template link onto the templates' own schedules.
//
// Envelope templates used to have no calendar of their own: a template fired
// only as a leg of a scheduled income occurrence, via `template_id` on the
// income budget item. That coupling had one real property — the pay day lived
// in one place — and one real defect: a month whose income amount was zero
// emitted no income row, and took the allocation down with it silently.
//
// Templates now carry their own schedule (`tpl.schedule`), which does
// everything the link did (months, payment_day, day_type, since/until,
// skipped) and adds `source_envelope_id` drawdown. The link is redundant, so
// it goes — but the runtime path is being deleted with it, which means an
// unconverted budget would simply stop allocating. Hence: convert on load,
// idempotently, before anything reads the schedule.
//
// Pure function. The caller persists whatever comes back.

import { MONTH_NAMES } from '../engine/_constants.js';
import { templateFillKey } from '../engine/scheduling.js';

/** Months carried over exactly as they behave today. */
function activeMonths(item) {
  const months = {};
  const schedule = item.monthly_schedule || {};
  for (const name of MONTH_NAMES) {
    const value = schedule[name];
    // `walkMonthlySchedule` treats `undefined` and `false` as inactive and
    // every other value — including 0 — as active. `computeScheduledOccurrences`
    // then drops the occurrence when the resolved amount rounds to nothing.
    // Both gates matter: reproducing only the first would start filling in
    // months that currently produce nothing.
    const walked = value !== undefined && value !== false;
    if (!walked) { months[name] = false; continue; }
    const amount = typeof value === 'number' ? value : (item.default_amount ?? 0);
    months[name] = Math.abs(amount) >= 0.005;
  }
  return months;
}

/**
 * The last month key (YYYY-MM) the income item already materialised, from its
 * posted rows and tombstones: `${itemId}:${month}` (income leg) and
 * `${itemId}:${month}:fill` (allocation leg). Null when it has none.
 */
function lastMaterialisedMonth(item, txs, tombstones) {
  const prefix = `${item.id}:`;
  let last = null;
  const consider = key => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return;
    const rest = key.slice(prefix.length);
    const month = rest.endsWith(':fill') ? rest.slice(0, -':fill'.length) : rest;
    if (/^\d{4}-\d{2}$/.test(month) && (last === null || month > last)) last = month;
  };
  for (const tx of txs) consider(tx && tx.from_budget);
  for (const key of tombstones) consider(key);
  return last;
}

function firstOfNextMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * The template's `since`. The income link only ever emitted a fill as a leg
 * of an income occurrence that had not posted yet, so every month up to the
 * last one the item materialised is settled: whatever fill it has (or had,
 * before the user deleted it) is final. Copying the item's own
 * `as_schedule_since` instead let the template materialiser backfill every
 * month since the salary started, including ones from before the template
 * was linked.
 */
function scheduleSince(item, txs, tombstones) {
  const last = lastMaterialisedMonth(item, txs, tombstones);
  const own = typeof item.as_schedule_since === 'string' ? item.as_schedule_since : null;
  if (last === null) return own;
  const next = firstOfNextMonth(last);
  return own && own > next ? own : next;
}

function scheduleFromIncomeItem(item, txs, tombstones) {
  const schedule = {
    enabled: true,
    months: activeMonths(item),
    payment_day: Number(item.payment_day) >= 1 ? Number(item.payment_day) : 1,
  };
  if (item.schedule_day_type) schedule.day_type = item.schedule_day_type;
  const since = scheduleSince(item, txs, tombstones);
  if (since) schedule.since = since;
  if (item.as_schedule_until) schedule.until = item.as_schedule_until;
  if (Array.isArray(item.skipped_occurrences) && item.skipped_occurrences.length) {
    // Same shape on both sides: 'YYYY-MM' keys consumed by walkMonthlySchedule.
    schedule.skipped = [...item.skipped_occurrences];
  }
  return schedule;
}

/**
 * Convert every income→template link onto the template's own schedule.
 *
 * Returns `{ changed, budgetItems, envelopeTemplates, transactions, meta, notes }`.
 * `meta` is a new object only when a tombstoned fill key was rewritten to the
 * template key format (`meta.scheduledTombstones`); otherwise the input.
 * `changed` is false when there was nothing to do, in which case the input
 * arrays come back by identity — the caller can skip the write entirely, and
 * a second run over converted data is a no-op.
 *
 * `notes` carries anything the conversion could not do faithfully, for the
 * caller to surface. It is never a reason to abort: leaving a link in place
 * would break allocation outright once the income-linked runtime is gone.
 */
export function convertIncomeLinkedTemplates({ budgetItems, envelopeTemplates, transactions, meta }) {
  const items = Array.isArray(budgetItems) ? budgetItems : [];
  const templates = Array.isArray(envelopeTemplates) ? envelopeTemplates : [];
  const txs = Array.isArray(transactions) ? transactions : [];
  const tombstones = meta && Array.isArray(meta.scheduledTombstones) ? meta.scheduledTombstones : [];

  const linked = items.filter(item =>
    item && item.kind === 'income' && item.as_schedule && item.template_id);
  if (linked.length === 0) {
    return { changed: false, budgetItems, envelopeTemplates, transactions, meta, notes: [] };
  }

  const byId = new Map(templates.map(tpl => [tpl.id, tpl]));
  const notes = [];
  const nextSchedules = new Map(); // templateId -> schedule
  const keyRewrites = new Map();   // old from_budget -> new from_budget
  const claimedBy = new Map();     // templateId -> item id that set its schedule

  for (const item of linked) {
    const tpl = byId.get(item.template_id);
    if (!tpl) {
      notes.push({ kind: 'missing-template', itemId: item.id, templateId: item.template_id });
      continue;
    }

    if (tpl.schedule && tpl.schedule.enabled === true) {
      // A schedule someone set deliberately outranks one derived from an
      // income item. Keep it, drop the link, and say so — the fill dates may
      // move, and that is worth knowing rather than discovering.
      notes.push({ kind: 'kept-existing-schedule', itemId: item.id, templateId: tpl.id });
    } else if (claimedBy.has(tpl.id)) {
      // A template can hold one calendar. Two income items pointing at it
      // cannot both be represented, so the second one's dates are lost.
      notes.push({
        kind: 'shared-template', itemId: item.id, templateId: tpl.id,
        keptItemId: claimedBy.get(tpl.id),
      });
    } else {
      nextSchedules.set(tpl.id, scheduleFromIncomeItem(item, txs, tombstones));
      claimedBy.set(tpl.id, item.id);
    }

    // Posted allocation fills carry the income item's key. The template
    // materialiser looks for `tpl:<id>:<month>`, so without this rewrite it
    // would find no record of the fills already posted and re-post the
    // current month's allocation on top of them.
    // Tombstones of deleted fills need the same rewrite, or the deleted
    // month is posted again under the template key.
    const prefix = `${item.id}:`;
    const rewrite = key => {
      if (typeof key !== 'string') return;
      if (!key.startsWith(prefix) || !key.endsWith(':fill')) return;
      const monthKey = key.slice(prefix.length, -':fill'.length);
      if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
      keyRewrites.set(key, templateFillKey(tpl.id, monthKey));
    };
    for (const tx of txs) {
      if (tx && tx.type === 'fill') rewrite(tx.from_budget);
    }
    for (const key of tombstones) rewrite(key);
  }

  const nextItems = items.map(item =>
    linked.includes(item) ? { ...item, template_id: null } : item);

  const nextTemplates = templates.map(tpl =>
    nextSchedules.has(tpl.id) ? { ...tpl, schedule: nextSchedules.get(tpl.id) } : tpl);

  const nextTxs = keyRewrites.size === 0
    ? transactions
    : txs.map(tx => (tx && keyRewrites.has(tx.from_budget) && keyRewrites.get(tx.from_budget) !== tx.from_budget
      ? { ...tx, from_budget: keyRewrites.get(tx.from_budget) }
      : tx));

  const nextMeta = tombstones.some(key => keyRewrites.has(key))
    ? { ...meta, scheduledTombstones: tombstones.map(key => keyRewrites.get(key) ?? key) }
    : meta;

  return {
    changed: true,
    budgetItems: nextItems,
    envelopeTemplates: nextTemplates,
    transactions: nextTxs,
    meta: nextMeta,
    notes,
  };
}
