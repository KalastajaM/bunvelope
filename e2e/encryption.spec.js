import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, dbBaseUrl } from './env.js';
import { resetCloudAccount, applyApiDelay, openSheet } from './cloud-helpers.js';

test.skip(!dbBaseUrl(), 'Set E2E_DATABASE_URL to run encryption recovery');
test.beforeEach(async ({ context }) => { await applyApiDelay(context); });
test.afterEach(async ({ request }) => {
  // Leave the next independent scenario a plaintext account even when this
  // test fails.
  await resetCloudAccount(request);
});
// After an unlock the app reopens the last budget by itself (U9) on the page
// the URL names, rather than showing the budget picker.
async function expectBudgetReopened(page) {
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);
  await expect(page.locator('.rail-item[data-page="settings"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('encryption survives a lost rotation response and reload without rewriting budgets', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bv-prefs-v1', JSON.stringify({ tourSeen: true }));
  });
  await page.goto('/');
  await page.getByPlaceholder('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Welcome, / })).toBeVisible();
  await page.getByRole('button', { name: 'New cloud budget' }).click();
  await page.locator('#setup-name').fill('Encrypted regression');
  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click();
  await page.locator('#setup-skip-income').click(); // no income (optional too)
  await page.locator('#setup-finish').click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.locator('.rail-item[data-page="settings"]').click();
  await page.getByRole('tab', { name: 'Data & Security', exact: true }).click();
  await page.route('**/api/user/encryption', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Enable encryption', exact: true }).click();
  await page.locator('.sheet-overlay.open').getByLabel('New passphrase', { exact: true }).fill('original-regression-passphrase');
  await page.locator('.sheet-overlay.open').getByLabel('Confirm passphrase', { exact: true }).fill('original-regression-passphrase');
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByText(/Could not finish enabling encryption/)).toBeVisible();
  await page.unroute('**/api/user/encryption');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.locator('.sheet-overlay.open').getByLabel('Passphrase', { exact: true }).fill('original-regression-passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expectBudgetReopened(page);
  await page.locator('.rail-item[data-page="settings"]').click();
  await page.getByRole('tab', { name: 'Data & Security', exact: true }).click();
  await expect(page.getByText('Encryption is incomplete. Some budgets are still stored unencrypted.')).toBeVisible();
  await page.screenshot({ path: 'test-results/encryption-resume.png', fullPage: true });
  await page.getByRole('button', { name: 'Finish encryption', exact: true }).click();
  await page.locator('.sheet-overlay.open').getByLabel('Passphrase', { exact: true }).fill('original-regression-passphrase');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Unlock', exact: true }).click(),
  ]);
  await expect(page.getByRole('dialog', { name: 'Unlock encryption', exact: true })).toBeVisible();
  await page.locator('.sheet-overlay.open').getByLabel('Passphrase', { exact: true }).fill('original-regression-passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expectBudgetReopened(page);
  await page.locator('.rail-item[data-page="settings"]').click();
  await page.getByRole('tab', { name: 'Data & Security', exact: true }).click();
  await expect(page.getByText('Encryption is enabled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish encryption', exact: true })).toHaveCount(0);
  const budgets = await (await page.request.get('/api/budgets')).json();
  const budget = budgets.find(b => b.name === 'Encrypted regression');
  const before = await (await page.request.get(`/api/budgets/${budget.id}`)).json();
  expect(before.accounts.__enc).toBe(1);
  // Commit on the server, then lose its response in transit.
  await page.route('**/api/user/encryption', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Change passphrase', exact: true }).click();
  await expect(page.locator('.sheet-overlay:not(.open)')).toHaveCount(0);
  await page.locator('.sheet-overlay.open').getByLabel('Current passphrase', { exact: true }).fill('original-regression-passphrase');
  await page.locator('.sheet-overlay.open').getByLabel('New passphrase', { exact: true }).fill('replacement-regression-passphrase');
  await page.locator('.sheet-overlay.open').getByLabel('Confirm passphrase', { exact: true }).fill('replacement-regression-passphrase');
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(page.getByText(/Could not confirm the passphrase change/)).toBeVisible();
  await page.screenshot({ path: 'test-results/encryption-recovery-message.png', fullPage: true });
  await page.unroute('**/api/user/encryption');
  expect(await (await page.request.get(`/api/budgets/${budget.id}`)).json()).toEqual(before);
  await page.reload();
  await page.locator('.sheet-overlay.open').getByLabel('Passphrase', { exact: true }).fill('replacement-regression-passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expectBudgetReopened(page);
  await page.locator('.rail-item[data-page="settings"]').click();
  await page.getByRole('tab', { name: 'Data & Security', exact: true }).click();
  await page.getByRole('button', { name: 'Disable encryption', exact: true }).click();
  // The confirm button lives in the sheet; scope to it rather than take the
  // last button of that name on the page.
  await page.locator('.sheet-overlay.open').getByRole('button', { name: 'Disable encryption', exact: true }).click();
  await page.locator('.sheet-overlay.open').getByLabel('Passphrase', { exact: true }).fill('replacement-regression-passphrase');
  // Unlocking closes the sheet at once, but the page is still the old one: it
  // decrypts every budget, switches the account to plaintext and only then
  // reloads. expectBudgetReopened passes on that stale page (sheet closed, rail
  // and heading still there), so the next steps would race the reload and the
  // conversion. Wait for the reload itself, as the Finish-encryption step does.
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Unlock', exact: true }).click(),
  ]);
  await expectBudgetReopened(page);
  await page.locator('.rail-item[data-page="accounts"]').click();
  await page.locator('.page-head').getByRole('button', { name: '+ New account', exact: true }).click();
  await openSheet(page).locator('input[name="name"]').fill('After encryption change');
  await openSheet(page).locator('input[name="initialBalance"]').fill('123.45');
  // The account save is a session batch PUT (/batch) whose items include the
  // accounts collection. Encryption is off now, so that collection must go
  // out as a plain array, not an encrypted envelope.
  const accountsItem = request => {
    try { return (JSON.parse(request.postData() || '{}').items || []).find(item => item.kind === 'accounts'); } catch { return undefined; }
  };
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/budgets/${budget.id}/batch`)
    && response.request().method() === 'PUT' && !!accountsItem(response.request()));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.status()).toBe(200);
  expect(Array.isArray(accountsItem(savedResponse.request()).data)).toBe(true);
  await expect(page.getByText('After encryption change')).toBeVisible();
  const plain = await (await page.request.get(`/api/budgets/${budget.id}`)).json();
  expect(Array.isArray(plain.accounts)).toBe(true);
  expect(plain.accounts.some(a => a.name === 'After encryption change')).toBe(true);
});
