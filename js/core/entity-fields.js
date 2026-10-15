import { spendingAccount } from '../engine/spending-profile.js';
// js/core/entity-fields.js — what an account, an envelope, a plan item or an
// envelope template may hold, and how a command's `fields` input becomes the
// stored record. The edit forms used to
// carry these rules inline; the account and envelope commands, the CLI flags
// and the AI/MCP schemas now share them (as js/core/tx-fields.js does for
// transactions).

import { round2, slugify, uniqueId } from '../utils.js';
import { spendingByDefault } from '../engine/balances.js';
import { SETTLED_TYPES, canPayCards } from '../engine/card-settlement.js';
import { sinceOnSave, resolvePlanItemAccountId } from './plan-item-rules.js';
import { MONTHS, SCENARIOS, CAT_CHOICES, cutScenariosFor, stressCutPct } from '../engine/stress.js';

export const ACCOUNT_TYPES = Object.freeze(['bank', 'cash', 'credit_card', 'savings', 'investment', 'asset', 'loan', 'loan_given']);

/**
 * The editable account fields. `archived`, the reconcile stamps
 * (`lastReconciledAt`, `lastReconciledBalance`, `lastReconciledLedger`,
 * `lastReconciledStamp`) and
 * `id` are not among them: other commands own those.
 */
export const ACCOUNT_FIELD_PROPERTIES = Object.freeze({
  code: { type: 'string', description: 'Unique four-character short code (A–Z, 0–9); blank generates one automatically' },
  name: { type: 'string' },
  type: { enum: [...ACCOUNT_TYPES] },
  initialBalance: { type: 'money', description: 'Opening balance; for a loan, the amount owed as a negative number (a positive one is refused)' },
  notes: { type: 'string', nullable: true },
  interestTiers: {
    type: 'array', nullable: true, description: 'Savings interest by balance tier; upTo is exclusive; the last tier has no upTo',
    items: { type: 'object', required: ['rate'], properties: { rate: { type: 'number' }, upTo: { type: 'number' } } },
  },
  interestTierMode: {
    enum: ['progressive', 'full-balance'], nullable: true,
    description: 'Savings tier calculation: progressive applies each rate to its portion; full-balance applies the matching rate to the entire balance. Null defaults to progressive',
  },
  interestPayout: { enum: ['monthly', 'quarterly'], nullable: true, description: 'Interest payout; null = yearly' },
  interestRates: {
    type: 'array', nullable: true, description: 'Loan interest rates, each from a date',
    items: { type: 'object', required: ['from', 'rate'], properties: { from: { type: 'date' }, rate: { type: 'number' } } },
  },
  interestDayCount: {
    enum: ['act/365', 'act/360', '30/360'], nullable: true,
    description: 'Loan interest day count (engine loanDayCount); act/365 is the default, stored as no key',
  },
  loanStart: { type: 'date', nullable: true },
  loanEnd: { type: 'date', nullable: true },
  trackInvestments: { type: 'boolean', nullable: true },
  pensionInsurance: { type: 'boolean', nullable: true },
  taxWrapped: { type: 'boolean', nullable: true },
  spending: { type: 'boolean', nullable: true },
  crisisCash: { type: 'boolean', nullable: true },
  group: { type: 'string', nullable: true },
  favorite: { type: 'boolean' },
  expectedGrowth: { type: 'number', nullable: true },
  plannedMonthly: { type: 'number', nullable: true },
  settledFrom: {
    type: 'ref', kind: 'account', nullable: true,
    description: 'Credit card (or a bank or cash account used as a card): the bank, cash or savings account that pays it off in the forecast and the Net worth projection, the previous month-end balance owed paid on the 15th; null = not settled (it accumulates the spending)',
  },
});

// Which account types a field belongs to, exactly as the edit form shows and
// stores it (js/pages/account-edit.js). A field not listed applies to every
// type.
const OFF_BUDGET = new Set(['asset', 'loan', 'loan_given']);
/** @type {Record<string, (type: string) => boolean>} */
const ACCOUNT_FIELD_TYPES = {
  interestTiers: (type) => type === 'savings',
  interestTierMode: (type) => type === 'savings',
  interestPayout: (type) => type === 'savings' || type === 'loan_given',
  trackInvestments: (type) => type === 'investment',
  pensionInsurance: (type) => type === 'investment',
  taxWrapped: (type) => type === 'investment',
  spending: (type) => !OFF_BUDGET.has(type),
  crisisCash: (type) => !OFF_BUDGET.has(type),
  group: (type) => type === 'asset',
  interestRates: (type) => type === 'loan' || type === 'loan_given',
  interestDayCount: (type) => type === 'loan',
  loanStart: (type) => type === 'loan_given',
  loanEnd: (type) => type === 'loan_given',
  settledFrom: (type) => SETTLED_TYPES.includes(type),
};

/**
 * @param {string} field
 * @param {string} type
 * @returns {boolean}
 */
export function accountFieldApplies(field, type) {
  if (!Object.hasOwn(ACCOUNT_FIELD_PROPERTIES, field)) return false;
  const applies = ACCOUNT_FIELD_TYPES[field];
  return applies ? applies(type) : true;
}

/**
 * What to store for an account's `crisisCash` field: `null` when it should
 * be omitted (the default for its type/spending combination applies), or the
 * explicit boolean the user chose. Crisis-cash is irrelevant for a spending
 * account (already always counted) and for an asset account (off-budget),
 * and otherwise only needs storing when it differs from the type's default
 * (`savings` defaults to true, everything else to false).
 * Moved from js/pages/account-edit-rules.js, which re-exports it.
 *
 * @param {{ isAsset: boolean, spending: boolean, crisisChecked: boolean, type: string }} args
 * @returns {boolean | null}
 */
export function crisisCashToStore({ isAsset, spending, crisisChecked, type }) {
  if (isAsset || spending) return null;
  if (crisisChecked === (type === 'savings')) return null;
  return crisisChecked;
}

const LOAN_TYPES = new Set(['loan', 'loan_given']);

/**
 * The account with `fields` applied: a given field is set, `null` deletes it
 * (and so does `''` for notes).
 *
 * With `type` among `fields` (the edit form always sends it), the whole
 * record is cleaned up: every field that does not belong to the resulting
 * type is dropped, as the form's `else delete` does, along with the legacy
 * `interestFirstMonth` (superseded by the dated rates), and every value is
 * normalised as below. Without `type` (the favourite star, the net-worth
 * growth and contribution edits), only the given keys are touched: each is
 * dropped if it does not belong to the type and normalised on its own, with
 * the fields derived from it (the payout from the tiers and rates, which also
 * supersede a legacy loan's tiers; `crisisCash` from `spending`). Every other
 * key stays exactly as stored.
 *
 * The values are stored as the edit form stores them
 * (js/pages/account-edit.js, Save), so a CLI or AI write and a form save give
 * the same record: empty tier and rate lists and a blank group are deleted;
 * the payout only stays beside tiers (savings) or rates (loan given);
 * `interestDayCount` only when it is not the default `act/365`;
 * `trackInvestments` is stored only as false, `pensionInsurance` and
 * `taxWrapped` only as true; `spending` only when it differs from the type's
 * default, and `crisisCash` as `crisisCashToStore` says.
 *
 * A loan set up before rates had dates carries savings-style tiers. The form
 * offers that rate as the first dated row and so replaces the tiers on save;
 * here the tiers stay until `interestRates` is given, so an update of another
 * field does not lose the rate.
 *
 * @param {Record<string, any>} account
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
export function applyAccountFields(account, fields) {
  /** @type {Record<string, any>} */
  const out = { ...account };
  const given = Object.keys(fields || {}).filter(key => Object.hasOwn(ACCOUNT_FIELD_PROPERTIES, key));
  for (const key of given) {
    const v = fields[key];
    if (v === null || (key === 'notes' && v === '')) delete out[key];
    else out[key] = v;
  }
  const sweep = given.includes('type');
  // The keys this update normalises: every field with a type, else the given
  // ones and the fields derived from them.
  const touched = new Set(sweep ? Object.keys(ACCOUNT_FIELD_PROPERTIES) : given);
  if (touched.has('interestTiers') || touched.has('interestRates')) touched.add('interestPayout');
  if (touched.has('interestRates')) touched.add('interestTiers');
  if (touched.has('spending')) touched.add('crisisCash');
  for (const key of touched) {
    if (!accountFieldApplies(key, out.type)) delete out[key];
  }
  if (sweep) delete out.interestFirstMonth;

  const legacyTiers = LOAN_TYPES.has(account?.type) && LOAN_TYPES.has(out.type)
    && !Object.hasOwn(fields || {}, 'interestRates')
    && Array.isArray(account.interestTiers) && account.interestTiers.length > 0;
  if (legacyTiers && touched.has('interestTiers')) out.interestTiers = account.interestTiers;

  const norm = (key) => touched.has(key);
  if (norm('interestTiers') && Array.isArray(out.interestTiers) && out.interestTiers.length === 0) delete out.interestTiers;
  if (norm('interestRates') && Array.isArray(out.interestRates) && out.interestRates.length === 0) delete out.interestRates;
  if (norm('group') && Object.hasOwn(out, 'group') && (typeof out.group !== 'string' || !out.group.trim())) delete out.group;
  const rated = out.type === 'savings' ? Boolean(out.interestTiers) : Boolean(out.interestRates) || legacyTiers;
  if (norm('interestPayout') && (out.interestPayout === 'yearly' || !rated)) delete out.interestPayout;
  if (norm('interestDayCount') && out.interestDayCount !== 'act/360' && out.interestDayCount !== '30/360') delete out.interestDayCount;
  if (norm('trackInvestments') && out.trackInvestments !== false) delete out.trackInvestments;
  if (norm('pensionInsurance') && out.pensionInsurance !== true) delete out.pensionInsurance;
  if (norm('taxWrapped') && out.taxWrapped !== true) delete out.taxWrapped;
  if (norm('spending') && (typeof out.spending !== 'boolean' || out.spending === spendingByDefault(out.type))) delete out.spending;
  if (norm('crisisCash') && Object.hasOwn(out, 'crisisCash')) {
    const store = typeof out.crisisCash === 'boolean'
      ? crisisCashToStore({
        isAsset: OFF_BUDGET.has(out.type),
        spending: typeof out.spending === 'boolean' ? out.spending : spendingByDefault(out.type),
        crisisChecked: out.crisisCash,
        type: out.type,
      })
      : null;
    if (store === null) delete out.crisisCash;
    else out.crisisCash = store;
  }
  return out;
}

/**
 * The form's cross-field rules for a finished account record: a loan end
 * before its start is refused, and a loan given with interest needs a start
 * date to count its cycle from, and a loan's opening balance is what is owed,
 * so it is stored negative (or zero); a positive one is refused rather than
 * flipped. A `settledFrom` account must be another, live bank, cash or
 * savings account (`accounts` is the budget's list; its existence is the
 * schema's ref check). Paths are field names; a command prefixes
 * them with where the fields sit in its input.
 *
 * @param {Record<string, any>} account
 * @param {any[]} [accounts]
 * @returns {{ path: string, message: string }[]}
 */
export function accountRuleErrors(account, accounts = []) {
  const errors = [];
  if (typeof account.settledFrom === 'string' && account.settledFrom) {
    const payer = (accounts || []).find(a => a && a.id === account.settledFrom);
    if (account.settledFrom === account.id) errors.push({ path: 'settledFrom', message: 'must be another account' });
    else if (payer?.archived) errors.push({ path: 'settledFrom', message: 'must not be an archived account' });
    else if (payer && !canPayCards(payer)) errors.push({ path: 'settledFrom', message: 'must be a bank, cash or savings account' });
  }
  if (account.loanStart && account.loanEnd && account.loanEnd < account.loanStart) {
    errors.push({ path: 'loanEnd', message: 'must not be before loanStart' });
  }
  if (account.type === 'loan_given' && Array.isArray(account.interestRates) && account.interestRates.length && !account.loanStart) {
    errors.push({ path: 'loanStart', message: 'is required when a loan given has interest rates' });
  }
  if (account.type === 'loan' && Number(account.initialBalance) > 0) {
    errors.push({ path: 'initialBalance', message: 'must be zero or negative for a loan (the amount owed is negative)' });
  }
  return errors;
}

/**
 * `fields` with the free-text values trimmed (name, notes, group), as the
 * form trims them before storing. The apply helpers store what they are given.
 *
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
export function trimAccountText(fields) {
  /** @type {Record<string, any>} */
  const out = { ...fields };
  for (const key of ['name', 'notes', 'group']) {
    if (typeof out[key] === 'string') out[key] = out[key].trim();
  }
  return out;
}

// Percentages are an explicit forecast assumption, not allocation or a transfer.
export function checkForecastShares(fields, accounts) {
  const shares = fields.forecast_account_shares;
  if (shares == null) return null;
  const ids = new Set();
  let total = 0;
  for (const share of shares) {
    if (ids.has(share.account_id) || !accounts.some(a => a.id === share.account_id && spendingAccount(a))) {
      return { path: 'forecast_account_shares', message: 'Use each active spending account only once' };
    }
    ids.add(share.account_id); total += share.percent;
  }
  if (!shares.length || Math.abs(total - 100) > 0.000001) return { path: 'forecast_account_shares', message: 'Percentages must total 100' };
  return null;
}

export const ENVELOPE_FIELD_PROPERTIES = Object.freeze({
  code: { type: 'string', description: 'Unique four-character short code (A–Z, 0–9); blank generates one automatically' },
  name: { type: 'string' },
  category: { type: 'string' },
  description: { type: 'string' },
  rollover: { enum: ['carry', 'cover-from-unallocated', 'zero-monthly'] },
  spend_flag_exempt: { type: 'boolean' },
  forecast_account_shares: { type: 'array', nullable: true, description: 'Override the historical spending-account mix; percentages must total 100. null restores history.',
    items: { type: 'object', required: ['account_id', 'percent'], properties: {
      account_id: { type: 'ref', kind: 'account' }, percent: { type: 'number', minimum: 0.01, maximum: 100 },
    } } },
  goal_amount: { type: 'money', minimum: 0.01, nullable: true },
  goal_date: { type: 'date', nullable: true },
  favorite: { type: 'boolean' },
});

/**
 * `fields` with the free-text values trimmed (name, category, description), as
 * the envelope form trims them before storing.
 *
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
export function trimEnvelopeText(fields) {
  /** @type {Record<string, any>} */
  const out = { ...fields };
  for (const key of ['name', 'category', 'description']) {
    if (typeof out[key] === 'string') out[key] = out[key].trim();
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The envelope with `fields` applied: a given field is set, `null` deletes it.
 * A given `rollover: 'carry'` is the default and stored as no key, and a given
 * `goal_amount` is rounded to the cent, as the form stores it.
 *
 * `goal_start` is the day the goal was set, so the pace verdict has a real
 * span to measure against. It is stamped once and then left alone (re-stamping
 * would restart the clock on every edit), and only exists alongside a goal
 * amount and date: kept when it is already a valid date, else `todayIso`, when
 * both are set after the update; deleted otherwise. It is re-derived only when
 * `goal_amount` or `goal_date` is given: an update of any other field (the
 * favourite star) leaves a legacy goal without a start as it is.
 *
 * @param {Record<string, any>} envelope
 * @param {Record<string, any>} fields
 * @param {string} todayIso  YYYY-MM-DD, local
 * @returns {Record<string, any>}
 */
export function applyEnvelopeFields(envelope, fields, todayIso) {
  /** @type {Record<string, any>} */
  const out = { ...envelope };
  const given = new Set(Object.keys(fields || {}).filter(key => Object.hasOwn(ENVELOPE_FIELD_PROPERTIES, key)));
  for (const key of given) {
    const v = fields[key];
    if (v === null) delete out[key];
    else out[key] = v;
  }
  if (given.has('rollover') && out.rollover === 'carry') delete out.rollover;
  // The form stores the goal to the cent.
  if (given.has('goal_amount') && typeof out.goal_amount === 'number') out.goal_amount = round2(out.goal_amount);
  if (given.has('goal_amount') || given.has('goal_date')) {
    const existingStart = typeof envelope?.goal_start === 'string' && ISO_DATE.test(envelope.goal_start)
      ? envelope.goal_start
      : null;
    if (out.goal_amount != null && out.goal_date != null) out.goal_start = existingStart || todayIso;
    else delete out.goal_start;
  }
  return out;
}

/**
 * The name rule shared by every entity: trimmed, non-empty, and unique
 * case-insensitively among all rows of that kind, archived ones included.
 * `selfId` is the row being renamed, which may keep its own name.
 *
 * @param {string} kind
 * @param {any[]} rows
 * @param {any} name
 * @param {string | null} [selfId]
 * @returns {null | { code: string, params: Record<string, any> }}
 */
export function checkName(kind, rows, name, selfId = null) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { code: 'bad_input', params: { errors: [{ path: 'name', message: 'must not be empty' }] } };
  const lower = trimmed.toLowerCase();
  const clash = (rows || []).some(r => r && r.id !== selfId
    && typeof r.name === 'string' && r.name.trim().toLowerCase() === lower);
  return clash ? { code: 'name_taken', params: { kind, name: trimmed } } : null;
}

/**
 * @param {any[]} accounts
 * @param {string} name
 * @returns {string}
 */
export function newAccountId(accounts, name) {
  return uniqueId(slugify(name) || 'account', new Set((accounts || []).map(a => a?.id)));
}

/**
 * @param {any[]} envelopes
 * @param {string} category
 * @param {string} name
 * @returns {string}
 */
export function newEnvelopeId(envelopes, category, name) {
  return uniqueId(slugify(`${category}-${name}`) || 'envelope', new Set((envelopes || []).map(e => e?.id)));
}

/**
 * What still references an account, per collection: the page's
 * countAccountRefs (js/pages/account-edit.js), moved here.
 *
 * @param {any} data  BudgetData
 * @param {string} id
 * @returns {{ transactions: number }}
 */
export function accountRefs(data, id) {
  let transactions = 0;
  for (const tx of data?.transactions || []) {
    if (tx.account === id) transactions++;
    if (tx.from_account === id) transactions++;
    if (tx.to_account === id) transactions++;
    if (tx.source_account === id) transactions++;
    if (tx.interest_of === id) transactions++;
    if (tx.type === 'adjustment' && tx.target === 'account' && tx.target_id === id) transactions++;
  }
  return { transactions };
}

/**
 * What still references an envelope, per collection: the page's
 * countEnvelopeRefs (js/pages/envelope-edit.js), moved here.
 *
 * @param {any} data  BudgetData
 * @param {string} id
 * @returns {{ budgetItems: number, transactions: number, envelopeTemplates: number }}
 */
export function envelopeRefs(data, id) {
  let budgetItems = 0;
  for (const it of data?.budgetItems || []) if (it.envelope_id === id) budgetItems++;
  let transactions = 0;
  for (const tx of data?.transactions || []) {
    if (tx.envelope_id === id) transactions++;
    if (tx.from_envelope_id === id) transactions++;
    if (tx.to_envelope_id === id) transactions++;
    if (Array.isArray(tx.lines)) for (const ln of tx.lines) if (ln.envelope_id === id) transactions++;
    // A split expense carries no envelope_id of its own, only its splits.
    if (Array.isArray(tx.envelope_splits)) for (const sp of tx.envelope_splits) if (sp && sp.envelope_id === id) transactions++;
    if (tx.type === 'adjustment' && tx.target === 'envelope' && tx.target_id === id) transactions++;
  }
  // Templates: a manual template's lines, a dynamic template's assignments,
  // and the envelope a schedule draws its fill from.
  let envelopeTemplates = 0;
  for (const tpl of data?.envelopeTemplates || []) {
    for (const ln of [...(tpl?.lines || []), ...(tpl?.assignments || [])]) {
      if (ln && ln.envelope_id === id) envelopeTemplates++;
    }
    if (tpl?.schedule?.source_envelope_id === id) envelopeTemplates++;
  }
  return { budgetItems, transactions, envelopeTemplates };
}

// ── Plan items (budgetItems) ────────────────────────────────────────────────
// The rules of the plan-item editor sheet's save (js/pages/budget-plan-editor.js,
// the submit handler), so a command, the CLI and the AI store the record the
// editor stores.

export const ITEM_KINDS = Object.freeze(['expense', 'income', 'investment_transfer', 'account_transfer', 'loan_payment']);

const YEAR_MONTH = /^\d{4}-\d{2}$/;
const CALENDAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const AMOUNT_LIMIT = 1e12;

const fraction = { type: 'number', minimum: 0, maximum: 1 };
// `false` is a month switched off after a loan's payoff (loan upkeep writes
// it), accepted so a schedule read back can be written back as it is.
const itemMonth = {
  anyOf: [{ enum: [true, false] }, { type: 'money', minimum: 0.01 }],
  description: 'true = the default amount, a custom amount for that month, or false = off',
};

/**
 * The editable plan-item fields. Not among them: `id`; `as_schedule_since`
 * (stamped, see applyItemFields); `skipped_occurrences` (the skip commands);
 * `loan_paid_off` and `loan_months_off` (loan upkeep); `as_schedule_until`
 * and the legacy `template_id`, which nothing edits. An update keeps them.
 */
export const ITEM_FIELD_PROPERTIES = Object.freeze({
  recurring_review: {
    type: 'object', nullable: true, description: 'Optional cost-control reminders; no effect on payment scheduling. Dates are explicit deadlines, not automatic cancellation.',
    properties: {
      review_on: { type: 'date', nullable: true },
      linked_reminder: { type: 'boolean', description: 'One reminder before renewal/end or an earlier cancellation deadline. review_on is used only when no deadline exists. The web editor enables this when saving.' },
      starts_on: { type: 'date', nullable: true, description: 'Informational agreement start date; does not change payment scheduling' },
      continuous: { type: 'boolean', description: 'Agreement runs until further notice. Renewal/end/cancellation deadlines and Plan end fallback are ignored for reminders; review_on may hold an optional review reminder.' },
      cancel_by: { type: 'date', nullable: true },
      renews_on: { type: 'date', nullable: true },
      ends_on: { type: 'date', nullable: true, description: 'Agreement end date; defaults to the plan item end when omitted' },
      reminder_days: { type: 'integer', minimum: 0, maximum: 3650, description: 'Calendar days before renewal, end or cancellation to show an in-app reminder; omitted = 45. Review on is an exact reminder date.' },
      hidden: { type: 'boolean', description: 'Hide from cost tracking and suppress reminders; payments and forecasts are unchanged' },
      category: { type: 'string', nullable: true, description: 'Optional recurring-cost group, e.g. Streaming or Insurance' },
      notes: { type: 'string', nullable: true },
    },
  },
  kind: { enum: [...ITEM_KINDS] },
  envelope_id: { type: 'ref', kind: 'envelope', nullable: true, description: 'Expense envelope; null spends from Unallocated' },
  description: { type: 'string', nullable: true },
  default_amount: { type: 'money', description: 'Any sign: stored positive for income and dividends, negative otherwise' },
  transfer_mode: { enum: ['fixed', 'target_balance'], nullable: true },
  target_balance: { type: 'money', minimum: 0, nullable: true, description: 'Destination balance to top up to; 0 pays off outstanding debt. Never transfers money back.' },
  extra_buffer: { type: 'money', minimum: 0 },
  include: { type: 'boolean' },
  include_in_emergency_budget: { type: 'boolean' },
  payment_day: { type: 'integer', minimum: 0, maximum: 31 },
  stress_category: { enum: [...CAT_CHOICES], nullable: true, description: 'Stress severity; Z = never cut' },
  stress_cut_pct: { ...fraction, description: 'Legacy flat cut, a fraction 0-1' },
  stress_cut_pcts: {
    type: 'object', nullable: true, description: 'Cut per stress scenario, a fraction 0-1',
    properties: Object.fromEntries(SCENARIOS.map(s => [s, fraction])),
  },
  monthly_schedule: {
    type: 'object', description: 'Active months; an inactive month has no key. Omitted on create = every month; an included item needs at least one active month',
    properties: Object.fromEntries(MONTHS.map(m => [m, itemMonth])),
  },
  as_schedule: { type: 'boolean' },
  account_id: { type: 'ref', kind: 'account', nullable: true },
  schedule_day_type: { enum: ['exact', 'next_work_day', 'prev_work_day'] },
  investment_account_id: { type: 'ref', kind: 'account', nullable: true },
  symbol: { type: 'string', nullable: true },
  direction: { enum: ['buy', 'dividend'], nullable: true },
  to_account_id: { type: 'ref', kind: 'account', nullable: true },
  loan_fee: { type: 'money', minimum: 0, nullable: true },
  loan_method: { enum: ['annuity', 'equal_principal'], nullable: true, description: 'null = a fixed payment' },
  loan_end: { type: 'string', nullable: true, description: 'Last payment month, YYYY-MM' },
  funding_style: { enum: ['bill', 'spending'], nullable: true },
  start_month: { type: 'string', nullable: true, description: 'First month the item applies, YYYY-MM; empty = no start' },
  end_month: { type: 'string', nullable: true, description: 'Last month the item applies (inclusive), YYYY-MM; empty = no end' },
});

const isLoanKind = (/** @type {string} */ kind) => kind === 'loan_payment';
const notTransferOrLoan = (/** @type {string} */ kind) => kind !== 'account_transfer' && kind !== 'loan_payment';
/** @type {Record<string, (kind: string) => boolean>} */
const ITEM_FIELD_KINDS = {
  envelope_id: (kind) => kind !== 'account_transfer',
  extra_buffer: (kind) => kind !== 'account_transfer',
  include_in_emergency_budget: (kind) => kind === 'expense' || kind === 'loan_payment',
  stress_category: notTransferOrLoan,
  stress_cut_pct: notTransferOrLoan,
  stress_cut_pcts: notTransferOrLoan,
  investment_account_id: (kind) => kind === 'investment_transfer',
  symbol: (kind) => kind === 'investment_transfer',
  direction: (kind) => kind === 'investment_transfer',
  to_account_id: (kind) => kind === 'account_transfer' || kind === 'loan_payment',
  transfer_mode: (kind) => kind === 'account_transfer',
  target_balance: (kind) => kind === 'account_transfer',
  loan_fee: isLoanKind,
  loan_method: isLoanKind,
  loan_end: isLoanKind,
  funding_style: (kind) => kind === 'expense' || kind === 'loan_payment',
  // A loan payment's span is the loan's (loan_end, the payoff, loan upkeep).
  start_month: (kind) => !isLoanKind(kind),
  end_month: (kind) => !isLoanKind(kind),
};

// What the editor stores for a field that does not apply to the kind:
// `undefined` means the key is deleted.
/** @type {Record<string, any>} */
const ITEM_FIELD_OFF = {
  envelope_id: null,
  extra_buffer: 0,
  include_in_emergency_budget: false,
  stress_category: null,
  stress_cut_pct: 0,
  stress_cut_pcts: undefined,
  investment_account_id: null,
  symbol: null,
  direction: null,
  to_account_id: null,
  loan_fee: undefined,
  loan_method: undefined,
  loan_end: undefined,
  funding_style: undefined,
  start_month: undefined,
  end_month: undefined,
};

// A `null` in `fields` deletes these keys, as the editor does; every other
// nullable field is stored as an explicit null, again as the editor stores it.
const ITEM_NULL_DELETES = new Set(['transfer_mode', 'target_balance', 'stress_cut_pcts', 'loan_fee', 'loan_method', 'loan_end', 'funding_style']);

/**
 * Whether a field may hold a value of its own for a kind, as the editor sheet
 * shows and stores it. A field that does not apply is stored as the editor's
 * off value (null, 0, false, or no key): `extra_buffer` is 0 and
 * `envelope_id` null for a transfer, and `include_in_emergency_budget` is
 * false except for an expense or a loan payment.
 *
 * @param {string} field
 * @param {string} kind
 * @returns {boolean}
 */
export function itemFieldApplies(field, kind) {
  if (!Object.hasOwn(ITEM_FIELD_PROPERTIES, field)) return false;
  const applies = ITEM_FIELD_KINDS[field];
  return applies ? applies(kind) : true;
}

/**
 * The kind as the editor reads a stored item (budget-plan-editor.js:53): a
 * missing or unknown kind is an expense.
 * @param {any} item
 * @returns {string}
 */
const itemKind = (item) => (ITEM_KINDS.includes(item?.kind) ? item.kind : 'expense');

/** @param {any} item */
const positiveAmountKind = (item) => itemKind(item) === 'income'
  || (itemKind(item) === 'investment_transfer' && item.direction === 'dividend');

/**
 * The plan item with `fields` applied, normalised as the editor sheet's save
 * normalises it (js/pages/budget-plan-editor.js), so a command, the CLI and
 * the AI store the record the editor stores:
 *
 * - a given field is set; `null` deletes `loan_fee`, `loan_method`,
 *   `loan_end`, `funding_style` and `stress_cut_pcts`, and is stored as null
 *   for the others, as the editor stores them;
 * - `default_amount` is positive for income and a dividend, negative for
 *   everything else, whatever sign it is given in;
 * - `description` is trimmed (blank is null); `symbol` is trimmed and
 *   uppercased (blank is null); `loan_fee` is rounded to the cent and deleted
 *   when 0; `direction` of an investment is 'dividend' or 'buy';
 * - an account transfer and a loan payment always post on a schedule;
 * - `schedule_day_type` is 'exact' when the item does not post on a schedule;
 * - `loan_method` and `loan_end` are deleted for a fixed payment (no method);
 * - `loan_months_off` is pruned to the months still off;
 * - with `kind` given, the legacy `loan_rate` is deleted (rates now come
 *   from the loan account); a live control's edit leaves it, as the engine
 *   still falls back to it;
 * - a stress category of none or 'Z' clears the cuts;
 * - `account_id` follows resolvePlanItemAccountId;
 * - `as_schedule_since` follows sinceOnSave, from `prev` (null for a new
 *   item) and `todayIso`.
 *
 * With `kind` among `fields` (the editor always sends it), the whole record
 * is normalised: every field that does not apply to the kind gets its off
 * value, a non-loan drops `loan_months_off` and `loan_paid_off`, and the
 * stress cuts are rebuilt for the category's scenarios. Without `kind` (the
 * Plan and Stress pages' live controls), only the given keys and the fields
 * derived from them are touched: the sign from `direction`, `account_id`,
 * `schedule_day_type` and `as_schedule_since` from `as_schedule`, the stamp
 * from `include`, the cuts from a cleared category, and `loan_months_off`
 * from `monthly_schedule`. Every other key stays exactly as stored.
 *
 * @param {Record<string, any>} item
 * @param {Record<string, any>} fields
 * @param {{ todayIso: string, prev: Record<string, any> | null }} opts
 * @returns {Record<string, any>}
 */
export function applyItemFields(item, fields, { todayIso, prev }) {
  /** @type {Record<string, any>} */
  const out = { ...item };
  const given = Object.keys(fields || {}).filter(key => Object.hasOwn(ITEM_FIELD_PROPERTIES, key));
  for (const key of given) {
    const v = fields[key];
    if (v === null && ITEM_NULL_DELETES.has(key)) delete out[key];
    else if (v !== null && typeof v === 'object') out[key] = structuredClone(v);
    else out[key] = v;
  }
  const sweep = given.includes('kind');
  const touched = new Set(sweep ? Object.keys(ITEM_FIELD_PROPERTIES) : given);
  if (touched.has('direction')) touched.add('default_amount');
  if (touched.has('as_schedule')) { touched.add('account_id'); touched.add('schedule_day_type'); }
  const kind = itemKind(out);

  // Fields that do not apply to the kind take the editor's off value.
  for (const key of touched) {
    if (!Object.hasOwn(ITEM_FIELD_KINDS, key) || itemFieldApplies(key, kind)) continue;
    if (ITEM_FIELD_OFF[key] === undefined) delete out[key];
    else out[key] = ITEM_FIELD_OFF[key];
  }
  if (sweep && !isLoanKind(kind)) {
    delete out.loan_months_off;
    delete out.loan_paid_off;
  }
  if (sweep) delete out.loan_rate;

  // The form's empty values: a blank picker is null, a blank number 0, and
  // only an explicit `include: false` is disabled.
  for (const key of ['envelope_id', 'account_id', 'investment_account_id', 'to_account_id']) {
    if (touched.has(key) && itemFieldApplies(key, kind)) out[key] = out[key] || null;
  }
  if (touched.has('extra_buffer') && itemFieldApplies('extra_buffer', kind)) out.extra_buffer = Number(out.extra_buffer) || 0;
  if (touched.has('payment_day')) out.payment_day = Number.isInteger(out.payment_day) ? out.payment_day : 0;
  if (touched.has('include')) out.include = out.include !== false;
  if (touched.has('include_in_emergency_budget')) out.include_in_emergency_budget = out.include_in_emergency_budget === true;
  if (touched.has('as_schedule')) out.as_schedule = out.as_schedule === true;
  if (touched.has('monthly_schedule') && (!out.monthly_schedule || typeof out.monthly_schedule !== 'object')) out.monthly_schedule = {};
  for (const key of ['start_month', 'end_month']) {
    if (touched.has(key) && itemFieldApplies(key, kind) && Object.hasOwn(out, key)) {
      out[key] = typeof out[key] === 'string' && out[key].trim() ? out[key].trim() : null;
    }
  }
  // An end month given replaces the legacy end date nothing else edits.
  if (given.includes('end_month')) delete out.as_schedule_until;
  if (touched.has('description')) {
    out.description = typeof out.description === 'string' ? (out.description.trim() || null) : null;
  }
  if (touched.has('direction') && kind === 'investment_transfer') {
    out.direction = out.direction === 'dividend' ? 'dividend' : 'buy';
  }
  if (touched.has('symbol') && kind === 'investment_transfer') {
    out.symbol = typeof out.symbol === 'string' && out.symbol.trim() ? out.symbol.trim().toUpperCase() : null;
  }
  if (touched.has('default_amount')) {
    const magnitude = Math.abs(Number(out.default_amount) || 0);
    out.default_amount = positiveAmountKind(out) ? magnitude : -magnitude;
  }
  if (kind === 'account_transfer' && out.transfer_mode === 'target_balance') {
    out.default_amount = 0;
    // Target amounts are not per-month fixed payments; retain active months only.
    out.monthly_schedule = Object.fromEntries(Object.entries(out.monthly_schedule || {})
      .filter(([, v]) => v === true || (typeof v === 'number' && v !== 0)).map(([m]) => [m, true]));
  } else if (touched.has('transfer_mode') || sweep) {
    delete out.target_balance;
    if (out.transfer_mode === 'fixed') delete out.transfer_mode;
  }
  if (touched.has('loan_fee') && isLoanKind(kind)) {
    if (typeof out.loan_fee === 'number' && out.loan_fee) out.loan_fee = Math.round(out.loan_fee * 100) / 100;
    else delete out.loan_fee;
  }
  if ((touched.has('loan_method') || touched.has('loan_end')) && isLoanKind(kind) && !out.loan_method) {
    delete out.loan_method;
    delete out.loan_end;
  }

  // Stress: no category (or 'Z', never cut) carries no cut. With the kind,
  // the map is rebuilt for the scenarios the category hits, as the editor's
  // buildStressCutsForSave does.
  if (itemFieldApplies('stress_category', kind)) {
    const cat = out.stress_category;
    const cutting = SCENARIOS.includes(cat);
    if (touched.has('stress_category') && !cutting) {
      out.stress_cut_pct = 0;
      delete out.stress_cut_pcts;
    } else if (sweep) {
      out.stress_cut_pct = out.stress_cut_pct ?? 0;
      const draft = { stress_category: cat, stress_cut_pct: out.stress_cut_pct, stress_cut_pcts: out.stress_cut_pcts };
      /** @type {Record<string, number>} */
      const cuts = {};
      for (const s of cutScenariosFor(draft)) cuts[s] = stressCutPct(draft, s);
      if (Object.keys(cuts).length) out.stress_cut_pcts = cuts;
      else delete out.stress_cut_pcts;
    }
  }

  if (touched.has('as_schedule') && (kind === 'account_transfer' || isLoanKind(kind))) out.as_schedule = true;
  const asSchedule = out.as_schedule === true;
  if (touched.has('schedule_day_type')) out.schedule_day_type = asSchedule ? (out.schedule_day_type || 'exact') : 'exact';
  if (touched.has('account_id')) out.account_id = resolvePlanItemAccountId(kind, asSchedule, out.account_id || null);
  if (touched.has('as_schedule') || touched.has('include')) {
    // The previous kind read as the editor reads it, so a kindless legacy
    // item is not taken for a kind change.
    const prevItem = prev ? { ...prev, kind: itemKind(prev) } : null;
    const since = sinceOnSave({ prevItem, nextInclude: out.include, nextKind: kind, asSchedule, today: todayIso });
    // A single-field update leaves a legacy item without the key as it is.
    if (sweep || since !== null || out.as_schedule_since != null) out.as_schedule_since = since;
  }

  // Months switched off after a payoff stay on record only while still off.
  if ((sweep || touched.has('monthly_schedule')) && out.loan_months_off && typeof out.loan_months_off === 'object') {
    const schedule = out.monthly_schedule || {};
    const still = Object.entries(out.loan_months_off).filter(([m]) => !schedule[m]);
    if (still.length) out.loan_months_off = Object.fromEntries(still);
    else delete out.loan_months_off;
  }
  return out;
}

/**
 * The editor sheet's checks on a finished plan item, plus Budget's `set-item`
 * checks: an amount that is not zero and below 1e12, and references to
 * envelopes and accounts that exist. A stored missing or unknown kind is
 * checked as an expense, as the editor reads it; an unknown kind in a
 * command's input is refused by ITEM_FIELD_PROPERTIES.kind. Paths are field names; a
 * command prefixes them with where the fields sit in its input.
 *
 * @param {Record<string, any>} item
 * @param {any} data  BudgetData
 * @returns {null | { code: string, params: { errors: { path: string, message: string }[] } }}
 */
export function checkItem(item, data) {
  /** @type {{ path: string, message: string }[]} */
  const errors = [];
  const err = (/** @type {string} */ path, /** @type {string} */ message) => {
    if (!errors.some(e => e.path === path && e.message === message)) errors.push({ path, message });
  };
  const kind = itemKind(item);
  const amount = Number(item.default_amount);
  const targetTransfer = kind === 'account_transfer' && item.transfer_mode === 'target_balance';
  if (targetTransfer && !(Number.isFinite(item.target_balance) && item.target_balance >= 0 && item.target_balance < AMOUNT_LIMIT)) {
    err('target_balance', 'must be 0 or more and below 1e12');
  }
  if (!targetTransfer && (!Number.isFinite(amount) || amount === 0)) err('default_amount', 'must not be zero');
  else if (Math.abs(amount) >= AMOUNT_LIMIT) err('default_amount', 'must be below 1e12');

  const isDividend = kind === 'investment_transfer' && item.direction === 'dividend';
  if ((kind === 'loan_payment' || (kind === 'investment_transfer' && !isDividend)) && !item.envelope_id) err('envelope_id', 'is required');
  if (kind === 'investment_transfer') {
    if (!item.investment_account_id) err('investment_account_id', 'is required');
    else if (item.as_schedule === true && item.account_id === item.investment_account_id) {
      err('account_id', 'must differ from investment_account_id');
    }
    if (isDividend && !item.symbol) err('symbol', 'is required for a dividend');
  }
  if (kind === 'account_transfer') {
    if (!item.account_id) err('account_id', 'is required');
    if (!item.to_account_id) err('to_account_id', 'is required');
    if (item.account_id && item.account_id === item.to_account_id) err('to_account_id', 'must differ from account_id');
  }
  if (kind === 'loan_payment') {
    if (!item.to_account_id) err('to_account_id', 'is required');
    if (item.loan_fee != null && !(Number.isFinite(item.loan_fee) && item.loan_fee >= 0)) err('loan_fee', 'must be 0 or more');
    if (item.loan_method && !(typeof item.loan_end === 'string' && YEAR_MONTH.test(item.loan_end))) {
      err('loan_end', 'is required (YYYY-MM) for a calculated loan method');
    }
  }
  for (const key of ['start_month', 'end_month']) {
    const v = item[key];
    if (v != null && !(typeof v === 'string' && CALENDAR_MONTH.test(v))) err(key, 'must be a month, YYYY-MM');
  }
  if (typeof item.start_month === 'string' && typeof item.end_month === 'string'
      && CALENDAR_MONTH.test(item.start_month) && CALENDAR_MONTH.test(item.end_month) && item.end_month < item.start_month) {
    err('end_month', 'must not be before start_month');
  }
  // An included item must be active in at least one month (owner decision
  // 2026-10-05): with none it is in the plan yet never budgeted or posted. A
  // month is active when it is `true` or a non-zero amount; `false` and a
  // missing key are off. An excluded item may keep an empty schedule.
  if (item.include !== false && !hasActiveMonth(item.monthly_schedule)) {
    err('monthly_schedule', 'needs at least one active month while the item is included');
  }
  if (item.as_schedule === true) {
    if (!item.account_id) err('account_id', 'is required');
    const day = item.payment_day;
    if (!Number.isInteger(day) || day < 1 || day > 31) err('payment_day', 'must be 1-31 when posting on a schedule');
  }

  /** @type {[string, string][]} */
  const refs = [['envelope_id', 'envelopes'], ['account_id', 'accounts'], ['investment_account_id', 'accounts'], ['to_account_id', 'accounts']];
  for (const [key, collection] of refs) {
    const id = item[key];
    if (id == null || id === '') continue;
    if (!(data?.[collection] || []).some((/** @type {any} */ r) => r && r.id === id)) {
      err(key, `no ${collection === 'envelopes' ? 'envelope' : 'account'} with id "${id}"`);
    }
  }
  return errors.length ? { code: 'bad_input', params: { errors } } : null;
}

/**
 * Whether a plan item's schedule has an active month: `true` or a non-zero
 * amount (computeAnnual and the posting walk read it so).
 *
 * @param {unknown} schedule
 * @returns {boolean}
 */
export function hasActiveMonth(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const months = /** @type {Record<string, unknown>} */ (schedule);
  return MONTHS.some(m => months[m] === true || (typeof months[m] === 'number' && months[m] !== 0));
}

/**
 * A new plan item's id, as the editor builds it: from 'income', a
 * dividend's symbol, 'transfer', or the envelope id, then `-item`.
 *
 * @param {any[]} items
 * @param {Record<string, any>} item
 * @returns {string}
 */
export function newItemId(items, item) {
  const kind = itemKind(item);
  const base = kind === 'income'
    ? 'income'
    : kind === 'investment_transfer' && item.direction === 'dividend'
      ? `dividend-${item.symbol || ''}`
      : kind === 'account_transfer' ? 'transfer' : item.envelope_id;
  const taken = new Set((items || []).map(it => it?.id));
  return uniqueId(slugify(`${base || 'item'}-item`) || 'item', taken);
}

// ── Envelope templates ──────────────────────────────────────────────────────
// The rules of the template editor sheets (js/pages/templates.js, the manual
// and dynamic submit handlers and the schedule section's getSchedule).

const SCHEDULE_DAY_TYPES = ['exact', 'next_work_day', 'prev_work_day'];
const LINE_MODES = ['add', 'set'];

export const TEMPLATE_FIELD_PROPERTIES = Object.freeze({
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  kind: { enum: ['manual', 'dynamic'] },
  lines: {
    type: 'array', description: 'A manual template: an amount per envelope',
    items: {
      type: 'object', required: ['envelope_id', 'mode', 'amount'],
      properties: {
        envelope_id: { type: 'ref', kind: 'envelope' },
        mode: { enum: LINE_MODES, description: 'add = top up by the amount; set = fill to the amount' },
        amount: { type: 'money', minimum: 0.01 },
      },
    },
  },
  assignments: {
    type: 'array', description: "A dynamic template: a percent of each envelope's monthly plan",
    items: {
      type: 'object', required: ['envelope_id', 'mode', 'percent'],
      properties: {
        envelope_id: { type: 'ref', kind: 'envelope' },
        mode: { enum: LINE_MODES },
        percent: { type: 'number', minimum: 0.01, maximum: 1000 },
      },
    },
  },
  schedule: {
    type: 'object', nullable: true, description: 'Fill on a calendar of its own; null removes it',
    required: ['enabled', 'payment_day', 'months'],
    properties: {
      enabled: { type: 'boolean' },
      payment_day: { type: 'integer', minimum: 1, maximum: 31 },
      day_type: { enum: SCHEDULE_DAY_TYPES },
      months: { type: 'object', properties: Object.fromEntries(MONTHS.map(m => [m, { enum: [true] }])) },
      since: { type: 'date' },
      until: { type: 'date' },
      skipped: { type: 'array', items: { type: 'string', description: 'YYYY-MM' } },
      source_envelope_id: { type: 'ref', kind: 'envelope', nullable: true, description: 'Draw the fill from this envelope' },
      source_since: { type: 'date', nullable: true },
    },
  },
});

/**
 * A schedule as getSchedule stores it: the day clamped to 1-31, the day type
 * defaulted, only the active months, `skipped` kept only as YYYY-MM months
 * and only when there are any, and the source keys only when a source is set.
 * A stored disabled schedule's keys pass through the same way.
 *
 * @param {Record<string, any>} sched
 * @returns {Record<string, any>}
 */
function normaliseTemplateSchedule(sched) {
  /** @type {Record<string, any>} */
  const months = {};
  for (const m of MONTHS) if (sched.months?.[m] === true) months[m] = true;
  /** @type {Record<string, any>} */
  const out = {
    enabled: sched.enabled === true,
    payment_day: Math.min(31, Math.max(1, Math.floor(Number(sched.payment_day) || 1))),
    day_type: SCHEDULE_DAY_TYPES.includes(sched.day_type) ? sched.day_type : 'exact',
    months,
  };
  if (typeof sched.since === 'string' && ISO_DATE.test(sched.since)) out.since = sched.since;
  if (typeof sched.until === 'string' && ISO_DATE.test(sched.until)) out.until = sched.until;
  const skipped = (Array.isArray(sched.skipped) ? sched.skipped : []).filter(k => typeof k === 'string' && YEAR_MONTH.test(k));
  if (skipped.length) out.skipped = skipped;
  if (sched.source_envelope_id) out.source_envelope_id = sched.source_envelope_id;
  if (typeof sched.source_since === 'string' && ISO_DATE.test(sched.source_since)) out.source_since = sched.source_since;
  return out;
}

/**
 * The template with `fields` applied, as the editor sheets build it: the name
 * trimmed; the description trimmed (blank is null); lines with no envelope or
 * an amount of 0 or less dropped, and assignments with a percent of 0 or less;
 * the schedule as getSchedule stores it, and `null` removes it. A given `kind`
 * drops the other kind's list (a manual template has no assignments, a
 * dynamic one no lines). Every other key, including ones the editor does not
 * render, stays as stored.
 *
 * @param {Record<string, any>} tpl
 * @param {Record<string, any>} fields
 * @returns {Record<string, any>}
 */
export function applyTemplateFields(tpl, fields) {
  /** @type {Record<string, any>} */
  const out = { ...tpl };
  const given = new Set(Object.keys(fields || {}).filter(key => Object.hasOwn(TEMPLATE_FIELD_PROPERTIES, key)));
  if (given.has('name')) out.name = typeof fields.name === 'string' ? fields.name.trim() : fields.name;
  if (given.has('description')) out.description = typeof fields.description === 'string' ? (fields.description.trim() || null) : null;
  if (given.has('kind')) {
    out.kind = fields.kind;
    if (fields.kind === 'dynamic') delete out.lines;
    else delete out.assignments;
  }
  if (given.has('lines')) {
    out.lines = (fields.lines || [])
      .map((/** @type {any} */ l) => ({ envelope_id: l.envelope_id, mode: l.mode, amount: Math.abs(Number(l.amount) || 0) }))
      .filter((/** @type {any} */ l) => l.envelope_id && l.amount > 0);
  }
  if (given.has('assignments')) {
    out.assignments = (fields.assignments || [])
      .map((/** @type {any} */ a) => ({ envelope_id: a.envelope_id, mode: a.mode, percent: Math.max(0, Number(a.percent) || 0) }))
      .filter((/** @type {any} */ a) => a.envelope_id && a.percent > 0);
  }
  if (given.has('schedule')) {
    if (fields.schedule == null) delete out.schedule;
    else out.schedule = normaliseTemplateSchedule(fields.schedule);
  }
  return out;
}

/**
 * The editor sheets' checks on a finished template, plus Budget's
 * `set-template` ones:
 * - the name is not blank and, when it changed, not taken (case-insensitive);
 * - at least one line (manual) or assignment (dynamic), one per envelope;
 * - an enabled schedule has a month, an end not before its start, and a
 *   source envelope that is not one of the targets and not archived;
 * - `source_since` needs a source.
 *
 * @param {Record<string, any>} tpl
 * @param {any} data  BudgetData
 * @returns {null | { code: string, params: Record<string, any> }}
 */
export function checkTemplate(tpl, data) {
  const templates = data?.envelopeTemplates || [];
  const stored = templates.find((/** @type {any} */ x) => x && x.id === tpl.id);
  const nameChanged = !stored || stored.name !== tpl.name;
  const nameError = nameChanged
    ? checkName('template', templates, tpl.name, tpl.id)
    : checkName('template', [], tpl.name);
  if (nameError && nameError.code !== 'bad_input') return nameError;

  /** @type {{ path: string, message: string }[]} */
  const errors = [...(nameError?.params.errors ?? [])];
  if (tpl.kind !== 'manual' && tpl.kind !== 'dynamic') errors.push({ path: 'kind', message: 'must be one of: manual, dynamic' });
  const listKey = tpl.kind === 'dynamic' ? 'assignments' : 'lines';
  const list = Array.isArray(tpl[listKey]) ? tpl[listKey] : [];
  if (!list.length) errors.push({ path: listKey, message: `needs at least one ${tpl.kind === 'dynamic' ? 'assignment' : 'line'}` });
  const seen = new Set();
  list.forEach((/** @type {any} */ l, /** @type {number} */ i) => {
    if (seen.has(l.envelope_id)) errors.push({ path: `${listKey}[${i}].envelope_id`, message: 'appears more than once' });
    seen.add(l.envelope_id);
  });

  const sched = tpl.schedule;
  if (sched && sched.enabled === true) {
    if (!Object.values(sched.months || {}).some(Boolean)) errors.push({ path: 'schedule.months', message: 'needs at least one month' });
    if (sched.since && sched.until && sched.until < sched.since) errors.push({ path: 'schedule.until', message: 'must not be before since' });
    const source = sched.source_envelope_id;
    if (source) {
      if (seen.has(source)) errors.push({ path: 'schedule.source_envelope_id', message: 'must not be one of the template\'s envelopes' });
      const env = (data?.envelopes || []).find((/** @type {any} */ e) => e && e.id === source);
      if (env?.archived) errors.push({ path: 'schedule.source_envelope_id', message: 'is archived' });
    }
  }
  if (sched && sched.source_since && !sched.source_envelope_id) {
    errors.push({ path: 'schedule.source_since', message: 'needs source_envelope_id' });
  }
  return errors.length ? { code: 'bad_input', params: { errors } } : null;
}

/**
 * @param {any[]} templates
 * @param {string} name
 * @returns {string}
 */
export function newTemplateId(templates, name) {
  return uniqueId(slugify(name) || 'template', new Set((templates || []).map(x => x?.id)));
}

/**
 * A copy of the template with `monthKey` added to `schedule.skipped` (sorted,
 * deduplicated): the schedule then skips that occurrence. allocation.fill's
 * skipTemplateMonth applies it.
 * @param {any} tpl
 * @param {string} monthKey  YYYY-MM
 */
export function withSkippedMonth(tpl, monthKey) {
  const prev = Array.isArray(tpl.schedule?.skipped) ? tpl.schedule.skipped : [];
  const skipped = [...new Set([...prev, monthKey])].sort();
  return { ...tpl, schedule: { ...tpl.schedule, skipped } };
}

/** Map normalized template list errors back to the caller's original indices. */
export function templateInputErrors(errors, fields) {
  return errors.map(e => {
    const match = /^(lines|assignments)\[(\d+)\](.*)$/.exec(e.path);
    if (!match || !Array.isArray(fields[match[1]])) return e;
    const key = match[1];
    const indices = fields[key].map((row, i) => ({ row, i })).filter(({ row }) =>
      row.envelope_id && (key === 'lines' ? Math.abs(Number(row.amount) || 0) : Math.max(0, Number(row.percent) || 0)) > 0);
    const index = indices[Number(match[2])]?.i;
    return index === undefined ? e : { ...e, path: `${key}[${index}]${match[3]}` };
  });
}
