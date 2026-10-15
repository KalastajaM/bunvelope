// js/pages/budget-plan-cells.js — the monthly-schedule cell grid shared by
// the budget-item editor sheet and the row-chip schedule popover: build,
// paint, wire and read back .bp-mcell elements. Pure DOM helpers — no page
// state; callers own persistence via their onChange callbacks.

import { fmt, escHtml } from '../utils.js';
import { t } from '../ui/i18n.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';

export const QUARTERS = [
  { label: 'Q1', months: ['Jan','Feb','Mar'] },
  { label: 'Q2', months: ['Apr','May','Jun'] },
  { label: 'Q3', months: ['Jul','Aug','Sep'] },
  { label: 'Q4', months: ['Oct','Nov','Dec'] },
];

/** Localised three-letter month label for a schedule cell. */
export function monLabel(mon) {
  return t('bp.monthAbbr.' + mon) || mon.toUpperCase();
}

export function _buildMonthCell(mon, val) {
  const active = val !== undefined && val !== false;
  const isCustom = typeof val === 'number';
  const customAttr = isCustom ? ` data-custom-amt="${Math.abs(val)}"` : '';
  const amtHtml = active
    ? (isCustom
        ? `<div class="bp-mcell-amt">${fmt(Math.abs(val))}</div><div class="bp-mcell-tag">${escHtml(t('bp.cellCustom'))}</div>`
        : `<div class="bp-mcell-amt">${escHtml(t('bp.cellDefault'))}</div>`)
    : `<div class="bp-mcell-amt muted">—</div>`;
  return `<button type="button" class="bp-mcell ${active ? 'active' : ''}" data-mon="${mon}"${customAttr} title="${escHtml(t('bp.cellTitle'))}">
    <div class="bp-mcell-label">${escHtml(monLabel(mon))}</div>
    ${amtHtml}
  </button>`;
}

// ── Set cell contents based on active/custom state ───────────────────────────
export function paintCell(cell, { active, customVal }) {
  const mon = cell.dataset.mon;
  cell.classList.toggle('active', !!active);
  if (customVal !== undefined) cell.dataset.customAmt = customVal;
  else delete cell.dataset.customAmt;

  const label = `<div class="bp-mcell-label">${escHtml(monLabel(mon))}</div>`;
  if (!active) {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    cell.innerHTML = `${label}<div class="bp-mcell-amt muted">—</div>`;
  } else if (customVal !== undefined) {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    cell.innerHTML = `${label}<div class="bp-mcell-amt">${escHtml(fmt(customVal))}</div><div class="bp-mcell-tag">${escHtml(t('bp.cellCustom'))}</div>`;
  } else {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    cell.innerHTML = `${label}<div class="bp-mcell-amt">${escHtml(t('bp.cellDefault'))}</div>`;
  }
}

// ── Wire a month cell: click to toggle active, click amount to set custom ────
export function wireMonthCell(cell, { getDefaultAmt, onChange, allowCustom = () => true }) {
  cell.addEventListener('click', e => {
    if (e.target.classList.contains('bp-mcell-amt-input')) return;
    const mon = cell.dataset.mon;
    const isActive = cell.classList.contains('active');
    const clickedAmount = e.target.classList.contains('bp-mcell-amt') || e.target.classList.contains('bp-mcell-tag');

    if (isActive && clickedAmount && allowCustom()) {
      if (cell.querySelector('.bp-mcell-amt-input')) return;
      const defaultAmt = Math.abs(Number(getDefaultAmt?.()) || 0);
      const inputEl = document.createElement('input');
      inputEl.type = 'number';
      inputEl.className = 'bp-mcell-amt-input';
      inputEl.min = '0'; inputEl.step = '0.01';
      inputEl.placeholder = fmt(defaultAmt);
      const storedCustom = parseFloat(cell.dataset.customAmt);
      if (!isNaN(storedCustom)) inputEl.value = storedCustom;
      enableFormulaInput(inputEl);
      // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
      cell.innerHTML = `<div class="bp-mcell-label">${escHtml(mon.toUpperCase())}</div>`;
      cell.appendChild(inputEl);
      inputEl.focus(); inputEl.select();
      const commit = () => {
        const val = parseAmountInput(inputEl.value);
        const hasCustom = !isNaN(val) && val > 0;
        paintCell(cell, { active: true, customVal: hasCustom ? val : undefined });
        onChange?.();
      };
      inputEl.addEventListener('blur', commit);
      inputEl.addEventListener('keydown', e2 => {
        if (e2.key === 'Enter') { e2.preventDefault(); commit(); }
        else if (e2.key === 'Escape') { commit(); }
      });
      return;
    }

    paintCell(cell, { active: !isActive });
    onChange?.();
  });
}

// ── Collect monthly_schedule object from a list of .bp-mcell elements ────────
export function collectScheduleFromCells(cells) {
  const schedule = {};
  cells.forEach(cell => {
    const mon = cell.dataset.mon;
    if (!cell.classList.contains('active')) return;
    const customInput = cell.querySelector('.bp-mcell-amt-input');
    if (customInput) {
      const val = parseAmountInput(customInput.value);
      schedule[mon] = (!isNaN(val) && val > 0) ? val : true;
      return;
    }
    const stored = parseFloat(cell.dataset.customAmt);
    schedule[mon] = !isNaN(stored) && stored > 0 ? stored : true;
  });
  return schedule;
}
