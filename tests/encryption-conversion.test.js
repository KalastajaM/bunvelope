// convertBudgetEncryption rewrites every cloud budget under the new key. A
// budget whose setup wizard never finished has no meta; loadBudgetData invents
// one for it, and writing that back made the unfinished budget look set up
// (the wizard was then skipped, leaving an empty budget with made-up meta).
import { describe, it, expect, vi } from 'vitest';
import { convertBudgetEncryption } from '../js/storage/encryption-config.js';

function fakeApi(budgets) {
  const bundles = new Map(budgets.map(b => [b.id, b.bundle]));
  return {
    flushWrites: vi.fn(async () => {}),
    listCloudBudgets: vi.fn(async () => budgets.map(({ id, name }) => ({ id, name }))),
    readJson: vi.fn(async (ref, filename) => {
      expect(filename).toBe('budget-meta.json');
      return bundles.get(ref.budgetId).meta ?? null;
    }),
    loadBudgetData: vi.fn(async ref => {
      const b = bundles.get(ref.budgetId);
      return { ...b, meta: b.meta ?? { schemaVersion: 8 } };
    }),
    writeBatch: vi.fn(async () => {}),
  };
}

const empty = { envelopes: [], budgetItems: [], transactions: [], accounts: [], envelopeTemplates: [] };

describe('convertBudgetEncryption', () => {
  it('skips a budget whose meta is null instead of writing invented meta', async () => {
    const api = fakeApi([
      { id: 'done', name: 'Done', bundle: { ...empty, meta: { schemaVersion: 8, name: 'Done' } } },
      { id: 'fresh', name: 'Fresh', bundle: { ...empty, meta: null } },
    ]);
    await convertBudgetEncryption(api, null);
    expect(api.writeBatch).toHaveBeenCalledTimes(1);
    const [ref, items] = api.writeBatch.mock.calls[0];
    expect(ref.budgetId).toBe('done');
    expect(items.find(i => i.filename === 'budget-meta.json').data).toEqual({ schemaVersion: 8, name: 'Done' });
  });
});
