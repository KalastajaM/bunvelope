// js/ui/display-name.js — currency and country names in the UI language.
//
// Labels come from Intl.DisplayNames, so a new app locale needs no new
// dictionary entries. `fallback` is the English name for engines without
// DisplayNames support (the second element of CURRENCIES / COUNTRIES in
// js/core/settings-fields.js). Shared by Settings and the setup wizard.

import { langLocale } from './i18n.js';

/**
 * @param {'currency'|'region'} type
 * @param {string} code ISO currency or region code
 * @param {string} fallback
 * @returns {string}
 */
export function displayName(type, code, fallback) {
  try {
    return new Intl.DisplayNames([langLocale()], { type })?.of(code) || fallback;
  } catch {
    return fallback;
  }
}
