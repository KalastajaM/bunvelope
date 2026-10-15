// Pure, independent suggestions over original statement rows. No rule ordering.
import { validateImportRule } from './import-rule-fields.js';
import { payeeKey, getPayeeAliases, resolvePayeeAlias } from './payee-fields.js';
import { validateAmount } from '../utils.js';
const clone = x => JSON.parse(JSON.stringify(x));
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
export function importRuleContext(data) {
  return JSON.stringify(stable({ rules: data.meta?.importRules ?? [], aliases: getPayeeAliases(data.meta),
    accounts: (data.accounts || []).map(a => ({ id: a.id, archived: !!a.archived })).sort((a,b) => a.id.localeCompare(b.id)),
    envelopes: (data.envelopes || []).map(a => ({ id: a.id, archived: !!a.archived })).sort((a,b) => a.id.localeCompare(b.id)),
  }));
}
export function listImportRules(data) {
  const raw = data.meta?.importRules ?? [];
  if (!Array.isArray(raw)) return { rules: [], diagnostics: [{ index: -1, id: null, code: 'malformed' }] };
  const diagnostics = [];
  const rules = raw.map((r, index) => {
    const id = typeof r?.id === 'string' && r.id.trim() ? r.id : null;
    const checked = validateImportRule(data, r);
    const duplicates = id && raw.filter(x => x?.id === id).length > 1;
    if (!id || !checked.ok || duplicates) diagnostics.push({ index, id, code: duplicates ? 'duplicate_id' : !id ? 'malformed' : 'unavailable' });
    return clone(r);
  });
  return { rules, diagnostics };
}
/**
 * @param {any} data
 * @param {any[]} rows
 * @param {null | {id?: string, name: string, enabled?: boolean, conditions: object, actions: object}} draft
 */
export function evaluateImportRules(data, rows, draft = null) {
  const listed = listImportRules(data);
  let rules = listed.rules;
  let diagnostics = listed.diagnostics;
  if (draft) {
    const count = rules.filter(r => r?.id === draft.id).length;
    if (draft.id && count !== 1) diagnostics = [...diagnostics, { index: -1, id: draft.id, code: 'not_found' }];
    else {
      const id = draft.id || '__draft__';
      rules = draft.id ? rules.map(r => r?.id === id ? { ...draft, id } : r) : [...rules, { ...draft, id }];
      const checked = listImportRules({ ...data, meta: { ...data.meta, importRules: rules } });
      rules = checked.rules; diagnostics = checked.diagnostics;
    }
  }
  const invalid = new Set(diagnostics.map(d => d.index));
  const valid = rules.flatMap((r, i) => {
    if (invalid.has(i) || r?.enabled === false) return [];
    const checked = validateImportRule(data, r);
    return checked.ok ? [checked.value] : [];
  });
  const aliases = getPayeeAliases(data.meta);
  return { context: importRuleContext(data), diagnostics, rows: rows.map(row => {
    const amount = validateAmount(row.amount);
    const eligible = amount !== null && amount !== 0 && (!row.type || ['income', 'expense'].includes(row.type));
    /** @type {{key: string, eligible: boolean, excluded: boolean, matches: string[], fields: Record<string, any>}} */
    const result = { key: row.key, eligible, excluded: !!row.excluded, matches: [], fields: {} };
    if (!eligible || row.excluded) return result;
    const merchant = payeeKey(row.payee);
    for (const rule of valid) {
      const c = rule.conditions; const text = payeeKey(c.merchant);
      const matches = c.operator === 'equals' ? merchant === text : c.operator === 'startsWith' ? merchant.startsWith(text) : merchant.includes(text);
      if (!matches || c.direction !== (amount > 0 ? 'income' : 'expense') || (c.account && c.account !== row.account)
        || (c.minAmount != null && Math.abs(amount) < c.minAmount) || (c.maxAmount != null && Math.abs(amount) > c.maxAmount)) continue;
      result.matches.push(rule.id);
      for (const [field, proposed] of Object.entries(rule.actions)) {
        const value = field === 'payee' ? resolvePayeeAlias(proposed, aliases) : proposed;
        const f = result.fields[field] ||= { status: 'suggested', alternatives: [] };
        let a = f.alternatives.find(a => a.value === value);
        if (!a) { a = { value, rules: [], proposed: [] }; f.alternatives.push(a); }
        a.rules.push(rule.id); if (!a.proposed.includes(proposed)) a.proposed.push(proposed);
        if (f.alternatives.length > 1) f.status = 'conflict';
      }
    }
    return result;
  }) };
}
