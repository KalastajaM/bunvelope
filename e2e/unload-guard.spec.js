// e2e/unload-guard.spec.js — closing the page with a save still in flight
// asks first (js/state/unload-guard.js).
//
// Writes are fire-and-forget: the UI shows the change from memory and the PUT
// lands later. Closing or reloading in between used to cancel the request and
// lose the edit silently (BACKLOG 2026-09-29). Here a save is held at the
// network, the page is closed, and the browser must raise its own
// "Leave site?" prompt; once the save has landed, closing must not.

import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, dbBaseUrl } from './env.js';
import { resetCloudAccount, openSheet } from './cloud-helpers.js';

test.skip(!dbBaseUrl(),
  'Set E2E_DATABASE_URL (or MIGRATION_TEST_DATABASE_URL) to run the e2e suite');

test.afterEach(async ({ request }) => { await resetCloudAccount(request); });

async function signInToNewBudget(page) {
  await page.addInitScript(() => {
    localStorage.setItem('bv-prefs-v1', JSON.stringify({ tourSeen: true }));
  });
  await page.goto('/');
  await page.getByPlaceholder('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Welcome, / })).toBeVisible();
  await page.getByRole('button', { name: 'New cloud budget' }).click();
  await page.locator('#setup-name').fill('Unload Guard');
  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click(); // no main account
  await page.locator('#setup-skip-income').click(); // no income (optional too)
  await page.locator('#setup-finish').click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

// True for a batch PUT that writes the accounts collection.
function isAccountsBatch(request) {
  if (request.method() !== 'PUT') return false;
  try {
    return (JSON.parse(request.postData() || '{}').items || []).some((item) => item.kind === 'accounts');
  } catch { return false; }
}

async function addAccount(page, name) {
  await page.locator('.rail-item[data-page="accounts"]').click();
  await page.locator('.page-head').getByRole('button', { name: '+ New account', exact: true }).click();
  const sheet = openSheet(page);
  await sheet.locator('input[name="name"]').fill(name);
  await sheet.locator('input[name="initialBalance"]').fill('100');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

test('closing with a save in flight asks first; after it lands it does not', async ({ page }) => {
  await signInToNewBudget(page);

  // Hold the account save until released, the way a slow network would. The
  // session writes through one batch PUT (/batch); match the one whose body
  // writes the accounts collection, so any other batch is not held.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let seenPut = false;
  await page.route('**/api/budgets/*/batch', async (route) => {
    if (!isAccountsBatch(route.request())) return route.fallback();
    seenPut = true;
    await held;
    await route.fallback();
  });

  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    // Stay on the page: the save must still be allowed to finish.
    await dialog.dismiss();
  });

  await addAccount(page, 'Held Account');
  // The PUT has left the page and is being held: a save in flight.
  await expect.poll(() => seenPut).toBe(true);

  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);

  // Let the save land, then closing is silent.
  const saved = page.waitForResponse((res) => /\/batch$/.test(new URL(res.url()).pathname)
    && isAccountsBatch(res.request()));
  release();
  expect((await saved).status()).toBe(200);
  await expect.poll(() => page.evaluate(async () =>
    (await import('/js/state/unload-guard.js')).hasUnsavedWrites())).toBe(false);

  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toEqual(['beforeunload']);
});
