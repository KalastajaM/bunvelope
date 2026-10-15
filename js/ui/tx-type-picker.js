// js/ui/tx-type-picker.js — the transaction-type row of the add and edit
// sheets: one icon button per type, each named by a tooltip and an
// aria-label, the chosen one highlighted. There are up to seven types, and
// labelled buttons wrapped and clipped ("Investmen"), so the row carries
// icons and the sheet title names the choice ("New expense"; owner choice
// 2026-10-02).

import { icon } from './icon.js';

const TYPE_ICONS = {
  expense: 'tx-expense',
  income: 'tx-income',
  account_transfer: 'tx',
  envelope_transfer: 'tx-envelope-transfer',
  investment_transfer: 'tx-investment',
  loan_payment: 'tx-loan-payment',
  loan_given: 'tx-loan-given',
};

/**
 * The icon button row. `onPick(value)` runs on a click; `setActive(value)`
 * moves the highlight when the type changes another way.
 *
 * @param {Array<[string, string]>} types  [value, label] pairs
 * @param {string} value
 * @param {(value: string) => void} onPick
 */
export function txTypePicker(types, value, onPick) {
  const row = document.createElement('div');
  row.className = 'tx-type-btns tx-type-btns--icons';
  row.setAttribute('role', 'group');
  for (const [v, label] of types) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tx-type-btn';
    btn.dataset.value = v;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(icon(TYPE_ICONS[v] || 'tx', 20));
    btn.addEventListener('click', () => onPick(v));
    row.append(btn);
  }
  const setActive = (/** @type {string} */ v) => {
    for (const b of row.querySelectorAll('.tx-type-btn')) {
      const on = /** @type {HTMLElement} */ (b).dataset.value === v;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  setActive(value);
  return { el: row, setActive };
}
