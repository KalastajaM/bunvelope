// js/ui/loan-schedule-sheet.js — a loan account's repayment plan: which plan
// item pays it, its schedule (engine loanSchedule), and the side panel that
// lists every payment to the payoff.

import { openSheet } from './sheet.js';
import { moneyEl } from './money.js';
import { t, fmtDateLang, fmtMonthLang } from './i18n.js';
import { fmt } from '../utils.js';

/** @typedef {import('../engine/loan-schedule.js').LoanRepayment} LoanRepayment */

/** The one-line payoff for a loan's card, or '' when there is nothing to say. @param {LoanRepayment} r */
export function loanPayoffLine(r) {
  if (r.status === 'shared') return t('loanSchedule.shared');
  if (r.status === 'none') return t('loanSchedule.noPlan');
  const s = r.schedule;
  if (s.ends === 'repaid' && s.payoffDate) return t('loanSchedule.paidOffBy')(fmtMonthLang(s.payoffDate.slice(0, 7)));
  if (s.ends === 'not_repaid') return t('loanSchedule.notRepaid');
  if (s.ends === 'plan_ends') return t('loanSchedule.planEnds')(fmtMonthLang(s.rows[s.rows.length - 1].monthKey), fmt(s.owedAtEnd));
  return '';
}

function stat(label, value) {
  const box = document.createElement('div');
  box.className = 'loan-schedule-stat';
  const l = document.createElement('div');
  l.className = 'loan-schedule-stat-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'loan-schedule-stat-value';
  if (value instanceof Node) v.append(value); else v.textContent = value;
  box.append(l, v);
  return box;
}

function moneyCell(value, cls = '') {
  const td = document.createElement('td');
  td.className = `num ${cls}`.trim();
  td.append(moneyEl(value, { size: 'inline' }));
  return td;
}

function textCell(text, cls = '') {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

/**
 * The schedule as a table: a row per payment, under a row per calendar year
 * that totals it and gives what is owed at its end.
 * @param {import('../engine/loan-schedule.js').LoanSchedule} s
 */
function scheduleTable(s) {
  const withFees = s.totalFees > 0;
  const table = document.createElement('table');
  table.className = 'tx-table loan-schedule-table';
  const caption = document.createElement('caption');
  caption.className = 'sr-only';
  caption.textContent = t('loanSchedule.title');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const cols = ['colDate', 'colPayment', 'colInterest', ...(withFees ? ['colFee'] : []), 'colPrincipal', 'colOwed'];
  for (const key of cols) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = t(`loanSchedule.${key}`);
    if (key !== 'colDate') th.className = 'num';
    hr.append(th);
  }
  thead.append(hr);
  table.append(caption, thead);

  /** @type {Map<string, typeof s.rows>} */
  const byYear = new Map();
  for (const r of s.rows) {
    const y = r.monthKey.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)?.push(r);
  }
  const sum = (/** @type {typeof s.rows} */ rows, /** @type {'payment'|'interest'|'fee'|'principal'} */ k) =>
    Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
  for (const [year, rows] of byYear) {
    const tbody = document.createElement('tbody');
    const yr = document.createElement('tr');
    yr.className = 'loan-schedule-year';
    const yh = document.createElement('th');
    yh.scope = 'rowgroup';
    yh.textContent = year;
    yr.append(yh, moneyCell(sum(rows, 'payment')), moneyCell(sum(rows, 'interest')));
    if (withFees) yr.append(moneyCell(sum(rows, 'fee')));
    yr.append(moneyCell(sum(rows, 'principal')), moneyCell(-rows[rows.length - 1].owedAfter));
    tbody.append(yr);
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.append(textCell(fmtDateLang(r.date)), moneyCell(r.payment), moneyCell(r.interest));
      if (withFees) tr.append(moneyCell(r.fee));
      tr.append(moneyCell(r.principal), moneyCell(-r.owedAfter));
      tbody.append(tr);
    }
    table.append(tbody);
  }
  return table;
}

/**
 * The side panel listing a loan's payments to the payoff.
 * @param {any} account
 * @param {import('../core/queries/accounts-detail.js').RepaymentAnswer} r  accounts.detail's repayment, the ok shape
 */
export function openLoanScheduleSheet(account, r) {
  const { item, schedule: s } = r;
  const wrap = document.createElement('div');
  wrap.className = 'loan-schedule';

  const stats = document.createElement('div');
  stats.className = 'loan-schedule-stats';
  const methodKey = { fixed_payment: 'budgetPlan.loanMethodFixed', annuity: 'budgetPlan.loanMethodAnnuity', equal_principal: 'budgetPlan.loanMethodEqual' }[s.method];
  stats.append(
    stat(t('loanSchedule.owedNow'), moneyEl(-s.owedNow, { size: 'inline' })),
    stat(t('loanSchedule.nextPayment'), s.rows.length ? moneyEl(s.rows[0].payment, { size: 'inline' }) : '–'),
    stat(t('loanSchedule.paidOff'), s.payoffDate ? fmtMonthLang(s.payoffDate.slice(0, 7)) : loanPayoffLine(r) || '–'),
    stat(t('loanSchedule.totalInterest'), moneyEl(s.totalInterest + s.totalFees, { size: 'inline' })),
    stat(t('budgetPlan.loanMethod'), t(methodKey)),
  );
  const note = document.createElement('p');
  note.className = 'muted loan-schedule-note';
  note.textContent = t('loanSchedule.note')(item.description || account.name);

  wrap.append(stats, note);
  if (s.rows.length) {
    const scroller = document.createElement('div');
    scroller.className = 'loan-schedule-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', t('loanSchedule.title'));
    scroller.append(scheduleTable(s));
    wrap.append(scroller);
  }
  return openSheet({ title: t('loanSchedule.titleFor')(account.name), content: wrap, wide: true });
}
