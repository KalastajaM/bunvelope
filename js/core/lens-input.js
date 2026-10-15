// js/core/lens-input.js — the lens and the reference date every query that
// follows the balance view shares, so they validate a horizon and pick their
// rows the same way `balances` does.
//
//   LENS_INPUT  the `lens` (optional, default booked) and `horizon` schema
//               properties; a lens-following query spreads them into its input.
//   lensRows    the lens rows for an input: `lensTransactions` with the
//               horizon checked and resolved to an ISO date.
//   todayRows   the Today lens rows (what has cleared), the baseline a lens
//               query measures "not yet cleared" against.
//   refDate     the day a "this month" / "today" query is about.
//   MONTH_RE, badMonth  a month input (YYYY-MM) and the error for a bad one.

import { ok, fail } from './result.js';
import { isoDate } from './context.js';
import { LENSES, HORIZONS, DEFAULT_LENS, DEFAULT_HORIZON, lensTransactions, resolveHorizonDate } from '../engine/lens.js';

const HORIZON_MESSAGE = `must be one of: ${HORIZONS.join(', ')}, or a real date (YYYY-MM-DD)`;

/**
 * A preset, or an ISO date that reads back as typed (no 30 February).
 * @param {any} h
 * @returns {boolean}
 */
export function isHorizon(h) {
  if (HORIZONS.includes(h)) return true;
  if (typeof h !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(h)) return false;
  const [y, m, d] = h.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d)) === h;
}

/** Schema properties of a query that follows the balance view. */
export const LENS_INPUT = Object.freeze({
  lens: { enum: LENSES, description: `today = cleared as of today; booked = everything entered; forecast = booked plus generated rows through the horizon. Default ${DEFAULT_LENS}` },
  horizon: { type: 'string', description: `Forecast only: eom, 3m, 6m, 12m or a date (YYYY-MM-DD). Default ${DEFAULT_HORIZON}` },
});

/**
 * The rows a lens-following query walks. `lens` defaults to booked; `horizon`
 * is refused with any lens but forecast, and resolved (default 3m) to an ISO
 * date for it, null otherwise.
 *
 * @param {any} data
 * @param {{ lens?: 'today' | 'booked' | 'forecast', horizon?: string }} input
 * @param {import('./context.js').Ctx} ctx
 * @returns {import('./result.js').Result}  value `{ lens, horizon: string | null, txs }`
 */
export function lensRows(data, { lens = DEFAULT_LENS, horizon }, ctx) {
  if (horizon !== undefined && lens !== 'forecast') return fail('bad_input', { errors: [{ path: 'horizon', message: 'only allowed with lens forecast' }] });
  if (horizon !== undefined && !isHorizon(horizon)) {
    return fail('bad_input', { errors: [{ path: 'horizon', message: HORIZON_MESSAGE }] });
  }
  const resolved = lens === 'forecast' ? resolveHorizonDate(horizon ?? DEFAULT_HORIZON, ctx.now) : null;
  const txs = lensTransactions(data, { lens, horizon: resolved ?? undefined, today: ctx.now });
  return ok({ lens, horizon: resolved, txs });
}

/**
 * The Today lens rows: what has cleared as of the query's clock.
 *
 * @param {any} data
 * @param {import('./context.js').Ctx} ctx
 * @returns {any[]}
 */
export function todayRows(data, ctx) {
  return lensTransactions(data, { lens: 'today', today: ctx.now });
}

/** A month input, YYYY-MM. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The `bad_input` failure for a `month` input that is not YYYY-MM.
 * @returns {import('./result.js').Result}
 */
export function badMonth() {
  return fail('bad_input', { errors: [{ path: 'month', message: 'must be a month, YYYY-MM' }] });
}

/**
 * The day a query is about: `input.date` (ISO, already validated by the
 * schema) or today, as a local Date at noon. Noon keeps a DST shift from
 * moving it to another day; the engine functions it feeds read only the
 * calendar day.
 *
 * @param {{ date?: string }} input
 * @param {import('./context.js').Ctx} ctx
 * @returns {Date}
 */
export function refDate({ date } = {}, ctx) {
  const [y, m, d] = (date ?? ctx.todayIso).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/**
 * @param {string} iso  YYYY-MM-DD
 * @returns {string} YYYY-MM
 */
export function monthOf(iso) {
  return iso.slice(0, 7);
}
