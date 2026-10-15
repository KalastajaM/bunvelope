// js/core/template-pending.js — "Fill now" on a scheduled template can be
// an extra fill or the next scheduled fill run early. Finds the occurrence an
// early run would replace; kept free of DOM/app imports so it can be
// unit-tested.
//
// The run itself is allocation.fill with `month` and `skipTemplateMonth`: it
// skips the occurrence through the template's own `schedule.skipped` month
// list, which the materialiser, every forecast and the page's "Next run" line
// already honour. The fill is NOT tagged with the occurrence's `from_budget`
// key instead: an early run dated weeks before the occurrence would sit more
// than LINK_DAY_WINDOW outside the keyed month, and the invariant check would
// report it as a stale link.
import { forecastTemplateFills, forecastDueAheadTemplateFills } from '../engine/scheduling.js';
import { takenOccurrenceKeys } from './effective-txs.js';
import { isoDate } from './context.js';

/**
 * The next occurrence of a scheduled template that has not yet posted, been
 * deleted or been skipped, or null when the template is not scheduled or has
 * nothing left to fire.
 *
 * Includes an occurrence whose schedule date has passed but whose
 * banking-day-shifted payment date is still ahead: it has not filled yet, so
 * it is the one an early run replaces.
 *
 * @param {any} tpl
 * @param {{ budgetItems?: any[], envelopes?: any[], transactions?: any[],
 *   tombstones?: string[], taken?: Set<string>, today: Date, country?: string }} ctx
 * @returns {{ date: string, monthKey: string } | null}
 */
export function nextPendingTemplateFill(tpl, ctx) {
  if (!tpl || tpl.schedule?.enabled !== true) return null;
  const { budgetItems = [], envelopes = [], transactions = [], tombstones = [], today, country = 'FI' } = ctx;
  // 13 months: an occurrence in the current month that already passed comes
  // round again a year later, plus room for a banking-day shift.
  const end = isoDate(new Date(today.getFullYear(), today.getMonth() + 13, today.getDate()));
  const rows = [
    ...forecastDueAheadTemplateFills([tpl], budgetItems, envelopes, today, { country }),
    ...forecastTemplateFills([tpl], budgetItems, envelopes, today, end, { country }),
  ];
  const taken = ctx.taken ?? takenOccurrenceKeys(transactions, tombstones);
  let best = null;
  for (const row of rows) {
    if (taken.has(row.forecast_dedup_key)) continue;
    if (!best || row.date < best.date) best = row;
  }
  if (!best) return null;
  return {
    date: best.date,
    monthKey: best.forecast_month_key,
  };
}
