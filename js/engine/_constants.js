// js/engine/_constants.js — shared internal constants + small helpers for
// the engine modules. Underscore prefix signals "engine-internal" — callers
// should import the public API from `../engine.js` (or specific engine
// submodules), not this.

/**
 * Days either side of a due date a payment may land and still be recognised as
 * the money that settled it.
 *
 * One definition, two very different uses, and they must not drift apart.
 * `envelope-forecast.js` matches payments to occurrences with it. `insights.js`
 * judges a `from_budget` link stale with it — a due date sits somewhere inside
 * the month the key names, so a payment settling it has to fall within this
 * many days of that month; outside, no occurrence in the month could ever be
 * matched, whatever the key claims. Widening one and not the other would let
 * the invariant check flag links the matcher is happy to make.
 */
export const LINK_DAY_WINDOW = 10;

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * True when a budget item should be treated as income for envelope-planning
 * aggregations (annual totals, expense calendar, buffers, emergency, stress,
 * dynamic templates). Two flavours qualify:
 *
 *   1. `kind === 'income'` — the original income kind (salary etc.).
 *   2. `kind === 'investment_transfer'` with `direction === 'dividend'` —
 *      cash income tied to a holding. Dividend recurrence pairs with
 *      buy-direction DCA but lands like income (credits a cash account,
 *      doesn't drive an envelope debit), so it should partition into the
 *      income bucket on annual totals and skip the expense-only paths.
 *
 * Investment buys (`kind === 'investment_transfer'` with no direction or
 * direction === 'buy') still aggregate as expenses since they debit the
 * investing envelope.
 */
export function isIncomeLikeItem(item) {
  if (!item) return false;
  if (item.kind === 'income') return true;
  if (item.kind === 'investment_transfer' && item.direction === 'dividend') return true;
  return false;
}

/**
 * How an item is consumed. An explicit `funding_style` wins. Otherwise it is
 * spending (groceries, fuel) only when nothing marks a payment date: not
 * auto-posted, active in all twelve months, and no payment day past the 1st.
 * Everything else is a bill: an auto-posted item, a seasonal one (annual,
 * quarterly), or a monthly one with its own day (a premium on the 8th). On
 * the example budget that reads groceries and transport as spending and
 * rent, utilities, internet and insurance as bills.
 *
 * @param {import('./item-funding.js').FundingItem | null | undefined} item
 * @returns {import('./item-funding.js').FundingStyle}
 */
export function resolveFundingStyle(item) {
  if (!item) return 'bill';
  if (item.funding_style === 'bill' || item.funding_style === 'spending') return item.funding_style;
  if (item.as_schedule) return 'bill';
  const sched = item.monthly_schedule || {};
  const everyMonth = MONTH_NAMES.every(m => sched[m] !== undefined && sched[m] !== false);
  const day = Number(item.payment_day);
  const hasDay = Number.isFinite(day) && day > 1;
  return everyMonth && !hasDay ? 'spending' : 'bill';
}

/**
 * Half a cent — the width of "no difference" in money comparisons.
 *
 * Amounts are floats rounded to two decimals at boundaries, so a residue
 * smaller than half a cent is an artefact of the arithmetic, not a figure.
 * Every engine module was carrying this as a bare `0.005`, twenty-odd times
 * across seven files, plus a local `EPS` in envelope-forecast.js and a
 * `SETTLED_EPSILON` in reconcile-model.js — three names for one idea, and no
 * way to find them all when the idea changes.
 *
 * Comparisons keep their own operators: whether a boundary value counts is a
 * per-site decision (a gap of exactly half a cent is "not yet settled" to the
 * reconcile dialog and "already zero" to a forecast floor), and collapsing
 * those into one predicate would silently move behaviour.
 */
export const CENT_EPSILON = 0.005;

/** True when an amount is zero to the cent. */
export function isZeroMoney(n) {
  return !Number.isFinite(n) || Math.abs(n) < CENT_EPSILON;
}

/**
 * Assert that a caller supplied a usable clock, and hand it back.
 *
 * The engine reads no wall clock: every function that needs "now" takes it as
 * a required parameter. A default — `today = new Date()`, or a
 * `today instanceof Date ? today : new Date()` fallback — is untestable by
 * omission: a caller that forgets silently gets wall time, the answer then
 * depends on when and where the process ran, and nothing says so. It is also
 * how a date test passes in one timezone and fails in another
 * (`npm run test:tz`).
 *
 * Throwing is the point. A missing clock is a bug at the call site, and the
 * alternative is a number that is quietly wrong.
 *
 * @param {unknown} value
 * @param {string} fnName  named in the message, so the failure points at the
 *   function whose contract was broken
 * @returns {Date}
 */
export function requireClock(value, fnName) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new TypeError(
    `${fnName}: a valid Date is required — the engine reads no wall clock, ` +
    'so the caller supplies "now" (js/app.js exports `now()` for this).',
  );
}

/**
 * Money as whole cents, rounded exactly as `round2` rounds (half away from
 * zero on the value `n * 100` as the float holds it). The balance walks add
 * cents, not euros: a float sum of two-decimal amounts drifts in its last
 * bits (on the owner's ledger, 26 of 50 envelope balances failed a
 * two-decimal round trip), while a sum of integers is exact, so every balance
 * the engine returns is an exact two-decimal number. Integers stay exact up to
 * 2^53 cents, far above the 1e12 cap `validateAmount` enforces.
 *
 * @param {unknown} n
 * @returns {number}
 */
export function toCents(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
}

/** Back from whole cents to euros. @param {number} c @returns {number} */
export function fromCents(c) {
  return c / 100;
}

/** Amount tolerance for calling a payment "the same money" as its bill. */
export const LINK_AMOUNT_EPS = 0.01;

/** Whole days from `b` to `a`, both 'YYYY-MM-DD' (UTC-parsed, so no DST drift). */
export const dateDiffDays = (a, b) => Math.round(
  (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000,
);

/**
 * Could this untagged outflow be the payment for this occurrence? `row` and
 * `occ` each carry `date` (yyyy-mm-dd) and `amount` (positive magnitude).
 * Exported so the reconcile dialog asks the same question before it posts a
 * scheduled row (js/reconcile-model.js).
 *
 * A row the user linked to a budget item (`itemId`, from the transaction's
 * `budget_item_id`) answers by the link instead of the amount: it pays its
 * own item's occurrence whatever the amount (an invoice that came in above
 * or below its estimate), when it falls in the occurrence's month or within
 * the link window, and it NEVER pays another item's occurrence, however well
 * the amount matches. The user said which bill this is; a coincidence of
 * amounts does not overrule that. An unlinked row keeps the exact-amount rule.
 * Fill % (js/engine/item-funding.js) applies the same rule.
 *
 * @param {{ date: string, amount: number, itemId?: string | null }} row
 * @param {{ date: string, amount: number, itemId?: string | null }} occ
 * @returns {boolean}
 */
export function settles(row, occ) {
  const near = Math.abs(dateDiffDays(row.date, occ.date)) <= LINK_DAY_WINDOW;
  if (row.itemId) {
    return occ.itemId === row.itemId
      && (near || String(row.date).slice(0, 7) === String(occ.date).slice(0, 7));
  }
  return Math.abs(row.amount - occ.amount) <= LINK_AMOUNT_EPS && near;
}

/**
 * Loan account id → the one enabled, auto-posting `loan_payment` item that
 * pays it. A loan account two such items pay maps to neither.
 *
 * This is how a loan payment recorded by hand (Add transaction → Loan payment)
 * finds its item: it is saved as a `debt_payment` into the loan plus separate
 * interest and fee expenses, none of which equals the item's whole instalment,
 * so the amount rule in `settles()` can never match it, and the CLI and the
 * add form record no `budget_item_id` on it. The loan account names the item
 * as surely as a link would, as long as only one item pays that loan.
 *
 * @param {any[] | null | undefined} budgetItems
 * @returns {Map<string, string>}
 */
export function loanItemsByLoanAccount(budgetItems) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const shared = new Set();
  for (const it of budgetItems || []) {
    if (!it || it.kind !== 'loan_payment' || !it.as_schedule || it.include === false) continue;
    const loanId = it.to_account_id;
    if (typeof loanId !== 'string' || !loanId) continue;
    if (map.has(loanId) && map.get(loanId) !== it.id) shared.add(loanId);
    else map.set(loanId, it.id);
  }
  for (const loanId of shared) map.delete(loanId);
  return map;
}

/**
 * The budget item a real transaction pays: for a split expense asked about
 * one envelope, that envelope's line's own link (`envelope_splits[].
 * budget_item_id`, the first line of that envelope that has one); else the
 * row's `budget_item_id`; else, for a `debt_payment` into a loan, the item
 * `loanLinks` names for that loan (`loanItemsByLoanAccount`). Null when none
 * applies.
 *
 * @param {any} tx
 * @param {Map<string, string> | null} [loanLinks]
 * @param {string | null} [envelopeId]  the envelope the question is about
 * @returns {string | null}
 */
export function txLinkedItemId(tx, loanLinks = null, envelopeId = null) {
  if (envelopeId && Array.isArray(tx?.envelope_splits)) {
    const line = tx.envelope_splits.find(s => s && s.envelope_id === envelopeId
      && typeof s.budget_item_id === 'string' && s.budget_item_id);
    if (line) return line.budget_item_id;
  }
  if (typeof tx?.budget_item_id === 'string' && tx.budget_item_id) return tx.budget_item_id;
  if (loanLinks && tx?.type === 'debt_payment' && typeof tx.to_account === 'string') {
    return loanLinks.get(tx.to_account) ?? null;
  }
  return null;
}

/**
 * The item and month a `from_budget` key names: `${itemId}:YYYY-MM`, or a
 * loan payment's second and third rows, `${itemId}:YYYY-MM:interest` and
 * `:fee`. Null for anything else (a rollover or template key reads as an
 * item id that matches no item, which callers already tolerate).
 *
 * @param {unknown} key
 * @returns {{ itemId: string, month: string } | null}
 */
export function parseFromBudgetKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(.+):(\d{4}-\d{2})(?::(?:interest|fee))?$/.exec(key);
  return m ? { itemId: m[1], month: m[2] } : null;
}
