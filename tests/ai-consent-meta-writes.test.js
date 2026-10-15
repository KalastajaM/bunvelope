// tests/ai-consent-meta-writes.test.js — the AI consent/dismissal writers go
// through the shared meta queue: state.meta moves only once the save lands,
// and a write queued alongside another is not lost.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appState = { meta: null, budgetFolder: 'A' };
const saves = [];
let gate = null;
vi.mock('../js/app.js', () => ({ state: appState }));
vi.mock('../js/data.js', () => ({
  saveMeta: async (folder, meta) => { saves.push(meta); if (gate) await gate; },
}));
vi.mock('../js/ui/dialog.js', () => ({ confirmDialog: vi.fn() }));

const { beginBudgetSession, holdBudget } = await import('../js/state/budget-session.js');
const { confirmDialog } = await import('../js/ui/dialog.js');
const consent = await import('../js/ai/consent.js');
const { updateMeta } = await import('../js/state/meta-writes.js');

beforeEach(() => {
  beginBudgetSession();
  confirmDialog.mockReset();
  saves.length = 0;
  gate = null;
  appState.budgetFolder = 'A';
});

describe('AI meta writers on the shared queue', () => {
  it('moves state.meta only after the save lands', async () => {
    appState.meta = { ai: { enabled: true } };
    let open;
    gate = new Promise(r => { open = r; });
    const p = consent.setAiModel('claude-sonnet-5');
    await new Promise(r => setTimeout(r, 0));
    expect(appState.meta.ai.model).toBeUndefined();
    open();
    await p;
    expect(appState.meta.ai.model).toBe('claude-sonnet-5');
  });

  it('keeps a concurrent Settings write and a dismissal both', async () => {
    appState.meta = { currency: 'EUR', ai: { enabled: true } };
    await Promise.all([
      updateMeta(appState, m => ({ ...m, currency: 'USD' })),
      consent.dismissItem('anomaly', 'k1', 'Odd charge'),
    ]);
    expect(appState.meta.currency).toBe('USD');
    expect(appState.meta.ai.dismissed.anomaly.k1.label).toBe('Odd charge');
  });

  it('listing dismissals does not rewrite the live meta', () => {
    const ai = { dismissed: {}, dismissedSubs: ['Netflix'] };
    appState.meta = { ai };
    const listed = consent.listDismissed('subscription');
    expect(listed.map(x => x.key)).toEqual(['Netflix']);
    expect(ai.dismissed).toEqual({});
  });

  it('restoreItem writes nothing when the key is not dismissed', async () => {
    appState.meta = { ai: { dismissed: { anomaly: {} } } };
    await consent.restoreItem('anomaly', 'missing');
    expect(saves).toHaveLength(0);
  });
});


describe('setup consent', () => {
  it('allows AI during setup without creating a metadata stub', async () => {
    appState.meta = null;
    holdBudget();
    confirmDialog.mockResolvedValue(true);
    expect(await consent.ensureAiConsent({ setup: true })).toBe(true);
    expect(consent.hasFreshConsent()).toBe(true);
    expect(await consent.requireFreshConsent()).toBe(true);
    expect(saves).toEqual([]);
    // Abandoning setup leaves nothing saved for the next open.
    beginBudgetSession();
    appState.meta = null;
    expect(consent.hasFreshConsent()).toBe(false);
    expect(saves).toEqual([]);
  });

  it('does not let the ordinary AI dialog save during a load', async () => {
    appState.meta = null;
    holdBudget();
    expect(await consent.ensureAiConsent()).toBe(false);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(saves).toEqual([]);
  });

  it.each([false, true])('discards consent accepted after switching budgets (setup=%s)', async setup => {
    appState.meta = null;
    if (setup) holdBudget();
    let accept;
    confirmDialog.mockImplementation(() => new Promise(r => { accept = r; }));
    const pending = consent.ensureAiConsent({ setup });
    beginBudgetSession();
    appState.meta = { name: 'Other budget' };
    accept(true);
    expect(await pending).toBe(false);
    expect(appState.meta).toEqual({ name: 'Other budget' });
    expect(saves).toEqual([]);
  });
});

it('does not authorize the next budget when the consent save finishes after a switch', async () => {
  appState.meta = null;
  confirmDialog.mockResolvedValue(true);
  let finish;
  gate = new Promise(resolve => { finish = resolve; });
  const pending = consent.ensureAiConsent();
  await vi.waitFor(() => expect(saves).toHaveLength(1));
  beginBudgetSession();
  appState.meta = { name: 'Next budget' };
  finish();
  expect(await pending).toBe(false);
  expect(appState.meta).toEqual({ name: 'Next budget' });
});
