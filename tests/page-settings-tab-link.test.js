// @vitest-environment jsdom
// navigate('settings', { tab }) opens that Settings tab: the status-bar
// badge's sheet links to Clean-up this way. The filter is consumed once, so
// a later plain visit to Settings keeps whatever tab was last chosen.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => ({
  ...(await import('./_fakes/pageApp.js')).appStub,
  savePrefs: vi.fn(),
  runDataCheck: vi.fn(async () => ({ report: { totalProblems: 0 }, extras: { archivedFuture: [] } })),
  openDataCheckSheet: vi.fn(),
}));

import { render } from '../js/pages/settings.js';
import { state, resetState, mountHosts, flush } from './_fakes/pageApp.js';
import { t } from '../js/ui/i18n.js';

const activeTab = () => document.querySelector('.content-tab.is-active')?.dataset.tab;

beforeEach(() => {
  mountHosts();
  resetState();
});

describe('Settings deep link to a tab', () => {
  it('puts the budgeting guide collection on the Help tab', async () => {
    const host = document.getElementById('app-root');
    state.pendingFilter = { tab: 'help' };
    await render(host);
    expect(activeTab()).toBe('help');
    expect(host.querySelector('.budget-guides h3').textContent).toBe(t('guides.title'));
    expect(host.querySelectorAll('.guide-list button')).toHaveLength(5);
  });
  it('opens the tab named in the navigation filter, then forgets it', async () => {
    const host = document.getElementById('app-root');
    state.pendingFilter = { tab: 'cleanup' };
    await render(host);
    await flush();
    expect(activeTab()).toBe('cleanup');
    expect(state.pendingFilter).toBeNull();
  });

  it('ignores a tab name it does not have', async () => {
    const host = document.getElementById('app-root');
    state.pendingFilter = { tab: 'budget' };
    await render(host);
    host.replaceChildren();
    state.pendingFilter = { tab: 'nope' };
    await render(host);
    expect(activeTab()).toBe('budget');
  });

  // BACKLOG 2026-10-05 (phone width): the tabs are one strip that scrolls
  // inside itself with the edge cue, styled by class rather than inline.
  it('renders the tabs as a scroll-cued strip', async () => {
    const host = document.getElementById('app-root');
    state.pendingFilter = { tab: 'cleanup' };
    await render(host);
    const strip = document.querySelector('.content-tabs');
    expect(strip?.hasAttribute('data-scroll-cue')).toBe(true);
    const active = document.querySelector('.content-tab.is-active');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.getAttribute('style')).toBeNull();
  });
});

it('keeps tab focus during selection and a direct page rerender', async () => {
  const host = document.getElementById('app-root');
  state.pendingFilter = { tab: 'budget' };
  await render(host);
  const first = host.querySelector('[role=tab][aria-selected=true]');
  first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const selected = host.querySelector('[role=tab][aria-selected=true]');
  expect(selected.dataset.tab).toBe('cleanup');
  expect(document.activeElement).toBe(selected);
  expect(host.querySelector('[role=tab]')).toBe(first);
  await render(host);
  expect(document.activeElement).toBe(host.querySelector('[role=tab][aria-selected=true]'));
  expect(host.querySelectorAll('[role=tabpanel]:not([hidden])')).toHaveLength(1);
  expect(host.querySelector('#settings-body')).not.toBeNull();
  await flush();
});
