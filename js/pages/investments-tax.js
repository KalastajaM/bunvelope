// js/pages/investments-tax.js — the Investments page's "Realised gains for
// tax" card: one calendar year of sales, FIFO acquisition cost beside the
// deemed acquisition cost, and the €1,000 small-sales rules. The figures are
// the `investments.tax` query's (js/core/queries/investments-tax.js); this
// only lays them out.
//
// The Holdings tables above keep average cost, which is the right picture of
// a position. This card is the figure to compare with the broker's tax
// report before filing.

import { state } from '../app.js';
import { ask } from '../ui/query.js';
import { moneyEl } from '../ui/money.js';
import { t, fmtDateLang } from '../ui/i18n.js';
import { fmtNum } from '../utils.js';
import { fmtMoney, numCell } from './investments-shared.js';

// The year picked, kept while the page re-renders; null = newest with sales.
let pickedYear = null;

/** Back to the newest year with sales. The picked year is module state; a test resets it here. */
export function resetPickedTaxYear() {
  pickedYear = null;
}

/**
 * The card, or null when no taxable sale is on record (or the query failed).
 * @param {{ onChange: () => void }} opts  re-render after a year pick
 * @returns {HTMLElement | null}
 */
export function buildTaxCard({ onChange }) {
  const summary = ask('investments.tax', pickedYear !== null ? { year: pickedYear } : {});
  if (!summary || summary.year === null) return null;
  const { years: allYears, year, totals } = summary;
  const accountName = new Map((state.accounts || []).map(a => [a.id, a.name]));

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:16px;';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap;';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.style.margin = '0';
  title.textContent = t('investments.tax.title');
  const yearSel = document.createElement('select');
  yearSel.className = 'form-input';
  yearSel.style.cssText = 'width:auto;';
  yearSel.setAttribute('aria-label', t('investments.tax.year'));
  for (const y of allYears) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    if (y === year) opt.selected = true;
    yearSel.append(opt);
  }
  yearSel.addEventListener('change', () => {
    pickedYear = Number(yearSel.value);
    onChange();
  });
  head.append(title, yearSel);
  card.append(head);

  // ── Totals ────────────────────────────────────────────────────────────
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:12px;margin-bottom:12px;';
  const stat = (label, value, signed = false) => {
    const wrap = document.createElement('div');
    wrap.className = 'money-metric';
    const l = document.createElement('div');
    l.className = 'muted';
    l.style.cssText = 'font-size:12px;';
    l.textContent = label;
    wrap.append(l, moneyEl(value, { role: 'summary', signed }));
    return wrap;
  };
  grid.append(
    stat(t('investments.tax.proceeds'), totals.grossProceeds),
    stat(t('investments.tax.deductedCost'), totals.deductedCost),
    stat(t('investments.tax.gains'), totals.gains),
    stat(t('investments.tax.losses'), totals.losses, true),
    stat(t('investments.tax.net'), totals.net, true),
  );
  card.append(grid);

  // ── Per-sale table ────────────────────────────────────────────────────
  const scroller = document.createElement('div');
  scroller.style.cssText = 'overflow-x:auto;';
  scroller.setAttribute('data-scroll-cue', '');
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;min-width:640px;border-collapse:collapse;font-size:13px;';
  const cols = ['date', 'symbol', 'units', 'proceeds', 'cost', 'actual', 'deemed', 'taxable'];
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const key of cols) {
    const th = document.createElement('th');
    th.textContent = t(`investments.tax.col.${key}`);
    th.style.cssText = 'text-align:left;padding:8px 6px;border-bottom:1px solid var(--border, #e5e7eb);font-weight:600;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;';
    if (!['date', 'symbol'].includes(key)) th.style.textAlign = 'right';
    trh.append(th);
  }
  thead.append(trh);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const s of summary.sales) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border, #e5e7eb)';
    const dateTd = document.createElement('td');
    dateTd.style.cssText = 'padding:10px 6px;white-space:nowrap;';
    dateTd.textContent = fmtDateLang(s.date);
    const symTd = document.createElement('td');
    symTd.style.cssText = 'padding:10px 6px;';
    const sym = document.createElement('div');
    sym.style.fontWeight = '600';
    sym.textContent = s.symbol;
    const acct = document.createElement('div');
    acct.className = 'muted';
    acct.style.fontSize = '11px';
    acct.textContent = accountName.get(s.accountId) || s.accountId;
    symTd.append(sym, acct);
    const costTd = numCell(fmtMoney(s.cost));
    costTd.title = t('investments.tax.costHint')(fmtMoney(s.acquisitionCost), fmtMoney(s.fee));
    const taxTd = numCell(fmtMoney(s.taxableGain, { signed: true }));
    taxTd.style.fontWeight = '600';
    const how = document.createElement('div');
    how.className = 'muted';
    how.style.cssText = 'font-size:11px;font-weight:400;';
    how.textContent = s.method === 'deemed' ? t('investments.tax.methodDeemed') : t('investments.tax.methodActual');
    taxTd.append(how);
    tr.append(
      dateTd,
      symTd,
      numCell(fmtNum(s.units, { maxDecimals: 6 })),
      numCell(fmtMoney(s.grossProceeds)),
      costTd,
      numCell(s.actualGain === null ? '—' : fmtMoney(s.actualGain, { signed: true })),
      numCell(fmtMoney(s.deemedGain, { signed: true })),
      taxTd,
    );
    tbody.append(tr);
  }
  table.append(tbody);
  scroller.append(table);
  card.append(scroller);

  // ── Notes ─────────────────────────────────────────────────────────────
  const notes = [];
  // The €1,000 thresholds are euros; in another currency they do not apply.
  const euro = (state.meta?.currency || 'EUR') === 'EUR';
  if (euro && summary.gainsExempt && totals.gains > 0) notes.push(t('investments.tax.noteExempt'));
  if (euro && !summary.lossesDeductible && totals.losses < 0) notes.push(t('investments.tax.noteLossesNotDeductible'));
  if (summary.salesWithoutCost > 0) notes.push(t('investments.tax.noteNoCost')(summary.salesWithoutCost));
  notes.push(t('investments.tax.noteRules'));
  for (const text of notes) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.style.cssText = 'font-size:12px;margin-top:8px;line-height:1.4;';
    p.textContent = text;
    card.append(p);
  }
  return card;
}
