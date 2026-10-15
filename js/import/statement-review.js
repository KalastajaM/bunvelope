import { queryAnswer } from '../ai/query.js';
import { t } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { parseAmountInput } from '../ui/amount-input.js';
import { isoDate } from '../core/context.js';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action, accent = false) => {
  const node = el('button', text, `btn btn-sm ${accent ? 'btn-accent' : 'btn-ghost'}`);
  node.type = 'button'; node.addEventListener('click', action); return node;
};
const field = (label, input) => {
  const node = el('label', null, 'field');
  input.setAttribute('aria-label', label);
  node.append(el('span', label), input);
  return node;
};

/** Shared preflight for account statements and reconciliation imports. Writes nothing. */
export function renderStatementReview({ host, setHeaderActions, getState, accountId, rows, clock,
  initialTarget = null, initialDate = null, initialBasis = 'booked', checked, active, onContinue, onBack }) {
  const sources = rows.map((r, i) => ({ ...r, key: `statement:${i}`, date: r.date instanceof Date ? isoDate(r.date) : r.date }));
  const queryRows = sources.map(({ key, date, payee, amount, bankStatus, bankBalance }) => ({ key, date, payee: payee || '', amount,
    ...(bankStatus ? { bankStatus } : {}), ...(Number.isFinite(bankBalance) ? { bankBalance } : {}) }));
  let selected;
  let result;
  let snapshot;
  let busy = false;
  const opened = new Map([['missing', true], ['review', true]]);
  const root = el('div', null, 'statement-review');
  const controls = el('div', null, 'statement-review-controls');
  const target = el('input'); target.type = 'text'; target.inputMode = 'decimal'; target.className = 'form-input';
  if (Number.isFinite(initialTarget)) target.value = String(initialTarget);
  const date = el('input'); date.type = 'date'; date.className = 'form-input';
  if (initialDate) date.value = initialDate;
  const basis = el('select', null, 'form-input');
  for (const value of ['booked', 'available']) { const opt = el('option', t(`statementReview.${value}`)); opt.value = value; basis.append(opt); }
  basis.value = initialBasis;
  const targetField = field(t('statementReview.target'), target); targetField.classList.add('statement-review-target');
  const basisField = field(t('statementReview.basis'), basis); basisField.classList.add('statement-review-basis');
  const dateField = field(t('statementReview.date'), date); dateField.classList.add('statement-review-date');
  controls.append(targetField, ...(checked === undefined ? [basisField] : []), dateField);
  root.append(controls);
  const balance = el('div', null, 'statement-review-balance');
  balance.setAttribute('aria-live', 'polite');
  balance.style.cssText = 'padding:12px;background:var(--surface-alt);border-radius:8px;margin:8px 0 14px;';
  const groups = el('div');
  const status = el('p', '', 'muted'); status.setAttribute('role', 'status');
  root.append(balance, groups, status);
  host.replaceChildren(root);
  const footer = el('div'); footer.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
  const count = el('span', '', 'muted');
  const next = button(t('statementReview.continue'), async () => {
    if (!active() || busy) return;
    const before = snapshot;
    refresh();
    if (before !== snapshot) { status.textContent = t('statementReview.changed'); return; }
    busy = true; next.disabled = true;
    try {
      const chosen = new Map(result.rows.filter(r => r.included).map(r => [r.key, r]));
      await onContinue(sources.filter(r => chosen.has(r.key)).map(r => ({ ...r, importReviewed: true, importMatch: chosen.get(r.key).match })), result);
    } finally { busy = false; next.disabled = false; }
  }, true);
  footer.append(count, button(t('txImport.backBtn'), onBack), next);
  setHeaderActions(footer);

  function ask() {
    const amount = target.value.trim() ? parseAmountInput(target.value) : NaN;
    return queryAnswer(getState(), 'import.review', { account: accountId, rows: queryRows,
      ...(Number.isFinite(amount) ? { target: amount } : {}), ...(date.value ? { date: date.value } : {}),
      ...(checked !== undefined ? { checked } : {}),
      basis: basis.value, ...(selected ? { selected: [...selected] } : {}) }, clock);
  }
  function refresh() {
    const previousContext = result?.context;
    result = ask();
    if (previousContext && previousContext !== result.context) {
      selected = undefined;
      result = ask();
    }
    if (!selected) selected = new Set(result.rows.filter(r => r.included).map(r => r.key));
    // Includes current ledger and classifications, so another edit needs a fresh approval.
    snapshot = JSON.stringify(result);
    if (!date.value) date.value = result.balance.date;
    if (!target.value && result.balance.target !== null) target.value = String(result.balance.target);
    balance.replaceChildren();
    const b = result.balance;
    if (b.ledgerRemaining !== null) balance.append(el('strong', t('statementReview.remaining')(fmt(b.ledgerRemaining, { signed: true }))));
    balance.append(el('p', t(checked === undefined ? 'statementReview.totals' : 'statementReview.checkedTotals')(fmt(b.ledger), fmt(b.selectedDelta, { signed: true }), fmt(b.projected))));
    if (checked === undefined && (b.pendingTotal || b.pendingRecorded)) balance.append(el('p', t('statementReview.comparison')(t(`statementReview.${b.basis}`), fmt(b.comparisonLedger), fmt(b.comparisonProjected)), 'muted'));
    if (checked === undefined && b.pendingRecorded) balance.append(el('p', t('statementReview.pendingExplanation')(fmt(b.pendingRecorded, { signed: true }), fmt(b.bookedEstimate))));
    const suggestionKey = checked !== undefined && result.suggestion.status === 'balanced' ? 'checkedBalanced'
      : checked !== undefined && result.suggestion.status === 'unique' ? 'checkedUnique' : `suggestion.${result.suggestion.status}`;
    balance.append(el('p', t(`statementReview.${suggestionKey}`), 'muted'));
    if (result.suggestion.status === 'unique') balance.append(button(t('statementReview.useSuggestion'), () => {
      selected = new Set(result.suggestion.keys); refresh();
    }));
    groups.replaceChildren();
    for (const group of ['missing', 'review', 'recorded', 'pending']) {
      const entries = result.rows.filter(r => r.group === group);
      if (!entries.length) continue;
      const details = el('details'); details.dataset.group = group; details.open = opened.get(group) || false;
      details.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;';
      details.addEventListener('toggle', () => opened.set(group, details.open));
      details.append(el('summary', `${t(`statementReview.groups.${group}`)} (${entries.length})`));
      const actions = el('div'); actions.style.cssText = 'display:flex;gap:8px;margin:10px 0;';
      for (const include of [true, false]) actions.append(button(t(include ? 'statementReview.includeAll' : 'statementReview.excludeAll'), () => {
        for (const r of entries) { if (include && !r.afterDate) selected.add(r.key); else selected.delete(r.key); } refresh();
      }));
      details.append(actions);
      for (const row of entries) {
        const line = el('label'); line.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-top:1px solid var(--border);';
        const check = el('input'); check.type = 'checkbox'; check.checked = row.included; check.disabled = row.afterDate;
        check.style.marginTop = '4px'; check.setAttribute('aria-label', `${row.date} ${row.payee} ${fmt(row.amount)}`);
        check.addEventListener('change', () => { if (check.checked) selected.add(row.key); else selected.delete(row.key); refresh(); });
        const text = el('div'); text.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;';
        text.append(el('div', `${row.date} · ${row.payee || '—'} · ${fmt(row.amount, { signed: true })}`));
        if (row.match) text.append(el('small', t('statementReview.match')(row.match.date, row.match.payee || '—', fmt(row.match.amount, { signed: true })), 'muted'));
        if (row.adjustmentDate && group !== 'recorded') text.append(el('p', t('statementReview.adjustment')(row.adjustmentDate), 'muted'));
        if (row.afterDate) text.append(el('small', t('statementReview.afterDate'), 'muted'));
        line.append(check, text); details.append(line);
      }
      groups.append(details);
    }
    count.textContent = t('statementReview.selected')(result.rows.filter(r => r.included).length);
    next.disabled = target.value.trim() !== '' && !Number.isFinite(parseAmountInput(target.value));
  }
  for (const control of [target, date, basis]) control.addEventListener('change', refresh);
  refresh();
}
