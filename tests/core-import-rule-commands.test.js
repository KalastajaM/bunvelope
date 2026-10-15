import { it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { importRuleContext } from '../js/core/import-rules.js';
import { createBrowserSession } from '../js/session/browser-session.js';
import { createMetaQueue } from '../js/state/meta-queue.js';
const input = { name: 'Shop', conditions: { merchant: 'SHOP', operator: 'equals', direction: 'expense' }, actions: { envelope: 'food' } };
const budget = () => ({ meta: { schemaVersion: 8, unrelated: 'keep' }, accounts: [{ id: 'bank', name: 'Bank', type: 'bank' }], envelopes: [{ id: 'food', name: 'Food' }], transactions: [], budgetItems: [], envelopeTemplates: [] });
const clock = () => new Date(2026, 9, 9, 12);
const ctx = () => makeCtx({ now: clock(), newId: () => 'r' });
const run = (name, x, d) => runCommand(registry, d, name, x, ctx());
it('creates, previews, updates and deletes without changing the ledger or unrelated meta', () => {
  let d = budget();
  const r = run('importRule.create', input, d);
  expect(r.ok).toBe(true);
  expect(d.meta.importRules).toBeUndefined();
  d = r.value.after;
  expect(d.meta.unrelated).toBe('keep');
  expect(d.transactions).toEqual([]);
  expect(runQuery(registry, d, 'importRules.preview', { rows: [{ key: 'x', payee: 'SHOP', amount: -20, account: 'bank' }] }, ctx()).value.rows[0].matches).toEqual(['r']);
  expect(run('importRule.update', { id: 'r', fields: { enabled: false } }, d).value.after.meta.importRules[0].enabled).toBe(false);
  expect(run('importRule.update', { id: 'r', fields: { name: 'Shop' } }, d).value.diff).toEqual({});
  expect(run('importRule.delete', { id: 'r' }, d).value.after.meta.importRules).toEqual([]);
  expect(run('importRule.delete', { id: 'missing' }, d).error.code).toBe('not_found');
});
it('can disable/delete unavailable references but refuses invalid new actions', () => {
  let d = run('importRule.create', input, budget()).value.after;
  d = { ...d, envelopes: [] };
  expect(run('importRule.update', { id: 'r', fields: { enabled: false } }, d).ok).toBe(true);
  expect(run('importRule.delete', { id: 'r' }, d).ok).toBe(true);
  expect(run('importRule.update', { id: 'r', fields: { actions: { envelope: 'food' } } }, d).ok).toBe(false);
});
it('refuses a stale reviewed import without reapplying rules', () => {
  const d = budget(); const context = importRuleContext(d);
  const rows = [{ type: 'expense', amount: 20, account: 'bank', payee: 'SHOP' }];
  expect(run('transaction.import', { rows, expectedImportContext: context }, d).ok).toBe(true);
  d.meta.payeeAliases = { shop: 'Renamed' };
  expect(run('transaction.import', { rows, expectedImportContext: context }, d)).toMatchObject({ ok: false, error: { code: 'import_review_changed' } });
});
function setup() {
  const state = { ...budget(), budgetFolder: { name: 'A' } }; let generation = 1; let n = 0;
  const queue = createMetaQueue(async () => {});
  const writeBatch = vi.fn(async () => {});
  const session = createBrowserSession({ state, registry, writeBatch, runMetaExclusive: queue.runExclusive, updateMeta: queue.update,
    clock, newId: () => `r${++n}`, currentGeneration: () => generation, notify: () => {}, isVersionConflict: () => false });
  return { state, session, queue, writeBatch, switchBudget: () => { generation++; } };
}
it('publishes only successful saves and supports Undo', async () => {
  const c = setup(); c.writeBatch.mockRejectedValueOnce(new Error('disk failed'));
  expect((await c.session.dispatch('importRule.create', input)).ok).toBe(false);
  expect(c.state.meta.importRules).toBeUndefined();
  const saved = await c.session.dispatch('importRule.create', input);
  expect(saved.ok).toBe(true);
  expect(c.state.meta.importRules).toHaveLength(1);
  expect((await c.session.undo(saved.value.undo)).ok).toBe(true);
  expect(c.state.meta.importRules).toBeUndefined();
});
it('checks changed aliases inside the metadata queue before writing an import', async () => {
  const c = setup(); let release;
  const blocker = c.queue.runExclusive(c.state, async latest => {
    await new Promise(resolve => { release = resolve; });
    return { meta: { ...latest, payeeAliases: { shop: 'New name' } }, write: async () => {} };
  });
  await Promise.resolve();
  const pending = c.session.dispatch('transaction.import', { rows: [{ type: 'expense', amount: 20, account: 'bank', payee: 'SHOP' }], expectedImportContext: importRuleContext(c.state) });
  await new Promise(resolve => setTimeout(resolve, 0)); release(); await blocker;
  expect(await pending).toMatchObject({ ok: false, error: { code: 'import_review_changed' } });
  expect(c.state.transactions).toEqual([]);
});
it('a queued rule save belongs to its original budget', async () => {
  const c = setup(); const pending = c.session.dispatch('importRule.create', input); c.switchBudget();
  expect((await pending).ok).toBe(false);
  expect(c.state.meta.importRules).toBeUndefined();
});
