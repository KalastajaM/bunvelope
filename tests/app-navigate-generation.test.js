// @vitest-environment jsdom
// navigate() is called from the router, the nav rail, load paths and the tour.
// A page's module loads lazily on first visit, so a slow load can finish after
// the user has already moved on. It must not paint its page (or its error
// card) into the shared #app over the newer page.
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';

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

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"><div id="app"></div></div>';
  // No budget folder: no URL syncing, no startup-route logic.
  app.state.budgetFolder = null;
});

const appText = () => document.getElementById('app').textContent;
const fastPage = () => ({ render: (container) => { container.textContent = 'fast'; } });

describe('navigate() supersession', () => {
  it('a slow page that lands after a newer navigation does not overwrite it', async () => {
    let release;
    app.registerPage('audit-slow', () => new Promise((resolve) => { release = resolve; }));
    app.registerPage('audit-fast', async () => fastPage());

    const slow = app.navigate('audit-slow');
    await app.navigate('audit-fast');
    release({ render: (container) => { container.textContent = 'slow'; } });
    const slowResult = await slow;

    expect(app.state.currentPage).toBe('audit-fast');
    expect(appText()).toBe('fast');
    expect(slowResult).toBe(false);
  });

  it('a superseded page whose loader rejects does not paint the error card', async () => {
    let fail;
    app.registerPage('audit-slow-bad', () => new Promise((_, reject) => { fail = reject; }));
    app.registerPage('audit-fast-2', async () => fastPage());
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const slow = app.navigate('audit-slow-bad');
    await app.navigate('audit-fast-2');
    fail(new Error('chunk failed'));
    await slow;

    expect(appText()).toBe('fast');
    expect(appText()).not.toContain('chunk failed');
    err.mockRestore();
  });

  it('a current page whose loader rejects still paints the error card', async () => {
    app.registerPage('audit-bad', async () => { throw new Error('chunk failed'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await app.navigate('audit-bad');

    expect(result).toBe(false);
    expect(appText()).toContain('chunk failed');
    err.mockRestore();
  });

  // The view chip is only added for pages in app.js's VIEW_CHIP_PAGES, so
  // these two use real page names with a fake lazy loader.
  const headPage = (container) => {
    container.innerHTML = '<div class="page-head"><h1>Title</h1></div>';
  };

  it('a current renderer gets its view chip', async () => {
    app.registerPage('envelopes', async () => ({ render: headPage }));
    await app.navigate('envelopes');
    expect(document.querySelectorAll('#app .view-chip')).toHaveLength(1);
  });

  it('a superseded renderer that finishes late gets no view chip', async () => {
    let finish;
    app.registerPage('stress', async () => ({
      render: (container) => new Promise((resolve) => {
        headPage(container);
        finish = resolve;
      }),
    }));
    // The newer page has a heading too, which is where a stray chip would land.
    app.registerPage('audit-fast-3', async () => ({ render: headPage }));

    const slow = app.navigate('stress');
    // Let the slow page's module resolve and its render start.
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    await app.navigate('audit-fast-3');
    finish();
    expect(await slow).toBe(false);

    expect(document.querySelectorAll('#app .view-chip')).toHaveLength(0);
    expect(app.state.currentPage).toBe('audit-fast-3');
  });
});
