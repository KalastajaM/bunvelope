// Rule inputs deliberately cannot change financial facts from a statement.
import { validate } from './schema.js';
import { ok, fail } from './result.js';
export const RULE_CONDITION_SCHEMA = { type: 'object', required: ['merchant', 'operator', 'direction'], properties: {
  merchant: { type: 'string' }, operator: { enum: ['equals', 'startsWith', 'contains'] },
  direction: { enum: ['income', 'expense'] }, account: { type: 'ref', kind: 'account' },
  minAmount: { type: 'money', minimum: 0 }, maxAmount: { type: 'money', minimum: 0 },
} };
export const RULE_ACTION_SCHEMA = { type: 'object', properties: {
  payee: { type: 'string' }, envelope: { type: 'ref', kind: 'envelope', nullable: true },
} };
export const RULE_FIELDS = { name: { type: 'string' }, enabled: { type: 'boolean' }, conditions: RULE_CONDITION_SCHEMA, actions: RULE_ACTION_SCHEMA };
export function validateImportRule(data, rule, { allowUnavailable = false } = {}) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return fail('bad_input', { errors: [{ path: 'rule', message: 'needs a rule' }] });
  const { id, ...fields } = rule;
  const checked = validate(fields, { type: 'object', required: ['name', 'conditions', 'actions'], properties: RULE_FIELDS });
  if (!checked.ok) return checked;
  const r = { ...checked.value, name: checked.value.name.trim(), enabled: checked.value.enabled ?? true };
  r.conditions = { ...r.conditions, merchant: r.conditions.merchant.trim() };
  r.actions = { ...r.actions };
  if (r.actions.payee !== undefined) r.actions.payee = r.actions.payee.trim();
  const errors = [];
  const bad = (path, message) => errors.push({ path, message });
  if (!r.name) bad('name', 'needs a name');
  if (!r.conditions.merchant) bad('conditions.merchant', 'needs merchant text');
  if (r.conditions.minAmount > r.conditions.maxAmount) bad('conditions.maxAmount', 'must be at least the minimum');
  if (!Object.keys(r.actions).length) bad('actions', 'needs a naming or envelope action');
  if (r.actions.payee === '') bad('actions.payee', 'needs a payee name');
  if (!allowUnavailable) {
    for (const [path, value, rows] of [['conditions.account', r.conditions.account, data.accounts], ['actions.envelope', r.actions.envelope, data.envelopes]]) {
      if (value != null && !(rows || []).some(x => x.id === value && !x.archived)) bad(path, 'reference is missing or archived');
    }
  }
  return errors.length ? fail('bad_input', { errors }) : ok({ ...(id !== undefined ? { id } : {}), ...r });
}
