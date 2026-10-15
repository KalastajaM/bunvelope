// js/change-log-sheet.js — read-only view of the audit trail: edits to money
// on existing transactions and deletions, newest first, each with what the
// row was and what it became. The rule for what is recorded lives in
// js/state/change-log.js; nothing here writes.

import { state } from './app.js';
import { openSheet } from './ui/sheet.js';
import { t, fmtDateLang } from './ui/i18n.js';
import { fmt } from './utils.js';
import { txAbsAmount } from './engine.js';
import { isoDate } from './core/context.js';
import { validHistory } from './core/financial-history.js';
import { getChangeLog } from './state/change-log.js';

// Shown at most; the log itself keeps CHANGE_LOG_CAP.
const SHOWN = 200;

const accountName = (id) => (state.accounts || []).find(a => a.id === id)?.name || id;
const envelopeName = (id) => (id ? (state.envelopes || []).find(e => e.id === id)?.name || id : t('changeLog.none'));

/**
 * One field's value as the sheet prints it.
 * @param {string} field
 * @param {any} row
 * @returns {string}
 */
function fieldValue(field, row) {
  const v = row?.[field];
  if (v === undefined || v === null || v === '') return t('changeLog.none');
  switch (field) {
    case 'amount': return fmt(row.type === 'adjustment' ? Number(v) : txAbsAmount(row), { signed: row.type === 'adjustment' });
    case 'fee': return fmt(Number(v));
    case 'date': return fmtDateLang(String(v).slice(0, 10));
    case 'account': case 'from_account': case 'to_account': return accountName(v);
    case 'envelope_id': case 'from_envelope_id': case 'to_envelope_id': return envelopeName(v);
    case 'cleared': return v ? t('changeLog.yes') : t('changeLog.no');
    case 'envelope_splits':
      return Array.isArray(v) ? v.map(s => `${envelopeName(s?.envelope_id)} ${fmt(Number(s?.amount) || 0)}`).join(', ') : String(v);
    case 'lines': return Array.isArray(v) ? t('changeLog.lines')(v.length) : String(v);
    default: return String(v);
  }
}

/**
 * When the change was made, as date and local time.
 * @param {string} at
 */
function whenText(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at || '');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${fmtDateLang(isoDate(d))} ${hh}:${mm}`;
}

export function openChangeLogSheet() {
  const recorded = state.meta?.financialHistory;
  const earliest = validHistory(recorded) ? recorded.previous?.[0]?.start.at || recorded.start.at : null;
  const log = getChangeLog(state.meta).filter(e => !earliest || e.at < earliest);
  const content = document.createElement('div');

  const history = state.meta?.financialHistory;
  if (validHistory(history)) {
    const title = document.createElement('h3'); title.textContent = t('numberChanges.historyTitle'); content.append(title);
    const info = document.createElement('p'); info.className = 'sub'; info.textContent = t('numberChanges.historyIntro'); content.append(info);
    const entries = [...(history.previous || []).flatMap(h => h.entries), ...history.entries];
    if (history.gap) { const gap = document.createElement('p'); gap.textContent = t('numberChanges.historyGap'); content.append(gap); }
    for (const entry of entries.slice(-SHOWN).reverse()) {
      const block = document.createElement('details'); block.className = 'number-changes-step';
      const summary = document.createElement('summary'); summary.textContent = whenText(entry.at); block.append(summary);
      for (const [kind, diff] of Object.entries(entry.diff)) {
        const heading = document.createElement('h4'); heading.textContent = t('numberChanges.groups.' + (kind === 'meta' ? 'settings' : kind)); block.append(heading);
        const list = document.createElement('ul');
        if (kind === 'meta') {
          for (const field of diff.changed) {
            const item = document.createElement('li'); item.textContent = field.key === 'investments' ? t('numberChanges.groups.investments') : `${t('numberChanges.settingsChanged')}: ${field.key}`; list.append(item);
          }
        } else {
          for (const [op, changes] of [['added', diff.added], ['edited', diff.changed], ['removed', diff.removed]]) {
            for (const change of changes) {
              const record = change.row || change.after || change.before;
              const item = document.createElement('li');
              item.textContent = `${t('numberChanges.kinds.' + op)} · ${record.name || record.description || record.payee || record.id}`;
              if (record.date) item.textContent += ` · ${fmtDateLang(record.date)}`;
              if (record.amount !== undefined) item.textContent += ` · ${change.before ? `${fieldValue('amount', change.before)} → ` : ''}${fieldValue('amount', record)}`;
              list.append(item);
            }
          }
          if (diff.order) { const item = document.createElement('li'); item.textContent = t('numberChanges.reordered'); list.append(item); }
        }
        block.append(list);
      }
      content.append(block);
    }
    if (log.length) { const title = document.createElement('h3'); title.textContent = t('numberChanges.historyLegacy'); content.append(title); }
  }
  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.style.cssText = 'font-size:13px;margin:0 0 12px;';
  intro.textContent = t('changeLog.intro');
  if (!history || log.length) content.append(intro);

  if (!log.length && !history) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.cssText = 'font-size:13px;';
    empty.textContent = t('changeLog.empty');
    content.append(empty);
  }

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  for (const entry of log.slice(-SHOWN).reverse()) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm, 6px);font-size:13px;';

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;';
    const what = document.createElement('span');
    what.style.fontWeight = '500';
    const before = entry.before || {};
    const payee = before.payee || before.note || t('changeLog.noPayee');
    what.textContent = `${entry.op === 'delete' ? t('changeLog.deleted') : t('changeLog.edited')} · ${payee} · ${fmtDateLang(String(before.date || '').slice(0, 10))}`;
    const when = document.createElement('span');
    when.className = 'muted';
    when.style.cssText = 'font-size:12px;white-space:nowrap;';
    when.textContent = whenText(entry.at);
    top.append(what, when);
    row.append(top);

    const detail = document.createElement('div');
    detail.className = 'muted';
    detail.style.cssText = 'font-size:12px;margin-top:4px;line-height:1.5;';
    if (entry.op === 'delete') {
      detail.textContent = t('changeLog.deletedDetail')(fieldValue('amount', before), accountName(before.account || before.from_account || ''));
    } else {
      for (const f of entry.fields || []) {
        const line = document.createElement('div');
        line.textContent = `${t(`changeLog.field.${f}`) || f}: ${fieldValue(f, before)} → ${fieldValue(f, entry.after)}`;
        detail.append(line);
      }
    }
    row.append(detail);
    list.append(row);
  }
  content.append(list);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');
  const { close } = openSheet({ title: t('changeLog.title'), content, wide: true, headerActions: [closeBtn] });
  closeBtn.addEventListener('click', close);
}
