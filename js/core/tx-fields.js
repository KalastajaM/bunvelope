// js/core/tx-fields.js — what a transaction row of each type may hold, and
// how a command's input becomes row fields. The add and edit forms used to
// carry these rules inline; every command and every surface now shares them.

import { validateTxSplits } from '../engine/insights.js';
import { round2 } from '../utils.js';

export const TX_TYPES_RECORDABLE = Object.freeze(['expense', 'income', 'account_transfer', 'envelope_transfer', 'investment_transfer', 'debt_payment']);

export const TYPE_FIELDS = Object.freeze({
  expense: ['account', 'envelope_id', 'envelope_splits', 'budget_item_id'],
  income: ['account', 'envelope_id', 'interest_of'],
  account_transfer: ['from_account', 'to_account'],
  envelope_transfer: ['from_envelope_id', 'to_envelope_id'],
  investment_transfer: ['direction', 'from_account', 'to_account', 'envelope_id', 'fee', 'units', 'pricePerUnit', 'symbol'],
  debt_payment: ['from_account', 'to_account', 'envelope_id'],
  adjustment: ['target', 'target_id'],
});
const SPECIFIC = new Set(Object.values(TYPE_FIELDS).flat());

// Input key → row field. `keepNull`: an explicit null is stored (meaning
// "none"), not a deletion.
/** @type {Readonly<Record<string, { field: string, keepNull?: boolean }>>} */
export const INPUT_FIELDS = Object.freeze({
  account: { field: 'account' },
  envelope: { field: 'envelope_id', keepNull: true },
  budgetItem: { field: 'budget_item_id' },
  interestOf: { field: 'interest_of' },
  fromAccount: { field: 'from_account' },
  toAccount: { field: 'to_account' },
  fromEnvelope: { field: 'from_envelope_id', keepNull: true },
  toEnvelope: { field: 'to_envelope_id', keepNull: true },
  direction: { field: 'direction' },
  units: { field: 'units' },
  pricePerUnit: { field: 'pricePerUnit' },
  fee: { field: 'fee' },
  symbol: { field: 'symbol' },
  payee: { field: 'payee' },
  note: { field: 'note', keepNull: true },
  date: { field: 'date' },
  amount: { field: 'amount' },
  fromBudget: { field: 'from_budget' },
  source: { field: 'source' },
  cleared: { field: 'cleared' },
  flagged: { field: 'flagged' },
});

/** Schema properties shared by transaction.record and transaction.amend. */
export const TX_INPUT_PROPERTIES = Object.freeze({
  amount: { type: 'money', minimum: 0.01, description: 'Amount, a positive magnitude' },
  date: { type: 'date', description: 'Date, YYYY-MM-DD (default today)' },
  payee: { type: 'string' },
  note: { type: 'string', nullable: true },
  account: { type: 'ref', kind: 'account', description: 'Account (expense, income)' },
  // `__none__` is the deliberate "No envelope (correction)" choice, stored as is
  // (see js/ui/unassigned.js); splits may not use it.
  envelope: { type: 'ref', kind: 'envelope', nullable: true, allow: ['__none__'], description: 'Envelope; null = unassigned, __none__ = deliberately none' },
  splits: {
    type: 'array', nullable: true, description: 'Expense split over envelopes (2 or more)',
    items: {
      type: 'object', required: ['envelope', 'amount'],
      properties: {
        envelope: { type: 'ref', kind: 'envelope' },
        amount: { type: 'money' },
        budgetItem: { type: 'ref', kind: 'budgetItem', nullable: true, description: 'Plan item this line pays (an item of its envelope)' },
      },
    },
  },
  budgetItem: { type: 'ref', kind: 'budgetItem', nullable: true, description: 'Plan item this expense pays (expense)' },
  interestOf: { type: 'ref', kind: 'account', nullable: true, description: 'Loan given this income is interest on (income; a loan_given account). Counts as interest received in its terms' },
  fromAccount: { type: 'ref', kind: 'account' },
  toAccount: { type: 'ref', kind: 'account' },
  fromEnvelope: { type: 'ref', kind: 'envelope', nullable: true, description: 'Envelope; null = unallocated' },
  toEnvelope: { type: 'ref', kind: 'envelope', nullable: true, description: 'Envelope; null = unallocated' },
  direction: { enum: ['buy', 'sell', 'dividend'] },
  units: { type: 'number', minimum: 0, nullable: true },
  pricePerUnit: { type: 'number', minimum: 0, nullable: true },
  fee: { type: 'number', minimum: 0, nullable: true },
  symbol: { type: 'string', nullable: true },
  fromBudget: { type: 'string', nullable: true, description: 'Plan occurrence key this row settles (item:YYYY-MM)' },
  source: { type: 'string' },
  cleared: { type: 'boolean' },
  force: { type: 'boolean', description: 'Bypass the strict-ledger history and future-date rules' },
});

// Investment extras are stored only when positive, rounded as the add form
// rounds them (fee 2 dp, units 6 dp, price per unit 5 dp). Anything else
// deletes the field.
const EXTRA_DECIMALS = Object.freeze({ fee: 100, units: 1e6, pricePerUnit: 1e5 });

/**
 * @param {Record<string, any>} row
 * @param {Record<string, any>} input
 */
export function applyTxInput(row, input) {
  /** @type {Record<string, any>} */
  const out = { ...row };
  for (const [key, spec] of Object.entries(INPUT_FIELDS)) {
    if (!Object.hasOwn(input, key)) continue;
    let v = input[key];
    if (v === null && !spec.keepNull) { delete out[spec.field]; continue; }
    if (key in EXTRA_DECIMALS) {
      const scale = EXTRA_DECIMALS[key];
      const r = Math.round(Number(v) * scale) / scale;
      if (!(r > 0)) { delete out[spec.field]; continue; }
      v = r;
    } else if (key === 'amount') {
      v = round2(Number(v));
    } else if (key === 'symbol' && typeof v === 'string') {
      v = v.trim().toUpperCase();
      if (!v) { delete out[spec.field]; continue; }
    } else if (key === 'payee' && typeof v === 'string') {
      v = v.trim();
    } else if (key === 'note' && typeof v === 'string') {
      v = v.trim() || null;
    }
    out[spec.field] = v;
  }
  if (Object.hasOwn(input, 'splits')) {
    if (input.splits === null) delete out.envelope_splits;
    else {
      out.envelope_splits = input.splits.map(s => ({
        envelope_id: s.envelope, amount: s.amount,
        ...(typeof s.budgetItem === 'string' && s.budgetItem ? { budget_item_id: s.budgetItem } : {}),
      }));
      out.envelope_id = null;
      delete out.budget_item_id;
    }
  }
  if (out.type === 'investment_transfer' && out.direction === 'dividend') {
    delete out.fee; delete out.units; delete out.pricePerUnit;
  }
  return out;
}

const DEFAULT_NULL_ENVELOPE = new Set(['expense', 'income', 'investment_transfer', 'debt_payment']);

/**
 * The envelope keys a row of this type always carries, null meaning "none".
 * Shared by transaction.record (a fresh row) and transaction.amend (a type
 * change), so the two stay in step. Keys the row already has are kept.
 * @param {Record<string, any>} row
 */
export function defaultTypeFields(row) {
  /** @type {Record<string, any>} */
  const out = { ...row };
  if (DEFAULT_NULL_ENVELOPE.has(out.type) && !Object.hasOwn(out, 'envelope_id')) out.envelope_id = null;
  if (out.type === 'envelope_transfer') {
    if (!Object.hasOwn(out, 'from_envelope_id')) out.from_envelope_id = null;
    if (!Object.hasOwn(out, 'to_envelope_id')) out.to_envelope_id = null;
  }
  return out;
}

/** Drop the fields specific to other types (a type change in transaction.amend). */
export function stripForeignFields(row) {
  const own = new Set(TYPE_FIELDS[row.type] || []);
  /** @type {Record<string, any>} */
  const out = { ...row };
  for (const f of SPECIFIC) if (!own.has(f)) delete out[f];
  return out;
}

/**
 * The checks that need the budget: an income row's `interest_of` must name a
 * loan given (the schema has already checked that the account exists).
 *
 * @param {Record<string, any>} row
 * @param {{ accounts?: any[] }} data
 * @returns {{ code: string, params: Record<string, any> } | null}
 */
export function checkTxLinks(row, data) {
  if (typeof row.interest_of === 'string' && row.interest_of) {
    const acct = (data?.accounts || []).find(a => a && a.id === row.interest_of);
    if (!acct || acct.type !== 'loan_given') {
      return { code: 'bad_input', params: { errors: [{ path: 'interestOf', message: 'must be a loan given account' }] } };
    }
  }
  return null;
}

/** @param {Record<string, any>} row @returns {{ code: string, params: Record<string, any> } | null} */
export function checkTxRow(row) {
  const err = (code, params = {}) => ({ code, params });
  const own = new Set(TYPE_FIELDS[row.type] || []);
  for (const f of SPECIFIC) {
    if (!own.has(f) && Object.hasOwn(row, f)) return err('field_not_allowed', { field: f, type: row.type });
  }
  if (row.type === 'adjustment') {
    if (!row.target) return err('field_required', { field: 'target' });
    if (!row.target_id) return err('field_required', { field: 'target_id' });
  }
  if ((row.type === 'expense' || row.type === 'income') && !row.account) return err('field_required', { field: 'account' });
  if (['account_transfer', 'investment_transfer', 'debt_payment'].includes(row.type)) {
    if (!row.from_account) return err('field_required', { field: 'from_account' });
    if (!row.to_account) return err('field_required', { field: 'to_account' });
    if (row.from_account === row.to_account) return err('same_account');
  }
  if (row.type === 'envelope_transfer' && (row.from_envelope_id ?? null) === (row.to_envelope_id ?? null)) return err('same_envelope');
  if (row.type === 'investment_transfer') {
    if (!row.direction) return err('field_required', { field: 'direction' });
    if (row.direction === 'sell' && !(Number(row.units) > 0)) return err('sell_needs_units');
  }
  if (Array.isArray(row.envelope_splits) && row.envelope_splits.length < 2) return err('split_invalid', { problems: ['tooFewSplits'] });
  const problems = validateTxSplits(row);
  if (problems.length) return err('split_invalid', { problems: problems.map(p => p.code) });
  return null;
}
