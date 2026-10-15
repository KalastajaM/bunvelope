// @vitest-environment jsdom
// runDueScheduled is the real wrapper that posts due scheduled rows on load.
// An empty plan (no budget items) used to make it return before the template
// materialiser ran, so a template with its own calendar schedule, which does
// not depend on plan items, never posted its fill. The engine function was
// always fine; the wrapper's early return was the bug, so this goes through
// the wrapper rather than the engine.
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';

vi.mock('../js/ui/shell.js', () => ({
  buildShell: () => {}, highlightActive: () => {}, applyPrefs: () => {},
  relabelShell: () => {}, setNavItemVisible: () => {}, refreshAiEntryPoints: () => {},
}));

let app;
let ready;
beforeAll(async () => {
  document.body.innerHTML = '<div id="app-root"><div id="app"></div></div>';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  // Keep app.js from running its boot sequence on import.
  ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  app = await import('../js/app.js');
});
afterAll(() => { ready.mockRestore(); });
afterEach(() => { vi.useRealTimers(); });

const envelopes = [{ id: 'food', name: 'Food' }];
const template = () => ({
  id: 'tpl',
  name: 'Monthly',
  kind: 'manual',
  lines: [{ envelope_id: 'food', mode: 'add', amount: 10 }],
  schedule: {
    enabled: true, payment_day: 1, day_type: 'exact',
    since: '2026-09-01', months: { Sep: true },
  },
});

function seed(budgetItems) {
  Object.assign(app.state, {
    budgetFolder: { __guest: true },
    envelopes,
    envelopeTemplates: [template()],
    budgetItems,
    transactions: [],
    accounts: [],
    meta: { schemaVersion: 8 },
  });
}

// Local time, so the engine's local-date reads see 29 Sep in every timezone.
function pinToday() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 29, 12));
}

it('posts a due standalone template fill even when the plan has no items', async () => {
  pinToday();
  seed([]);
  const result = await app.runDueScheduled();
  expect(result.emitted).toBe(1);
  expect(app.state.transactions).toHaveLength(1);
  expect(app.state.transactions[0]).toMatchObject({ type: 'fill', from_budget: 'tpl:tpl:2026-09' });
});

it('treats a missing budgetItems array the same as an empty plan', async () => {
  pinToday();
  seed(undefined);
  const result = await app.runDueScheduled();
  expect(result.emitted).toBe(1);
});

it('still posts nothing when there is no budget folder', async () => {
  pinToday();
  seed([]);
  app.state.budgetFolder = null;
  expect(await app.runDueScheduled()).toEqual({ emitted: 0 });
  expect(app.state.transactions).toHaveLength(0);
});
