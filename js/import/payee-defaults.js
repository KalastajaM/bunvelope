// js/import/payee-defaults.js — what an imported row defaults to from the
// payee's own history, the lookup Add transaction's payee autofill makes
// (js/state/payee-index.js). Without it a CSV import without AI landed every
// row Unassigned, even for a payee with dozens of rows in one envelope.
//
// Only what is safe is defaulted. The account is the one the user is
// importing into, and the type follows the bank's sign (money out is an
// expense, money in is income): a payee whose last row was a transfer or an
// investment says nothing about this one. So the default is the envelope,
// and only when the payee's newest row has the type the sign gives.
//
// Banks spell payees their own way ("SPOTIFY AB", "K-Market Töölö") where
// the budget has "Spotify" and "K-Market". After the exact name (and a
// remembered spelling from a payee merge), the lookup tries the name without
// a company form, then the longest known payee the bank's text starts with,
// as whole words. The result is only a default the review shows and the
// user can change.

import { findPayeeEntry, allPayees } from '../state/payee-index.js';
import { getPayeeAliases, payeeKey } from '../core/payee-fields.js';

// Company forms banks append to a merchant's name.
const RE_COMPANY_FORM = /[\s,.]+(?:ab|oy|oyj|ky|tmi|ry|as|asa|a\/s|aps|gmbh|ag|ltd|limited|inc|llc|plc|bv|nv|sa|sas|srl|spa)\.?$/i;

// A known payee shorter than this is too generic to match by prefix.
const MIN_PREFIX_LEN = 4;

/** `text` lowercased, trimmed, without a trailing company form. */
function bareName(text) {
  return payeeKey(text).replace(RE_COMPANY_FORM, '').trim();
}

/**
 * The defaults one index entry gives a row of `type`, or null.
 * @param {any} state
 * @param {any} entry
 * @param {'expense' | 'income'} type
 */
function defaultFromEntry(state, entry, type) {
  if (!entry || !entry.lastTx || entry.lastTx.type !== type) return null;
  // A split row has no single envelope; fall back to the payee's last one,
  // as the add form does.
  const envelopeId = entry.lastTx.envelope_id || entry.lastEnvelopeId || '';
  if (!envelopeId || envelopeId === '__none__') return null;
  const env = (state.envelopes || []).find(e => e.id === envelopeId);
  if (!env || env.archived) return null;
  return { type, envelope_id: envelopeId };
}

/**
 * The known payee names to try for a bank's `payee` text, best first.
 * @param {any} state
 * @param {string} payee
 * @returns {string[]}
 */
function candidateNames(state, payee) {
  const out = [];
  const alias = getPayeeAliases(state?.meta)[payeeKey(payee)];
  if (alias) out.push(alias);
  out.push(payee);
  const bare = bareName(payee);
  if (bare && bare !== payeeKey(payee)) out.push(bare);
  // Longest known payee that the bank text starts with, word for word.
  const text = payeeKey(payee);
  let best = '';
  for (const known of allPayees(state)) {
    const k = payeeKey(known);
    if (k.length < MIN_PREFIX_LEN || k.length <= best.length || k === text) continue;
    if (text.startsWith(k) && /^[\s,.\-/*]/.test(text.slice(k.length))) best = k;
  }
  if (best) out.push(best);
  return out;
}

/**
 * The defaults for one bank row, or null when its payee has no usable history.
 *
 * @param {{ transactions?: any[], envelopes?: any[], meta?: any }} state
 * @param {string} payee   the row's payee as the bank wrote it
 * @param {number} amount  the bank's signed amount (negative = money out)
 * @returns {{ type: 'expense' | 'income', envelope_id: string } | null}
 */
export function payeeHistoryDefault(state, payee, amount) {
  if (!payee || !String(payee).trim() || !Number.isFinite(amount) || amount === 0) return null;
  const type = amount < 0 ? 'expense' : 'income';
  for (const name of candidateNames(state, payee)) {
    const found = defaultFromEntry(state, findPayeeEntry(state, name), type);
    if (found) return found;
  }
  return null;
}
