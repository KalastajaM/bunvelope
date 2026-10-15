import { describe, it, expect } from 'vitest';
import { evaluateImportRules, importRuleContext } from '../js/core/import-rules.js';
import { validateImportRule } from '../js/core/import-rule-fields.js';
const rule = (id = 'r', extra = {}) => ({ id, name: 'Shop', enabled: true, conditions: { merchant: 'SHOP', operator: 'equals', direction: 'expense' }, actions: { payee: 'Shop', envelope: 'food' }, ...extra });
const data = (rules = [rule()], extra = {}) => ({ accounts: [{ id: 'bank' }, { id: 'old', archived: true }], envelopes: [{ id: 'food' }, { id: 'other' }, { id: 'gone', archived: true }], meta: { importRules: rules }, ...extra });
const row = (extra = {}) => ({ key: 'x', payee: ' SHOP ', amount: -20, account: 'bank', ...extra });
const evaluate = (d, r = row()) => evaluateImportRules(d, [r]).rows[0];
describe('import rule evaluation', () => {
  it('agrees on naming while exposing independent envelope conflicts', () => {
    const d = data([rule('a'), rule('b', { actions: { payee: 'Shop', envelope: 'other' } })]);
    const before = JSON.stringify(d);
    const r = evaluate(d);
    expect(r.fields.payee).toMatchObject({ status: 'suggested', alternatives: [{ value: 'Shop', rules: ['a', 'b'] }] });
    expect(r.fields.envelope.status).toBe('conflict');
    expect(r.fields.envelope.alternatives.map(a => a.value)).toEqual(['food', 'other']);
    r.fields.payee.alternatives[0].rules.push('mutated');
    expect(JSON.stringify(d)).toBe(before);
  });
  it.each(['equals', 'startsWith', 'contains'])('matches %s case-insensitively', operator => {
    const merchant = operator === 'equals' ? 'shop' : 'sho';
    const d = data([rule('r', { conditions: { merchant, operator, direction: 'expense', account: 'bank', minAmount: 20, maxAmount: 20 } })]);
    expect(evaluate(d).matches).toEqual(['r']);
    for (const extra of [{ amount: -19.99 }, { amount: -20.01 }, { amount: 20 }, { account: 'other' }, { type: 'account_transfer' }]) expect(evaluate(d, row(extra)).matches).toEqual([]);
  });
  it('distinguishes null from absent actions and ignores disabled rules', () => {
    expect(evaluate(data([rule('r', { actions: { envelope: null } })])).fields).toEqual({ envelope: { status: 'suggested', alternatives: [{ value: null, rules: ['r'], proposed: [null] }] } });
    expect(evaluate(data([rule('r', { enabled: false })])).matches).toEqual([]);
  });
  it('does not broaden unavailable, malformed or duplicate-id rules', () => {
    for (const rules of [[rule('r', { conditions: { ...rule().conditions, account: 'old' } })], [rule('r', { actions: { envelope: 'gone' } })], [null], [rule(), rule()]]) {
      const r = evaluateImportRules(data(rules), [row()]);
      expect(r.rows[0].matches).toEqual([]);
      expect(r.diagnostics.length).toBeGreaterThan(0);
    }
    expect(evaluateImportRules(data('broken'), [row()]).diagnostics.length).toBeGreaterThan(0);
  });
  it('uses a single alias lookup and matches original text without chaining rules', () => {
    const d = data([rule('a', { actions: { payee: 'A' } }), rule('b', { actions: { payee: 'B' } })]);
    d.meta.payeeAliases = { a: 'B', b: 'C' };
    const r = evaluate(d);
    expect(r.fields.payee.alternatives.map(a => a.value)).toEqual(['B', 'C']);
    expect(r.fields.payee.alternatives[0].proposed).toEqual(['A']);
  });
  it('holds excluded rows and validates draft identity', () => {
    expect(evaluate(data(), row({ excluded: true }))).toMatchObject({ excluded: true, matches: [] });
    const r = evaluateImportRules(data(), [row()], rule('missing'));
    expect(r.diagnostics.some(d => d.code === 'not_found')).toBe(true);
    expect(evaluateImportRules(data(), [row()], { ...rule(), actions: { envelope: 'other' } }).rows[0].fields.envelope.alternatives[0].value).toBe('other');
  });
  it('context ignores object key ordering but tracks alias and entity availability changes', () => {
    const d = data();
    expect(importRuleContext(d)).toBe(importRuleContext({ ...d, meta: { importRules: [{ actions: rule().actions, conditions: rule().conditions, enabled: true, name: 'Shop', id: 'r' }] } }));
    expect(importRuleContext(d)).not.toBe(importRuleContext({ ...d, envelopes: [{ id: 'food', archived: true }] }));
  });
});
describe('rule validation', () => {
  it.each([
    { conditions: { ...rule().conditions, merchant: ' ' } },
    { conditions: { ...rule().conditions, minAmount: 30, maxAmount: 20 } },
    { conditions: { ...rule().conditions, minAmount: Infinity } },
    { actions: {} }, { actions: { payee: ' ' } }, { actions: { amount: 12 } },
    { actions: { envelope: 'gone' } }, { name: '' },
  ])('refuses unsafe rule input %j', extra => expect(validateImportRule(data(), rule('r', extra)).ok).toBe(false));
});
