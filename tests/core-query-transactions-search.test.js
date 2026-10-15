import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { runTool } from '../js/ai/tools/registry.js';
import '../js/ai/tools/read.js';
const now = () => new Date(2026, 8, 15, 12);
const ctx = makeCtx({ now: now(), newId: () => { throw Error('read only'); } });
const tx = (id, over = {}) => ({ id, type: 'expense', date: '2026-09-10', payee: 'Shop', amount: 10, account: 'a', envelope_id: 'e', status: 'posted', ...over });
const data = (transactions, over = {}) => ({ transactions, accounts: [{ id: 'a', name: 'Bank' }, { id: 'b' }], envelopes: [{ id: 'e', name: 'Food' }, { id: 'f' }], budgetItems: [], envelopeTemplates: [], meta: {}, ...over });
const query = (d, input = {}) => runQuery(registry, d, 'transactions.search', input, ctx);
const answer = (d, input = {}) => { const r = query(d, input); expect(r.ok).toBe(true); expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value); return r.value; };
const ids = (a) => a.rows.map(t => t.id);
function freeze(o) { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(freeze); } return o; }

describe('transactions.search', () => {
  it('totals all matches and paginates stably in reverse input order within each day', () => {
    const d = freeze(data(Array.from({ length: 75 }, (_, i) => tx(String(i)))));
    const first = answer(d);
    expect(first).toMatchObject({ matched: 75, totalMagnitude: 750, offset: 0, limit: 60, hasMore: true });
    expect(ids(first)).toEqual(Array.from({ length: 60 }, (_, i) => String(74 - i)));
    expect(ids(answer(d, { offset: 60 }))).toEqual(Array.from({ length: 15 }, (_, i) => String(14 - i)));
    expect(answer(d, { offset: 80 })).toMatchObject({ rows: [], matched: 75, totalMagnitude: 750, hasMore: false });
    first.rows[0].payee = 'changed';
    expect(d.transactions[74].payee).toBe('Shop');
  });
  it('shares touching rules for fills, splits, transfers and adjustments, correcting AI omissions', () => {
    const d = data([
      tx('split', { envelope_id: null, envelope_splits: [{ envelope_id: 'e', amount: 10 }] }),
      tx('fill', { type: 'fill', account: null, envelope_id: null, source: 'new_income', source_account: 'a', lines: [{ envelope_id: 'e', amount: 20 }] }),
      tx('envAdjust', { type: 'adjustment', account: null, envelope_id: null, target: 'envelope', target_id: 'e' }),
      tx('acctAdjust', { type: 'adjustment', account: null, envelope_id: null, target: 'account', target_id: 'a' }),
      tx('envTransfer', { type: 'envelope_transfer', account: null, envelope_id: null, from_envelope_id: 'f', to_envelope_id: 'e' }),
      tx('acctTransfer', { type: 'account_transfer', account: null, envelope_id: null, from_account: 'b', to_account: 'a' }),
    ]);
    expect(ids(answer(d, { envelope: 'e' }))).toEqual(['envTransfer', 'envAdjust', 'fill', 'split']);
    expect(ids(answer(d, { account: 'a' }))).toEqual(['acctTransfer', 'acctAdjust', 'fill', 'split']);
    for (const [key, id] of [['envelope_id', 'e'], ['account_id', 'a']]) {
      const result = runTool('query_transactions', d, { [key]: id }, now).result;
      expect(result.transactions.map(t => t.id)).toEqual(ids(answer(d, { [key === 'envelope_id' ? 'envelope' : 'account']: id })));
    }
  });
  it('preserves literal versus token semantics, tags, quoted phrases and numeric tolerance', () => {
    const d = data([tx('a', { payee: 'Shop 123', note: '#food', amount: 10.004 }), tx('b', { payee: 'Other', note: 'Shop 123 #foodstuff', amount: 10 }), tx('c', { payee: 'Shop', amount: 123 })]);
    expect(ids(answer(d, { search: 'Shop 123' }))).toEqual(['b', 'a']);
    expect(ids(answer(d, { search: 'Shop 123', searchMode: 'tokens' }))).toEqual(['c']);
    expect(ids(answer(d, { search: '"Shop 123" #food =10', searchMode: 'tokens' }))).toEqual(['a']);
    expect(ids(answer(d, { minAmount: 10, maxAmount: 10, dateFrom: '2026-09-10', dateTo: '2026-09-10' }))).toEqual(['b']);
  });
  it('supports uncategorized, cleared and flagged filters without treating UI sentinels as IDs', () => {
    const d = data([tx('empty', { envelope_id: null }), tx('correction', { envelope_id: '__none__', cleared: true, flagged: true }), tx('split', { envelope_id: null, envelope_splits: [{ envelope_id: 'e', amount: 10 }] }), tx('income', { type: 'income', envelope_id: null })]);
    expect(ids(answer(d, { noEnvelope: true }))).toEqual(['correction', 'empty']);
    expect(ids(answer(d, { cleared: true, flagged: true }))).toEqual(['correction']);
    expect(query(d, { noEnvelope: true, envelope: 'e' }).ok).toBe(false);
    expect(query(d, { dateFrom: '2026-09-12', dateTo: '2026-09-10' }).ok).toBe(false);
    expect(query(d, { minAmount: 12, maxAmount: 10 }).ok).toBe(false);
  });
  it('uses the injected preview date and deduplicates settled and tombstoned schedules', () => {
    const d = data([], { budgetItems: [{ id: 'bill', kind: 'expense', envelope_id: 'e', account_id: 'a', description: 'Bill', default_amount: 20, include: true, as_schedule: true, as_schedule_since: '2026-09-01', payment_day: 20, schedule_day_type: 'exact', monthly_schedule: { Sep: true, Oct: true } }] });
    expect(answer(d).rows).toEqual([]);
    const preview = answer(d, { showScheduled: true });
    expect(preview.rows).toMatchObject([{ date: '2026-09-20', is_forecast: true }]);
    expect(answer({ ...d, meta: { scheduledTombstones: ['bill:2026-09'] } }, { showScheduled: true }).rows).toEqual([]);
    expect(answer({ ...d, transactions: [tx('paid', { amount: 20, date: '2026-09-20', from_budget: 'bill:2026-09' })] }, { showScheduled: true }).matched).toBe(1);
    expect(answer(d, { showScheduled: true, date: '2026-10-15' }).rows[0].date).toBe('2026-10-20');
    expect(answer(d, { showScheduled: true, cleared: false }).rows).toEqual([]);
  });
});
