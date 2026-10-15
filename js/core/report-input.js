// js/core/report-input.js — what the Reports queries share: the date range,
// the page filter's exclusions, and the "Other" row as data.
//
//   RANGE_INPUT        the `from` / `to` schema properties (inclusive dates,
//                      either open)
//   EXCLUDE_ENVELOPES  the `excludeEnvelopes` property: envelope ids left out,
//                      per split line (unknown ids ignored)
//   EXCLUDE_PAYEES     the `excludePayees` property: payees left out, whole
//                      rows, as `txPayeeLabel` names them
//   reportFlow         the rows, range and engine options a range report reads
//   foldTop            the top rows and the folded rest as `{ count, value }`
//   monthPoints        the engine's `{ label, value }` month points as the
//                      answers name them, `{ month, value }`

import { txPayeeLabel } from '../engine/reports.js';
import { round2 } from '../utils.js';
import { NONE } from './projection.js';

/** Schema properties of a report over a date range. */
export const RANGE_INPUT = Object.freeze({
  from: { type: 'date', description: 'First day of the range, inclusive (YYYY-MM-DD; default: from the start)' },
  to: { type: 'date', description: 'Last day of the range, inclusive (YYYY-MM-DD; default: no end)' },
});

// Plain ids, not refs: the page filter can still hold the id of an envelope
// deleted since, and one stale id must not fail the whole report. An id no
// envelope has is simply ignored.
export const EXCLUDE_ENVELOPES = Object.freeze({
  type: 'array', items: { type: 'string' },
  description: 'Envelope ids left out (the page filter): a split expense keeps its other lines; an unknown id is ignored',
});

export const EXCLUDE_PAYEES = Object.freeze({
  type: 'array', items: { type: 'string' },
  description: 'Payees left out (the page filter), whole rows: the trimmed payee, or "(no payee)" for a row without one',
});

/**
 * The rows a range report aggregates and the engine options it passes: the
 * stored rows less those of an excluded payee (the stored array itself when
 * none is excluded), the range as the engine reads it, and the excluded
 * envelopes with the accounts (so principal paid into a loan is saving, not
 * Spending).
 *
 * @param {any} data
 * @param {{ from?: string, to?: string, excludeEnvelopes?: string[], excludePayees?: string[] }} input
 * @returns {{ txs: any[], range: { from: string | null, to: string | null },
 *             opts: { excludeEnvelopes: Set<string>, accounts: any[] } }}
 */
export function reportFlow(data, input) {
  const all = data.transactions || NONE;
  const exPay = new Set(input.excludePayees || []);
  const txs = exPay.size ? all.filter((/** @type {any} */ tx) => !exPay.has(txPayeeLabel(tx))) : all;
  return {
    txs,
    range: { from: input.from ?? null, to: input.to ?? null },
    opts: { excludeEnvelopes: new Set(input.excludeEnvelopes || []), accounts: data.accounts || NONE },
  };
}

/**
 * The first `top` rows, and the rest folded into `{ count, value }` (null
 * when nothing is left over, or `top` is 0 = every row). The same fold the
 * engine's aggregates make with their `topN`, as data instead of an
 * "Other (n)" label.
 *
 * @template {{ value: number }} R
 * @param {R[]} rows  every row, in the order to keep
 * @param {number} top
 * @returns {{ rows: R[], other: { count: number, value: number } | null }}
 */
export function foldTop(rows, top) {
  if (!top || rows.length <= top) return { rows, other: null };
  const rest = rows.slice(top);
  return {
    rows: rows.slice(0, top),
    other: { count: rest.length, value: round2(rest.reduce((s, r) => s + r.value, 0)) },
  };
}

/**
 * The engine's month points (`label` is the YYYY-MM month) as the answers
 * name them.
 * @param {{ label: string, value: number }[]} points
 * @returns {{ month: string, value: number }[]}
 */
export const monthPoints = (points) => points.map(p => ({ month: p.label, value: p.value }));
