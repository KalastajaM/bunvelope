/**
 * import.js — ID generator.
 *
 * Historically this file also held Danske Bank and Goodbudget CSV parsers,
 * but the UI never wired them to a real import flow. They were removed
 * together with the "unassigned transactions" feature.
 */

/**
 * Generate a UUID v4. Prefers crypto.randomUUID(), falls back to
 * crypto.getRandomValues() so we never use the unsafe Math.random() path
 * (the previous fallback only had ~36 bits of effective entropy and could
 * collide in long-lived budgets). All supported browsers expose at least
 * one of the two.
 * @returns {string}
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const h = [...b].map(x => x.toString(16).padStart(2, '0'));
    return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10,16).join('')}`;
  }
  throw new Error('generateId: no Web Crypto API available');
}
