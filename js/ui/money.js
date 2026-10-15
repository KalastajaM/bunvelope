// js/ui/money.js — DOM renderers for money amounts.
//
// The formatting itself lives in js/utils.js (`fmt` / `fmtParts`). This file
// used to export a SECOND `fmt` with the same name, its own rounding and an
// option spelled `sign` instead of `signed`; pages picked one by import path.
// Only the DOM is here now.

import { fmt, fmtParts, currencyAfterAmount } from '../utils.js';

// size: 'hero' | 'lg' | 'md' | 'inline'
export function moneyEl(value, { size = 'md', role = null, signed = false } = {}) {
  if (role) return amountText(fmt(value, { signed }), role);
  const span = document.createElement('span');
  span.className = `num-${size}`;
  const parts = fmtParts(value, { signed });
  // Not a number: a dash, not the string "NaN" wearing a currency symbol.
  if (!parts) {
    span.textContent = '\u2014';
    return span;
  }
  const after = currencyAfterAmount();
  const cur = document.createElement('span'); cur.className = after ? 'cur cur-after' : 'cur'; cur.textContent = parts.currency;
  if (!after) span.append(cur);
  span.append(document.createTextNode(parts.prefix + parts.whole));
  if (parts.frac) {
    const f = document.createElement('span');
    f.style.opacity = '0.55';
    f.style.fontSize = '0.6em';
    f.textContent = parts.decimal + parts.frac;
    span.append(f);
  }
  // Finnish: "8 531,97 €", the symbol after the number (see fmt).
  if (after) span.append(cur);
  return span;
}

// Named presentation roles use canonical formatting, including currency spacing,
// full-size decimals and the locale's symbol order. No financial math belongs here.
export function amountText(text, role = 'summary') {
  const span = document.createElement('span');
  span.className = `money-amount money-${role}`;
  span.style.setProperty('--money-chars', String(Math.max(1, [...text].length)));
  span.textContent = text;
  return span;
}

// Animated count-up — replaces text content of `el` from its current data-val to `to`.
export function moneyAnimated(el, to, { duration = 600, signed = false } = {}) {
  const from = parseFloat(el.dataset.val || '0');
  const t0 = performance.now();
  function step(t) {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const cur = from + (to - from) * eased;
    renderInto(el, cur, signed);
    if (p < 1) requestAnimationFrame(step);
    else el.dataset.val = String(to);
  }
  requestAnimationFrame(step);
}
function renderInto(el, value, signed) {
  el.innerHTML = '';
  const next = moneyEl(value, { size: sizeFromClass(el), signed });
  while (next.firstChild) el.appendChild(next.firstChild);
}
function sizeFromClass(el) {
  if (el.classList.contains('num-hero')) return 'hero';
  if (el.classList.contains('num-lg')) return 'lg';
  if (el.classList.contains('num-md')) return 'md';
  return 'inline';
}
