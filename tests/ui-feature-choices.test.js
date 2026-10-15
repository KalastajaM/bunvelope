// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
const { prefs } = vi.hoisted(() => ({ prefs: {} }));
vi.mock('../js/app.js', () => ({
  state: { budgetFolder: null }, getPrefs: () => prefs,
  savePrefs: patch => Object.assign(prefs, patch), navigate: vi.fn(),
}));
import { renderTweaks, setUiMode } from '../js/ui/tweaks.js';

beforeEach(() => {
  for (const key of Object.keys(prefs)) delete prefs[key];
  document.body.innerHTML = '<div id="tweaks"></div>';
});

it('seeds from Simple, retains custom choices through Full and locks prerequisites with an explanation', () => {
  prefs.uiMode = 'simple';
  setUiMode('advanced');
  expect(prefs.uiFeatures).toEqual(['detailed-insights', 'recurring-costs']);
  document.getElementById('feature-flow').click();
  expect(prefs.uiFeatures).toContain('reports');
  expect(document.getElementById('feature-reports').disabled).toBe(true);
  expect(document.getElementById('feature-hint-reports').textContent).toContain('Required by:');
  setUiMode('full');
  expect(document.querySelector('.feature-choices')).toBeNull();
  setUiMode('advanced');
  expect(document.getElementById('feature-flow').checked).toBe(true);
  document.getElementById('feature-flow').click();
  expect(document.getElementById('feature-reports').disabled).toBe(false);
  document.getElementById('feature-reports').click();
  expect(prefs.uiFeatures).not.toContain('reports');
});

it('respects an explicitly empty selection and restores focus after a choice', () => {
  Object.assign(prefs, { uiMode: 'advanced', uiFeatures: [] });
  renderTweaks(document.getElementById('tweaks'));
  expect(document.querySelectorAll('input:checked')).toHaveLength(0);
  document.getElementById('feature-templates').click();
  expect(document.activeElement.id).toBe('feature-templates');
  expect(prefs.uiFeatures).toEqual(['templates']);
});
