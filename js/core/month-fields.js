// Shared by the month.* commands: the input they all take and how they read the
// reference date, country and tombstones. Pure; the clock is only ever the
// command's own date, built with arguments.

// Frozen: three commands share this one object as their input schema.
export const MONTH_INPUT_PROPERTIES = Object.freeze({
  date: Object.freeze({ type: 'date', description: 'Reference date, YYYY-MM-DD (default today)' }),
  cleared: Object.freeze({ type: 'boolean', description: 'Mark every posted row cleared' }),
  force: Object.freeze({ type: 'boolean', description: 'Bypass the strict-ledger history and future-date rules' }),
});

/**
 * Noon on the reference day, so a DST shift cannot move the calendar date.
 * @param {{ date?: string }} input
 * @param {{ todayIso: string }} ctx
 * @returns {Date}
 */
export function monthRefDate(input, ctx) {
  const [y, m, d] = String(input.date ?? ctx.todayIso).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** @param {Record<string, any>} data */
export const monthCountry = (data) => data.meta?.country ?? 'FI';

/** @param {Record<string, any>} data @returns {string[]} */
export const monthTombstones = (data) =>
  Array.isArray(data.meta?.scheduledTombstones) ? data.meta.scheduledTombstones : [];

/**
 * @param {Record<string, any>[]} rows
 * @param {{ cleared?: boolean }} input
 */
export const markCleared = (rows, input) => (input.cleared === true ? rows.map(r => ({ ...r, cleared: true })) : rows);

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
/**
 * The bad_input errors for a `month` input that is not a real 'YYYY-MM' key,
 * or null when it is one. Shared by month.close, .reopen and .clearReopen.
 * @param {string} month
 * @returns {{ path: string, message: string }[] | null}
 */
export const monthKeyErrors = (month) => (MONTH_KEY.test(month) ? null : [{ path: 'month', message: 'must be a month, YYYY-MM' }]);
