// js/pages/net-worth-alerts.js — pick the single earliest "date to act on"
// alert from a simulation's alert list, for the Dashboard's compact summary
// card. Pure; no DOM (and no import of app.js), so it is testable without
// the page or a browser.

/**
 * The earliest alert by `firstDate`. Ties keep whichever one appears first
 * in `alerts` (the simulation already returns them sorted this way, but
 * this helper doesn't rely on that).
 * @param {{ firstDate: string }[]} alerts
 * @returns {{ firstDate: string } | null}
 */
export function firstAlert(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return null;
  let best = alerts[0];
  for (let i = 1; i < alerts.length; i++) {
    const a = alerts[i];
    if (a && a.firstDate < best.firstDate) best = a;
  }
  return best;
}
