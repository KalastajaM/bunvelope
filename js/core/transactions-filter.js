// js/core/transactions-filter.js — Pure filter+sort for the Transactions page.
// Extracted so it can be unit-tested without DOM / state.
//
// Sort uses String#localeCompare on ISO date strings rather than
// `new Date(b) - new Date(a)`. For well-formed YYYY-MM-DD dates the
// ordering is identical, but it avoids constructing tens of thousands
// of Date objects per repaint — this is a behavioral equivalence, not
// a change.
//
// Search supports several token shapes that can appear inside `ui.search`:
//
//   • plain text       — matches payee or note (case-insensitive substring)
//   • "a quoted phrase"— one plain-text token even if it contains digits or
//                        a #; never parsed as an amount or tag token. An
//                        unterminated quote takes the rest of the string as
//                        the phrase.
//   • #tag             — matches transactions whose note has `#tag` (exact,
//                        case-insensitive — not substring)
//   • >50 / >=50       — minimum amount filter
//   • <50 / <=50       — maximum amount filter
//   • =50  / 50.00     — exact amount (within ±0.005)
//
// Multiple tokens (whitespace-separated, quoted phrases counting as one) all
// have to match (AND).
//
// Same-date tiebreaker: the running-balance helpers in `engine.js` walk
// transactions in input-array index ASCENDING order. To make the
// displayed list line up — i.e. so reading the running balance from
// bottom to top traces chronological progression — the display must
// invert that tiebreaker: same-date txs sort by input-index DESCENDING
// here, putting the chronologically-later (higher-index) entry on top.

import { extractTxTags } from '../engine/tx-tags.js';
import { txAbsAmount } from '../engine/tx-amounts.js';

const NUM = /^([<>]=?|=?)(-?\d+(?:[.,]\d+)?)$/;
const TAG_TOKEN = /^#([\p{L}\p{N}_-]+)$/u;

function parseSearchTokens(raw) {
  const text = [];
  const numeric = [];
  const tags = [];
  const s = String(raw || '');
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === '"') {
      i++;
      const start = i;
      const end = s.indexOf('"', i);
      // An unterminated quote takes the rest of the string as the phrase.
      const phrase = end === -1 ? s.slice(start).trim() : s.slice(start, end);
      if (phrase) text.push(phrase.toLowerCase());
      i = end === -1 ? n : end + 1;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(s[j])) j++;
    const tok = s.slice(i, j);
    i = j;
    const tagM = tok.match(TAG_TOKEN);
    if (tagM) { tags.push(tagM[1].toLowerCase()); continue; }
    const m = tok.match(NUM);
    if (m) {
      const op = m[1] || '=';
      const val = parseFloat(m[2].replace(',', '.'));
      if (Number.isFinite(val)) { numeric.push({ op, val }); continue; }
    }
    text.push(tok.toLowerCase());
  }
  return { text, numeric, tags };
}

function matchesNumericToken(tx, { op, val }) {
  const a = txAbsAmount(tx);
  const tolerance = 0.005;
  switch (op) {
    case '>':  return a >  val + tolerance;
    case '>=': return a >= val - tolerance;
    case '<':  return a <  val - tolerance;
    case '<=': return a <= val + tolerance;
    case '=':  return Math.abs(a - val) <= tolerance;
    default:   return false;
  }
}

// Returns true if `tx` touches `envelopeId` through any channel that
// contributes to the envelope's running balance (mirrors the per-type
// branches in engine.js → computeEnvelopeRunningBalances).
function txTouchesEnvelope(tx, envelopeId) {
  if (!envelopeId || envelopeId === '__none__') return false;
  if (tx.envelope_id === envelopeId) return true;
  if (Array.isArray(tx.envelope_splits)
      && tx.envelope_splits.some(s => s.envelope_id === envelopeId)) return true;
  if (tx.type === 'fill'
      && Array.isArray(tx.lines)
      && tx.lines.some(l => l.envelope_id === envelopeId)) return true;
  if (tx.type === 'envelope_transfer'
      && (tx.from_envelope_id === envelopeId || tx.to_envelope_id === envelopeId)) return true;
  if (tx.type === 'adjustment' && tx.target === 'envelope' && tx.target_id === envelopeId) return true;
  return false;
}

// Returns true if `tx` touches `accountId` through any channel that
// contributes to the account's running balance (mirrors txAccountDelta
// in engine.js).
function txTouchesAccount(tx, accountId) {
  if (!accountId) return false;
  if (tx.account === accountId) return true;
  if (tx.from_account === accountId || tx.to_account === accountId) return true;
  if (tx.type === 'fill' && tx.source === 'new_income' && tx.source_account === accountId) return true;
  if (tx.type === 'adjustment' && tx.target === 'account' && tx.target_id === accountId) return true;
  return false;
}

/**
 * @param {Array} transactions
 * @param {{search?: string, searchMode?: string, envelope?: string, account?: string, type?: string, status?: string, dateFrom?: string, dateTo?: string, flagged?: boolean | string, cleared?: boolean, minAmount?: number, maxAmount?: number}} ui
 * @returns {Array} filtered transactions, sorted by date desc.
 *
 * `ui.envelope === '__noenvelope__'` is a special filter that matches
 * uncategorized expense/debt_payment rows — i.e. ones the user still needs
 * to assign an envelope to. It treats both a missing `envelope_id` and the
 * `'__none__'` "correction" sentinel as "no envelope".
 */
export function filterAndSort(transactions, ui) {
  const tokens = ui.searchMode === 'literal'
    ? { text: String(ui.search || '').trim() ? [String(ui.search).trim().toLowerCase()] : [], numeric: [], tags: [] }
    : parseSearchTokens(ui.search);
  const idxByTx = new Map();
  for (let i = 0; i < (transactions || []).length; i++) {
    idxByTx.set(transactions[i], i);
  }
  return transactions
    .filter(tx => {
      if (ui.envelope === '__noenvelope__') {
        if (tx.type !== 'expense' && tx.type !== 'debt_payment') return false;
        if (tx.envelope_id && tx.envelope_id !== '__none__') return false;
        // A transaction that's been split across envelopes is also categorized;
        // skip it from the "no envelope" view even if its top-level envelope_id
        // is missing.
        if (Array.isArray(tx.envelope_splits)
            && tx.envelope_splits.some(s => s.envelope_id && s.envelope_id !== '__none__')) return false;
      } else if (ui.envelope && !txTouchesEnvelope(tx, ui.envelope)) return false;
      if (ui.type && ui.type !== 'all' && tx.type !== ui.type) return false;
      if ((ui.flagged === 'only' || ui.flagged === true) && !tx.flagged) return false;
      if (ui.flagged === false && tx.flagged) return false;
      if (ui.cleared !== undefined && (tx.is_forecast || (tx.cleared === true) !== ui.cleared)) return false;
      if (ui.status === 'posted' && tx.status !== 'posted') return false;
      const magnitude = txAbsAmount(tx);
      if (ui.minAmount !== undefined && magnitude < ui.minAmount) return false;
      if (ui.maxAmount !== undefined && magnitude > ui.maxAmount) return false;
      if (tx.is_forecast && (ui.status === 'cleared' || ui.status === 'uncleared')) return false;
      if (ui.status === 'cleared'   && tx.cleared !== true) return false;
      if (ui.status === 'uncleared' && tx.cleared === true) return false;
      if (ui.status === 'scheduled' && tx.status !== 'scheduled') return false;
      if (ui.account && !txTouchesAccount(tx, ui.account)) return false;
      if (tokens.text.length || tokens.numeric.length || tokens.tags.length) {
        const haystack = `${tx.payee || ''} ${tx.note || ''}`.toLowerCase();
        for (const term of tokens.text) {
          if (!haystack.includes(term)) return false;
        }
        for (const num of tokens.numeric) {
          if (!matchesNumericToken(tx, num)) return false;
        }
        if (tokens.tags.length) {
          const txTags = extractTxTags(tx.note);
          for (const tag of tokens.tags) {
            if (!txTags.includes(tag)) return false;
          }
        }
      }
      const d = (tx.date || '').slice(0, 10);
      if (ui.dateFrom && d < ui.dateFrom) return false;
      if (ui.dateTo   && d > ui.dateTo)   return false;
      return true;
    })
    .sort((a, b) => {
      const da = (a.date || '').slice(0, 10);
      const db = (b.date || '').slice(0, 10);
      const cmp = db.localeCompare(da);
      if (cmp !== 0) return cmp;
      return (idxByTx.get(b) ?? 0) - (idxByTx.get(a) ?? 0);
    });
}
