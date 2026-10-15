// js/core/context.js — the one place a command or query learns "now".
// Built by a session at the impure edge and passed in; core never reads a clock.

/** @typedef {{ now: Date, today: Date, todayIso: string, newId: () => string, country: string }} Ctx
 *  `now` and `today` are getters returning a fresh Date on every read, so a command cannot corrupt them. */

/**
 * Local calendar date as YYYY-MM-DD.
 * @param {Date} d
 * @returns {string}
 */
export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {{ now: Date, newId: () => string, country?: string }} args
 * @returns {Ctx}
 */
export function makeCtx({ now, newId, country = 'FI' }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('makeCtx: `now` must be a valid Date (the clock is injected, never read here)');
  }
  if (typeof newId !== 'function') throw new TypeError('makeCtx: `newId` must be a function');
  const nowMs = now.getTime();
  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayIso = isoDate(new Date(todayMs));
  return Object.freeze({
    get now() { return new Date(nowMs); },
    get today() { return new Date(todayMs); },
    todayIso,
    newId,
    country,
  });
}
