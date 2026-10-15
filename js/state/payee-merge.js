// js/state/payee-merge.js — find and merge near-duplicate payees.
//
// Bank imports write the same shop a dozen ways ("LIDL 1234", "Lidl",
// "lidl"), which splits its history, its envelope memory and the payee
// suggestions (ux-review U16 follow-up: ~3 200 near-duplicates in the live
// budget). These are the pure halves of the tidy-up sheet: list, cluster by a
// normalised key, search, and rewrite rows. Exact groups use no fuzzy
// matching (plan D3); the looser, confirm-only suggestions and the search
// also accept a typo or two (a near-identical spelling).

import { isEnvelopeInternal, mergePayees, mergePayeeRules } from '../core/payee-fields.js';

import { fold, payeeClusterKey } from '../core/payee-cluster.js';
export { payeeClusterKey } from '../core/payee-cluster.js';

export function listPayees(transactions) {
  const byKey = new Map();
  for (const tx of transactions || []) {
    if (isEnvelopeInternal(tx)) continue;
    const raw = (tx.payee || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const date = tx.date || '';
    let e = byKey.get(key);
    if (!e) { e = { payee: raw, key, count: 0, lastDate: '' }; byKey.set(key, e); }
    e.count += 1;
    if (date >= e.lastDate) { e.lastDate = date; e.payee = raw; }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function findPayeeClusters(payees) {
  const byCluster = new Map();
  for (const p of payees || []) {
    const ck = payeeClusterKey(p.payee);
    if (!ck) continue; // symbol-only / non-Latin payees fold to '', never a cluster
    if (!byCluster.has(ck)) byCluster.set(ck, []);
    byCluster.get(ck).push(p);
  }
  const out = [];
  for (const [clusterKey, members] of byCluster) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    out.push({ clusterKey, members, total: members.reduce((s, m) => s + m.count, 0) });
  }
  return out.sort((a, b) => b.total - a.total || a.clusterKey.localeCompare(b.clusterKey));
}

// ── Looser suggestions (confirm-only) ─────────────────────────────────────
// The exact rule misses card-processor prefixes ("PAYPAL *STEAM"), branches
// of one shop ("Albert Heijn 1234" / "Albert Heijn Amsterdam") and typos
// ("Spotfy"). These groups are only suggested; nothing merges without a
// confirm, and Ignore works as for exact groups.

const PROCESSOR_PREFIX = /^\s*(paypal|sq|sumup|iz|zettle|vfs|crv|sp|tst|pp)\s*[*_]+\s*/i;
const FIRST_WORD_STOP = new Set(['the', 'and', 'shop', 'store', 'cafe', 'caffe', 'restaurant', 'ravintola', 'hotel', 'www', 'http', 'https', 'payment', 'card', 'mobile', 'online', 'kauppa']);

/** The exact cluster key after removing a card-processor prefix. */
export function looseKey(payee) {
  return payeeClusterKey(String(payee || '').replace(PROCESSOR_PREFIX, ''));
}

/** True when the raw payee text carries a recognised card-processor prefix ("PAYPAL *STEAM"). */
export function hasProcessorPrefix(payee) {
  return PROCESSOR_PREFIX.test(String(payee || ''));
}

/**
 * Default "keep as" name for members sorted most-used first: the busiest
 * spelling without a card-processor prefix, so "PAYPAL *STEAM" doesn't win
 * over "Steam" on row count alone; else the busiest member; null if none.
 */
export function preferredTarget(members) {
  const list = members || [];
  return list.find(m => !hasProcessorPrefix(m.payee)) ?? list[0] ?? null;
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** More payees than this sharing a first word are not grouped by it (see findLooseClusters). */
export const FIRST_WORD_MAX = 8;

const digitsOf = (s) => s.replace(/\D+/g, '');

/**
 * Two folded names a typo apart: at most 2 edits, and the same numbers, so
 * "HSL 2x" / "HSL 3x" or "Taxes 2019 1/2" / "2/2" are not a misspelling.
 * @param {string} a @param {string} b
 */
function nearSpelling(a, b) {
  return digitsOf(a) === digitsOf(b) && editDistanceAtMost(a, b, 2);
}

/**
 * Possible-duplicate groups the exact rule misses. Same shape as
 * `findPayeeClusters` (`{ clusterKey, members, total }`), `clusterKey`
 * prefixed `loose:`.
 *
 * Payees already in an exact group (2+ members sharing a `payeeClusterKey`,
 * whether that group is currently shown or ignored — ignoring is a sheet-
 * level filter applied after this) are left out of the loose pool entirely,
 * so a loose group never just repeats an exact one. Once an exact group is
 * merged, its kept name is a single payee again and rejoins the loose pool
 * on the next render.
 */
/** Largest 3-letter block compared pairwise as is; see findLooseClusters. */
export const LOOSE_BLOCK_CAP = 250;

export function findLooseClusters(payees) {
  const exactMemberKeys = new Set();
  for (const cluster of findPayeeClusters(payees)) {
    for (const m of cluster.members) exactMemberKeys.add(m.key);
  }
  const list = (payees || []).filter(p => looseKey(p.payee) && !exactMemberKeys.has(p.key));
  const parent = list.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  // Computed once per payee (list is indexed 1:1 with looseKeys) rather than
  // re-folding/re-stripping the same string on every pairwise comparison
  // below, since the block loop is quadratic within a block.
  const looseKeys = list.map(p => looseKey(p.payee));

  const byLoose = new Map();
  /** @type {Map<string, number[]>} */
  const byFirst = new Map();
  const byBlock = new Map();
  list.forEach((p, i) => {
    const lk = looseKeys[i];
    if (byLoose.has(lk)) join(byLoose.get(lk), i); else byLoose.set(lk, i);
    const first = lk.split(' ')[0];
    if (first.length >= 4 && !FIRST_WORD_STOP.has(first)) {
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push(i);
    }
    if (lk.length >= 6) {
      const block = lk.slice(0, 3);
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(i);
    }
  });
  // The pairwise pass is quadratic per block. Real blocks are small (on the
  // owner's 3 179 payees the largest is 89, the whole pass ~30 ms), but a
  // chain whose branches all start alike ("k market olari", "k market
  // kamppi" … × 800) made one block cost seconds. An oversized block is split
  // past the prefix its members all share, on the next three letters, and
  // again while a part is still oversized. It can then miss a typo right after
  // that shared prefix, only in an oversized block, which is the price of not
  // freezing the sheet. Blocks under the cap are compared exactly as before.
  const blocks = [];
  const splitBlock = (idxs, offset) => {
    if (idxs.length <= LOOSE_BLOCK_CAP) { blocks.push(idxs); return; }
    const keys = idxs.map(i => looseKeys[i]);
    let lcp = offset;
    while (keys.every(k => k.length > lcp && k[lcp] === keys[0][lcp])) lcp++;
    const parts = new Map();
    idxs.forEach((i, n) => {
      const k = keys[n].slice(lcp, lcp + 3);
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push(i);
    });
    // Nothing left to split on (members identical past the prefix): compare
    // as is. Identical keys are already joined above and skipped below.
    if (parts.size === 1) { blocks.push(idxs); return; }
    for (const part of parts.values()) splitBlock(part, lcp + 3);
  };
  // A shared first word is a shop's branches ("Aldi Nord", "Aldi Süd") only
  // while few payees share it; past FIRST_WORD_MAX it is a person or a habit
  // of describing ("Anna lunch", "Anna dentist" … × 49), which flooded the
  // looser matches with one group of unrelated rows. Those are left to the
  // typo rule below, so "Verkkauppa" still meets "Verkkokauppa".
  for (const idxs of byFirst.values()) {
    if (idxs.length < 2 || idxs.length > FIRST_WORD_MAX) continue;
    for (const i of idxs.slice(1)) join(idxs[0], i);
  }
  for (const idxs of byBlock.values()) splitBlock(idxs, 0);
  for (const idxs of blocks) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = looseKeys[idxs[x]], b = looseKeys[idxs[y]];
        if (a !== b && nearSpelling(a, b)) join(idxs[x], idxs[y]);
      }
    }
  }

  const groups = new Map();
  list.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  });
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    if (new Set(members.map(m => payeeClusterKey(m.payee))).size < 2) continue; // exact rule covers it
    members.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const firstKey = [...members].map(m => m.key).sort()[0];
    out.push({ clusterKey: `loose:${firstKey}`, members, total: members.reduce((s, m) => s + m.count, 0) });
  }
  return out.sort((a, b) => b.total - a.total || a.clusterKey.localeCompare(b.clusterKey));
}

/**
 * Whether a folded name holds the folded query a typo or two apart, starting
 * at a word: "verkkauppa" finds "verkkokauppa lamps" and the other way round.
 * One edit for a query of 5+ letters, two from 9; shorter queries match only
 * as a substring.
 * @param {string} name @param {string} q
 */
function nearMatch(name, q) {
  const tol = q.length >= 9 ? 2 : q.length >= 5 ? 1 : 0;
  if (!tol) return false;
  for (let start = 0; start < name.length; start = name.indexOf(' ', start) + 1) {
    for (let len = q.length - tol; len <= q.length + tol; len++) {
      if (len < 1 || start + len > name.length) continue;
      if (digitsOf(name.slice(start, start + len)) !== digitsOf(q)) continue;
      if (editDistanceAtMost(name.slice(start, start + len), q, tol)) return true;
    }
    if (name.indexOf(' ', start) < 0) break;
  }
  return false;
}

/**
 * Payees whose folded name contains the query, then those a typo or two from
 * it (nearMatch), so searching one spelling also finds the other.
 */
export function searchPayees(payees, query) {
  const q = fold(query);
  if (!q) return [];
  const exact = [];
  const near = [];
  for (const p of payees || []) {
    const name = fold(p.payee);
    if (name.includes(q)) exact.push(p);
    else if (nearMatch(name, q)) near.push(p);
  }
  return [...exact, ...near];
}

// mergePayees and mergePayeeRules live in core, where payee.merge uses them.
export { mergePayees, mergePayeeRules };

// ── Ignored suggestion groups ─────────────────────────────────────────────
// Some suggested groups are not duplicates ("Anna" the person and
// "Anna Oy" the company), and without a way to say so they come back every
// time. `meta.payeeMergeIgnored` maps a cluster key to the member keys it had
// when ignored. A group stays hidden while every member is one of those; a
// NEW spelling joining it brings it back, since that one may be a real
// duplicate. A member going away (merged elsewhere) keeps it hidden.

/** `{ [clusterKey]: memberKey[] }`, dropping anything malformed. */
export function getIgnoredClusters(meta) {
  const raw = meta?.payeeMergeIgnored;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string');
  }
  return out;
}

export function ignoreCluster(ignored, cluster) {
  return { ...ignored, [cluster.clusterKey]: cluster.members.map(m => m.key).sort() };
}

export function unignoreCluster(ignored, clusterKey) {
  const out = { ...ignored };
  delete out[clusterKey];
  return out;
}

/** Partition clusters into those to suggest and those the user ignored. */
export function splitIgnoredClusters(clusters, ignored) {
  const active = [];
  const hidden = [];
  for (const c of clusters || []) {
    const known = ignored?.[c.clusterKey];
    const stillIgnored = Array.isArray(known) && c.members.every(m => known.includes(m.key));
    (stillIgnored ? hidden : active).push(c);
  }
  return { active, ignored: hidden };
}

/**
 * Like `splitIgnoredClusters`, but for loose clusters: a loose cluster's
 * `clusterKey` is `loose:` + the alphabetically-first CURRENT member key
 * (see `findLooseClusters`), so it changes whenever that member merges
 * away — a lookup by `clusterKey` would then miss the stored ignore entry
 * and the group would come back, even though nothing the user judged
 * "not a duplicate" changed. Match by membership instead: a cluster is
 * ignored when some ignored entry whose key starts with `loose:` contains
 * every one of the cluster's current member keys. A member going away
 * still leaves the rest inside that stored set, so the group stays
 * hidden; a NEW spelling is never in the stored set, so it un-hides the
 * group (it may be a genuine duplicate the user hasn't judged yet).
 */
export function splitIgnoredLooseClusters(clusters, ignored) {
  const looseIgnoredEntries = Object.entries(ignored || {})
    .filter(([key]) => key.startsWith('loose:'))
    .map(([key, members]) => [key, Array.isArray(members) ? members : []]);
  const active = [];
  const hidden = [];
  for (const c of clusters || []) {
    // A cluster can be covered by more than one stored key (e.g. it was
    // ignored, shrank, and was ignored again under its new clusterKey) —
    // collect every stored key whose recorded membership still contains
    // every current member, so the caller can delete all of them on
    // restore. `group.clusterKey` alone is not one of these in general: it
    // is derived from the CURRENT members and may never have been stored.
    const ignoredKeys = looseIgnoredEntries
      .filter(([, set]) => c.members.every(m => set.includes(m.key)))
      .map(([key]) => key);
    if (ignoredKeys.length > 0) hidden.push({ ...c, ignoredKeys });
    else active.push(c);
  }
  return { active, ignored: hidden };
}

/**
 * Members ticked in the basket across several searches, refreshed against
 * the current payee list: drops a member whose key no longer exists (merged
 * away elsewhere) or is now hidden, and replaces the rest with the LIVE
 * member object so a stale count/spelling doesn't linger. `basketEntries` is
 * `[key, member][]` (e.g. `[...basketMap]`); order is preserved.
 */
export function refreshBasket(basketEntries, livePayees, hiddenKeys) {
  const liveByKey = new Map((livePayees || []).map(p => [p.key, p]));
  const out = [];
  for (const [key] of basketEntries || []) {
    if (hiddenKeys?.has(key)) continue;
    const live = liveByKey.get(key);
    if (!live) continue;
    out.push([key, live]);
  }
  return out;
}
