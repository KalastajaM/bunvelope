/**
 * The storage contract suite — one set of assertions, run against every
 * adapter.
 *
 * Ported from the v2 rebuild's `packages/store/src/contract.ts`, whose header
 * makes the argument: divergence between adapters is invisible when each has
 * its own tests, if any. In this repo, before this file existed:
 *
 *   • `fsapi-adapter` had 4 tests — round-trip and migrations.
 *   • `api-adapter` had 8 — fetch mapping, versions, encryption, serialisation.
 *   • `guest-adapter` had none, and it is the adapter every new user meets
 *     first ("Continue as guest" / "Load example budget").
 *
 * They shared no assertion, so nothing said the three behave alike, and
 * nothing would notice if they stopped. This suite is what says so. Adapter-
 * specific behaviour (migrations, encryption, HTTP shapes) stays in each
 * adapter's own file — this covers only what all three must agree on.
 *
 * Usage, one line per adapter:
 *
 *     runStoreContract('guest', () => ({ adapter: guest, handle: GUEST_FOLDER }));
 */
import { describe, it, expect, beforeEach } from 'vitest';

const BUNDLE = {
  envelopes: [{ id: 'e1', name: 'Food', category: 'Basics' }],
  budgetItems: [{ id: 'b1', envelope_id: 'e1', default_amount: 100, include: true }],
  transactions: [{ id: 't1', type: 'expense', date: '2026-03-01', amount: 12.34, account: 'a1', envelope_id: 'e1' }],
  accounts: [{ id: 'a1', name: 'Main', type: 'bank', initialBalance: 500 }],
  envelopeTemplates: [{ id: 'tpl1', name: 'Payday', lines: [] }],
};

/**
 * @param {string} name  adapter name, for the describe block
 * @param {() => {adapter, handle, reset?: () => void}} setup
 *        Called fresh for each test. `reset` clears whatever the previous test
 *        left behind.
 * @param {{fileExistsIsMetaOnly?: boolean, readsAreCached?: boolean}} [divergences]
 *        Where this adapter is deliberately NOT like the others. Declaring one
 *        here is the point of the suite: a difference that is written down at
 *        the call site, with a reason, is a decision; the same difference
 *        discovered later is a bug. Anything not declared must hold.
 */
export function runStoreContract(name, setup, divergences = {}) {
  describe(`store contract: ${name}`, () => {
    let adapter, handle;

    beforeEach(() => {
      const ctx = setup();
      adapter = ctx.adapter;
      handle = ctx.handle;
      ctx.reset?.();
    });

    it('reports the meta file absent before the budget is written, and present after', async () => {
      // This one is uniform across every adapter and has to be: the setup
      // wizard decides whether to run by asking whether meta exists.
      expect(await adapter.fileExists(handle, adapter.FILE_META)).toBe(false);
      await adapter.writeJson(handle, adapter.FILE_META, { schemaVersion: adapter.CURRENT_SCHEMA_VERSION, name: 'X' });
      await adapter.flushWrites();
      expect(await adapter.fileExists(handle, adapter.FILE_META)).toBe(true);
    });

    it('reports a collection absent before it is written, and present after', async () => {
      if (divergences.fileExistsIsMetaOnly) return; // declared: see the call site
      expect(await adapter.fileExists(handle, adapter.FILE_ACCOUNTS)).toBe(false);
      await adapter.writeJson(handle, adapter.FILE_ACCOUNTS, BUNDLE.accounts);
      await adapter.flushWrites();
      expect(await adapter.fileExists(handle, adapter.FILE_ACCOUNTS)).toBe(true);
    });

    it('reads back nothing for a file that was never written', async () => {
      const v = await adapter.readJson(handle, adapter.FILE_TRANSACTIONS);
      // null locally, [] in the cloud (the server seeds defaults). What every
      // caller actually needs is that it is not a populated list.
      expect(v === null || (Array.isArray(v) && v.length === 0)).toBe(true);
    });

    it('round-trips a value through writeJson / readJson', async () => {
      await adapter.writeJson(handle, adapter.FILE_TRANSACTIONS, BUNDLE.transactions);
      await adapter.flushWrites();
      expect(await adapter.readJson(handle, adapter.FILE_TRANSACTIONS)).toEqual(BUNDLE.transactions);
    });

    it('hands back a copy, not the stored object', async () => {
      // A caller that mutates what it read must not reach into storage. The
      // balance cache keys on array identity, so a shared reference would
      // also make a stale balance survive a write.
      if (divergences.readsAreCached) return; // declared: see the call site
      const rows = [{ id: 't1', type: 'expense', date: '2026-03-01', amount: 1, account: 'a1', envelope_id: 'e1' }];
      await adapter.writeJson(handle, adapter.FILE_TRANSACTIONS, rows);
      await adapter.flushWrites();
      const first = await adapter.readJson(handle, adapter.FILE_TRANSACTIONS);
      first[0].amount = 999;
      const second = await adapter.readJson(handle, adapter.FILE_TRANSACTIONS);
      expect(second[0].amount).toBe(1);
    });

    it('overwrites rather than merges', async () => {
      await adapter.writeJson(handle, adapter.FILE_ACCOUNTS, [
        { id: 'a1', name: 'Main', type: 'bank', initialBalance: 0 },
        { id: 'a2', name: 'Spare', type: 'bank', initialBalance: 0 },
      ]);
      await adapter.flushWrites();
      await adapter.writeJson(handle, adapter.FILE_ACCOUNTS, [{ id: 'a1', name: 'Main', type: 'bank', initialBalance: 0 }]);
      await adapter.flushWrites();
      expect(await adapter.readJson(handle, adapter.FILE_ACCOUNTS)).toHaveLength(1);
    });

    it('writeBatch commits every item in the batch', async () => {
      await adapter.writeBatch(handle, [
        { filename: adapter.FILE_ACCOUNTS, data: BUNDLE.accounts },
        { filename: adapter.FILE_ENVELOPES, data: BUNDLE.envelopes },
        { filename: adapter.FILE_TRANSACTIONS, data: BUNDLE.transactions },
      ]);
      await adapter.flushWrites();
      expect(await adapter.readJson(handle, adapter.FILE_ACCOUNTS)).toEqual(BUNDLE.accounts);
      expect(await adapter.readJson(handle, adapter.FILE_ENVELOPES)).toEqual(BUNDLE.envelopes);
      expect(await adapter.readJson(handle, adapter.FILE_TRANSACTIONS)).toEqual(BUNDLE.transactions);
    });

    it('the save* helpers write the file their name promises', async () => {
      await adapter.saveAccounts(handle, BUNDLE.accounts);
      await adapter.saveEnvelopes(handle, BUNDLE.envelopes);
      await adapter.saveBudgetItems(handle, BUNDLE.budgetItems);
      await adapter.saveTransactions(handle, BUNDLE.transactions);
      await adapter.saveEnvelopeTemplates(handle, BUNDLE.envelopeTemplates);
      await adapter.flushWrites();
      expect(await adapter.readJson(handle, adapter.FILE_ACCOUNTS)).toEqual(BUNDLE.accounts);
      expect(await adapter.readJson(handle, adapter.FILE_ENVELOPES)).toEqual(BUNDLE.envelopes);
      expect(await adapter.readJson(handle, adapter.FILE_BUDGET_ITEMS)).toEqual(BUNDLE.budgetItems);
      expect(await adapter.readJson(handle, adapter.FILE_TRANSACTIONS)).toEqual(BUNDLE.transactions);
      expect(await adapter.readJson(handle, adapter.FILE_ENV_TEMPLATES)).toEqual(BUNDLE.envelopeTemplates);
    });

    it('loadBudgetData returns every collection as an array, on an empty store', async () => {
      const out = await adapter.loadBudgetData(handle);
      for (const key of ['envelopes', 'budgetItems', 'transactions', 'accounts', 'envelopeTemplates']) {
        expect(Array.isArray(out[key])).toBe(true);
      }
      expect(typeof out.meta).toBe('object');
    });

    it('loadBudgetData reads back what was saved, at the current schema version', async () => {
      await adapter.writeBatch(handle, [
        { filename: adapter.FILE_ACCOUNTS, data: BUNDLE.accounts },
        { filename: adapter.FILE_ENVELOPES, data: BUNDLE.envelopes },
        { filename: adapter.FILE_BUDGET_ITEMS, data: BUNDLE.budgetItems },
        { filename: adapter.FILE_TRANSACTIONS, data: BUNDLE.transactions },
        { filename: adapter.FILE_ENV_TEMPLATES, data: BUNDLE.envelopeTemplates },
        { filename: adapter.FILE_META, data: { schemaVersion: adapter.CURRENT_SCHEMA_VERSION, name: 'Contract' } },
      ]);
      await adapter.flushWrites();
      const out = await adapter.loadBudgetData(handle);
      expect(out.accounts).toEqual(BUNDLE.accounts);
      expect(out.envelopes).toEqual(BUNDLE.envelopes);
      expect(out.transactions).toEqual(BUNDLE.transactions);
      expect(out.meta.schemaVersion).toBe(adapter.CURRENT_SCHEMA_VERSION);
    });

    it('refuses to write a malformed collection', async () => {
      // `assertCollection` is the save-path guard against an in-memory bug
      // reaching storage. fsapi and api both call it; the guest adapter did
      // not, so the same broken write was rejected in one mode and accepted
      // in another — and guest is the mode every new user meets first, and
      // the one whose data can be exported and reopened as a real budget.
      await expect(
        adapter.writeJson(handle, adapter.FILE_ACCOUNTS, [{ id: 'a1' }]),
      ).rejects.toThrow(/Invalid accounts/);
    });

    it('refuses a malformed collection inside a batch, before writing any of it', async () => {
      await adapter.writeJson(handle, adapter.FILE_ENVELOPES, BUNDLE.envelopes);
      await adapter.flushWrites();
      await expect(adapter.writeBatch(handle, [
        { filename: adapter.FILE_ENVELOPES, data: [{ id: 'e9', name: 'Later' }] },
        { filename: adapter.FILE_ACCOUNTS, data: [{ id: 'a1' }] },
      ])).rejects.toThrow(/Invalid accounts/);
      // The valid item in the same batch must not have landed either.
      expect(await adapter.readJson(handle, adapter.FILE_ENVELOPES)).toEqual(BUNDLE.envelopes);
    });

    it('names itself, and agrees with the rest of the app about the filenames', async () => {
      expect(typeof adapter.adapterName).toBe('string');
      expect(adapter.FILE_ACCOUNTS).toBe('accounts.json');
      expect(adapter.FILE_ENVELOPES).toBe('envelopes.json');
      expect(adapter.FILE_BUDGET_ITEMS).toBe('budget-items.json');
      expect(adapter.FILE_TRANSACTIONS).toBe('transactions.json');
      expect(adapter.FILE_META).toBe('budget-meta.json');
      expect(adapter.FILE_ENV_TEMPLATES).toBe('envelope-templates.json');
    });
  });
}
