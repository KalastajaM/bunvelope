// js/ai/reconcile-sheet.js — shared AI Reconcile sheet UI.
// Used by the Review page (no preselected account) and the Accounts page
// (per-account button preselects that account).

import { state, now } from '../app.js';
import { t } from '../ui/i18n.js';
import { openSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { openEditTx } from '../pages/edit-tx.js';
import { buildReconcileCtx } from './context-builder.js';
import { aiInsights } from './client.js';
import { aiErrorText } from './render.js';
import { formatAiText } from './money-text.js';
import { moneyEl } from '../ui/money.js';
import { validateAmount } from '../utils.js';

/**
 * Open the AI Reconcile sheet. `accountId` (optional) preselects an
 * account in the dropdown; if omitted, the first non-archived account is
 * used.
 */
export function openReconcileSheet({ monthIso, accountId } = {}) {
  const accounts = (state.accounts || []).filter((a) => !a.archived);
  if (!accounts.length) return;

  const today = now();
  const month = monthIso || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  const lbl = document.createElement('label');
  lbl.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;';
  const lblText = document.createElement('span');
  lblText.style.color = 'var(--muted)';
  lblText.textContent = t('ai.reconcile.accountLabel');
  const sel = document.createElement('select');
  sel.className = 'form-input';
  sel.style.cssText = 'width:auto;padding:6px 10px;font-size:13px;';
  for (const a of accounts) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    sel.append(o);
  }
  if (accountId && accounts.some((a) => a.id === accountId)) {
    sel.value = accountId;
  }
  lbl.append(lblText, sel);
  content.append(lbl);

  const summaryHost = document.createElement('div');
  summaryHost.style.cssText = 'min-height:24px;font-size:14px;line-height:1.5;';
  content.append(summaryHost);

  const listHost = document.createElement('div');
  content.append(listHost);

  let inFlight = false;
  async function run() {
    if (inFlight) return;
    inFlight = true;
    summaryHost.textContent = t('common.loading');
    listHost.replaceChildren();
    try {
      const ctx = buildReconcileCtx(state, sel.value, month, now);
      const out = await aiInsights('reconcile', {
        contextOverride: ctx,
        input: 'Find issues in this month\'s reconciliation.',
      });
      renderReconcile(summaryHost, listHost, out);
    } catch (err) {
      summaryHost.textContent = '';
      const e = document.createElement('div');
      e.className = 'ai-error';
      e.textContent = aiErrorText(err);
      listHost.replaceChildren(e);
    } finally {
      inFlight = false;
    }
  }
  sel.addEventListener('change', run);

  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border);';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost';
  closeBtn.textContent = t('common.close');
  footer.append(closeBtn);
  content.append(footer);

  const sheet = openSheet({ title: t('ai.reconcile.title'), content, wide: true });
  closeBtn.addEventListener('click', () => sheet.close());
  run();
}

function renderReconcile(summaryHost, listHost, out) {
  summaryHost.textContent = formatAiText(out?.summary || '');
  listHost.replaceChildren();
  const suggestions = Array.isArray(out?.suggestions) ? out.suggestions : [];
  if (!suggestions.length) {
    const e = document.createElement('div');
    e.className = 'ai-error';
    e.style.marginTop = '8px';
    e.textContent = t('ai.reconcile.empty');
    listHost.append(e);
    return;
  }
  const txById = new Map((state.transactions || []).map((tx) => [tx.id, tx]));
  const envById = new Map((state.envelopes || []).map((e) => [e.id, e]));
  for (const s of suggestions) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'margin-top:12px;padding:12px;';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:500;margin-bottom:4px;';
    head.textContent = `${formatAiText(s.kind || 'suggestion')} — ${(s.tx_ids || []).length} tx`;
    card.append(head);

    const note = document.createElement('p');
    note.style.cssText = 'margin:0 0 8px;color:var(--muted);font-size:13px;line-height:1.5;';
    note.textContent = formatAiText(s.rationale || '');
    card.append(note);

    // Proposed split: the model's numbers, formatted by the app.
    const splits = Array.isArray(s.proposed?.splits) ? s.proposed.splits : [];
    if (splits.length) {
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin:0 0 8px;font-size:13px;';
      for (const sp of splits) {
        const amount = validateAmount(sp?.amount);
        if (amount === null) continue;
        // An id that is not in this budget is skipped, as the health card
        // does, rather than shown raw.
        const env = envById.get(sp?.envelope_id);
        if (!env) continue;
        const line = document.createElement('div');
        line.style.cssText = 'display:flex;justify-content:space-between;gap:12px;';
        const name = document.createElement('span');
        name.textContent = env.name;
        line.append(name, moneyEl(amount, { size: 'inline' }));
        list.append(line);
      }
      if (list.childElementCount) card.append(list);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn btn-accent';
    apply.textContent = t('ai.reconcile.accept');
    apply.addEventListener('click', () => {
      const firstId = (s.tx_ids || [])[0];
      const tx = firstId && txById.get(firstId);
      if (tx) {
        openEditTx(tx);
      } else {
        toast(t('ai.reconcile.applied'));
      }
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-ghost';
    dismiss.textContent = t('ai.reconcile.dismiss');
    dismiss.addEventListener('click', () => card.remove());
    actions.append(apply, dismiss);
    card.append(actions);
    listHost.append(card);
  }
}
