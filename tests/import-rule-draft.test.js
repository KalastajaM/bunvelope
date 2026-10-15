import { describe, it, expect } from 'vitest';
import { createImportRuleDraft } from '../js/import/rule-draft.js';
const rule = (id, envelope) => ({ id, name: id, enabled: true, conditions: { merchant: 'SHOP', operator: 'equals', direction: 'expense' }, actions: { envelope } });
const setup = (rules = [rule('r', 'food')], extra = {}) => {
  const data = { accounts: [{ id: 'bank' }], envelopes: [{ id: 'food' }, { id: 'other' }], meta: { importRules: rules, ...extra } };
  const rows = [{ key: 'x', payee: 'SHOP', amount: -20, account: 'bank' }];
  const draft = createImportRuleDraft({ data, rows, baselines: { x: { payee: 'SHOP', envelope: null } } });
  return { data, rows, draft };
};
describe('rule draft state', () => {
  it('suggests a rule over baseline and preserves an explicit correction across refresh', () => {
    const { data, draft } = setup();
    expect(draft.view()[0].values.envelope).toBe('food');
    draft.edit('x', 'envelope', 'other');
    draft.refresh({ ...data, meta: { importRules: [] } });
    expect(draft.view()[0].values.envelope).toBe('other');
  });
  it('requires an explicit choice for a conflict, including choosing the baseline', () => {
    const { data, draft } = setup([rule('a', 'food'), rule('b', 'other')]);
    expect(draft.approval(data).reason).toBe('conflicts');
    draft.edit('x', 'envelope', null);
    expect(draft.approval(data).fieldsByKey.x.envelope).toBe(null);
    draft.refresh(data);
    expect(draft.view()[0].values.envelope).toBe(null);
  });
  it('re-including a duplicate runs rules and enforces its conflicts', () => {
    const { data, draft } = setup([rule('a', 'food'), rule('b', 'other')]);
    draft.setExcluded('x', true);
    expect(draft.approval(data).ok).toBe(true);
    draft.setExcluded('x', false);
    expect(draft.approval(data).reason).toBe('conflicts');
  });
  it('refreshes stale context once and retains manual choices', () => {
    const { data, draft } = setup(); draft.edit('x', 'envelope', 'other');
    const changed = { ...data, meta: { ...data.meta, payeeAliases: { shop: 'Shop Oy' } } };
    expect(draft.approval(changed).reason).toBe('changed');
    expect(draft.approval(changed).fieldsByKey.x).toEqual({ payee: 'SHOP', envelope: 'other' });
    expect(draft.view()[0].values.payee).toBe('Shop Oy');
  });
  it('blocks a deleted manual target rather than clearing it', () => {
    const { data, draft } = setup(); draft.edit('x', 'envelope', 'other');
    const changed = { ...data, envelopes: [{ id: 'food' }] }; draft.refresh(changed);
    expect(draft.approval(changed).reason).toBe('unavailable');
  });
  it('counts field outcomes from provenance and exclusion', () => {
    const { draft } = setup();
    expect(draft.summary()).toEqual({ retained: 1, changed: 0, unresolved: 0 });
    draft.edit('x', 'envelope', 'other');
    expect(draft.summary()).toEqual({ retained: 0, changed: 1, unresolved: 0 });
    draft.edit('x', 'envelope', 'food');
    expect(draft.summary().retained).toBe(1);
    draft.setExcluded('x', true); expect(draft.summary()).toEqual({ retained: 0, changed: 0, unresolved: 0 });
  });
  it('keeps a single-lookup alias result distinct from its write input', () => {
    const r = { ...rule('r','food'), actions: { payee: 'A' } };
    const { draft, data } = setup([r], { payeeAliases: { a: 'B', b: 'C' } });
    expect(draft.view()[0].values.payee).toBe('B');
    expect(draft.approval(data).fieldsByKey.x.payee).toBe('A');
  });
  it('does not apply suggestions to a transfer after a user type correction', () => {
    const { draft } = setup(); draft.setType('x', 'account_transfer');
    expect(draft.view()[0].values.envelope).toBe(null);
    expect(draft.summary().retained).toBe(0);
  });
});
