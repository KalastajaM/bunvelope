// js/engine/whatif.js — what-if scenarios as a transform of the simulation's
// dated forecast rows (spec 2026-09-28-what-if-scenarios-design.md).
//
// A scenario never touches the budget: `applyScenario` takes the Forecast
// lens's rows and returns a new array in which plan rows are scaled or cut
// and synthetic rows are added. `simulate({ scenario })` walks that array
// instead of the lens's. Booked rows (real transactions, future-dated ones
// included) are never changed; only `is_forecast` rows that carry a
// `forecast_budget_item_id` are plan rows.
//
// Stress cuts come in as a function (`stressCut(item, scenario)`, a fraction
// 0–1; callers pass `stressCutFor` from `js/engine/stress.js`) so this module
// does not depend on the plan-item stress model.
//
// Pure. No clock: the window comes in as `startIso` / `endIso`.

import { round2 } from '../utils.js';
import { isIncomeLikeItem } from './_constants.js';

/**
 * @typedef {'A'|'B'|'C'|'D'|'E'} StressScenario
 * @typedef {{ type: 'income', pct: number, from: string, itemId?: string }
 *   | { type: 'monthly', amount: number, account: string, toAccount?: string, from: string, until?: string, day?: number }
 *   | { type: 'oneoff', date: string, amount: number, account: string, label: string }
 *   | { type: 'stress', scenario: StressScenario, from: string }} WhatIfChange
 * @typedef {{ id: string, name: string, changes: WhatIfChange[] }} WhatIfScenario
 * @typedef {(item: any, scenario: StressScenario) => number} StressCutFn
 * @typedef {{ kind: string, id: string | null, firstDate: string }} AlertLike
 */

const STRESS_SCENARIOS = ['A', 'B', 'C', 'D', 'E'];
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})$/;

/** @param {unknown} v @returns {v is string} */
function isMonth(v) {
  return typeof v === 'string' && MONTH_RE.test(v);
}

/** A real calendar date (no 2027-02-30). @param {unknown} v @returns {v is string} */
function isDate(v) {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const day = Number(m[3]);
  const daysInMonth = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/** @param {unknown} v @returns {v is number} */
function isMoney(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @param {unknown} v @returns {v is string} */
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * One change, validated and rebuilt with only its own keys, or null.
 *
 * @param {any} c
 * @param {Set<string>} liveAccounts   ids of non-archived accounts
 * @param {Set<string>} incomeItems    ids of income-like plan items
 * @returns {WhatIfChange | null}
 */
function normalizeChange(c, liveAccounts, incomeItems) {
  if (!c || typeof c !== 'object') return null;
  if (c.type === 'income') {
    if (!isMoney(c.pct) || c.pct < -100 || c.pct > 500 || !isMonth(c.from)) return null;
    if (c.itemId === undefined || c.itemId === null) return { type: 'income', pct: c.pct, from: c.from };
    if (typeof c.itemId !== 'string' || !incomeItems.has(c.itemId)) return null;
    return { type: 'income', pct: c.pct, from: c.from, itemId: c.itemId };
  }
  if (c.type === 'monthly') {
    if (!isMoney(c.amount) || c.amount === 0 || !liveAccounts.has(c.account) || !isMonth(c.from)) return null;
    /** @type {WhatIfChange} */
    const out = { type: 'monthly', amount: c.amount, account: c.account, from: c.from };
    if (c.toAccount !== undefined && c.toAccount !== null) {
      if (!liveAccounts.has(c.toAccount) || c.toAccount === c.account) return null;
      out.toAccount = c.toAccount;
    }
    if (c.until !== undefined && c.until !== null) {
      if (!isMonth(c.until) || c.until < c.from) return null;
      out.until = c.until;
    }
    if (c.day !== undefined && c.day !== null) {
      if (!Number.isInteger(c.day) || c.day < 1 || c.day > 28) return null;
      out.day = c.day;
    }
    return out;
  }
  if (c.type === 'oneoff') {
    if (!isDate(c.date) || !isMoney(c.amount) || c.amount === 0 || !liveAccounts.has(c.account)) return null;
    return { type: 'oneoff', date: c.date, amount: c.amount, account: c.account,
      label: typeof c.label === 'string' ? c.label : '' };
  }
  if (c.type === 'stress') {
    if (!STRESS_SCENARIOS.includes(c.scenario) || !isMonth(c.from)) return null;
    return { type: 'stress', scenario: c.scenario, from: c.from };
  }
  return null;
}

/**
 * The saved scenarios, read defensively: a malformed change is dropped (an
 * unknown type, a bad month or date, a non-finite amount, `pct` outside
 * −100…500, a zero monthly or one-off amount, an unknown, archived or
 * identical account, a `day` outside 1–28, an `itemId` that is not an income
 * plan item), and so is a scenario without an id or name, without one valid
 * change, or repeating an earlier scenario's id. Id and name are trimmed.
 *
 * @param {unknown} raw   `meta.whatIfScenarios`, as stored
 * @param {{ accounts?: any[], budgetItems?: any[] }} ctx
 * @returns {WhatIfScenario[]}
 */
export function normalizeScenarios(raw, { accounts, budgetItems }) {
  if (!Array.isArray(raw)) return [];
  const liveAccounts = new Set((accounts || []).filter(a => a && !a.archived).map(a => a.id));
  const incomeItems = new Set((budgetItems || []).filter(isIncomeLikeItem).map(i => i.id));
  /** @type {WhatIfScenario[]} */
  const out = [];
  // The first valid scenario with an id wins; a later one would be
  // unreachable from the page's picker, which selects by id.
  /** @type {Set<string>} */
  const seenIds = new Set();
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    if (!nonEmptyString(s.id) || !nonEmptyString(s.name) || !Array.isArray(s.changes)) continue;
    const id = s.id.trim();
    if (seenIds.has(id)) continue;
    /** @type {WhatIfChange[]} */
    const changes = [];
    for (const c of s.changes) {
      const n = normalizeChange(c, liveAccounts, incomeItems);
      if (n) changes.push(n);
    }
    if (!changes.length) continue;
    seenIds.add(id);
    out.push({ id, name: s.name.trim(), changes });
  }
  return out;
}

/** @param {any} row @returns {string} */
const rowDate = (row) => (typeof row?.date === 'string' ? row.date.slice(0, 10) : '');

/** @param {string} month  `YYYY-MM` @param {number} add @returns {string} */
function addMonths(month, add) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + add;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12 + 1;
  return `${yy}-${String(mm).padStart(2, '0')}`;
}

/**
 * A synthetic row: money in (`amount > 0`) or out of `account`, or a
 * transfer of `|amount|` to `toAccount`. Amounts are positive magnitudes;
 * the type carries the sign. Null for a zero amount.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.date
 * @param {number} p.amount
 * @param {string} p.account
 * @param {string} [p.toAccount]
 * @param {string} p.payee
 * @param {boolean} [p.once]
 * @returns {any}
 */
function syntheticRow({ id, date, amount, account, toAccount, payee, once }) {
  const magnitude = round2(Math.abs(amount));
  if (magnitude === 0) return null;
  const base = {
    id, is_forecast: true, whatif: true, ...(once ? { whatif_once: true } : {}),
    date, status: 'scheduled', envelope_id: null, payee, note: null,
  };
  if (toAccount) {
    return { ...base, type: 'account_transfer', amount: magnitude, from_account: account, to_account: toAccount };
  }
  return { ...base, type: amount > 0 ? 'income' : 'expense', amount: magnitude, account };
}

/**
 * The forecast rows with one scenario applied, as a new array (neither the
 * array nor any row is mutated). Changes apply in order, so an income change
 * and a Stress cut on the same row compose.
 *
 * - `income`: the plan rows of income-like items (or of `itemId`) dated in or
 *   after `from` are scaled by `1 + pct / 100`.
 * - `stress`: the plan rows dated in or after `from` of every item
 *   `stressCut(item, scenario)` hits are cut by that fraction. Without
 *   `stressCut`, nothing.
 * - `monthly` / `oneoff`: synthetic rows (`is_forecast`, `whatif`, one-offs
 *   also `whatif_once`), ids `whatif:<scenarioId>:<changeIndex>:<date>`, only
 *   on dates inside [startIso, endIso].
 *
 * @param {any[]} rows
 * @param {WhatIfScenario | null | undefined} scenario
 * @param {object} ctx
 * @param {any[]} [ctx.budgetItems]
 * @param {any[]} [ctx.accounts]   unused by the transform; accepted for symmetry with `normalizeScenarios`
 * @param {string} ctx.startIso    first date a synthetic row may fall on (inclusive)
 * @param {string} ctx.endIso      last date a synthetic row may fall on (inclusive)
 * @param {StressCutFn} [ctx.stressCut]
 * @returns {any[]}
 */
export function applyScenario(rows, scenario, { budgetItems, startIso, endIso, stressCut }) {
  let out = [...(rows || [])];
  const changes = Array.isArray(scenario?.changes) ? scenario.changes : [];
  if (!changes.length) return out;
  const itemsById = new Map((budgetItems || []).filter(Boolean).map(i => [i.id, i]));
  const scenarioId = scenario?.id ?? '';
  const inWindow = (/** @type {string} */ d) => d >= startIso && d <= endIso;

  /**
   * Scale plan rows dated in or after `from` by `factorFor(item)`. A row
   * scaled to zero (a 100 % cut, −100 %) is dropped, not kept at 0.
   * @param {string} from
   * @param {(item: any) => number} factorFor   1 = unchanged
   */
  const scalePlanRows = (from, factorFor) => {
    /** @type {any[]} */
    const next = [];
    for (const row of out) {
      if (!row?.is_forecast || row.forecast_budget_item_id == null
        || rowDate(row).slice(0, 7) < from) { next.push(row); continue; }
      const item = itemsById.get(row.forecast_budget_item_id);
      const factor = item ? factorFor(item) : 1;
      const amount = Number(row.amount);
      if (factor === 1 || !Number.isFinite(amount)) { next.push(row); continue; }
      const scaled = round2(amount * factor);
      if (scaled !== 0) next.push({ ...row, amount: scaled });
    }
    out = next;
  };

  /** @type {any[]} */
  const added = [];
  changes.forEach((change, index) => {
    if (change.type === 'income') {
      const factor = Math.max(0, 1 + change.pct / 100);
      scalePlanRows(change.from, item =>
        (isIncomeLikeItem(item) && (change.itemId == null || item.id === change.itemId) ? factor : 1));
    } else if (change.type === 'stress') {
      if (typeof stressCut !== 'function') return;
      scalePlanRows(change.from, item => {
        const cut = Number(stressCut(item, change.scenario));
        return Number.isFinite(cut) && cut > 0 ? 1 - Math.min(1, cut) : 1;
      });
    } else if (change.type === 'monthly') {
      const day = String(change.day ?? 1).padStart(2, '0');
      const lastMonth = change.until && change.until < endIso.slice(0, 7) ? change.until : endIso.slice(0, 7);
      for (let i = 0, month = change.from; month <= lastMonth; month = addMonths(change.from, ++i)) {
        const date = `${month}-${day}`;
        if (!inWindow(date)) continue;
        const row = syntheticRow({ id: `whatif:${scenarioId}:${index}:${date}`, date, amount: change.amount,
          account: change.account, toAccount: change.toAccount, payee: '' });
        if (row) added.push(row);
      }
    } else if (change.type === 'oneoff') {
      if (!inWindow(change.date)) return;
      const row = syntheticRow({ id: `whatif:${scenarioId}:${index}:${change.date}`, date: change.date,
        amount: change.amount, account: change.account, payee: change.label, once: true });
      if (row) added.push(row);
    }
  });
  return added.length ? [...out, ...added] : out;
}

/**
 * How a scenario's dates to act on differ from the plan's, keyed on `kind` +
 * `id`: alerts only in `whatAlerts` are added, only in `baseAlerts` removed,
 * and in both with a different `firstDate` moved (`alert` is the scenario's).
 *
 * @template {AlertLike} T
 * @param {T[] | null | undefined} baseAlerts
 * @param {T[] | null | undefined} whatAlerts
 * @returns {{ added: T[], removed: T[], moved: Array<{ alert: T, from: string, to: string }> }}
 */
export function diffAlerts(baseAlerts, whatAlerts) {
  const keyOf = (/** @type {AlertLike} */ a) => `${a.kind}:${a.id ?? ''}`;
  const base = (baseAlerts || []).filter(Boolean);
  const what = (whatAlerts || []).filter(Boolean);
  const baseByKey = new Map(base.map(a => [keyOf(a), a]));
  const whatKeys = new Set(what.map(keyOf));
  /** @type {T[]} */
  const added = [];
  /** @type {Array<{ alert: T, from: string, to: string }>} */
  const moved = [];
  for (const a of what) {
    const b = baseByKey.get(keyOf(a));
    if (!b) added.push(a);
    else if (b.firstDate !== a.firstDate) moved.push({ alert: a, from: b.firstDate, to: a.firstDate });
  }
  const removed = base.filter(b => !whatKeys.has(keyOf(b)));
  return { added, removed, moved };
}
