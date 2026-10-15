// A reversal is a durable correction. The command owns both preview and write.
import { state, session, now } from '../app.js';
import { openSheet } from './sheet.js';
import { guardSubmit } from './submit-guard.js';
import { dispatchOrReport } from './save-error.js';
import { confirmClosedEdit } from './closed-period-guard.js';
import { t, fmtDateLang } from './i18n.js';
import { moneyEl } from './money.js';
import { txAbsAmount, txAccountDelta, txEnvelopeEffect, txEnvelopeIds } from '../engine.js';
import { describeError } from '../core/errors.js';

/** Local YYYY-MM-DD of a Date. */
function isoDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function openTransactionReversal(tx, { isCurrent, onCommitted }) {
  const form = document.createElement('form');
  form.className = 'transaction-reversal';
  const explanation = document.createElement('p');
  explanation.textContent = t('reversal.explanation');
  const field = document.createElement('div');
  field.className = 'field';
  const dateLabel = document.createElement('label');
  dateLabel.textContent = t('reversal.date'); dateLabel.htmlFor = 'reversal-date';
  field.append(dateLabel);
  const date = document.createElement('input');
  date.type = 'date'; date.id = 'reversal-date'; date.name = 'reversal-date'; date.required = true;
  // Today: a correction is made now, and dating it back would land in a
  // period already reconciled or closed. Never before the original, though.
  const original0 = String(tx.date || '').slice(0, 10);
  const today = isoDay(now());
  date.value = original0 > today ? original0 : today;
  field.append(date);
  // What confirming will add, in words, above the rows themselves.
  const summary = document.createElement('p');
  summary.className = 'reversal-summary';
  summary.style.cssText = 'margin:8px 0 0;font-size:13px;';
  const preview = document.createElement('div');
  preview.className = 'reversal-rows';
  const error = document.createElement('p');
  error.className = 'reversal-error'; error.setAttribute('role', 'alert');
  error.style.color = 'var(--danger-text)';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'btn btn-ghost btn-sm';
  refresh.textContent = t('reversal.preview');
  const confirm = document.createElement('button');
  confirm.type = 'button'; confirm.className = 'btn btn-accent btn-sm';
  confirm.textContent = t('reversal.confirm'); confirm.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn btn-ghost btn-sm'; cancel.textContent = t('common.cancel');
  form.append(explanation, field, summary, preview, error);
  let active = true;
  let busy = false;
  let checked = null;
  const { close } = openSheet({ title: t('reversal.title'), content: form,
    headerActions: [cancel, refresh, confirm], onClose: () => { active = false; } });
  cancel.addEventListener('click', close);
  const current = () => active && isCurrent() && !!form.closest('[data-sheet-open]');
  const invalidate = () => { checked = null; confirm.disabled = true; preview.replaceChildren(); summary.textContent = ''; };
  date.addEventListener('input', invalidate);

  async function loadPreview() {
    if (busy || !current()) return;
    busy = true; refresh.disabled = true; date.disabled = true;
    invalidate(); error.textContent = '';
    const original = state.transactions.find(row => row.id === tx.id);
    const signature = JSON.stringify(original);
    const input = { id: tx.id, date: date.value };
    try {
      const result = await session.dispatch('transaction.reverse', input, { dryRun: true });
      if (!current()) return;
      if (!result.ok) {
        error.textContent = describeError(result.error, t);
        return;
      }
      if (JSON.stringify(state.transactions.find(row => row.id === tx.id)) !== signature) {
        error.textContent = t('reversal.changed'); return;
      }
      checked = { input, signature, originalDate: original.date };
      const rows = result.value.value.reversal;
      const parts = [t('reversal.willCreate')(rows.length, fmtDateLang(input.date))];
      if (original.type === 'expense' && rows.some(r => r.type === 'income')) parts.push(t('reversal.expenseAsIncome'));
      if (original.type === 'income' && rows.some(r => r.type === 'expense')) parts.push(t('reversal.incomeAsExpense'));
      summary.textContent = parts.join(' ');
      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'reversal-row';
        line.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--border);';
        const label = document.createElement('div');
        label.textContent = `${fmtDateLang(row.date)} · ${row.payee}`;
        const detail = document.createElement('div');
        const typeKey = { income: 'typeIncome', expense: 'typeExpense', account_transfer: 'typeAccountTransfer',
          investment_transfer: 'typeInvestment', envelope_transfer: 'typeEnvelopeTransfer', adjustment: 'typeAdjustment', fill: 'typeFill' }[row.type];
        detail.append(document.createTextNode(`${t(`transactions.${typeKey}`)} · `), moneyEl(txAbsAmount(row)));
        if (row.symbol) detail.append(document.createTextNode(` · ${row.units ?? ''} × ${row.symbol}`));
        const accountIds = [...new Set([row.account, row.from_account, row.to_account, row.source_account,
          row.target === 'account' ? row.target_id : null].filter(Boolean))];
        for (const id of accountIds) {
          const leg = document.createElement('div');
          leg.append(document.createTextNode(`${state.accounts.find(a => a.id === id)?.name || id}: `),
            moneyEl(txAccountDelta(row, id), { signed: true }));
          detail.append(leg);
        }
        for (const id of txEnvelopeIds(row)) {
          const effect = txEnvelopeEffect(row, id);
          if (effect?.mode !== 'add') continue;
          const leg = document.createElement('div');
          leg.append(document.createTextNode(`${state.envelopes.find(e => e.id === id)?.name || id}: `),
            moneyEl(effect.amount, { signed: true }));
          detail.append(leg);
        }
        line.append(label, detail); preview.append(line);
      }
      confirm.disabled = false;
    } finally {
      busy = false; refresh.disabled = false; date.disabled = false;
    }
  }
  refresh.addEventListener('click', () => { loadPreview().catch(showFailure); });
  function showFailure(err) { if (current()) error.textContent = err?.message || String(err); }
  confirm.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', guardSubmit(async () => {
    if (busy || !checked || !current()) return;
    busy = true; confirm.disabled = true; refresh.disabled = true; date.disabled = true;
    try {
      const proposed = checked;
      if (!(await confirmClosedEdit([proposed.originalDate, proposed.input.date]))) return;
      if (!current()) return;
      if (JSON.stringify(state.transactions.find(row => row.id === tx.id)) !== proposed.signature) {
        invalidate(); error.textContent = t('reversal.changed'); return;
      }
      const result = await dispatchOrReport(session, 'transaction.reverse', proposed.input);
      if (!result || !current()) return;
      close();
      await onCommitted(result);
    } finally {
      busy = false; confirm.disabled = !checked; refresh.disabled = false; date.disabled = false;
    }
  }));
  loadPreview().catch(showFailure);
}
