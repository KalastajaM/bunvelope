// e2e/static-helpers.js — shared by the guest-mode and fsapi-mode specs
// (the static-server project). Not a spec: the file name does not match the
// project's testMatch.

import { expect } from '@playwright/test';

// The example budget is a fixed snapshot that guest mode shifts forward by
// whole months so its latest activity lands in the current month. Pinning the
// browser clock makes that shift, and every figure derived from it, the same
// on every run — so the specs can assert exact numbers.
export const PINNED_NOW = new Date('2026-09-15T12:00:00');

// Figures of the shipped example budget (budgets/example-project) under the
// pinned clock, "Booked" balance view. If the example data changes on
// purpose, these are the numbers to update.
//
// The example is in EUR, so numbers take the Finnish format: a space (a
// no-break one) between thousands and a decimal comma, "€ 1 997,70".
// `eur` matches that with any spacing.
export function eur(amount) {
  const body = amount.replace(/[.+]/g, '\\$&').replace(/ /g, '\\s?');
  return new RegExp(`€\\s?${body}`);
}

export const EXAMPLE = {
  unallocated: eur('5 432,04'),
  checking: eur('15 272,15'),
  diningOut: eur('579,40'),
  groceries: eur('1 095,55'),
};

/**
 * Pin the clock and mark the first-run tour as seen (its backdrop intercepts
 * clicks). Must run before the first navigation. `firstRun` leaves the
 * preferences empty instead, as a browser that has never opened the app.
 * @param {import('@playwright/test').Page} page
 * @param {{ firstRun?: boolean }} [opts]
 */
export async function preparePage(page, { firstRun = false } = {}) {
  await page.clock.setFixedTime(PINNED_NOW);
  if (!firstRun) {
    await page.addInitScript(() => {
      localStorage.setItem('bv-prefs-v1', JSON.stringify({ tourSeen: true }));
    });
  }
  // Any uncaught error in the app is a failure, whatever the assertions say.
  page.__errors = [];
  page.on('pageerror', (err) => page.__errors.push(err.message));
}

/** Navigate the left rail. */
export async function goTo(page, name) {
  await page.locator(`.rail-item[data-page="${name}"]`).click();
}

/**
 * Add an expense from the Transactions page and wait for the sheet to close.
 * @param {import('@playwright/test').Page} page
 * @param {{payee: string, amount: string, envelope: string, account?: string}} tx
 */
export async function addExpense(page, { payee, amount, envelope, account }) {
  await goTo(page, 'transactions');
  await page.getByRole('button', { name: 'New transaction' }).first().click();
  const sheet = page.locator('.sheet-overlay.open');
  await sheet.locator('input[name="payee"]').fill(payee);
  await sheet.locator('input[name="amount"]').fill(amount);
  // Envelope picker: a combobox; type to filter, then choose the option.
  await sheet.getByRole('combobox', { name: 'Type to find an envelope' }).first().fill(envelope);
  await sheet.getByRole('option', { name: envelope }).first().click();
  if (account) {
    await sheet.locator('.field', { has: page.locator('label', { hasText: /^Account$/ }) })
      .locator('select').selectOption({ label: account });
  }
  await page.getByRole('button', { name: 'Add & close' }).click();
  await expect(page.locator('.sheet-overlay.open')).toHaveCount(0);
}

/** The envelope card on the Envelopes page. */
export function envelopeCard(page, id) {
  return page.locator(`.env[data-env-id="${id}"]`);
}

/** The account card on the Accounts page. */
export function accountCard(page, id) {
  return page.locator(`.env[data-acc-id="${id}"]`);
}
