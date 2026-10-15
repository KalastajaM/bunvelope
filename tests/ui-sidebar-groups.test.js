// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { applyPrefs, buildShell, highlightActive, setNavItemVisible } from '../js/ui/shell.js';

let navigate, save;
const toggle = (page) => document.querySelector(`[data-group="${page}"] .rail-submenu-toggle`);
const submenu = (page) => document.getElementById(`rail-submenu-${page}`);

beforeEach(() => {
  // jsdom lacks CSS.escape; these page IDs contain only safe identifier characters.
  vi.stubGlobal('CSS', { escape: (s) => String(s) });
  document.body.replaceChildren();
  for (const id of ['app-root', 'rail', 'topnav', 'statusbar']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.append(el);
  }
  applyPrefs({ uiMode: 'full' });
  navigate = vi.fn();
  save = vi.fn();
  buildShell({ onNavigate: navigate, onUnallocatedClick: vi.fn(), onTweaksToggle: vi.fn(), onHelpClick: vi.fn(), onRailGroupsChange: save });
});

describe('sidebar submenus', () => {
  it('starts every submenu collapsed without saved preferences', () => {
    for (const group of document.querySelectorAll('#rail [data-group]')) {
      expect(submenu(group.dataset.group).hidden).toBe(true);
      expect(toggle(group.dataset.group).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('toggles children separately from navigation and keeps the choice on navigation', () => {
    applyPrefs({ collapsedRailGroups: [] });
    expect(toggle('dashboard').getAttribute('aria-expanded')).toBe('true');
    toggle('dashboard').click();
    expect(submenu('dashboard').hidden).toBe(true);
    expect(toggle('dashboard').textContent).toBe('+');
    expect(toggle('dashboard').getAttribute('aria-controls')).toBe(submenu('dashboard').id);
    expect(toggle('dashboard').getAttribute('aria-label')).toBe('Expand Overview');
    expect(navigate).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(['dashboard']);
    document.querySelector('#rail [data-page="transactions"]').click();
    expect(navigate).toHaveBeenCalledWith('transactions');
    highlightActive('detailed-insights');
    expect(submenu('dashboard').hidden).toBe(true);
    expect(document.querySelector('#rail [data-page="dashboard"]').classList.contains('parent-active')).toBe(true);
    toggle('dashboard').click();
    expect(submenu('dashboard').hidden).toBe(false);
    expect(save).toHaveBeenLastCalledWith([]);
  });

  it('parent activation opens but never closes, including Enter and Space', () => {
    applyPrefs({ collapsedRailGroups: ['dashboard'] });
    const parent = document.querySelector('#rail [data-page="dashboard"]');
    parent.click();
    expect(submenu('dashboard').hidden).toBe(false);
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(navigate).toHaveBeenLastCalledWith('dashboard');
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(submenu('dashboard').hidden).toBe(false);
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(submenu('dashboard').hidden).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1);
    toggle('dashboard').click();
    expect(submenu('dashboard').hidden).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it('restores saved groups and ignores malformed preferences', () => {
    applyPrefs({ collapsedRailGroups: ['dashboard', 'accounts'] });
    expect(submenu('dashboard').hidden).toBe(true);
    expect(submenu('accounts').hidden).toBe(true);
    expect(submenu('budget-plan').hidden).toBe(false);
    applyPrefs({ collapsedRailGroups: [] });
    expect(submenu('dashboard').hidden).toBe(false);
    applyPrefs({ collapsedRailGroups: 'dashboard' });
    expect(submenu('dashboard').hidden).toBe(true);
  });

  it('hides empty toggles in simple mode and when child pages are unavailable', () => {
    applyPrefs({ uiMode: 'simple' });
    expect(toggle('accounts').hidden).toBe(true);
    expect(toggle('dashboard').hidden).toBe(false);
    setNavItemVisible('detailed-insights', false);
    expect(toggle('dashboard').hidden).toBe(true);
    setNavItemVisible('detailed-insights', true);
    expect(toggle('dashboard').hidden).toBe(false);
    expect(document.querySelector('[data-group="transactions"]')).toBeNull();
  });
});

describe('advanced navigation', () => {
  it('hides optional views in both navigation layouts and keeps essential setup reachable', () => {
    applyPrefs({ uiMode: 'advanced', uiFeatures: [] });
    for (const page of ['accounts', 'envelopes', 'transactions', 'budget-plan', 'settings']) {
      for (const el of document.querySelectorAll(`[data-page="${page}"]`)) expect(el.hasAttribute('data-feature-hidden')).toBe(false);
    }
    for (const page of ['templates', 'reports', 'flow', 'recurring-costs', 'investments']) {
      for (const el of document.querySelectorAll(`[data-page="${page}"]`)) expect(el.hasAttribute('data-feature-hidden')).toBe(true);
    }
    expect(toggle('dashboard').hidden).toBe(true);
    expect(toggle('accounts').hidden).toBe(true);
    expect(document.documentElement.dataset.balanceViews).toBe('false');
    applyPrefs({ uiMode: 'advanced', uiFeatures: ['flow', 'balance-views'] });
    expect(toggle('reports').hidden).toBe(false);
    expect(document.querySelector('.topnav-item[data-page="reports"]').hasAttribute('data-feature-hidden')).toBe(false);
    expect(document.documentElement.dataset.balanceViews).toBe('true');
  });

  it('does not override service availability when switching modes or rebuilding the shell', () => {
    setNavItemVisible('insights', false);
    applyPrefs({ uiMode: 'advanced', uiFeatures: ['insights'] });
    expect(document.querySelector('[data-page="insights"]').hidden).toBe(true);
    applyPrefs({ uiMode: 'advanced', uiFeatures: [] });
    buildShell({ onNavigate: navigate, onTweaksToggle: vi.fn() });
    expect(toggle('dashboard').hidden).toBe(true);
    expect(document.querySelector('[data-page="templates"]').hasAttribute('data-feature-hidden')).toBe(true);
  });
});
