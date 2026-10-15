// js/ui/theme.js — Light / Dark / System theme preference.
//
// Stored per browser in localStorage `bv-theme`, NOT through savePrefs (those
// sync to the account). js/theme-boot.js applies the same rule before first
// paint and keeps following the OS while the preference is System; this module
// is what the Tweaks panel uses to change it.

export const THEME_KEY = 'bv-theme';
export const THEME_PREFS = /** @type {const} */ (['light', 'dark', 'system']);

/**
 * @param {unknown} value
 * @returns {'light'|'dark'|'system'}
 */
export function normalizeThemePref(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * The theme to render for a stored preference and the OS setting.
 * Anything unrecognised (null, '', a stale value) counts as System.
 * @param {unknown} stored
 * @param {boolean} osDark
 * @returns {'light'|'dark'}
 */
export function resolveTheme(stored, osDark) {
  const pref = normalizeThemePref(stored);
  if (pref === 'system') return osDark ? 'dark' : 'light';
  return pref;
}

/** @returns {'light'|'dark'|'system'} */
export function getThemePref() {
  try { return normalizeThemePref(localStorage.getItem(THEME_KEY)); } catch { return 'system'; }
}

function osPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

/** Re-resolve and write <html data-theme>. */
export function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(getThemePref(), osPrefersDark());
}

/** Store a preference and apply it immediately. */
export function setThemePref(pref) {
  const value = normalizeThemePref(pref);
  try { localStorage.setItem(THEME_KEY, value); } catch { /* storage blocked: still apply for this page load */ }
  applyTheme();
}
