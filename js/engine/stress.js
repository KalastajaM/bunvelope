// js/engine/stress.js — the stress-scenarios model: the scenarios, an item's
// cut per scenario and its annual amount before and after the cut.
//
// Engine code because its money is computed in core: the stress.runway query
// (js/core/queries/stress-runway.js) sums the scenario totals from it, and the
// what-if simulation takes `stressCutFor` as its cut. The pages (Stress, the
// Plan page and its editor, the what-if editor) import it to edit and sort an
// item's cuts: the scenario and category lists, the cut readers, the
// flat-cut expansion and the two mutators below; its money functions are
// banned there (`bunvelope/no-page-money`). Dependency-free (nothing outside
// this file), so any of them can import it without a cycle.
//
// Two functions are DRAFT MUTATORS: `setStressCutPct` and `clearStressCuts`
// write into the item they are given. They are for an editor's own working
// copy of an item, never for a row in `state.budgetItems` (the session's diff
// compares rows, so an in-place edit there is invisible to it). Everything
// else here is pure.
//
// Per-item stress shape on budget items:
//   stress_category : 'A'|'B'|'C'|'D'|'E'|'Z'|null  — severity threshold
//   stress_cut_pcts : { A?,B?,C?,D?,E? } of 0..1     — per-scenario cut (new)
//   stress_cut_pct  : number 0..1                    — legacy flat cut (fallback)
//
// Cut resolution (stressCutPct): a present stress_cut_pcts map is authoritative
// (the legacy scalar is dead once a map exists); without a map we fall back to
// the scalar so un-migrated budgets keep their flat behaviour until edited.

/**
 * The plan-item fields this module reads (and, for the two draft mutators,
 * writes). A plan item has many more; only these matter here.
 * @typedef {'A'|'B'|'C'|'D'|'E'} StressScenario
 * @typedef {StressScenario | 'Baseline'} StressColumn
 * @typedef {{
 *   id?: string,
 *   kind?: string,
 *   include?: boolean,
 *   default_amount?: number,
 *   monthly_schedule?: Record<string, boolean | number | null | undefined>,
 *   stress_category?: StressScenario | 'Z' | null,
 *   stress_cut_pcts?: Partial<Record<StressScenario, number>>,
 *   stress_cut_pct?: number,
 * }} StressItem
 */

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** @type {StressScenario[]} */
export const SCENARIOS = ['A','B','C','D','E'];
export const CAT_CHOICES = ['A','B','C','D','E','Z']; // Z = excluded (never cut)

/** Clamp to a 0..1 fraction; anything that is not a number is 0. @param {unknown} n @returns {number} */
export function clampFrac(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

// An `account_transfer` moves money between the user's own accounts, so it is
// never income, never spending, and never a stress cut. The editor never
// gives one a stress category, so `scenarioHits` already returns false for
// it (null category) — this guard is for the totals in
// js/core/queries/stress-runway.js (and `stressCutFor` below) that iterate
// every budget item directly rather than going through a hit list, where a
// transfer would otherwise fall into the expense bucket by default (it is
// not income-like either).
/** @param {StressItem | null | undefined} item @returns {boolean} */
export function isTransferItem(item) {
  return !!item && item.kind === 'account_transfer';
}

// Rule: scenario severity ≥ item severity. A = most severe; alphabetically A < B,
// so `scenario <= item.stress_category` means scenario is at least as severe.
/** @param {string} scenario @param {StressItem} item @returns {boolean} */
export function scenarioHits(scenario, item) {
  const cat = item.stress_category;
  if (!cat) return false;
  if (cat === 'Z') return false;
  if (!SCENARIOS.includes(/** @type {StressScenario} */ (cat))) return false;
  return scenario <= cat;
}

// Scenarios for which a cut% is settable on this item: its category's own level
// plus every more-severe level (e.g. cat D → ['A','B','C','D']). Empty for
// null/Z/invalid category.
/** @param {StressItem} item @returns {StressScenario[]} */
export function cutScenariosFor(item) {
  return SCENARIOS.filter(s => scenarioHits(s, item));
}

// Per-scenario cut fraction (0..1). 0 when the scenario doesn't hit the item.
// A present stress_cut_pcts map wins (missing key → 0); otherwise the legacy
// flat scalar applies to every hitting scenario.
/** @param {StressItem} item @param {string} scenario @returns {number} */
export function stressCutPct(item, scenario) {
  if (!scenarioHits(scenario, item)) return 0;
  const map = item.stress_cut_pcts;
  if (map && typeof map === 'object') return clampFrac(map[/** @type {StressScenario} */ (scenario)]);
  return clampFrac(item.stress_cut_pct);
}

// Set the cut for one scenario, mutating `item`. No-op if the scenario doesn't
// hit the item. On first write the map is seeded from the legacy scalar across
// all currently-hitting scenarios, so editing one level doesn't zero its
// siblings.
/**
 * @param {StressItem} item  a draft, mutated in place
 * @param {string} scenario
 * @param {number} frac
 * @returns {void}
 */
export function setStressCutPct(item, scenario, frac) {
  if (!scenarioHits(scenario, item)) return;
  if (!item.stress_cut_pcts || typeof item.stress_cut_pcts !== 'object') {
    const seed = clampFrac(item.stress_cut_pct);
    item.stress_cut_pcts = {};
    for (const s of cutScenariosFor(item)) item.stress_cut_pcts[s] = seed;
  }
  item.stress_cut_pcts[/** @type {StressScenario} */ (scenario)] = clampFrac(frac);
}

/**
 * Items still carrying only the legacy flat scalar — a non-zero
 * `stress_cut_pct` with no `stress_cut_pcts` map.
 *
 * §2.12 — a flat scalar cuts an item by the same percentage in EVERY scenario
 * it is hit by, so the A–E severity ladder is flat for every item on the
 * fallback: scenario A (most severe) and scenario E cut them identically, and
 * the ladder may convey less than intended. Equal cuts can also be deliberate;
 * this storage-shape check does not establish whether an item was reviewed.
 *
 * @param {StressItem[] | null | undefined} budgetItems
 * @returns {StressItem[]}
 */
export function itemsNeedingCutExpansion(budgetItems) {
  return (budgetItems || []).filter(it => it
    && (!it.stress_cut_pcts || typeof it.stress_cut_pcts !== 'object')
    && clampFrac(it.stress_cut_pct) > 0
    && cutScenariosFor(it).length > 0);
}

/**
 * The review queue for §2.12: enabled items hit by two or more scenarios and
 * cut by the same non-zero percentage in every one of them, so scenario A and
 * the mildest scenario that hits them cut them identically.
 *
 * Reads the resolved cut, not the storage shape, so an item stays in the queue
 * after `expandFlatCuts` seeds it with identical values. Equal cuts may be
 * intentional; membership is a review aid, not evidence of unfinished work. An item hit by a single scenario
 * (category A) has no ladder to be flat, so it is never listed. Largest annual
 * amount first, where a considered cut moves the totals most.
 *
 * @param {StressItem[] | null | undefined} budgetItems
 * @returns {StressItem[]}
 */
export function itemsWithFlatLadder(budgetItems) {
  return (budgetItems || []).filter((it) => {
    if (!it || it.include === false || isTransferItem(it) || it.kind === 'loan_payment') return false;
    const scs = cutScenariosFor(it);
    if (scs.length < 2) return false;
    const first = stressCutPct(it, scs[0]);
    return first > 0 && scs.every(s => stressCutPct(it, s) === first);
  }).sort((a, b) => annualAmount(b) - annualAmount(a));
}

/**
 * Expand every flat scalar into a per-scenario map, seeded from the scalar.
 * Returns a NEW array; items that need no expansion are passed through by
 * reference.
 *
 * Value-preserving by construction: `stressCutPct` already returns the scalar
 * for every hitting scenario, so seeding each of those scenarios with the same
 * number cannot move a single figure. That is the assertion that proves the
 * expansion was faithful — the Stress page's scenario totals are identical
 * immediately afterwards and diverge only as the owner edits them.
 *
 * Deliberately NOT done silently on load. A flat cut expanded into five
 * identical cuts LOOKS migrated and is not, and the owner would then have no
 * way to tell which rows they had actually thought about. The expansion has to
 * be an action the owner takes, with the affected items shown explicitly.
 *
 * @param {StressItem[] | null | undefined} budgetItems
 * @returns {StressItem[]}
 */
export function expandFlatCuts(budgetItems) {
  const needing = new Set(itemsNeedingCutExpansion(budgetItems).map(it => it.id));
  if (!needing.size) return budgetItems || [];
  return (budgetItems || []).map((it) => {
    if (!it || !needing.has(it.id)) return it;
    const seed = clampFrac(it.stress_cut_pct);
    /** @type {Partial<Record<StressScenario, number>>} */
    const map = {};
    for (const s of cutScenariosFor(it)) map[s] = seed;
    return { ...it, stress_cut_pcts: map };
  });
}

// Remove all cuts (used when the category is cleared or set to Z). A draft
// mutator: `item` is changed in place.
/** @param {StressItem} item  a draft, mutated in place @returns {void} */
export function clearStressCuts(item) {
  delete item.stress_cut_pcts;
  item.stress_cut_pct = 0;
}

// Annual amount for an item: sum of monthly_schedule across 12 months. Does NOT
// include extra_buffer (a reserve floor, not recurring spend), so it must not
// inflate the annual burn in runway math.
/** @param {StressItem} item @returns {number} */
export function annualAmount(item) {
  if (item.include === false) return 0;
  const sched = item.monthly_schedule || {};
  let total = 0;
  for (const m of MONTHS) {
    const v = sched[m];
    if (v === true) total += Math.abs(item.default_amount ?? 0);
    else if (typeof v === 'number') total += Math.abs(v);
  }
  return total;
}

// Annual amount after applying the per-scenario cut. 'Baseline' = no cut.
/** @param {StressItem} item @param {string} scenario @returns {number} */
export function adjustedAnnual(item, scenario) {
  const base = annualAmount(item);
  if (scenario === 'Baseline') return base;
  return base * (1 - stressCutPct(item, scenario));
}

/**
 * The `(item, scenario) => fraction` cut the what-if simulation takes as its
 * `stressCut`. A transfer is never a stress cut (as on the Stress page), even
 * if a stale category survived a kind change.
 *
 * Module-level on purpose: `simulate`'s cache key includes the `stressCut`
 * function by identity (js/engine/simulation.js), so one stable reference for
 * the whole session keeps the cache hitting. Never wrap it per call.
 *
 * @param {StressItem} item
 * @param {string} scenario
 * @returns {number}
 */
export function stressCutFor(item, scenario) {
  return !isTransferItem(item) && scenarioHits(scenario, item) ? stressCutPct(item, scenario) : 0;
}
