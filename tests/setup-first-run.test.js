// @vitest-environment jsdom
// First-run wizard copy and fields (BACKLOG 2026-10-05): a guest or cloud
// budget is not "an empty folder", the review step shows the opening balance
// entered in step 2, the country (banking holidays) is chosen in step 1 and
// saved, and the shell hides its dead navigation while no budget is open.
import { it, expect, vi, beforeEach, describe } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/ai/client.js', () => ({ isCloudMode: () => false, aiInsights: vi.fn() }));
vi.mock('../js/ui/sheet.js', () => ({ openSheet: vi.fn(() => ({ close() {} })) }));
vi.mock('../js/ui/tour.js', () => ({ maybeAutoStartTour: vi.fn() }));
import { state, resetState } from './_fakes/pageApp.js';
import { beginBudgetSession, budgetHeld } from '../js/state/budget-session.js';
import { GUEST_FOLDER, resetGuestMemory, readJson } from '../js/storage/guest-adapter.js';
import { runSetupWizard, guessCountry, welcomeBody } from '../js/setup.js';
import { setLang, t } from '../js/ui/i18n.js';

beforeEach(() => {
  setLang('en');
  resetState(); resetGuestMemory(); beginBudgetSession();
  state.budgetFolder = GUEST_FOLDER;
  state.meta = null;
  document.documentElement.removeAttribute('data-nobudget');
  document.body.innerHTML = '<div id="app"></div>';
});

describe('welcomeBody', () => {
  it('does not call a guest or cloud budget an empty folder', () => {
    expect(welcomeBody(GUEST_FOLDER)).toBe(t('setup.welcomeBodyNew'));
    expect(welcomeBody({ kind: 'cloud', budgetId: 'b1' })).toBe(t('setup.welcomeBodyNew'));
    expect(welcomeBody(GUEST_FOLDER)).not.toMatch(/folder/i);
  });
  it('keeps the folder wording for a local folder', () => {
    expect(welcomeBody({ kind: 'directory', name: 'budget' })).toBe(t('setup.welcomeBody'));
  });
});

describe('guessCountry', () => {
  it('reads the region of the first language the app has holidays for', () => {
    expect(guessCountry(['fi-FI', 'en'])).toBe('FI');
    expect(guessCountry(['en', 'nl-NL', 'en-GB'])).toBe('GB');
    expect(guessCountry(['sv_SE'])).toBe('SE');
  });
  it('falls back to the default without a known region', () => {
    expect(guessCountry([])).toBe('FI');
    expect(guessCountry(['en', 'fr-FR'])).toBe('FI');
    expect(guessCountry(undefined)).toBe('FI');
  });
});

it('offers EUR first and selected, and every Settings currency', async () => {
  await runSetupWizard(document.getElementById('app'), GUEST_FOLDER);
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById('setup-currency'));
  expect(sel.options[0].value).toBe('EUR');
  expect(sel.value).toBe('EUR');
  expect([...sel.options].map(o => o.value)).toEqual(expect.arrayContaining(['CHF', 'USD', 'SEK']));
  expect(document.getElementById('app').textContent).not.toMatch(/folder is empty/i);
});

it('hides the shell navigation while the wizard runs', async () => {
  await runSetupWizard(document.getElementById('app'), GUEST_FOLDER);
  expect(document.documentElement.hasAttribute('data-nobudget')).toBe(true);
});

it('shows the opening balance and country on review, and saves the country', async () => {
  await runSetupWizard(document.getElementById('app'), GUEST_FOLDER);
  const country = /** @type {HTMLSelectElement} */ (document.getElementById('setup-country'));
  country.value = 'SE';
  document.getElementById('setup-next1').click();
  /** @type {HTMLInputElement} */ (document.getElementById('setup-acct-name')).value = 'Main account';
  /** @type {HTMLInputElement} */ (document.getElementById('setup-acct-balance')).value = '1500';
  document.getElementById('setup-next2').click();
  document.getElementById('setup-skip-income').click();

  const review = document.getElementById('app').querySelector('table').textContent;
  expect(review).toContain('Main account');
  expect(document.getElementById('setup-review-balance').textContent).toMatch(/1\D?500[.,]00/);
  expect(review).toMatch(/Sweden|SE/);

  document.getElementById('setup-finish').click();
  await vi.waitFor(() => expect(budgetHeld()).toBe(false));
  const meta = await readJson(GUEST_FOLDER, 'budget-meta.json');
  expect(meta.country).toBe('SE');
  expect(meta.currency).toBe('EUR');
  const accounts = await readJson(GUEST_FOLDER, 'accounts.json');
  expect(accounts[0].initialBalance).toBe(1500);
});

it('leaves the balance row out when no account was entered', async () => {
  await runSetupWizard(document.getElementById('app'), GUEST_FOLDER);
  document.getElementById('setup-next1').click();
  document.getElementById('setup-next2').click();
  document.getElementById('setup-next3').click(); // blank income = skipped
  expect(document.getElementById('setup-review-balance')).toBeNull();
});
