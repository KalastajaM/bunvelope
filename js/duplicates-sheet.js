import { describeError } from './core/errors.js';
// js/duplicates-sheet.js — review likely duplicate transactions and clean
// them up.
//
// `transactions.duplicates` (shared core query) proposes the
// groups; this sheet is where the user picks which row of each group to keep
// and writes the result. Nothing is removed without a tick, a plain match
// (same payee, amount and day) is never pre-ticked because it is as often two
// real purchases, and "Not a duplicate" hides a group for good.

import { state, session } from './app.js';
import { dismissGroup } from './state/duplicate-finder.js';
import { updateMeta } from './state/meta-writes.js';
import { txEnvelopeIds, txAbsAmount } from './engine.js';
import { openSheet } from './ui/sheet.js';
import { toast } from './ui/toast.js';
import { moneyEl } from './ui/money.js';
import { reportSaveError, dispatchOrReport, reportDispatchFailure, SHARED_REPORT_CODES } from './ui/save-error.js';
import { t, fmtDateLang, trEnv } from './ui/i18n.js';

// A failed cleanup (or undo) says so in the sheet's own words, assertively, as
// it always has. A version conflict still gets the reload dialog and a budget
// switch says nothing: those refusals go to the shared reporter.
const APPLY_FAILED = { failKey: 'duplicates.applyFailed', assertive: true, logAs: 'duplicates cleanup failed' };

/** Groups for the current state, dismissed ones left out. */
export function scanDuplicates() {
  const result = session.query('transactions.duplicates', {});
  if (!result.ok) throw new Error(result.error.code);
  return result.value.groups;
}

/**
 * Groups where an automatic post duplicated a hand entry: the ones worth
 * raising in the status badge. A key posted twice is already there as an
 * invariant problem, and a plain match is too often two real purchases.
 */
export function countPostedDuplicates() {
  return scanDuplicates().filter(g => g.kind === 'postedOverHand').length;
}

const accountName = (id) => (state.accounts || []).find(a => a && a.id === id)?.name || id || '';

function whereText(tx) {
  if (tx.type === 'account_transfer' || tx.type === 'investment_transfer') {
    return `${accountName(tx.from_account)} → ${accountName(tx.to_account)}`;
  }
  const envs = txEnvelopeIds(tx)
    .map(id => (state.envelopes || []).find(e => e && e.id === id))
    .filter(Boolean)
    .map(e => trEnv(e));
  return [accountName(tx.account), ...envs].filter(Boolean).join(' · ');
}

function badge(text) {
  const b = document.createElement('span');
  b.style.cssText = 'font-size:10px;padding:1px 6px;border-radius:8px;background:var(--bg-sunken);color:var(--muted);'
    + 'font-weight:500;text-transform:uppercase;letter-spacing:0.4px;white-space:nowrap;';
  b.textContent = text;
  return b;
}

/** One row of a group: a Keep radio, what it is, and its amount. */
function rowLine(tx, group, choice, onKeep) {
  const line = document.createElement('label');
  line.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:6px 0;cursor:pointer;';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `dup-keep-${group.id}`;
  radio.checked = choice.keepId === tx.id;
  radio.style.cssText = 'width:auto;margin-top:3px;flex-shrink:0;';
  radio.title = t('duplicates.keep');
  radio.addEventListener('change', () => { if (radio.checked) onKeep(tx.id); });

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;';
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px;';
  const payee = document.createElement('span');
  payee.style.cssText = 'overflow-wrap:anywhere;';
  payee.textContent = tx.payee || '—';
  top.append(payee);
  if (tx.from_budget) top.append(badge(t('duplicates.badgePosted')));
  if (tx.cleared) top.append(badge(t('duplicates.badgeReconciled')));
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;';
  meta.textContent = [fmtDateLang(tx.date) || tx.date, whereText(tx)].filter(Boolean).join(' · ');
  body.append(top, meta);

  const amt = document.createElement('div');
  amt.style.cssText = 'flex-shrink:0;';
  amt.append(moneyEl(tx.type === 'income' ? txAbsAmount(tx) : -txAbsAmount(tx), { size: 'inline' }));

  const keepLbl = document.createElement('span');
  keepLbl.style.cssText = 'font-size:11px;color:var(--muted);width:40px;flex-shrink:0;margin-top:2px;';
  keepLbl.textContent = choice.keepId === tx.id ? t('duplicates.keep') : t('duplicates.remove');

  line.append(radio, keepLbl, body, amt);
  return line;
}

/**
 * Review-and-clean-up sheet. `onAfterChange` fires when rows were removed or
 * a group dismissed, so callers can repaint.
 */
export function openDuplicatesSheet({ onAfterChange = null } = {}) {
  let groups = scanDuplicates();
  const content = document.createElement('div');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-accent btn-sm';

  // groupId → { on, keepId }; survives a re-render after a dismissal.
  const choices = new Map();

  const { close } = openSheet({
    title: t('duplicates.title'), content, wide: true,
    headerActions: [closeBtn, applyBtn],
  });
  closeBtn.addEventListener('click', close);

  function syncApply() {
    const n = groups.filter(g => choices.get(g.id)?.on)
      .reduce((s, g) => s + g.rows.length - 1, 0);
    applyBtn.textContent = t('duplicates.apply')(n);
    applyBtn.disabled = n === 0;
    applyBtn.hidden = groups.length === 0;
  }

  function render() {
    content.replaceChildren();
    if (groups.length === 0) {
      const head = document.createElement('div');
      head.style.cssText = 'font-size:15px;margin:8px 0 6px;';
      head.textContent = t('duplicates.none');
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.style.cssText = 'font-size:13px;margin:0;';
      hint.textContent = t('duplicates.noneHint');
      content.append(head, hint);
      syncApply();
      return;
    }

    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.style.cssText = 'font-size:13px;margin:0 0 14px;';
    intro.textContent = t('duplicates.intro');
    const count = document.createElement('div');
    count.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:8px;';
    count.textContent = t('duplicates.found')(groups.length);
    content.append(intro, count);

    for (const g of groups) {
      if (!choices.has(g.id)) choices.set(g.id, { on: g.recommended, keepId: g.keepId });
      const choice = choices.get(g.id);

      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:4px;';
      const onLbl = document.createElement('label');
      onLbl.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;cursor:pointer;';
      const onCb = document.createElement('input');
      onCb.type = 'checkbox';
      onCb.checked = choice.on;
      onCb.style.cssText = 'width:auto;';
      onCb.addEventListener('change', () => { choice.on = onCb.checked; syncApply(); });
      onLbl.append(onCb, document.createTextNode(t(`duplicates.kind.${g.kind}`)));

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'btn btn-ghost btn-sm';
      dismissBtn.textContent = t('duplicates.notDuplicate');
      dismissBtn.addEventListener('click', async () => {
        dismissBtn.disabled = true;
        try {
          await updateMeta(state, (meta) => dismissGroup(meta, g));
        } catch (err) {
          dismissBtn.disabled = false;
          reportSaveError(err, 'duplicates: dismiss save failed');
          return;
        }
        groups = groups.filter(x => x.id !== g.id);
        choices.delete(g.id);
        render();
        onAfterChange?.();
      });
      head.append(onLbl, dismissBtn);

      const why = document.createElement('div');
      why.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 4px 26px;';
      why.textContent = t(`duplicates.why.${g.kind}`);

      const list = document.createElement('div');
      list.style.cssText = 'margin-left:26px;';
      const paintRows = () => {
        list.replaceChildren(...g.rows.map(tx => rowLine(tx, g, choice, (id) => {
          choice.keepId = id;
          choice.on = true;
          onCb.checked = true;
          paintRows();
          syncApply();
        })));
      };
      paintRows();

      card.append(head, why, list);
      content.append(card);
    }
    syncApply();
  }

  let settled = false;
  applyBtn.addEventListener('click', async () => {
    if (settled) return;
    const chosen = groups
      .filter(g => choices.get(g.id)?.on)
      .map(g => ({ ...g, keepId: choices.get(g.id).keepId }));
    if (chosen.length === 0) return;

    const groupsInput = chosen.map(g => ({
      keep: g.keepId,
      drop: g.rows.filter(r => r.id !== g.keepId).map(r => r.id),
    }));
    settled = true;
    applyBtn.disabled = true;
    // The session writes first and publishes after, so a refused write leaves
    // state as it was: nothing to roll back, only the latch to reopen.
    const r = await dispatchOrReport(session, 'transaction.resolveDuplicates', { groups: groupsInput }, {}, APPLY_FAILED);
    if (!r) {
      settled = false;
      applyBtn.disabled = false;
      return;
    }
    close();
    onAfterChange?.();
    const token = r.value.undo;
    toast(t('duplicates.applied')(r.value.value.removed), {
      duration: 8000,
      action: token ? { label: t('common.undo'), onAction: () => undoCleanup(token) } : undefined,
    });
  });

  /**
   * The session's Undo for the cleanup. It refuses (undo_stale) once another
   * budget is open, or once a row the cleanup touched has changed since: an
   * edit made in between is kept, and nothing is undone.
   */
  async function undoCleanup(token) {
    let u;
    try {
      u = await session.undo(token);
    } catch (err) {
      console.error('duplicates undo failed:', err);
      toast(t('duplicates.applyFailed'), { assertive: true });
      return;
    }
    if (u.ok) { onAfterChange?.(); return; }
    if (u.error.code === 'undo_stale') { toast(describeError(u.error, t)); return; }
    console.error('duplicates undo failed:', u.error);
    if (SHARED_REPORT_CODES.has(u.error.code)) { reportDispatchFailure(u.error); return; }
    toast(t('duplicates.applyFailed'), { assertive: true });
  }

  render();
}
