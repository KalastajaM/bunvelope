// js/repair-links.js — reconnect a scheduled bill to the payment that settled it.
//
// A scheduled (`as_schedule`) budget item and the transaction that pays it are
// linked by one string: `from_budget` (`<itemId>:YYYY-MM`), stamped by the
// post-due materialiser. Record the payment by hand — or clean up a
// double-booking by deleting the tagged copy — and the link is simply gone.
//
// Nothing about the ledger looks wrong afterwards, but two things are: the
// forecast reads the bill as an unpaid backlog, and `materializeDueBudgetItems`
// is still free to post a duplicate for that occurrence on the next folder open.
//
// `transactions.unlinked` (shared core query) proposes the repairs; this
// sheet is where the user reviews them and writes them. Nothing is applied
// without an explicit tick — restoring a key changes what the forecast believes
// and suppresses a future post, so it is never done silently.

import { state, session } from './app.js';
import { transferRowName } from './pages/budget-plan-transfer.js';
import { openSheet } from './ui/sheet.js';
import { toast } from './ui/toast.js';
import { moneyEl } from './ui/money.js';
import { dispatchOrReport } from './ui/save-error.js';
import { t, fmtDateLang, trEnv } from './ui/i18n.js';

/** Proposals for the current state, optionally scoped to one envelope. */
export function scanUnlinkedPayments({ envelopeId = null } = {}) {
  const result = session.query('transactions.unlinked', envelopeId ? { envelope: envelopeId } : {});
  if (!result.ok) throw new Error(result.error.code);
  return result.value.proposals;
}

function labelledLine(label, value) {
  const wrap = document.createElement('div');
  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:2px;';
  lbl.textContent = label;
  wrap.append(lbl, value);
  return wrap;
}

/** One proposal: the bill on the left, the payment that settles it on the right. */
function proposalRow(p, selected, onToggle) {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:10px 12px;'
    + 'border:1px solid var(--border);border-radius:6px;margin-bottom:8px;cursor:pointer;';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selected.has(p.key);
  cb.style.cssText = 'width:auto;margin-top:2px;flex-shrink:0;';
  cb.addEventListener('change', () => onToggle(p.key, cb.checked));

  const cols = document.createElement('div');
  cols.style.cssText = 'flex:1;min-width:0;display:flex;gap:12px;flex-wrap:wrap;';

  // Left: the scheduled bill, or — a planned account_transfer has no
  // envelope (`envelopeId: null`, per findUnlinkedScheduledPayments) — the
  // planned transfer, named by its two accounts instead.
  const isTransfer = p.envelopeId === null;
  const envelope = (state.envelopes || []).find(e => e && e.id === p.envelopeId);
  const routeName = () => transferRowName({ account_id: p.fromAccount, to_account_id: p.toAccount }, state.accounts);
  const billName = document.createElement('div');
  billName.style.cssText = 'font-size:13px;overflow-wrap:anywhere;';
  billName.textContent = p.itemDescription || (isTransfer ? routeName() : p.itemId);
  const billMeta = document.createElement('div');
  billMeta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;';
  const dueMeta = t('repairLinks.due')(fmtDateLang(p.dueDate) || p.dueDate);
  billMeta.textContent = isTransfer
    ? `${routeName()} · ${dueMeta}`
    : `${envelope ? trEnv(envelope) : p.envelopeName} · ${dueMeta}`;
  const billBody = document.createElement('div');
  billBody.append(billName, billMeta);
  const bill = labelledLine(t('repairLinks.columnBill'), billBody);
  bill.style.cssText = 'flex:1 1 200px;min-width:0;';

  // Right: the payment. `p.txAmount` is a positive magnitude for both a bill
  // and a transfer (findUnlinkedScheduledPayments); negating it reads as a
  // bill payment leaving the envelope, and — for a transfer — the from-side
  // sign, money leaving `fromAccount`.
  const payLine = document.createElement('div');
  payLine.style.cssText = 'font-size:13px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;';
  const payName = document.createElement('span');
  payName.style.cssText = 'overflow-wrap:anywhere;';
  payName.textContent = p.txPayee || '—';
  payLine.append(payName, moneyEl(-p.txAmount, { size: 'inline' }));
  const payMeta = document.createElement('div');
  payMeta.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px;';
  payMeta.textContent = fmtDateLang(p.txDate) || p.txDate;
  const payBody = document.createElement('div');
  payBody.append(payLine, payMeta);
  const pay = labelledLine(t('repairLinks.columnPayment'), payBody);
  pay.style.cssText = 'flex:1 1 200px;min-width:0;';

  cols.append(bill, pay);
  row.append(cb, cols);
  return { row, cb };
}

/**
 * Review-and-apply sheet. `onAfterChange` fires only when links were actually
 * written, so callers can repaint the surface the user came from.
 */
export function openRepairLinksSheet({ envelopeId = null, onAfterChange = null } = {}) {
  const proposals = scanUnlinkedPayments({ envelopeId });

  const content = document.createElement('div');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');

  // Nothing to do: say why, including why a near-miss was deliberately skipped.
  if (proposals.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:8px 0 4px;';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:15px;margin-bottom:6px;';
    head.textContent = t('repairLinks.none');
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:13px;margin:0;';
    hint.textContent = t('repairLinks.noneHint');
    empty.append(head, hint);
    content.append(empty);

    const { close } = openSheet({
      title: t('repairLinks.title'), content, headerActions: [closeBtn],
    });
    closeBtn.addEventListener('click', close);
    return;
  }

  const selected = new Set(proposals.map(p => p.key));
  const onToggle = (key, on) => {
    if (on) selected.add(key); else selected.delete(key);
    syncSelectAll();
  };

  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.style.cssText = 'font-size:13px;margin:0 0 14px;';
  intro.textContent = t('repairLinks.intro');
  content.append(intro);

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;'
    + 'margin-bottom:8px;gap:12px;flex-wrap:wrap;';
  const count = document.createElement('div');
  count.style.cssText = 'font-size:12px;color:var(--muted);';
  count.textContent = t('repairLinks.found')(proposals.length);

  const allLabel = document.createElement('label');
  allLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;'
    + 'color:var(--muted);cursor:pointer;';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox';
  allCb.checked = true;
  allCb.style.width = 'auto';
  allLabel.append(allCb, document.createTextNode(t('repairLinks.selectAll')));
  bar.append(count, allLabel);
  content.append(bar);

  const list = document.createElement('div');
  const boxes = [];
  for (const p of proposals) {
    const { row, cb } = proposalRow(p, selected, onToggle);
    boxes.push({ key: p.key, cb });
    list.append(row);
  }
  content.append(list);

  function syncSelectAll() {
    allCb.checked = selected.size === proposals.length;
  }
  allCb.addEventListener('change', () => {
    const on = allCb.checked;
    selected.clear();
    if (on) for (const p of proposals) selected.add(p.key);
    for (const b of boxes) b.cb.checked = on;
  });

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn btn-accent btn-sm';
  applyBtn.textContent = t('repairLinks.apply');

  const { close } = openSheet({
    title: t('repairLinks.title'), content, wide: true,
    headerActions: [closeBtn, applyBtn],
  });
  closeBtn.addEventListener('click', close);

  let settled = false;
  applyBtn.addEventListener('click', async () => {
    if (settled) return;
    const chosen = proposals.filter(p => selected.has(p.key));
    if (chosen.length === 0) {
      toast(t('repairLinks.noneSelected'));
      return;
    }

    // One key per transaction. A single command checks the ledger once,
    // regardless of how many payments are selected, and saves atomically.
    const rows = chosen.map(p => ({ id: p.txId, fromBudget: p.key }));

    settled = true;
    applyBtn.disabled = true;
    // The session writes first and publishes after, so a refused write leaves
    // state as it was: nothing to roll back, only the latch to reopen.
    const r = await dispatchOrReport(session, 'transaction.setFields', { rows }, {}, { failKey: 'repairLinks.applyFailed', assertive: true, logAs: 'repair-links save failed' });
    if (!r) {
      settled = false;
      applyBtn.disabled = false;
      return;
    }
    toast(t('repairLinks.applied')(chosen.length));
    close();
    onAfterChange?.();
  });
}
