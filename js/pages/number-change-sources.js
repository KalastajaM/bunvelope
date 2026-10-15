import { state, navigate } from '../app.js';
import { t, fmtDateLang } from '../ui/i18n.js';
import { fmt, fmtNum } from '../utils.js';
import { openSheet } from '../ui/sheet.js';
import { openAccountEdit } from './account-edit.js';
import { openEnvelopeEdit } from './envelope-edit.js';
import { openEditTx } from './edit-tx.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
export function comparisonFieldLabel(key) {
  const label = t('numberChanges.fields.' + key);
  return label === 'numberChanges.fields.' + key
    ? key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()) : label;
}
const pathLabel = path => path.map(key => /^\d+$/.test(key) ? String(Number(key) + 1)
  : comparisonFieldLabel(key === 'rate' && path.includes('fx') ? 'exchangeRate' : key)).join(' · ');
function display(value, format, currency) {
  if (value == null || value === '') return '—';
  if (format === 'money' && Number.isFinite(value)) return fmt(value);
  if (format === 'price' && Number.isFinite(value)) return `${fmtNum(value, { maxDecimals: 10 })}${currency ? ' ' + currency : ''}`;
  if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
  return String(value);
}
export function comparisonDetailTable(source) {
  const wrap = el('div', 'number-changes-table-wrap');
  const table = el('table', 'number-changes-table');
  const head = el('thead', ''); const heading = el('tr', '');
  for (const key of ['field', 'beforeValue', 'afterValue']) heading.append(el('th', '', t('numberChanges.' + key)));
  head.append(heading); table.append(head);
  const body = el('tbody', '');
  for (const detail of source.details || []) {
    const row = el('tr', '');
    row.append(el('th', '', pathLabel(detail.path)), el('td', '', display(detail.before, detail.format, detail.beforeCurrency)), el('td', '', display(detail.after, detail.format, detail.afterCurrency)));
    body.append(row);
  }
  table.append(body); wrap.append(table); return wrap;
}
function openDetails(source) {
  const content = el('div', 'number-changes-record');
  if (source.kind === 'removed') content.append(el('p', 'sub', t('numberChanges.removedRecord')));
  content.append(comparisonDetailTable(source));
  openSheet({ title: source.field ? comparisonFieldLabel(source.field) : source.name, content, wide: true });
}
function openRecord(group, source, close) {
  const record = state[group]?.find?.(row => row.id === source.id);
  if (!record || source.kind === 'removed') return openDetails(source);
  // Stack editors so closing them returns to the comparison; navigation-based
  // editors close the comparison before opening their own page.
  if (group === 'accounts') openAccountEdit(record);
  else if (group === 'envelopes') openEnvelopeEdit(record);
  else if (group === 'transactions') openEditTx(record);
  else if (group === 'budgetItems' || group === 'envelopeTemplates') {
    close(); navigate(group === 'budgetItems' ? 'budget-plan' : 'templates', { editId: source.id });
  } else openDetails(source);
}

export function comparisonSourceTable(step, close) {
  const wrap = el('div', 'number-changes-table-wrap');
  const table = el('table', 'number-changes-table number-changes-source-table');
  const hasValues = step.sources.some(source => source.amount || source.details?.length);
  const hasDates = step.sources.some(source => source.date);
  const head = el('thead', ''); const heading = el('tr', '');
  for (const key of ['item', 'change', ...(hasDates ? ['date'] : []), ...(hasValues ? ['beforeValue', 'afterValue'] : [])]) {
    heading.append(el('th', ['beforeValue', 'afterValue'].includes(key) ? 'number-changes-money' : '', t('numberChanges.' + key)));
  }
  head.append(heading); table.append(head);
  const body = el('tbody', '');
  for (const source of step.sources) {
    const row = el('tr', 'number-changes-source'); row.dataset.sourceId = source.id;
    const preview = source.amount ? { ...source.amount, format: 'money' }
      : source.details?.find(detail => ['money', 'price'].includes(detail.format)) || source.details?.[0];
    const name = el('td', '');
    const link = el('button', 'number-changes-link', source.field ? comparisonFieldLabel(source.field) : source.name);
    link.type = 'button'; link.addEventListener('click', () => openRecord(step.group, source, close));
    name.append(link);
    const fields = [...new Set([
      ...(source.amount ? [t('numberChanges.' + source.amount.label)] : preview ? [pathLabel(preview.path)] : []),
      ...(source.details || []).map(detail => comparisonFieldLabel(detail.path[0])),
    ])];
    if (fields.length) {
      const changes = el('button', 'number-changes-fields', fields.slice(0, 3).join(', ') + (fields.length > 3 ? ` +${fields.length - 3}` : ''));
      changes.type = 'button'; changes.title = t('numberChanges.viewDetails');
      changes.setAttribute('aria-label', `${t('numberChanges.viewDetails')}: ${source.name}`);
      changes.addEventListener('click', () => openDetails(source)); name.append(changes);
    }
    row.append(name, el('td', 'number-changes-kind', t('numberChanges.kinds.' + source.kind)));
    if (hasDates) row.append(el('td', 'number-changes-date-cell', source.date ? fmtDateLang(source.date) : '—'));
    if (hasValues) for (const side of ['before', 'after']) {
      const value = el('td', 'number-changes-value' + (['money', 'price'].includes(preview?.format) ? ' number-changes-money' : ''), display(preview?.[side], preview?.format, preview?.[side + 'Currency']));
      value.dataset.label = t('numberChanges.' + side + 'Value'); row.append(value);
    }
    body.append(row);
  }
  table.append(body); wrap.append(table);
  return wrap;
}
