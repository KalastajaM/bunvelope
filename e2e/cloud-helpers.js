// e2e/cloud-helpers.js — shared by the cloud specs (golden-path, encryption).
// Not a spec: the file name does not match a spec pattern.

import { E2E_PASSWORD } from './env.js';

/**
 * Return the e2e account to a fresh one: no budgets, encryption off.
 *
 * The specs share one server and one database, and sign in as the same
 * account. A budget left behind makes the next spec's sign-in reopen it
 * (U9) instead of showing the "Welcome, <name>" picker it starts from, so every
 * spec runs this afterwards, pass or fail. That also keeps `--repeat-each`
 * runs independent. Uses the API request context, so it does not depend on
 * the page under test being alive.
 * @param {import('@playwright/test').APIRequestContext} request
 */
export async function resetCloudAccount(request) {
  // This server is backed by the disposable e2e database only.
  await request.post('/auth/password', { data: { password: E2E_PASSWORD } });
  const budgets = await (await request.get('/api/budgets')).json();
  for (const b of budgets) await request.delete(`/api/budgets/${b.id}`);
  const cfg = await (await request.get('/api/user/encryption')).json();
  await request.post('/api/user/encryption', { data: { enabled: false, expected: cfg } });
}

/**
 * The open form sheet. Reach every field of a sheet through this locator.
 *
 * A sheet is only `.open` once its first animation frame has run, and that
 * same frame moves focus to its first field. Filling a field before then
 * races the frame: it can land between Playwright focusing the field and
 * typing into it, and the text goes to the first field instead (seen as the
 * amount ending up in Payee, which left "Add & close" disabled). Scoping to
 * `.open` makes the locator wait for that frame.
 * @param {import('@playwright/test').Page} page
 */
export function openSheet(page) {
  return page.locator('.sheet-overlay.open');
}

/**
 * Race detector: `E2E_API_DELAY_MS=400 npx playwright test --project=cloud`
 * holds every browser-side /api call for that long before it reaches the
 * server, the way a busy machine does. A wait that only looks at the UI, not
 * at the state it depends on (a save landing, a reload finishing), stops
 * passing by luck and fails every time. Off by default.
 * @param {import('@playwright/test').BrowserContext} context
 */
export async function applyApiDelay(context) {
  const ms = Number(process.env.E2E_API_DELAY_MS || 0);
  if (!(ms > 0)) return;
  await context.route('**/api/**', async (route) => {
    await new Promise(resolve => setTimeout(resolve, ms));
    await route.fallback();
  });
}
