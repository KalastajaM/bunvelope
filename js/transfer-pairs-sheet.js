// js/transfer-pairs-sheet.js — review expenses that are really transfers and
// merge them, one pair at a time (owner decision 7, 2026-10-05).
//
// `transactions.transferPairs` (core query) proposes the pairs: an expense on
// one own account and an income of the same amount on another, a few days
// apart, under the same payee. Each pair's "Merge into transfer" dispatches
// transaction.mergeTransfer, which replaces both rows with one account
// transfer and keeps both notes. Nothing is merged without that click, and
// each merge can be undone from its toast.
//
// "Not a transfer" dismisses a pair: its id goes to
// `meta.transferPairDismissed`, UI state like the duplicates sheet's
// `duplicateDismissed` (a plain updateMeta write, not a command), which the
// query reads, so the CLI leaves it out too. "Show dismissed" lists them
// with a Restore button. The lookback (12 months, 2 years, all) maps to the
// query's `since`; it lasts for the session and the Clean-up count follows it.

import { state, session, now } from './app.js';
import { updateMeta } from './state/meta-writes.js';
import { reportSaveError } from './ui/save-error.js';
import { describeError } from './core/errors.js';
import { openSheet } from './ui/sheet.js';
import { toast } from './ui/toast.js';
import { moneyEl } from './ui/money.js';
import { dispatchOrReport, reportDispatchFailure, SHARED_REPORT_CODES } from './ui/save-error.js';
import { t, fmtDateLang } from './ui/i18n.js';

const MERGE_FAILED = { failKey: 'transferPairs.mergeFailed', assertive: true, logAs: 'transfer pair merge failed' };
const DISMISSED_KEY = 'transferPairDismissed';

export const LOOKBACKS = ['12m', '2y', 'all'];
// The session's choice; not saved, like the Net worth horizon.
let lookback = '12m';
export function setLookback(value) { if (LOOKBACKS.includes(value)) lookback = value; }
export function getLookback() { return lookback; }

const pad = (n) => String(n).padStart(2, '0');
/** The query's `since` for a lookback: none (the query's 12 months), two years back, or every row. */
export function sinceFor(value, today) {
  if (value === '2y') {
    const d = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate(), 12);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  if (value === 'all') return '1900-01-01';
  return undefined;
}

/** The pairs, and the dismissed ones, for the current budget and lookback. */
function queryPairs() {
  const since = sinceFor(lookback, now());
  const result = session.query('transactions.transferPairs', since ? { since } : {});
  if (!result.ok) throw new Error(result.error.code);
  return { pairs: result.value.pairs, dismissed: result.value.dismissed || [] };
}

/** The pairs still to check for the current budget. */
export function scanTransferPairs() {
  return queryPairs().pairs;
}

/** Meta with a pair id added to, or taken from, the dismissed list. */
export function withDismissed(meta, id, dismissed) {
  const raw = meta?.[DISMISSED_KEY];
  const set = new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  if (dismissed) set.add(id); else set.delete(id);
  return { ...(meta || {}), [DISMISSED_KEY]: [...set].sort() };
}

const accountName = (id) => (state.accounts || []).find(a => a && a.id === id)?.name || id || '';

/** One leg: what kind, its date and payee, and its account. */
function legLine(label, legRow) {
  const line = document.createElement('div');
  line.style.cssText = 'font-size:12px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere;';
  line.textContent = [
    label,
    fmtDateLang(legRow.date) || legRow.date,
    legRow.payee || '—',
    accountName(legRow.account),
    legRow.note || '',
  ].filter(Boolean).join(' · ');
  return line;
}

/**
 * Review sheet. `onAfterChange` fires after a merge (or its undo), so the
 * caller can repaint.
 */
export function openTransferPairsSheet({ onAfterChange = null } = {}) {
  let { pairs, dismissed } = queryPairs();
  let showDismissed = false;
  const content = document.createElement('div');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');

  const { close } = openSheet({
    title: t('transferPairs.title'), content, wide: true,
    headerActions: [closeBtn],
  });
  closeBtn.addEventListener('click', close);

  function rescan() {
    try { ({ pairs, dismissed } = queryPairs()); } catch (err) { console.error('transfer pairs rescan failed:', err); }
    render();
  }

  /** 12 months / 2 years / All: the rows the query compares. */
  function lookbackControl() {
    const row = document.createElement('div');
    row.className = 'transfer-pairs-lookback';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px;font-size:12px;color:var(--muted);';
    const label = document.createElement('span');
    label.textContent = t('transferPairs.lookback');
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', t('transferPairs.lookback'));
    for (const value of LOOKBACKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.lookback = value;
      b.textContent = t(`transferPairs.lookback_${value}`);
      const on = value === lookback;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.addEventListener('click', () => {
        if (value === lookback) return;
        lookback = value;
        rescan();
        onAfterChange?.();
      });
      seg.append(b);
    }
    row.append(label, seg);
    return row;
  }

  function dismissedSection() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:12px;';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost btn-sm transfer-pairs-show-dismissed';
    toggle.setAttribute('aria-expanded', String(showDismissed));
    toggle.textContent = showDismissed
      ? t('transferPairs.hideDismissed')
      : t('transferPairs.showDismissed')(dismissed.length);
    toggle.addEventListener('click', () => { showDismissed = !showDismissed; render(); });
    wrap.append(toggle);
    if (showDismissed) {
      const list = document.createElement('div');
      list.style.cssText = 'margin-top:8px;';
      for (const p of dismissed) list.append(pairCard(p, true));
      wrap.append(list);
    }
    return wrap;
  }

  function render() {
    content.replaceChildren(lookbackControl());
    if (dismissed.length === 0) showDismissed = false;
    if (pairs.length === 0) {
      const head = document.createElement('div');
      head.style.cssText = 'font-size:15px;margin:8px 0 6px;';
      head.textContent = t('transferPairs.none');
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.style.cssText = 'font-size:13px;margin:0;';
      hint.textContent = t('transferPairs.noneHint');
      content.append(head, hint);
      if (dismissed.length) content.append(dismissedSection());
      return;
    }

    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.style.cssText = 'font-size:13px;margin:0 0 14px;';
    intro.textContent = t('transferPairs.intro');
    const count = document.createElement('div');
    count.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:8px;';
    count.textContent = t('transferPairs.found')(pairs.length);
    content.append(intro, count);

    for (const p of pairs) content.append(pairCard(p));
    if (dismissed.length) content.append(dismissedSection());
  }

  function pairCard(p, isDismissed = false) {
    const card = document.createElement('div');
    card.className = isDismissed ? 'transfer-pair transfer-pair--dismissed' : 'transfer-pair';
    card.dataset.pair = p.id;
    card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;';
    const what = document.createElement('div');
    what.style.cssText = 'flex:1 1 200px;min-width:0;';
    const route = document.createElement('div');
    route.style.cssText = 'font-size:13px;font-weight:600;overflow-wrap:anywhere;';
    route.textContent = `${accountName(p.fromAccount)} → ${accountName(p.toAccount)}`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--muted);margin-top:2px;';
    sub.textContent = [fmtDateLang(p.date) || p.date, p.payee].filter(Boolean).join(' · ');
    what.append(route, sub);

    const amt = document.createElement('div');
    amt.style.cssText = 'flex-shrink:0;';
    amt.append(moneyEl(p.amount, { size: 'inline' }));

    head.append(what, amt);
    // The buttons keep together and wrap under the route on a phone.
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    head.append(actions);
    if (isDismissed) {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-ghost btn-sm';
      restoreBtn.textContent = t('transferPairs.restore');
      restoreBtn.addEventListener('click', () => setDismissed(p, false, restoreBtn));
      actions.append(restoreBtn);
    } else {
      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'btn btn-ghost btn-sm';
      dismissBtn.textContent = t('transferPairs.notTransfer');
      dismissBtn.addEventListener('click', () => setDismissed(p, true, dismissBtn));
      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      mergeBtn.className = 'btn btn-ghost btn-sm';
      mergeBtn.textContent = t('transferPairs.merge');
      mergeBtn.addEventListener('click', () => merge(p, mergeBtn));
      actions.append(dismissBtn, mergeBtn);
    }
    card.append(head,
      legLine(t('transferPairs.expenseLeg'), p.expense),
      legLine(t('transferPairs.incomeLeg'), p.income));
    return card;
  }

  /** "Not a transfer" (true) or Restore (false): UI state in meta, no command. */
  async function setDismissed(p, on, btn) {
    btn.disabled = true;
    try {
      await updateMeta(state, (meta) => withDismissed(meta, p.id, on));
    } catch (err) {
      btn.disabled = false;
      reportSaveError(err, 'transfer pairs: dismissal save failed');
      return;
    }
    rescan();
    onAfterChange?.();
  }

  async function merge(p, btn) {
    btn.disabled = true;
    const r = await dispatchOrReport(session, 'transaction.mergeTransfer',
      { incomeId: p.incomeId, expenseId: p.expenseId }, {}, MERGE_FAILED);
    if (!r) { btn.disabled = false; return; }
    // The merge may free or take rows another pair used: ask again.
    rescan();
    onAfterChange?.();
    const token = r.value.undo;
    toast(t('transferPairs.merged')(accountName(p.fromAccount), accountName(p.toAccount)), {
      duration: 8000,
      action: token ? { label: t('common.undo'), onAction: () => undoMerge(token) } : undefined,
    });
  }

  /**
   * The session's Undo for one merge. It refuses (undo_stale) once another
   * budget is open or the transfer has changed since; the edit is kept.
   */
  async function undoMerge(token) {
    let u;
    try {
      u = await session.undo(token);
    } catch (err) {
      console.error('transfer pair undo failed:', err);
      toast(t('transferPairs.mergeFailed'), { assertive: true });
      return;
    }
    if (u.ok) {
      if (content.isConnected) rescan();
      onAfterChange?.();
      return;
    }
    if (u.error.code === 'undo_stale') { toast(describeError(u.error, t)); return; }
    console.error('transfer pair undo failed:', u.error);
    if (SHARED_REPORT_CODES.has(u.error.code)) { reportDispatchFailure(u.error); return; }
    toast(t('transferPairs.mergeFailed'), { assertive: true });
  }

  render();
}
