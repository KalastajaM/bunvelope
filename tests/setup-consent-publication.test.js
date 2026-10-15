// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/ai/client.js', () => ({ isCloudMode: () => true, aiInsights: vi.fn() }));
vi.mock('../js/ui/dialog.js', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../js/ui/sheet.js', () => ({ openSheet: vi.fn(() => ({ close() {} })) }));
vi.mock('../js/ui/tour.js', () => ({ maybeAutoStartTour: vi.fn() }));
import { state, resetState } from './_fakes/pageApp.js';
import { beginBudgetSession, budgetHeld } from '../js/state/budget-session.js';
import { GUEST_FOLDER, resetGuestMemory, readJson } from '../js/storage/guest-adapter.js';
import { runSetupWizard } from '../js/setup.js';
import { CONSENT_VERSION } from '../js/ai/consent.js';

beforeEach(() => {
  resetState(); resetGuestMemory(); beginBudgetSession();
  state.budgetFolder = GUEST_FOLDER;
  state.meta = null;
  document.body.innerHTML = '<div id="app"></div>';
});

it('saves consent only with the completed wizard publication', async () => {
  await runSetupWizard(document.getElementById('app'), GUEST_FOLDER);
  document.getElementById('setup-ai-help').click();
  await vi.waitFor(() => expect(state.meta?.ai?.consentVersion).toBe(CONSENT_VERSION));
  expect(await readJson(GUEST_FOLDER, 'budget-meta.json')).toBeNull();
  document.getElementById('setup-next1').click();
  document.getElementById('setup-next2').click();
  document.getElementById('setup-skip-income').click();
  document.getElementById('setup-finish').click();
  await vi.waitFor(() => expect(budgetHeld()).toBe(false));
  const saved = await readJson(GUEST_FOLDER, 'budget-meta.json');
  expect(saved.ai).toMatchObject({ enabled: true, consentVersion: CONSENT_VERSION });
  expect(saved.schemaVersion).toBeTruthy();
  expect(await readJson(GUEST_FOLDER, 'envelopes.json')).toBeInstanceOf(Array);
});
