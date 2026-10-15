// js/ui/date-range.js — the date-range presets of the Charts and Money flow
// pages: year to date, the last 12 / 6 / 3 months (from the 1st of the month
// that many months back), everything, or a custom from/to. Takes today as an
// argument; pages pass `now()`.

/** The preset buttons, in the order the pages show them. */
export const RANGE_PRESETS = ['ytd', '12m', '6m', '3m', 'all'];

const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * @param {{ preset: string, from?: string | null, to?: string | null }} filter
 * @param {Date} today
 * @returns {{ from: string | null, to: string | null }}  inclusive ISO dates; null is unbounded
 */
export function resolveRangePreset(filter, today) {
  const y = today.getFullYear(), m = today.getMonth();
  const to = iso(y, m, today.getDate());
  // The 1st of the month n months back. Built from the 1st, so a month end
  // (31 May − 3) cannot roll over into the month after.
  const monthsBack = n => {
    const d = new Date(y, m - n, 1);
    return iso(d.getFullYear(), d.getMonth(), 1);
  };
  switch (filter.preset) {
    case 'ytd':    return { from: iso(y, 0, 1), to };
    case '12m':    return { from: monthsBack(12), to };
    case '6m':     return { from: monthsBack(6), to };
    case '3m':     return { from: monthsBack(3), to };
    case 'custom': return { from: filter.from ?? null, to: filter.to ?? null };
    default:       return { from: null, to: null };
  }
}
