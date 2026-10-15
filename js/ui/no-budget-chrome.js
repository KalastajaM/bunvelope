// js/ui/no-budget-chrome.js — the shell while no budget is open.
//
// On the welcome screen and in the setup wizard the rail's pages, the
// balance view and the status bar's "Unallocated: —" lead nowhere.
// `html[data-nobudget]` hides them (css/app.css), leaving the brand and
// Tweaks (language, theme). navigate() in js/app.js clears it once a budget
// renders.

/** @param {boolean} on */
export function setNoBudgetChrome(on) {
  if (typeof document === 'undefined') return;
  document.documentElement.toggleAttribute('data-nobudget', on);
}
