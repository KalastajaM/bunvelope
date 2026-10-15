import { deepEqual } from './diff.js';
import { txAbsAmount, txAccountDelta } from '../engine/tx-amounts.js';
import { fillDisplayTotal } from '../engine/scheduling.js';
import { txEnvelopeEffect } from '../engine/balances.js';

const refs = {
  account: 'accounts', account_id: 'accounts', from_account: 'accounts', to_account: 'accounts',
  investment_account_id: 'accounts', to_account_id: 'accounts', repayment_account: 'accounts', source_account: 'accounts',
  envelope_id: 'envelopes', from_envelope_id: 'envelopes', to_envelope_id: 'envelopes', template_id: 'envelopeTemplates',
};
const moneyFields = new Set(['amount', 'initialBalance', 'default_amount', 'extra_buffer', 'goal_amount', 'set_target', 'price', 'costBasis', 'avgCost']);
const nameOf = row => row.name || row.description || row.payee || row.id;
function valueOf(value, key, data, parent) {
  if (value == null) return null;
  if (key === 'target_id') return data[parent?.target === 'account' ? 'accounts' : 'envelopes']?.find(r => r.id === value)?.name || value;
  if (refs[key]) return data[refs[key]]?.find(r => r.id === value)?.name || value;
  return value;
}

// Scalar fields form a readable before/after table, including nested schedules
// and template lines. Never expose an object as an opaque JSON string.
function detailsOf(a, b, before, after, path = [], result = [], parentA, parentB) {
  if (deepEqual(a, b)) return result;
  if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
    for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      if (key === 'id' || key === 'updated_at' || key === 'created_at') continue;
      detailsOf(a?.[key], b?.[key], before, after, [...path, key], result, a, b);
    }
  } else {
    const key = path.at(-1);
    const price = key === 'price' || key === 'avgCost';
    result.push({ path, before: valueOf(a, key, before, parentA), after: valueOf(b, key, after, parentB),
      format: price ? 'price' : moneyFields.has(key) ? 'money' : 'text',
      ...(price ? { beforeCurrency: parentA?.currency || before.meta.currency, afterCurrency: parentB?.currency || after.meta.currency } : {}) });
  }
  return result;
}
function recordAmount(group, row) {
  if (!row) return null;
  if (group === 'transactions') {
    if (row.type === 'fill') return fillDisplayTotal(row);
    if (row.type === 'adjustment') {
      if (row.target === 'account') return txAccountDelta(row, row.target_id);
      const effect = txEnvelopeEffect(row, row.target_id);
      return effect?.mode === 'add' ? effect.amount : null;
    }
    if (['expense', 'income'].includes(row.type)) return txAccountDelta(row, row.account);
    return txAbsAmount(row);
  }
  const key = { accounts: 'initialBalance', envelopes: 'goal_amount', budgetItems: 'default_amount' }[group];
  return key && Number.isFinite(row[key]) ? row[key] : null;
}
const amountLabels = { accounts: 'openingBalance', envelopes: 'goalAmount', budgetItems: 'planAmount', transactions: 'transactionAmount' };

export function comparisonSources(group, before, after) {
  const old = new Map(before[group].map(r => [r.id, r]));
  const next = new Map(after[group].map(r => [r.id, r]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(id => {
    const a = old.get(id), b = next.get(id);
    if (deepEqual(a, b)) return [];
    const row = b || a;
    const amount = amountLabels[group] ? { label: amountLabels[group], before: recordAmount(group, a), after: recordAmount(group, b) } : null;
    return [{ id, name: nameOf(row), date: row.date || null,
      kind: !a ? 'added' : !b ? 'removed' : 'edited',
      amount: amount && (amount.before !== null || amount.after !== null) ? amount : null,
      details: detailsOf(
        group === 'transactions' && a ? { ...a, amount: recordAmount(group, a) } : a,
        group === 'transactions' && b ? { ...b, amount: recordAmount(group, b) } : b,
        before, after) }];
  });
}

export function comparisonMetaSources(group, fields, before, after) {
  const entries = group === 'investments'
    ? [...new Set([...Object.keys(before.meta.investments || {}), ...Object.keys(after.meta.investments || {})])].map(key => ({ key, a: before.meta.investments?.[key], b: after.meta.investments?.[key] }))
    : fields.map(key => ({ key, a: before.meta[key], b: after.meta[key] }));
  return entries.filter(({ a, b }) => !deepEqual(a, b)).map(({ key, a, b }) => ({
    id: key, name: key, field: key, date: null, kind: a == null ? 'added' : b == null ? 'removed' : 'edited', amount: null,
    details: detailsOf(a, b, before, after, [key]),
  })).filter(source => source.details.length);
}
