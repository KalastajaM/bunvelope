// js/engine/insights.js — dashboard summary, credit-card payment due,
// and schema-invariant validation.
//
// `computeDashboardSummary` is the KPI-bar data source.
// `computeCreditCardPaymentDue` powers the "Cards to pay" surface.
// `validateTxSplits` / `findInvalidTxSplits` enforce the expense-split
// invariant — caller decides whether to log, surface, or block on
// problems.
//
// Pure functions. No DOM, no I/O.

import { parseDate, round2, validateAmount } from '../utils.js';
import {
  computeAccountBalances,
  computeEnvelopeBalances,
  computeUnallocated,
  txEnvelopeEffect,
  txEnvelopeIds,
  txConsumptionTotal,
  loanAccountIds,
} from './balances.js';
import { buildExpenseCalendar } from './monthly-review.js';
import { planItemsAsOf, monthStartDate } from './item-dates.js';
import { txAccountDelta, isKnownTxType } from './tx-amounts.js';
import { LINK_DAY_WINDOW , CENT_EPSILON, requireClock } from './_constants.js';
import { findReconciledDrift, reconciledDriftChanges } from './reconciled.js';

// ─── Dashboard summary ───────────────────────────────────────────────────────

/**
 * Quick summary for the dashboard KPI bar.
 *
 * @param {Array}  accounts     - accounts array (with initialBalance)
 * @param {Array}  transactions - all transactions
 * @param {Array}  budgetItems  - budget items (for planned-this-month)
 * @param {string} month        - "YYYY-MM"
 * @returns {{ totalEnvelopeBalance, totalAccountBalance, unallocated,
 *             spentThisMonth, plannedThisMonth }}
 */
export function computeDashboardSummary(accounts, transactions, budgetItems, month) {
  const envelopeBalances = computeEnvelopeBalances(transactions);
  const accountBalances  = computeAccountBalances(accounts, transactions);
  const unallocated      = computeUnallocated(accountBalances, envelopeBalances, accounts);

  let totalEnvelopeBalance = 0;
  for (const v of envelopeBalances.values()) totalEnvelopeBalance += v;

  let totalAccountBalance = 0;
  for (const v of accountBalances.values()) totalAccountBalance += v;

  const [yearStr, monthStr] = month.split('-');
  const curYear = parseInt(yearStr, 10);
  const curM    = parseInt(monthStr, 10);

  // §2.1 — the shared spend rule, not a fifth inline filter. This was
  // `expense && isPostedTx` summing txAbsAmount, which agreed with the
  // reports' old figure only by coincidence: it counted no investment buys,
  // and it counted a split expense whole against whatever envelope it did
  // not have. docs/decisions.md D62 states this function already used
  // txEnvelopeSpend — it did not, which is what made the inconsistency
  // four-way rather than three-way.
  let spentThisMonth = 0;
  const loans = loanAccountIds(accounts);
  for (const tx of transactions) {
    const tDate = parseDate(tx.date);
    if (!tDate) continue;
    if (tDate.getMonth() + 1 === curM && tDate.getFullYear() === curYear) {
      spentThisMonth += txConsumptionTotal(tx, loans);
    }
  }
  spentThisMonth = round2(spentThisMonth);

  const eCal = buildExpenseCalendar(planItemsAsOf(budgetItems || [], monthStartDate(month)));
  let plannedThisMonth = 0;
  for (const arr of eCal.values()) plannedThisMonth += arr[curM] || 0;

  return {
    totalEnvelopeBalance: round2(totalEnvelopeBalance),
    totalAccountBalance:  round2(totalAccountBalance),
    unallocated,
    spentThisMonth,
    plannedThisMonth:     round2(plannedThisMonth),
  };
}

// ─── Credit-card payment due ─────────────────────────────────────────────────

/**
 * For each `account.type === 'credit_card'` (and not archived), compute the
 * outstanding balance the user would need to pay to bring the card to zero.
 * Returns Map<accountId, { account, paymentDue, postedDue }> where
 * `paymentDue` is computed from whatever transaction array the caller passes
 * (the active balance lens, in practice) and `postedDue` is always the
 * cleared-only equivalent, shown as a cross-check hint when it differs. Both
 * are non-negative — cards with zero or positive balances (overpayment) are
 * omitted.
 *
 * This is the data layer for the dashboard's "Cards to pay" surface and for
 * default-amount logic in the debt_payment flow. It's intentionally NOT a
 * synthetic envelope — Bunvelope's sum-zero invariant doesn't accommodate the
 * YNAB-style "auto-allocate to CC payment envelope" without restructuring the
 * unallocated relationship. Showing the due amount alongside the envelopes
 * gives the user the same visibility without that restructuring.
 */
export function computeCreditCardPaymentDue(accounts, transactions) {
  const out = new Map();
  const ccs = (accounts || []).filter(a => a && a.type === 'credit_card' && !a.archived);
  if (!ccs.length) return out;
  const budgetBalances = computeAccountBalances(accounts, transactions);
  const postedBalances = computeAccountBalances(accounts, transactions, { onlyPosted: true });
  for (const acc of ccs) {
    const bal = budgetBalances.get(acc.id) ?? 0;
    const posted = postedBalances.get(acc.id) ?? 0;
    const paymentDue = bal < -CENT_EPSILON ? round2(-bal) : 0;
    const postedDue  = posted < -CENT_EPSILON ? round2(-posted) : 0;
    if (paymentDue > 0 || postedDue > 0) {
      out.set(acc.id, { account: acc, paymentDue, postedDue });
    }
  }
  return out;
}

// ─── Schema invariants ───────────────────────────────────────────────────────

/**
 * Validate a single transaction against the schema's structural invariants.
 * Returns an array of `{ code, params, message }` problem objects (empty when
 * valid). `code` identifies the failure for i18n; `params` carries the values
 * to interpolate; `message` is a developer-facing fallback for logs.
 *
 * Currently checks expense splits:
 *   - signed sum(split.amount) ≈ |tx.amount| (tolerance 0.01)
 *   - if envelope_splits is non-empty, envelope_id should be null
 *   - every split entry must have envelope_id and a finite, non-zero amount
 *
 * Splits are signed: a negative line is a credit (refund/correction) baked
 * into a multi-envelope expense, so the lines must net to the transaction
 * total rather than each being individually positive.
 *
 * The engine treats split data as authoritative when present, so a mismatch
 * silently misallocates real money. This validator is the single source of
 * truth for callers that want to surface or block bad data.
 */
export function validateTxSplits(tx) {
  const problems = [];
  if (!tx || tx.type !== 'expense') return problems;
  if (!Array.isArray(tx.envelope_splits) || !tx.envelope_splits.length) return problems;

  const total = validateAmount(tx.amount);
  if (total === null) {
    problems.push({
      code: 'splitNoAmount',
      params: {},
      message: 'expense with envelope_splits has no valid amount',
    });
    return problems;
  }

  let sum = 0;
  for (const s of tx.envelope_splits) {
    if (!s || typeof s !== 'object') {
      problems.push({
        code: 'splitNotObject',
        params: {},
        message: 'split entry is not an object',
      });
      continue;
    }
    if (!s.envelope_id || s.envelope_id === '__none__') {
      problems.push({
        code: 'splitMissingEnvelope',
        params: {},
        message: 'split missing envelope_id',
      });
    }
    const sa = validateAmount(s.amount);
    if (sa === null || Math.abs(sa) < CENT_EPSILON) {
      problems.push({
        code: 'splitInvalidAmount',
        params: { amount: s.amount },
        message: `split amount invalid: ${s.amount}`,
      });
      continue;
    }
    sum += sa;
  }
  if (Math.abs(sum - Math.abs(total)) > 0.01) {
    const sumR = round2(sum);
    const totalR = round2(Math.abs(total));
    problems.push({
      code: 'splitSumMismatch',
      params: { sum: sumR, total: totalR },
      message: `split sum ${sumR} ≠ tx amount ${totalR}`,
    });
  }
  if (tx.envelope_id && tx.envelope_id !== '__none__') {
    problems.push({
      code: 'splitBothEnvelopeAndSplits',
      params: {},
      message: 'expense has both envelope_id and envelope_splits — splits take precedence',
    });
  }
  return problems;
}

/**
 * Run validateTxSplits over a list of transactions. Returns an array of
 * `{ id, problems }` rows for the malformed ones. Use this at load time to
 * log/raise warnings without blocking startup.
 */
export function findInvalidTxSplits(transactions) {
  const out = [];
  for (const tx of transactions || []) {
    const problems = validateTxSplits(tx);
    if (problems.length) out.push({ id: tx?.id ?? null, problems });
  }
  return out;
}

/**
 * Confirm every account-side reference on a transaction resolves to an id
 * present in the supplied `accountIds` set. Archived accounts count as
 * present — historical transactions may reference them. Returns an array
 * of human-readable problem strings (empty when valid).
 *
 * Dividends intentionally skip the `from_account` check: the paying
 * investment account may be informational only (not a budget account).
 */
export function validateAccountRefs(tx, accountIds) {
  const problems = [];
  if (!tx) return problems;
  const ids = accountIds instanceof Set ? accountIds : new Set(accountIds || []);
  const flag = (field, id, message) => {
    problems.push({ code: 'unknownAccount', params: { field, id }, message });
  };
  const check = (field) => {
    const v = tx[field];
    if (!v) return;
    if (!ids.has(v)) flag(field, v, `unknown ${field}: ${v}`);
  };
  switch (tx.type) {
    case 'expense':
      check('account');
      break;
    case 'income':
      check('account');
      // Interest received on a loan given (loanGivenTerms counts it).
      check('interest_of');
      break;
    case 'account_transfer':
    case 'debt_payment':
      check('from_account');
      check('to_account');
      break;
    case 'investment_transfer':
      if (tx.direction !== 'dividend') check('from_account');
      check('to_account');
      break;
    case 'fill':
      if (tx.source === 'new_income') check('source_account');
      break;
    case 'adjustment':
      if (tx.target === 'account') {
        const v = tx.target_id;
        if (v && !ids.has(v)) flag('target_id (account)', v, `unknown target_id (account): ${v}`);
      }
      break;
    default:
      break;
  }
  return problems;
}

/**
 * Confirm every envelope-side reference on a transaction resolves to an id
 * present in the supplied `envelopeIds` set, with `__none__` accepted
 * everywhere as the explicit "no envelope" sentinel. Archived envelopes
 * count as present.
 */
export function validateEnvelopeRefs(tx, envelopeIds) {
  const problems = [];
  if (!tx) return problems;
  const ids = envelopeIds instanceof Set ? envelopeIds : new Set(envelopeIds || []);
  const flag = (field, id, message) => {
    problems.push({ code: 'unknownEnvelope', params: { field, id }, message });
  };
  const check = (field) => {
    const v = tx[field];
    if (!v) return;
    if (v === '__none__') return;
    if (!ids.has(v)) flag(field, v, `unknown ${field}: ${v}`);
  };
  switch (tx.type) {
    case 'expense':
      if (Array.isArray(tx.envelope_splits) && tx.envelope_splits.length) {
        for (const s of tx.envelope_splits) {
          const v = s?.envelope_id;
          if (!v || v === '__none__') continue;
          if (!ids.has(v)) flag('split envelope_id', v, `unknown split envelope_id: ${v}`);
        }
      } else {
        check('envelope_id');
      }
      break;
    case 'income':
    case 'debt_payment':
    case 'investment_transfer':
      check('envelope_id');
      break;
    case 'envelope_transfer':
      check('from_envelope_id');
      check('to_envelope_id');
      break;
    case 'fill':
      for (const line of (tx.lines || [])) {
        const v = line?.envelope_id;
        if (!v) continue;
        if (!ids.has(v)) flag('fill line envelope_id', v, `unknown fill line envelope_id: ${v}`);
      }
      break;
    case 'adjustment':
      if (tx.target === 'envelope') {
        const v = tx.target_id;
        if (v && !ids.has(v)) flag('target_id (envelope)', v, `unknown target_id (envelope): ${v}`);
      }
      break;
    default:
      break;
  }
  return problems;
}

/**
 * Confirm `tx.amount` follows the engine's sign convention: positive
 * magnitude for type-signed transactions, signed value only for
 * `adjustment`. Mirrors `normalizeTxAmount`. A negative `amount` slipping
 * past the write boundary is a serialization or migration bug — silent,
 * but visible here.
 *
 * Skips when `tx.amount` is null/undefined (fill rows store amounts on
 * `lines[].amount`, not on the tx itself).
 */
const TYPE_SIGNED_CONVENTION = new Set(['adjustment']);
export function validateAmountSign(tx) {
  const problems = [];
  if (!tx || tx.amount === undefined || tx.amount === null) return problems;
  const n = validateAmount(tx.amount);
  if (n === null) return problems;
  if (TYPE_SIGNED_CONVENTION.has(tx.type)) return problems;
  // The convention is defined per type; a row whose type the engine does not
  // know has none, and `validateTxType` already reports it.
  if (!isKnownTxType(tx.type)) return problems;
  if (n < 0) {
    problems.push({
      code: 'negativeAmount',
      params: { amount: tx.amount, type: tx.type },
      message: `negative amount on type-signed tx (${tx.type}): ${tx.amount}`,
    });
  }
  return problems;
}

/**
 * Confirm every money field on a row is a finite number.
 *
 * `round2` (js/utils.js) maps a non-finite input to 0 rather than throwing,
 * and that coercion is deliberate: thirteen engine modules call it on the
 * paint path, so a throw turns a wrong number into a blank screen. What was
 * missing is any way for the owner to find out it happened. `round2(Infinity)
 * === 0` once silently zeroed every fill and projected a year of no income,
 * with no error anywhere.
 *
 * So: keep the coercion, add the report. Checking the ROW rather than
 * instrumenting each `round2` call site catches the value at its source —
 * one problem naming the offending id, instead of one per screen the bad
 * value reaches.
 *
 * `validateAmountSign` above cannot cover this: it bails out through
 * `validateAmount`, which returns null for exactly these values.
 */
const MONEY_FIELDS = ['amount', 'fee', 'pricePerUnit', 'units'];
export function validateAmountCoercion(tx) {
  const problems = [];
  if (!tx) return problems;

  const flag = (where, value) => {
    problems.push({
      code: 'nonFiniteAmount',
      params: { field: where, value: String(value) },
      message: `${where} is not a finite number (${String(value)}); `
             + 'it is being read as 0',
    });
  };

  const check = (where, value) => {
    if (value === undefined || value === null || value === '') return;
    const n = Number(value);
    if (!Number.isFinite(n)) flag(where, value);
  };

  for (const f of MONEY_FIELDS) check(f, tx[f]);

  if (Array.isArray(tx.envelope_splits)) {
    for (const [i, sp] of tx.envelope_splits.entries()) {
      if (sp && typeof sp === 'object') check(`envelope_splits[${i}].amount`, sp.amount);
    }
  }
  if (Array.isArray(tx.lines)) {
    for (const [i, l] of tx.lines.entries()) {
      if (l && typeof l === 'object') check(`lines[${i}].amount`, l.amount);
    }
  }
  return problems;
}

/**
 * Confirm `tx.date` is a real calendar date in `YYYY-MM-DD` form.
 *
 * Every date comparison in the engine is a LEXICOGRAPHIC string compare —
 * balance `asOf` cutoffs, scheduling windows, month bucketing, the running-
 * balance sort. That is deliberate and correct for ISO strings, and quietly
 * meaningless for anything else: a row dated `2026-8-6` sorts after
 * `2026-12-01`, and one dated `''` sorts before everything and lands in no
 * month at all. Neither throws; the row simply reports in the wrong place
 * forever.
 *
 * `2026-02-31` is rejected too — it parses in JS (rolling into March) but
 * would put the transaction in a month its own date string denies.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function validateTxDate(tx) {
  const problems = [];
  if (!tx) return problems;
  const raw = tx.date;
  if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
    // Blank and absent both read as "(missing)": rendering the empty string
    // verbatim produces "has an unusable date ()", which tells the reader
    // nothing about what is wrong with it.
    const shown = (raw === undefined || raw === null || raw === '') ? '(missing)' : String(raw);
    problems.push({
      code: 'invalidDate',
      params: { date: shown },
      message: `date is not YYYY-MM-DD: ${shown}`,
    });
    return problems;
  }
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    problems.push({
      code: 'invalidDate',
      params: { date: raw },
      message: `date is not a real calendar day: ${raw}`,
    });
  }
  return problems;
}

/**
 * The calendar month a `from_budget` key names, or null.
 *
 * The key is `<itemId>:<YYYY-MM>` in the common case, but not always: a fill
 * leg appends `:fill`, envelope rollovers prepend `rollover:`, and template
 * fills prepend `tpl:` and carry no budget item at all. So the month is
 * neither the first segment nor reliably the last — this takes the last
 * segment that IS one, which is unambiguous for every shape the app emits.
 */
function isMonthKey(part) {
  if (!/^\d{4}-\d{2}$/.test(part)) return false;
  const month = Number(part.slice(5));
  return month >= 1 && month <= 12;
}

function fromBudgetMonth(key) {
  if (typeof key !== 'string' || !key) return null;
  let found = null;
  for (const part of key.split(':')) if (isMonthKey(part)) found = part;
  return found;
}

/**
 * The same key pointed at a different month, or null if it names none.
 *
 * Rewrites the segment `fromBudgetMonth` reads, so it survives the suffixed
 * and namespaced shapes for the same reason that one does. Only the offer to
 * relink uses it; whether relinking is the right answer is the user's call,
 * because "I paid the August bill in October" and "this is the October bill"
 * produce identical data and only they know which one it was.
 */
export function repointFromBudgetMonth(key, month) {
  if (!fromBudgetMonth(key) || !isMonthKey(String(month))) return null;
  const parts = String(key).split(':');
  let at = -1;
  for (let i = 0; i < parts.length; i++) if (isMonthKey(parts[i])) at = i;
  if (at < 0) return null;
  parts[at] = month;
  return parts.join(':');
}

/** Whole days `dayStr` falls outside the calendar month `YYYY-MM`, else 0. */
function daysOutsideMonth(dayStr, monthStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  const [my, mm] = monthStr.split('-').map(Number);
  const day = Date.UTC(y, m - 1, d) / 86400000;
  const first = Date.UTC(my, mm - 1, 1) / 86400000;
  const last = Date.UTC(my, mm, 0) / 86400000;
  if (day < first) return first - day;
  if (day > last) return day - last;
  return 0;
}

/**
 * Confirm a transaction's `from_budget` link still points somewhere it could
 * plausibly have come from.
 *
 * The key says "this transaction settles that scheduled occurrence", and
 * nothing revisits it when the DATE changes. Both edit paths preserve it while
 * replacing the date: converting a forecast row stamps the key from
 * `forecast_month_key` and takes the date from the form, and editing a real
 * row spreads `...tx` over a new `date`. Re-date a materialized bill far
 * enough — "this one is actually due in October" — and the key names a month
 * the transaction has nothing to do with.
 *
 * Nothing else notices, and the consequences compound rather than cancel. The
 * forecast trusts the key absolutely: it dedups the occurrence the key names,
 * and it excludes the row from the settling pool BECAUSE the row carries a
 * key at all — so the occurrence the transaction really pays gets forecast on
 * top of it, and the bill is counted twice with no visible cause.
 *
 * `LINK_DAY_WINDOW` is the threshold, deliberately rather than a constant of
 * its own: it is already what the app means by "a payment can land this far
 * from its due date and still be the same money". The due date sits somewhere
 * inside the keyed month, so a payment settling it falls within that many days
 * of the month. Beyond it, the matcher itself could never pair them, whatever
 * the key claims — which makes this the exact complement of the netting rather
 * than a second opinion about it.
 *
 * Only a row dated AFTER its month (beyond the window) is flagged. One dated
 * before it is a bill paid early, however early: its key is still the month it
 * belongs to.
 *
 * Says nothing about a key it cannot read or a date it cannot parse: an
 * unreadable date is `validateTxDate`'s complaint, and reporting both would
 * charge one fault twice.
 */
export function validateFromBudgetLink(tx) {
  const problems = [];
  const key = typeof tx?.from_budget === 'string' ? tx.from_budget : '';
  if (!key) return problems;
  const month = fromBudgetMonth(key);
  if (!month) return problems;
  const date = typeof tx?.date === 'string' ? tx.date.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return problems;
  // Paid early: a row dated before its key's month settles that occurrence
  // ahead of time ("Post now" on a forecast occurrence keeps the key and
  // dates the row today, owner decision 2026-10-05). The key still names the
  // month the row belongs to, which is how the forecast dedups it and the
  // rollover counts it, so only a row dated after the month can be stale.
  if (date < `${month}-01`) return problems;
  const days = daysOutsideMonth(date, month);
  if (days <= LINK_DAY_WINDOW) return problems;
  problems.push({
    code: 'staleFromBudgetLink',
    params: { key, month, date, days },
    message: `dated ${date} but linked to the ${month} occurrence of "${key}" (${days} days outside it)`,
  });
  return problems;
}

/**
 * Confirm a transfer actually moves money between two different places.
 *
 * A transfer whose two ends are the same account nets to zero in
 * `txAccountDelta` — both legs hit the same id and cancel — so it is invisible
 * in every balance while still occupying a row, inflating transfer counts and
 * Age-of-Money flows. The envelope equivalent behaves the same way.
 *
 * Almost always a bad import mapping or a mis-click in the transfer form,
 * neither of which announces itself.
 */
export function validateSelfTransfer(tx) {
  const problems = [];
  if (!tx) return problems;
  const type = tx.type;

  if (type === 'account_transfer' || type === 'debt_payment' || type === 'investment_transfer') {
    if (tx.from_account && tx.from_account === tx.to_account) {
      problems.push({
        code: 'selfTransferAccount',
        params: { id: tx.from_account, type },
        message: `${type} moves from and to the same account: ${tx.from_account}`,
      });
    }
  }
  if (type === 'envelope_transfer') {
    if (tx.from_envelope_id && tx.from_envelope_id === tx.to_envelope_id) {
      problems.push({
        code: 'selfTransferEnvelope',
        params: { id: tx.from_envelope_id, type },
        message: `envelope_transfer moves from and to the same envelope: ${tx.from_envelope_id}`,
      });
    }
    // An envelope transfer naming NEITHER side moves no money at all, in
    // either envelope, while still occupying a row and reading as real on
    // every surface that lists transactions.
    //
    // `validateEnvelopeRefs` cannot see this: it reports ids that do not
    // RESOLVE, and returns early on a falsy one — a missing id is a different
    // fault and needs its own check. Two known producers, both writing the
    // pre-v3 field names (`from_envelope` / `to_envelope`) that the v2→v3
    // migration renamed: the AI proposal writer and the envelope-move tool,
    // fixed 2026-08-26. Rows accepted before that fix are still in the ledger
    // and are otherwise completely silent, which is what this surfaces.
    if (!tx.from_envelope_id && !tx.to_envelope_id) {
      problems.push({
        code: 'transferMissingEndpoints',
        params: { type },
        message: 'envelope_transfer names neither a source nor a destination envelope',
      });
    }
  }
  return problems;
}

/**
 * Confirm a row's `type` is one the engine gives an effect to (`TX_TYPES` in
 * tx-amounts.js).
 *
 * A row typed `'expnese'` passes the storage validator (which only asks for a
 * non-empty string, so one legacy row cannot lock the budget), matches no
 * branch in `txAccountDelta` or the envelope walk, and so moves no money
 * anywhere while still listing as a real transaction. Nothing else in the
 * scan notices: the ref, split, sign and conservation checks all key off a
 * known type and skip it.
 *
 * An absent or blank type is reported the same way, shown as "(missing)" like
 * `validateTxDate` does, since its effect on the numbers is identical.
 *
 * @param {any} tx
 * @returns {Array<{ code: 'unknownTxType', params: { type: string }, message: string }>}
 */
export function validateTxType(tx) {
  /** @type {Array<{ code: 'unknownTxType', params: { type: string }, message: string }>} */
  const problems = [];
  if (!tx || typeof tx !== 'object') return problems;
  if (isKnownTxType(tx.type)) return problems;
  const raw = tx.type;
  const shown = (raw === undefined || raw === null || raw === '') ? '(missing)' : String(raw);
  problems.push({
    code: 'unknownTxType',
    params: { type: shown },
    message: `has unsupported type "${shown}" and moves no money`,
  });
  return problems;
}

/**
 * Run every invariant over the supplied state and return a structured
 * summary. `state.accounts` / `state.envelopes` may be `null` when those
 * arrays are still loading — the corresponding ref checks then skip.
 *
 * Shape:
 *   {
 *     totalProblems: number,
 *     byCategory: { splits, accountRefs, envelopeRefs, signs, duplicateKeys,
 *                   dates, selfTransfers, duplicateIds, staleKeys, coercions,
 *                   conservation, unknownTypes },
 *     problems: Array<{ id, category, code, params, message }>
 *   }
 *
 * `byCategory` counts are how many transactions tripped each invariant;
 * `problems` lists the first ~50 individual messages so dialogs can show
 * concrete examples without unbounded growth.
 *
 * Two checks are cross-transaction rather than per-row, and only exist because
 * nothing else in the app would ever notice:
 *
 *   - `duplicateKeys`: `from_budget` is an idempotency key — one scheduled
 *     occurrence, one transaction — and four mechanisms trust it to be unique
 *     (the post-due materialiser's dedup, scheduled tombstones, the forecast's
 *     due-but-unposted netting, and the repair action that relinks a
 *     hand-recorded payment). Two rows sharing a key make an occurrence look
 *     settled that is only half settled.
 *   - `duplicateIds`: `tx.id` keys every Map the app builds over transactions
 *     — running balances, selection state, edit-by-id, the repair action's own
 *     write. Two rows sharing an id means one of them is unreachable and the
 *     other silently answers for both. Imports are the usual source.
 *
 * NOT included, deliberately: a check on the "unallocated identity", that
 * `Σ accounts − Σ envelopes === unallocated`. Envelope balances are derived
 * entirely from the transaction list, account balances are `initialBalance`
 * plus a walk over the SAME list, and `computeUnallocated` is DEFINED as the
 * difference — so that identity holds by construction and a check on it can
 * only ever pass. §4.5 of the remediation plan asks for it as "the cheapest
 * possible smoke test for a clobbered write"; it is not one, because a
 * clobbered transactions.json moves both sides together.
 *
 * What IS included (`conservation`) is the non-tautological half of the same
 * idea: v1 derives a transaction's account-side movement and its
 * envelope-side movement in two SEPARATE implementations — `txAccountDelta`
 * in tx-amounts.js and `txEnvelopeEffect` in balances.js. For a row that
 * charges an envelope, the two must agree, and nothing enforced that they do.
 * Adding a transaction field or a type and teaching only one walker about it
 * is exactly the drift AGENTS.md warns about, and it shows up here as money
 * leaving an account that never leaves an envelope, or the reverse.
 */
/**
 * Cross-check v1's two independent derivations of one transaction's movement.
 *
 * `txAccountDelta` (tx-amounts.js) answers "what did this do to the accounts";
 * `txEnvelopeEffect` (balances.js) answers "what did this do to the
 * envelopes". For an `expense` or `income` that carries envelope attribution
 * the two describe the same money and must agree in magnitude and direction.
 *
 * Rows where they legitimately disagree are excluded, not flagged:
 *   • unenveloped expense/income — the envelope side is unallocated, not zero
 *     by mistake (3 such rows exist on the owner's real budget);
 *   • fills, transfers and adjustments — a fill draws from unallocated, an
 *     account transfer is envelope-neutral, an envelope transfer is
 *     account-neutral. None of them is a two-sided move of the same money.
 */
const TWO_SIDED_TYPES = new Set(['expense', 'income']);
export function validateConservation(tx, accountIds, envelopeIds) {
  const problems = [];
  if (!tx || !TWO_SIDED_TYPES.has(tx.type)) return problems;
  if (!tx.account) return problems;

  // Envelope attribution: a top-level id or splits. Without either, the other
  // side is unallocated and there is nothing to reconcile.
  const hasSplits = Array.isArray(tx.envelope_splits) && tx.envelope_splits.length > 0;
  const envIds = txEnvelopeIds(tx);
  if (!hasSplits && !tx.envelope_id) return problems;
  if (!envIds.length) return problems;
  // A reference to an envelope that no longer exists is the envelopeRefs
  // check's business; reporting it twice helps nobody.
  if (envelopeIds && envIds.some((id) => id !== '__none__' && !envelopeIds.has(id))) {
    return problems;
  }
  if (accountIds && !accountIds.has(tx.account)) return problems;
  if (envIds.length === 1 && envIds[0] === '__none__') return problems;

  const accountSide = txAccountDelta(tx, tx.account);
  let envelopeSide = 0;
  for (const envId of envIds) {
    if (envId === '__none__') continue;
    const effect = txEnvelopeEffect(tx, envId);
    if (effect && effect.mode === 'add') envelopeSide += effect.amount;
  }

  const gap = round2(accountSide - envelopeSide);
  if (Math.abs(gap) >= 0.01) {
    problems.push({
      code: 'conservationGap',
      params: {
        account: round2(accountSide),
        envelope: round2(envelopeSide),
        gap,
      },
      message: `moves ${round2(accountSide)} in the accounts but `
             + `${round2(envelopeSide)} in the envelopes (off by ${gap})`,
    });
  }
  return problems;
}

/**
 * A `budget_item_id` (fill %, js/engine/item-funding.js) must name an item of
 * one of the row's own envelopes. When it names an item that now sits in
 * another envelope (the item was moved, or the row was re-enveloped without
 * clearing it), the link is silently ignored and the spend counts as
 * unlinked. A link to an item that no longer exists is not reported: it was
 * deleted on purpose and ignoring the link is exactly right.
 *
 * @param {any} tx
 * @param {Map<string, any>} itemsById
 */
export function validateBudgetItemLink(tx, itemsById) {
  const problems = [];
  const report = (itemId) => {
    const item = itemsById.get(itemId);
    problems.push({
      code: 'budgetItemOtherEnvelope',
      params: { item: item.description || itemId },
      message: `linked to budget item "${item.description || itemId}", which belongs to another envelope`,
    });
  };
  const itemId = tx?.budget_item_id;
  if (typeof itemId === 'string' && itemId) {
    const item = itemsById.get(itemId);
    if (item && !txEnvelopeIds(tx).includes(item.envelope_id)) report(itemId);
  }
  // A split line's link must name an item of that line's own envelope.
  for (const s of Array.isArray(tx?.envelope_splits) ? tx.envelope_splits : []) {
    const lineItem = s?.budget_item_id;
    if (typeof lineItem !== 'string' || !lineItem) continue;
    const item = itemsById.get(lineItem);
    if (item && item.envelope_id !== s.envelope_id) report(lineItem);
  }
  return problems;
}

/**
 * @param {object} [state]
 * @param {any[]} [state.accounts]
 * @param {any[]} [state.envelopes]
 * @param {any[]} [state.transactions]
 * @param {any[]} [state.budgetItems]  enables the budget-item link check
 * @param {{ change_log?: any[] }} [state.meta]  its change log names what moved a reconciliation
 */
export function runInvariantCheck({ accounts, envelopes, transactions, budgetItems, meta } = {}) {
  const txs = Array.isArray(transactions) ? transactions : [];
  const accountIds = Array.isArray(accounts)
    ? new Set(accounts.map((a) => a?.id).filter(Boolean))
    : null;
  const envelopeIds = Array.isArray(envelopes)
    ? new Set(envelopes.map((e) => e?.id).filter(Boolean))
    : null;

  const byCategory = {
    splits: 0, accountRefs: 0, envelopeRefs: 0, signs: 0,
    duplicateKeys: 0, dates: 0, selfTransfers: 0, duplicateIds: 0,
    staleKeys: 0, coercions: 0, conservation: 0, unknownTypes: 0, itemLinks: 0,
    reconciled: 0, clearedScheduled: 0,
  };
  const itemsById = Array.isArray(budgetItems)
    ? new Map(budgetItems.filter((it) => it && it.id).map((it) => [it.id, it]))
    : null;
  const problems = [];
  const PROBLEM_CAP = 50;
  const push = (id, category, p) => {
    if (problems.length < PROBLEM_CAP) {
      problems.push({ id, category, code: p.code, params: p.params, message: p.message });
    }
  };

  // Collected in the same pass, reported after it — a duplicate is only
  // visible once a second row carrying the key has been seen.
  const byKey = new Map();
  const byId = new Map();

  for (const tx of txs) {
    const id = tx?.id ?? null;
    const key = typeof tx?.from_budget === 'string' ? tx.from_budget : '';
    if (key) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(tx);
    }
    if (typeof id === 'string' && id) {
      if (!byId.has(id)) byId.set(id, 0);
      byId.set(id, byId.get(id) + 1);
    }
    const typeProblems = validateTxType(tx);
    if (typeProblems.length) {
      byCategory.unknownTypes++;
      for (const p of typeProblems) push(id, 'unknownTypes', p);
    }
    const dateProblems = validateTxDate(tx);
    if (dateProblems.length) {
      byCategory.dates++;
      for (const p of dateProblems) push(id, 'dates', p);
    }
    const linkProblems = validateFromBudgetLink(tx);
    if (linkProblems.length) {
      byCategory.staleKeys++;
      for (const p of linkProblems) push(id, 'staleKeys', p);
    }
    const selfProblems = validateSelfTransfer(tx);
    if (selfProblems.length) {
      byCategory.selfTransfers++;
      for (const p of selfProblems) push(id, 'selfTransfers', p);
    }
    const splitProblems = validateTxSplits(tx);
    if (splitProblems.length) {
      byCategory.splits++;
      for (const p of splitProblems) push(id, 'splits', p);
    }
    if (accountIds) {
      const acctProblems = validateAccountRefs(tx, accountIds);
      if (acctProblems.length) {
        byCategory.accountRefs++;
        for (const p of acctProblems) push(id, 'accountRefs', p);
      }
    }
    if (envelopeIds) {
      const envProblems = validateEnvelopeRefs(tx, envelopeIds);
      if (envProblems.length) {
        byCategory.envelopeRefs++;
        for (const p of envProblems) push(id, 'envelopeRefs', p);
      }
    }
    const signProblems = validateAmountSign(tx);
    if (signProblems.length) {
      byCategory.signs++;
      for (const p of signProblems) push(id, 'signs', p);
    }
    const coercionProblems = validateAmountCoercion(tx);
    if (coercionProblems.length) {
      byCategory.coercions++;
      for (const p of coercionProblems) push(id, 'coercions', p);
    }
    if (itemsById) {
      const itemProblems = validateBudgetItemLink(tx, itemsById);
      if (itemProblems.length) {
        byCategory.itemLinks++;
        for (const p of itemProblems) push(id, 'itemLinks', p);
      }
    }
    // Cleared yet still scheduled: the bank shows it, but the Today view
    // reads `status` and leaves it out. Rows ticked in a reconcile before
    // `applyReconcile` posted scheduled rows are stuck like this; the edit
    // sheet's "Post now" (transaction.post) fixes one.
    if (tx && !tx.is_forecast && tx.cleared === true && tx.status === 'scheduled') {
      byCategory.clearedScheduled++;
      push(id, 'clearedScheduled', {
        code: 'clearedScheduled',
        params: { date: typeof tx.date === 'string' ? tx.date.slice(0, 10) : '' },
        message: 'cleared but still scheduled, so the Today view leaves it out',
      });
    }
    const conservationProblems = validateConservation(tx, accountIds, envelopeIds);
    if (conservationProblems.length) {
      byCategory.conservation++;
      for (const p of conservationProblems) push(id, 'conservation', p);
    }
  }

  // Flag every row sharing a key, not just the extras: with two rows for one
  // occurrence neither is knowably "the" original, so both need looking at.
  for (const [key, rows] of byKey) {
    if (rows.length < 2) continue;
    byCategory.duplicateKeys += rows.length;
    for (const tx of rows) {
      push(tx?.id ?? null, 'duplicateKeys', {
        code: 'duplicateFromBudget',
        params: { key, count: rows.length },
        message: `shares from_budget key "${key}" with ${rows.length - 1} other transaction(s)`,
      });
    }
  }

  // Same "flag every row in the group" rule as duplicate keys, for the same
  // reason: neither copy is knowably the original.
  for (const [id, count] of byId) {
    if (count < 2) continue;
    byCategory.duplicateIds += count;
    for (let i = 0; i < count; i++) {
      push(id, 'duplicateIds', {
        code: 'duplicateTxId',
        params: { id, count },
        message: `transaction id "${id}" is used by ${count} rows`,
      });
    }
  }

  // A reconciled balance that no longer matches the bank: a cleared row dated
  // on or before the reconcile was edited, deleted or un-cleared since. Not a
  // row problem, an account one, so `id` is null and the account rides in
  // `params` (see js/engine/reconciled.js).
  if (Array.isArray(accounts)) {
    for (const d of findReconciledDrift(accounts, txs)) {
      byCategory.reconciled++;
      // The changes since the reconciliation that moved it, as far as the
      // change log and the reconcile's time can tell (reconciledDriftChanges).
      const { timingKnown, changes } = reconciledDriftChanges(
        accounts.find((a) => a?.id === d.accountId), txs, meta?.change_log);
      push(null, 'reconciled', {
        code: 'reconciledDrift',
        params: {
          accountId: d.accountId, date: d.reconciledAt, expected: d.expected, actual: d.actual, gap: d.gap,
          timingKnown, changes,
        },
        message: `account "${d.accountId}" reconciled on ${d.reconciledAt} at ${d.expected}; its cleared rows now add up to ${d.actual}`,
      });
    }
  }

  // Summed over the object rather than enumerated by hand: this used to name
  // each category, so adding one incremented `byCategory` but not the total —
  // and the status-bar badge, which gates on the total, stayed hidden while
  // the dialog behind it had something to say.
  const totalProblems = Object.values(byCategory).reduce((n, v) => n + v, 0);
  return { totalProblems, byCategory, problems };
}

// ─── Future rows on archived accounts and envelopes ───────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** Accounts a transaction moves money on, by id. */
function txAccountIds(tx) {
  const out = [];
  for (const id of [tx.account, tx.from_account, tx.to_account]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Transactions still ahead — dated after `today`, or `status: 'scheduled'` —
 * that touch one of the given accounts or envelopes. Forecast rows are
 * derived, not stored, and never count.
 *
 * Archiving hides an account or envelope from the pickers but not from the
 * ledger, so a future row naming one still posts against it: money moves on
 * an account nobody is looking at, or into an envelope that no longer shows.
 * The archive actions warn with this before archiving; the status badge
 * reports what is already there (`findFutureRowsOnArchived`).
 *
 * @param {object} input
 * @param {any[]} [input.transactions]
 * @param {Date} input.today
 * @param {Iterable<string>} [input.accountIds]
 * @param {Iterable<string>} [input.envelopeIds]
 * @returns {Array<{ id: string, date: string, payee: string, accountIds: string[], envelopeIds: string[] }>}
 *   the matching rows, oldest first, each naming which of the given ids it touches
 */
export function futureRowsTouching({ transactions, today, accountIds = [], envelopeIds = [] }) {
  const base = requireClock(today, 'futureRowsTouching');
  const todayStr = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
  const accts = new Set(accountIds);
  const envs = new Set(envelopeIds);
  if (accts.size === 0 && envs.size === 0) return [];
  const out = [];
  for (const tx of transactions || []) {
    if (!tx || tx.is_forecast) continue;
    const date = String(tx.date || '').slice(0, 10);
    if (!(tx.status === 'scheduled' || date > todayStr)) continue;
    const a = txAccountIds(tx).filter((id) => accts.has(id));
    const e = txEnvelopeIds(tx).filter((id) => envs.has(id));
    if (a.length || e.length) {
      out.push({ id: tx.id, date, payee: tx.payee || '', accountIds: a, envelopeIds: e });
    }
  }
  out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return out;
}

/**
 * Future transactions that touch an ARCHIVED account or envelope. Not a
 * schema violation (the references resolve), so the status badge folds it in
 * with neutral wording, like an unlinked bill.
 *
 * @param {object} input
 * @param {any[]} [input.accounts]
 * @param {any[]} [input.envelopes]
 * @param {any[]} [input.transactions]
 * @param {Date} input.today
 */
export function findFutureRowsOnArchived({ accounts, envelopes, transactions, today }) {
  return futureRowsTouching({
    transactions,
    today,
    accountIds: (accounts || []).filter((a) => a && a.archived).map((a) => a.id),
    envelopeIds: (envelopes || []).filter((e) => e && e.archived).map((e) => e.id),
  });
}
