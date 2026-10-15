// js/pages/investments-shared.js — helpers used by investments.js and its
// split-out modules (unmapped card, holding dialog). One-directional deps:
// the siblings import from here, never from the host page.

import { state } from '../app.js';
import { fmt } from '../utils.js';
import { listKnownSymbolsWithNames } from '../state/investments.js';

const SYMBOLS_DATALIST_ID = 'inv-symbols-datalist';

export function ensureSymbolsDatalist() {
  let dl = document.getElementById(SYMBOLS_DATALIST_ID);
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = SYMBOLS_DATALIST_ID;
    document.body.append(dl);
  }
  dl.replaceChildren();
  for (const { sym, name } of listKnownSymbolsWithNames(state)) {
    const o = document.createElement('option');
    o.value = sym;
    if (name) o.label = `${sym} — ${name}`;
    dl.append(o);
  }
  return SYMBOLS_DATALIST_ID;
}

// Kept as a name the investments modules already import; `fmt` produces
// exactly this string now that there is only one formatter.
export const fmtMoney = fmt;

/** Investment accounts the Investments page tracks: not archived, not opted out. */
export function trackedInvestmentAccounts(accounts) {
  return (accounts || []).filter(a =>
    a && a.type === 'investment' && !a.archived && a.trackInvestments !== false,
  );
}

export function numCell(text) {
  const td = document.createElement('td');
  td.className = 'money-amount money-table';
  td.style.cssText = 'padding:10px 6px;text-align:right;font-variant-numeric:tabular-nums;';
  td.textContent = text;
  return td;
}
