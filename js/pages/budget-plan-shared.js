// js/pages/budget-plan-shared.js — helpers used by the Budget Plan table and
// by its item editor.
//
// One-directional deps, the same shape as investments-shared.js: the editor
// and the host page both import from here, and this file imports from
// neither. It exists because the editor sheet moved out of budget-plan.js
// (1659 lines, of which 685 were the editor) and referenced a dozen of the
// host's module-locals on the way.
//
// Everything here reads `state` but owns none of the page's own state — no
// filters, no auto-save timer, no rendered table.

import { state, now as appNow } from '../app.js';
import { escHtml, fmt, slugify, uniqueId } from '../utils.js';
import { t } from '../ui/i18n.js';
import { parseAmountInput } from '../ui/amount-input.js';
import { QUARTERS } from './budget-plan-cells.js';
import { planItemsAsOf } from '../engine.js';

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Helper: deterministic category color from name ───────────────────────────
const CAT_PALETTE = ['#0071e3','#34c759','#ff9500','#af52de','#5ac8fa','#ff2d55','#ff6b35','#30b0c7'];

export function categoryColor(cat) {
  let hash = 0;
  for (const c of (cat || '')) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff;
  return CAT_PALETTE[hash % CAT_PALETTE.length];
}

// ── Envelope lookup helpers ───────────────────────────────────────────────────
export function envelopeById(id) {
  return state.envelopes.find(e => e.id === id) ?? null;
}

export function envelopeLabel(id) {
  if (!id) return t('addTx.unallocated');
  const env = envelopeById(id);
  if (!env) return t('budgetPlan.deletedEnvelope');
  return env.category ? `${env.category} · ${env.name}` : env.name;
}

export function envelopeCategory(id) {
  return envelopeById(id)?.category ?? '';
}

export function envelopeName(id) {
  if (!id) return t('addTx.unallocated');
  return envelopeById(id)?.name ?? '';
}

/**
 * <select> options for accounts (non-archived, or the currently-selected
 * one). `excludeId` drops one account from the list — used for a transfer's
 * "to account" picker so the from-account isn't offered as its own
 * destination — with the same escape hatch as archived/asset accounts: it
 * stays offered when it is already `selectedId`, so a value saved before the
 * exclusion applied doesn't silently vanish from its own picker. `emptyLabel`
 * overrides the empty option's text (default "Choose account") — the plan
 * editor uses this for an unscheduled expense item's account picker, whose
 * empty option means "from history" rather than "none chosen".
 */
export function accountSelectHtml(selectedId, { investmentOnly = false, nonInvestmentOnly = false, loanOnly = false, excludeId = null, emptyLabel = null } = {}) {
  const parts = [`<option value="">${escHtml(emptyLabel ?? t('budgetPlan.chooseAccount'))}</option>`];
  const active = (state.accounts || []).filter(a => {
    if (a.archived && a.id !== selectedId) return false;
    // `loanOnly`: the loan a loan-payment item pays into.
    if (loanOnly) return a.type === 'loan' || a.id === selectedId;
    if ((a.type === 'asset' || a.type === 'loan' || a.type === 'loan_given') && a.id !== selectedId) return false;
    if (investmentOnly && a.type !== 'investment') return false;
    if (nonInvestmentOnly && a.type === 'investment') return false;
    if (excludeId && a.id === excludeId && a.id !== selectedId) return false;
    return true;
  });
  active.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  for (const acc of active) {
    parts.push(
      `<option value="${escHtml(acc.id)}" ${acc.id === selectedId ? 'selected' : ''}>${escHtml(acc.name || acc.id)}</option>`,
    );
  }
  return parts.join('');
}

/** Today as YYYY-MM-DD. */
export function todayYmd() {
  const d = appNow();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** <select> options grouped by category, for envelope_id fields. */
export function envelopeSelectHtml(selectedId, { includeEmpty = false, emptyLabel = null } = {}) {
  emptyLabel = emptyLabel ?? t('budgetPlan.chooseEnvelope');
  const byCat = new Map();
  for (const env of state.envelopes) {
    if (env.archived && env.id !== selectedId) continue;
    const cat = env.category || t('budgetPlan.uncategorised');
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(env);
  }
  const cats = [...byCat.keys()].sort((a, b) => a.localeCompare(b));
  const parts = [];
  if (includeEmpty) {
    parts.push(`<option value="" ${!selectedId ? 'selected' : ''}>${escHtml(emptyLabel)}</option>`);
  }
  for (const cat of cats) {
    parts.push(`<optgroup label="${escHtml(cat)}">`);
    const envs = byCat.get(cat).sort((a, b) => a.name.localeCompare(b.name));
    for (const env of envs) {
      parts.push(
        `<option value="${escHtml(env.id)}" ${env.id === selectedId ? 'selected' : ''}>${escHtml(env.name)}</option>`,
      );
    }
    parts.push('</optgroup>');
  }
  return parts.join('');
}

// ── Unique id generation for new budget items ────────────────────────────────
export function newItemId(envelopeId) {
  const taken = new Set(state.budgetItems.map(it => it.id));
  const base = slugify(`${envelopeId || 'item'}-item`) || 'item';
  return uniqueId(base, taken);
}

// ── Show toast ────────────────────────────────────────────────────────────────
export function showToast(container, msg, type = 'success') {
  let toast = container.querySelector('.bp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'bp-toast';
    toast.style.cssText = `
      position:fixed; bottom:48px; left:50%; transform:translateX(-50%);
      padding:10px 18px; border-radius:8px; font-size:13px; font-weight:500;
      z-index:1000; box-shadow:0 4px 16px rgba(0,0,0,.2); transition:opacity .3s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'success' ? '#34c759' : type === 'error' ? '#ff3b30' : '#ff9500';
  toast.style.color = '#fff';
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ── Update quarter totals + yearly/avg in the sheet ──────────────────────────
export function updateDialogTotals(root) {
  const defaultAmt = Math.abs(parseAmountInput(root.querySelector('#bp-f-amount').value) || 0);
  const extraBuffer = Math.abs(parseAmountInput(root.querySelector('#bp-f-buffer').value) || 0);

  /** @type {Record<string, number | false>} each month's amount, false when off */
  const amounts = {};
  QUARTERS.forEach(q => q.months.forEach(mon => {
    amounts[mon] = false;
    const card = root.querySelector(`.bp-mcell[data-mon="${mon}"]`);
    if (!card || !card.classList.contains('active')) return;
    const customInput = card.querySelector('.bp-mcell-amt-input');
    const storedCustom = parseFloat(card.dataset.customAmt);
    amounts[mon] = customInput
      ? (parseAmountInput(customInput.value) || defaultAmt)
      : (!isNaN(storedCustom) ? storedCustom : defaultAmt);
  }));

  // Every figure here is the coming 12 months within the item's Active from /
  // until, as the Plan page counts it. A ticked month outside them is dimmed
  // and counts nowhere.
  const [dated] = planItemsAsOf([{
    monthly_schedule: amounts,
    extra_buffer: extraBuffer,
    start_month: root.querySelector('#bp-f-start-month')?.value || null,
    end_month: root.querySelector('#bp-f-end-month')?.value || null,
  }], appNow());
  let yearly = 0;
  QUARTERS.forEach(q => {
    let qTotal = 0;
    q.months.forEach(mon => {
      const v = dated.monthly_schedule[mon];
      if (typeof v === 'number') qTotal += v;
      root.querySelector(`.bp-mcell[data-mon="${mon}"]`)
        ?.classList.toggle('bp-mcell--outside', amounts[mon] !== false && v === false);
    });
    yearly += qTotal;
    const qtEl = root.querySelector(`.bp-qtotal[data-q="${q.label}"]`);
    if (qtEl) qtEl.textContent = qTotal > 0 ? fmt(qTotal) : '—';
  });
  yearly += dated.extra_buffer;
  const yearlyEl = root.querySelector('#bp-total-yearly');
  const avgEl = root.querySelector('#bp-avg-month');
  if (yearlyEl) yearlyEl.textContent = fmt(yearly);
  if (avgEl) avgEl.textContent = fmt(yearly / 12);
}

// ── Form field helper ────────────────────────────────────────────────────────
export function field(labelText, input) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.textContent = labelText;
  // Every input in this sheet carries a `bp-f-*` id; tie the label to it so a
  // screen reader announces the field and a click on the label focuses it.
  // Without `for`, a label that is merely a sibling names nothing.
  if (input?.id) lbl.htmlFor = input.id;
  wrap.append(lbl, input);
  return wrap;
}

// Expose a div-based .toggle to keyboard and assistive tech: switch role,
// Space/Enter activation, aria-checked kept in sync with the .on class.
// Call after the visual click wiring so the sync listener runs last.
export function a11ySwitch(toggleEl, labelText) {
  toggleEl.setAttribute('role', 'switch');
  toggleEl.tabIndex = 0;
  if (labelText) toggleEl.setAttribute('aria-label', labelText);
  const sync = () => toggleEl.setAttribute('aria-checked', String(toggleEl.classList.contains('on')));
  sync();
  toggleEl.addEventListener('click', sync);
  toggleEl.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleEl.click(); }
  });
}