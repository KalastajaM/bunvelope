// js/state/closed-periods.js — the closed-month rules now live in core, where
// the month.close / month.reopen / month.clearReopen commands use them. This
// file keeps the import path the pages, the guard and the tests already use.
export * from '../core/closed-periods.js';
