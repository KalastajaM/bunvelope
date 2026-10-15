// e2e/golden-path.spec.js — the BACKLOG golden path, end to end against the
// real server, real Postgres and the real browser bundle:
//
//   sign in → create budget (setup wizard) → add account → add expense
//   → reload → reopen budget → the data survived.
//
// Selectors prefer user-visible text (English locale, the app default) and
// the wizard's stable #setup-* ids.

import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, dbBaseUrl } from './env.js';
import { resetCloudAccount, applyApiDelay, openSheet } from './cloud-helpers.js';

test.skip(!dbBaseUrl(),
  'Set E2E_DATABASE_URL (or MIGRATION_TEST_DATABASE_URL) to run the e2e suite');

test.beforeEach(async ({ context }) => { await applyApiDelay(context); });
test.afterEach(async ({ request }) => {
  // The next spec (or repeat) signs in as the same account and expects the
  // "Welcome, <name>" picker, not a reopened budget.
  await resetCloudAccount(request);
});

test('golden path: sign in, set up a budget, record money, survive a reload', async ({ page }) => {
  // Mark the first-run tour as seen, as the other specs do: the wizard starts
  // it, and its backdrop takes every click. Preferences sync to the account,
  // so without this whether it shows depends on which spec signed in first.
  // The tour itself is covered by the static first-run spec.
  await page.addInitScript(() => {
    localStorage.setItem('bv-prefs-v1', JSON.stringify({ tourSeen: true }));
  });

  const sheet = openSheet(page);

  // ── Sign in (bypass mode) ────────────────────────────────────────────────
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Enter access password' })).toBeVisible();
  await page.getByPlaceholder('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  // Successful login reloads into the cloud welcome screen.
  await expect(page.getByRole('heading', { name: /^Welcome, / })).toBeVisible();

  // ── Create a budget → setup wizard ───────────────────────────────────────
  await page.getByRole('button', { name: 'New cloud budget' }).click();

  await expect(page.locator('#setup-name')).toBeVisible();
  await page.locator('#setup-name').fill('E2E Budget');
  await page.locator('#setup-next1').click();
  await page.locator('#setup-next2').click(); // skip the Goodbudget import
  await page.locator('#setup-skip-income').click(); // no income (optional too)
  await page.locator('#setup-finish').click();

  // Wizard hands off to the dashboard.
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // ── Create an account with an initial balance ────────────────────────────
  await page.locator('.rail-item[data-page="accounts"]').click();
  await page.locator('.page-head').getByRole('button', { name: '+ New account', exact: true }).click();
  await sheet.locator('input[name="name"]').fill('E2E Checking');
  await sheet.locator('input[name="initialBalance"]').fill('250');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('E2E Checking')).toBeVisible();

  // ── Record an expense ─────────────────────────────────────────────────────
  await page.locator('.rail-item[data-page="transactions"]').click();
  await page.getByRole('button', { name: 'New transaction' }).first().click();
  await sheet.locator('input[name="payee"]').fill('E2E Coffee');
  await sheet.locator('input[name="amount"]').fill('12.50');
  // Date is prefilled with today; the only account is auto-selected.
  // The list shows the new row from in-memory state the moment it is added;
  // the write to the server is issued then but lands later. Seeing the row
  // therefore proves nothing about persistence, and a reload straight after
  // it cancels a write still in flight. Wait for the PUT itself (writes to a
  // budget are serialised, so it also means the account write landed). The
  // add flow writes through the session, which sends one batch PUT
  // (/batch); a plain collection write (/collections/transactions) is the
  // other path to the same data, so either counts.
  const txSaved = page.waitForResponse(res =>
    res.request().method() === 'PUT'
    && /\/api\/budgets\/[^/]+\/(batch|collections\/transactions)$/.test(new URL(res.url()).pathname));
  await page.getByRole('button', { name: 'Add & close' }).click();
  expect((await txSaved).status()).toBe(200);
  await expect(page.getByText('E2E Coffee').first()).toBeVisible();

  // ── Reload: session and data must survive ────────────────────────────────
  // A reload reopens the last budget (U9) on the page the URL names, so it
  // lands back on Transactions without passing through the budget picker.
  await page.reload();
  await expect(page).toHaveURL(/#\/transactions$/);
  await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();

  // The transaction is still there…
  await expect(page.getByText('E2E Coffee').first()).toBeVisible();

  // …and the account balance reflects initial − expense = 237.50.
  await page.locator('.rail-item[data-page="accounts"]').click();
  await expect(page.getByText('E2E Checking')).toBeVisible();
  await expect(page.getByText(/237[.,]50/).first()).toBeVisible();
});
