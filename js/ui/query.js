// js/ui/query.js — how a page asks the session a query (js/core). A figure
// whose query fails is left off rather than shown from somewhere else, so
// the page gets the answer or null; a failure, or a query that throws, is
// warned in the console, never toasted. No engine import: the money is the
// query's.

import { session } from '../app.js';

/**
 * The answer of query `name`, or null when it failed or threw (warned).
 *
 * `onFail`, when given, sees a failed result's error first: a page that can
 * recover from one code (say a stale id) handles it there and returns true,
 * which skips the warning. A throw is always warned.
 *
 * @param {string} name
 * @param {Record<string, any>} input
 * @param {(error: { code: string, params?: Record<string, any> }) => boolean} [onFail]
 * @returns {any}
 */
export function ask(name, input, onFail) {
  let r;
  try {
    r = session.query(name, input);
  } catch (err) {
    console.warn(`[bunvelope] ${name} query threw:`, err);
    return null;
  }
  if (r.ok) return r.value;
  if (!onFail?.(r.error)) console.warn(`[bunvelope] ${name} query failed:`, r.error.code);
  return null;
}
