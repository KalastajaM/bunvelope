// js/core/duplicate-finder.js — find transactions that were recorded twice.
// Cleaning a group up is the transaction.resolveDuplicates command
// (js/core/commands/transaction-resolve-duplicates.js).
//
// Imports dedupe their own rows, and the invariant badge catches two rows that
// share an id or a `from_budget` key. Nothing caught two ordinary rows for the
// same payment: typed in twice, imported and also entered by hand, or — the
// case that motivated this — posted automatically for a scheduled bill the
// user had already recorded. Both then count against the account and the
// envelope, and nothing looks wrong.
//
// So this proposes; the user decides (js/duplicates-sheet.js). A same-day,
// same-shop, same-amount pair is often two real coffees, which is why a plain
// match is never pre-ticked and every group can be dismissed for good.
//
// Pure. No DOM, no I/O, no `state`.

import { txAbsAmount, txEnvelopeIds } from '../engine.js';
import { payeeClusterKey } from './payee-cluster.js';

/** Days apart two untagged rows may be and still be one payment. */
export const PLAIN_DAY_WINDOW = 3;
/**
 * Days apart an automatic post and a hand entry may be. Same as the link
 * matcher's LINK_DAY_WINDOW: a bill paid early is recorded up to that many
 * days before the post that duplicates it.
 */
export const POSTED_DAY_WINDOW = 10;

const TYPES = new Set(['expense', 'income', 'account_transfer', 'investment_transfer']);

/** Surest first. The order edges are joined in, and a group's headline kind. */
const KIND_RANK = { sameKey: 0, postedOverHand: 1, plain: 2 };

const keyOf = (tx) => (typeof tx.from_budget === 'string' && tx.from_budget ? tx.from_budget : null);
const dayOf = (tx) => String(tx.date || '').slice(0, 10);
const dayNum = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return y && m && d ? Date.UTC(y, m - 1, d) / 86400000 : NaN;
};

/** Where the money moves: the bucket a duplicate must share. */
function routeOf(tx) {
  return tx.type === 'account_transfer' || tx.type === 'investment_transfer'
    ? `${tx.from_account || ''}>${tx.to_account || ''}`
    : String(tx.account || '');
}

/** Unordered pair id, stable across renders: how a dismissal is stored. */
export function pairKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/** `meta.duplicateDismissed` as a Set, dropping anything malformed. */
export function getDismissedPairs(meta) {
  const raw = meta?.duplicateDismissed;
  return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
}

/**
 * Does a word of one payee (3+ letters, folded) occur in the other? A
 * substring test rather than whole words, so "Gym membership" matches
 * "FitGym".
 */
function payeesShareWord(pa, pb) {
  const a = payeeClusterKey(pa);
  const b = payeeClusterKey(pb);
  if (!a || !b) return false;
  const hit = (words, other) => words.split(' ').some((w) => w.length >= 3 && other.includes(w));
  return hit(a, b) || hit(b, a);
}

/**
 * How two rows relate, or null when they are not a plausible duplicate. Both
 * are already in the same type/route/amount bucket.
 */
function edgeKind(a, b) {
  // Both on a bank statement the user reconciled: both happened. Measured on
  // the owner's ledger (2026-09-29), this alone was 203 of 208 proposals, all
  // of them repeat purchases (transit tickets, parking) and none a copy.
  if (a.cleared && b.cleared) return null;
  const ka = keyOf(a);
  const kb = keyOf(b);
  if (ka && kb) return ka === kb ? 'sameKey' : null; // two occurrences, both real
  const gap = Math.abs(dayNum(dayOf(a)) - dayNum(dayOf(b)));
  if (!Number.isFinite(gap)) return null;
  // An expense charged to two different envelopes is two purchases.
  if (a.type === 'expense') {
    const ea = txEnvelopeIds(a).filter((id) => id && id !== '__none__');
    const eb = txEnvelopeIds(b).filter((id) => id && id !== '__none__');
    if (ea.length && eb.length && !ea.some((id) => eb.includes(id))) return null;
  }
  // An automatic post's payee is the plan item's description, so it need not
  // match the hand entry exactly, but it must share a word with it: the same
  // amount on neighbouring days is otherwise just two subscriptions at one
  // price (seen on the owner's ledger: "Amazon Prime" vs "Viaplay", 8.99).
  if (ka || kb) return gap <= POSTED_DAY_WINDOW && payeesShareWord(a.payee, b.payee) ? 'postedOverHand' : null;
  if (gap > PLAIN_DAY_WINDOW) return null;
  const pa = payeeClusterKey(a.payee);
  const pb = payeeClusterKey(b.payee);
  return pa && pa === pb ? 'plain' : null;
}

/**
 * The row a cleanup keeps by default: a reconciled one (removing it would
 * change a balance the user has signed off), else the hand entry over an
 * automatic post (it carries what really happened: the actual date and
 * payee), else the earliest.
 */
function defaultKeep(rows) {
  const cleared = rows.filter((r) => r.cleared);
  if (cleared.length === 1) return cleared[0].id;
  const pool = cleared.length ? cleared : rows;
  const hand = pool.filter((r) => !keyOf(r));
  return (hand.length && hand.length < pool.length ? hand : pool)[0].id;
}

/**
 * Likely duplicate groups in `transactions`.
 *
 * Rows qualify when they share type, route (account, or from/to for a
 * transfer) and amount, are real (not forecast), are not BOTH reconciled
 * (a statement showed both), and have distinct ids (a
 * shared id is the invariant badge's business: a delete by id would take
 * both). A pair is then:
 *   - `sameKey`: both carry the same `from_budget` — one scheduled
 *     occurrence posted twice;
 *   - `postedOverHand`: one carries a key and the other none, within
 *     POSTED_DAY_WINDOW days, not in different envelopes, and the payees
 *     share a word — an automatic post over a payment the user recorded;
 *   - `plain`: neither has a key, within PLAIN_DAY_WINDOW days, same payee
 *     (payeeClusterKey) and not in different envelopes.
 * Two rows with DIFFERENT keys are never a pair: those are two occurrences.
 *
 * Pairs join into groups, surest first, and a join that would put two
 * different keys in one group is refused, so a group can always be cleaned
 * up to one row carrying at most one key. Groups whose every pair was
 * dismissed are left out.
 *
 * @param {object} input
 * @param {any[]} [input.transactions]
 * @param {Set<string>} [input.dismissed]  pair keys (getDismissedPairs)
 * @returns {Array<{ id: string, kind: 'sameKey'|'postedOverHand'|'plain',
 *   rows: any[], keepId: string, key: string|null, pairs: string[],
 *   recommended: boolean }>}  surest kind first, then oldest
 */
export function findDuplicateGroups({ transactions = [], dismissed = new Set() } = {}) {
  const buckets = new Map();
  const seenIds = new Map();
  for (const tx of transactions || []) {
    if (!tx || !tx.id || tx.is_forecast || !TYPES.has(tx.type)) continue;
    seenIds.set(tx.id, (seenIds.get(tx.id) || 0) + 1);
  }
  for (const tx of transactions || []) {
    if (!tx || !tx.id || tx.is_forecast || !TYPES.has(tx.type)) continue;
    if (seenIds.get(tx.id) > 1) continue;
    const cents = Math.round(txAbsAmount(tx) * 100);
    if (!cents) continue;
    const bucket = `${tx.type}|${routeOf(tx)}|${cents}`;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(tx);
  }

  const edges = [];
  for (const rows of buckets.values()) {
    if (rows.length < 2) continue;
    rows.sort((x, y) => (dayOf(x) < dayOf(y) ? -1 : dayOf(x) > dayOf(y) ? 1 : 0));
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const gap = dayNum(dayOf(rows[j])) - dayNum(dayOf(rows[i]));
        // Sorted by date: past the widest window nothing later can pair,
        // except the same key, which pairs at any distance.
        const kind = edgeKind(rows[i], rows[j]);
        if (!kind) {
          if (gap > POSTED_DAY_WINDOW && !keyOf(rows[i])) break;
          continue;
        }
        edges.push({ a: rows[i], b: rows[j], kind, gap });
      }
    }
  }
  edges.sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.gap - y.gap);

  // Union-find over row ids; each root remembers the one key its group holds.
  const parent = new Map();
  const groupKey = new Map();
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const add = (tx) => {
    if (!parent.has(tx.id)) { parent.set(tx.id, tx.id); groupKey.set(tx.id, keyOf(tx)); }
  };
  const joined = [];
  for (const e of edges) {
    add(e.a); add(e.b);
    const ra = find(e.a.id);
    const rb = find(e.b.id);
    if (ra === rb) { joined.push(e); continue; }
    const ka = groupKey.get(ra);
    const kb = groupKey.get(rb);
    if (ka && kb && ka !== kb) continue;
    parent.set(rb, ra);
    groupKey.set(ra, ka || kb);
    joined.push(e);
  }

  const byRoot = new Map();
  const txById = new Map();
  for (const e of joined) { txById.set(e.a.id, e.a); txById.set(e.b.id, e.b); }
  for (const e of joined) {
    const root = find(e.a.id);
    if (!byRoot.has(root)) byRoot.set(root, { rowIds: new Set(), pairs: [], kinds: new Set() });
    const g = byRoot.get(root);
    g.rowIds.add(e.a.id); g.rowIds.add(e.b.id);
    g.pairs.push(pairKey(e.a.id, e.b.id));
    g.kinds.add(e.kind);
  }

  const out = [];
  for (const [root, g] of byRoot) {
    if (g.pairs.every((p) => dismissed.has(p))) continue;
    const rows = [...g.rowIds].map((id) => txById.get(id))
      .sort((x, y) => (dayOf(x) < dayOf(y) ? -1 : dayOf(x) > dayOf(y) ? 1 : 0));
    const kind = [...g.kinds].sort((x, y) => KIND_RANK[x] - KIND_RANK[y])[0];
    out.push({
      id: rows.map((r) => r.id).sort().join('|'),
      kind,
      rows,
      keepId: defaultKeep(rows),
      key: groupKey.get(root) || null,
      pairs: [...new Set(g.pairs)].sort(),
      // Pre-ticked only when a machine can be sure: one occurrence posted
      // twice, or posted over a hand entry. (Two reconciled rows never pair.)
      recommended: kind !== 'plain',
    });
  }
  // Surest kind first (they are the pre-ticked ones), then oldest first.
  out.sort((x, y) => KIND_RANK[x.kind] - KIND_RANK[y.kind]
    || (dayOf(x.rows[0]) < dayOf(y.rows[0]) ? -1 : dayOf(x.rows[0]) > dayOf(y.rows[0]) ? 1 : 0));
  return out;
}
