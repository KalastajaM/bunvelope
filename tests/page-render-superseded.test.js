// @vitest-environment jsdom
// Reports and the dashboard paint a skeleton into the shared #app, yield a
// frame, then fill in the page. navigate() clears #app for the next page
// without waiting for that render, so a page that resumes after the yield must
// see it no longer owns the container and stop, or two pages end up mixed
// (architecture review F4). Reports also re-renders itself on a filter change,
// so the older of two overlapping renders must give way the same way.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render as renderReports } from '../js/pages/reports.js';
import { render as renderDashboard } from '../js/pages/dashboard.js';
import { resetState, mountHosts, flush } from './_fakes/pageApp.js';
import { stubResizeObserver } from './_fakes/resizeObserver.js';

const ledger = () => [
  { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 2000, account: 'chk', status: 'posted' },
  { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Supermarket', amount: 80, account: 'chk', envelope_id: 'food', status: 'posted' },
];

// The next page, painted the way navigate() does: clear, then render.
function navigateAway(app) {
  app.innerHTML = '';
  const other = document.createElement('div');
  other.id = 'other-page';
  app.append(other);
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  stubResizeObserver();
  resetState({ transactions: ledger() });
  mountHosts();
});

describe('a render that resumes after the user moved on', () => {
  it('reports does not overwrite the page that replaced it', async () => {
    const app = document.getElementById('app-root');
    const pending = renderReports(app);
    navigateAway(app);
    await pending;
    await flush();
    expect(app.children).toHaveLength(1);
    expect(app.firstElementChild.id).toBe('other-page');
  });

  it('the dashboard leaves the newer page alone', async () => {
    const app = document.getElementById('app-root');
    const pending = renderDashboard(app);
    navigateAway(app);
    await pending;
    await flush();
    expect(app.children).toHaveLength(1);
    expect(app.firstElementChild.id).toBe('other-page');
  });

  it('of two overlapping reports renders, the newer one is what shows', async () => {
    const app = document.getElementById('app-root');
    const first = renderReports(app);
    const second = renderReports(app);
    await Promise.all([first, second]);
    await flush();
    expect(app.querySelectorAll('.page')).toHaveLength(1);
    expect(app.querySelector('.skeleton, .skel')).toBeNull();
  });

  it('reports still renders when nothing replaced it', async () => {
    const app = document.getElementById('app-root');
    await renderReports(app);
    await flush();
    expect(app.querySelector('.chart-slot')).not.toBeNull();
  });
});
