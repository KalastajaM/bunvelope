import { infoButton } from '../ui/info-button.js';
import { node, disclosure } from '../ui/planning-workspace.js';
/**
 * review.js — Monthly Envelope Review page.
 *
 * Shows per-envelope balance, actual vs planned spend, required reserve,
 * and projected end-of-month position for the selected month.
 *
 * (Was formerly envelopes.js. The Envelopes page now manages envelope
 * CRUD; this page is the analytical monthly review.)
 */

import { state, updateStatusBar, session, now as appNow } from '../app.js';
import { txAbsAmount } from '../engine.js';
import { isMonthClosed, monthHasEnded } from '../state/closed-periods.js';
import { fmt, escHtml } from '../utils.js';
import { fmtDateLang, fmtMonthLang, t, langLocale } from '../ui/i18n.js';
import { toast } from '../ui/toast.js';
import { dispatchOrReport } from '../ui/save-error.js';
import { ask } from '../ui/query.js';
import { isAiFeatureEnabled } from '../ai/client.js';
import { openReconcileSheet } from '../ai/reconcile-sheet.js';
import { confirmDialog } from '../ui/dialog.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';

function fmtColored(n, negClass = 'danger') {
  if (n === null || n === undefined || isNaN(n)) return '<span>—</span>';
  const colorClass = n < -0.005 ? negClass : '';
  const style = colorClass === 'danger' ? 'color:var(--danger-text)' :
                colorClass === 'warning' ? 'color:var(--warning)' : '';
  return style
    ? `<span style="${style}">${fmt(n)}</span>`
    : `<span>${fmt(n)}</span>`;
}

// ── Helpers ────────────────────────────────────────────────────────────────


// The local calendar month of `d` as YYYY-MM. toISOString() is UTC, so just
// after midnight on the 1st in Helsinki it still named the previous month.
function localMonthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── Render ─────────────────────────────────────────────────────────────────

export async function render(container) {
  const today = appNow();
  const defaultMonth = localMonthKey(today); // "YYYY-MM"

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="page working-money">
      <div class="page-sticky-top-wrap" id="review-sticky">
        <div class="page-head">
          <div>
            <h1>${escHtml(t('review.title'))}</h1>
            <div class="page-head-meta">
              <div id="review-assign-pill" class="review-assign-pill" hidden></div>
            </div>
          </div>
        </div>
        <div class="filters">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);white-space:nowrap;">
            ${escHtml(t('review.monthLabel'))}
            <input type="month" id="month-picker" value="${defaultMonth}">
          </label>
        </div>
      </div>
      <div id="review-content"></div>
    </div>
  `;

  container.querySelector('.page-head h1').append(infoButton('envelopeFigures'));

  // The view chip under the title: Review is pinned to today's balances for
  // the current and future months, and shows a past month as it stood on its
  // last day, so the chip follows the month (renderReview updates it).
  const h1 = container.querySelector('.page-head h1');
  if (h1) {
    const chip = document.createElement('div');
    chip.id = 'review-view-chip';
    h1.parentElement.querySelector('.page-head-meta').prepend(chip);
    setViewChip(chip, { isPast: false, asOf: null });
  }

  const monthPicker = container.querySelector('#month-picker');
  const reviewContent = container.querySelector('#review-content');

  function runReview() {
    const month = monthPicker.value;
    renderReview(reviewContent, month, runReview);
  }

  monthPicker.addEventListener('change', runReview);

  if (isAiFeatureEnabled('reconcile')) {
    const head = container.querySelector('#review-sticky .page-head');
    if (head) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.textContent = '✨ ' + t('ai.reconcile.btn');
      btn.addEventListener('click', () => openReconcileSheet({ monthIso: monthPicker.value || defaultMonth }));
      wrap.append(btn);
      head.append(wrap);
    }
  }

  if (state.envelopes.length > 0 || state.transactions.length > 0) {
    runReview();
  } else {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    reviewContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <p>${escHtml(t('review.emptyState'))}</p>
      </div>
    `;
  }
}

// The chip reads "Today · this page always uses today's balances", or for a
// past month "End of month · as it stood on <last day>".
function setViewChip(chip, { isPast, asOf }) {
  const past = !!(isPast && asOf);
  chip.className = `view-chip view-chip--${past ? 'month-end' : 'today'}`;
  chip.title = past ? t('lens.monthEndHint') : t('lens.todayHint');
  const name = document.createElement('strong');
  name.textContent = past ? t('lens.monthEnd') : t('lens.today');
  const detail = past ? t('lens.chipMonthEnd')(fmtDateLang(asOf)) : t('workspace.reviewBasis');
  chip.replaceChildren(name, document.createTextNode(` · ${detail}`));
}

// ── Envelope detail row (posted + scheduled expenses for the month) ───────

function toggleEnvelopeDetail(container, envelopeId, month) {
  const row = container.querySelector(`tr[data-env-row="${CSS.escape(envelopeId)}"]`);
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.dataset.envDetailFor === envelopeId) {
    next.remove();
    return;
  }
  // Remove any other detail row currently open
  container.querySelectorAll('tr[data-env-detail-for]').forEach(r => r.remove());

  const res = session.query('review.month', { month, envelope: envelopeId });
  if (!res.ok) {
    console.error('review.month failed:', res.error?.code ?? res);
    return;
  }
  const { actual: actuals, overdue: scheduledOverdue, coming: scheduledComing, future, totals } = res.value.detail;
  const txs = [...actuals, ...scheduledOverdue, ...scheduledComing, ...future];

  const detail = document.createElement('tr');
  detail.dataset.envDetailFor = envelopeId;
  const cell = document.createElement('td');
  cell.colSpan = 7;
  cell.style.cssText = 'padding:14px 24px;background:var(--bg-sunken);';

  if (!txs.length) {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    cell.innerHTML = `<div class="muted" style="font-size:13px;">No transactions for this envelope in ${escHtml(month)}.</div>`;
  } else {
    cell.append(
      buildDetailSection(t('review.actuals'), actuals, totals.actual, 'var(--danger)'),
      buildDetailSection(t('review.overdue'), scheduledOverdue, totals.overdue, 'var(--danger)', true),
      buildDetailSection(t('review.scheduled'), scheduledComing, totals.coming, 'var(--warning)'),
      buildDetailSection(t('review.future'), future, totals.future, 'var(--muted)'),
    );
  }
  detail.append(cell);
  row.after(detail);
}

function buildDetailSection(label, rows, total, color, overdue = false) {
  const wrap = document.createElement('div');
  if (!rows.length) return wrap;
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;font-size:11.5px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin:8px 0 6px;';
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  head.innerHTML = `<span>${escHtml(label)} · ${rows.length}</span><span style="color:${color};font-weight:600;">${escHtml(fmt(total))}</span>`;
  wrap.append(head);
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  for (const tx of rows) {
    const line = document.createElement('div');
    line.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:4px 6px;border-radius:6px;cursor:pointer;';
    line.addEventListener('mouseenter', () => { line.style.background = 'var(--surface-alt)'; });
    line.addEventListener('mouseleave', () => { line.style.background = ''; });
    line.addEventListener('click', () => {
      import('./edit-tx.js').then(m => m.openEditTx?.(tx)).catch(err => console.error(err));
    });
    const left = document.createElement('span');
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    left.innerHTML = `<span class="muted" style="min-width:92px;display:inline-block;">${escHtml(fmtDateLang(tx.date))}</span> ${escHtml(tx.payee || '—')}`;
    if (overdue) {
      const pill = document.createElement('span');
      pill.textContent = t('review.overdue');
      pill.style.cssText = 'margin-left:8px;font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;background:var(--danger-fill);color:#fff;padding:1px 6px;border-radius:999px;font-weight:600;';
      left.append(pill);
    }
    const right = document.createElement('span');
    right.textContent = fmt(txAbsAmount(tx));
    line.append(left, right);
    list.append(line);
  }
  wrap.append(list);
  return wrap;
}

// ── Consolidate popover ────────────────────────────────────────────────────

function openConsolidatePopover(btn, { envName, available, defaultAmount, onSave }) {
  // Close any existing popover
  document.querySelectorAll('.review-consolidate-pop').forEach(el => el.remove());

  const pop = document.createElement('div');
  pop.className = 'review-consolidate-pop';
  // z-index 60 sits above the page-sticky-top-wrap (50) so the popover
  // never disappears behind the sticky review header.
  pop.style.cssText = 'position:absolute;z-index:60;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,0.15);padding:12px;min-width:260px;display:flex;flex-direction:column;gap:8px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);';
  title.textContent = t('review.consolidateTitle');
  const envLabel = document.createElement('div');
  envLabel.style.cssText = 'font-weight:600;font-size:13px;';
  envLabel.textContent = envName;

  const availEl = document.createElement('div');
  availEl.style.cssText = 'font-size:12px;color:var(--muted);';
  availEl.textContent = t('review.consolidateAvailable')(fmt(available ?? 0));

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'form-input';
  input.step = '0.01';
  input.value = (Math.round(defaultAmount * 100) / 100).toFixed(2);
  input.style.cssText = 'padding:6px 8px;font-size:14px;';
  enableFormulaInput(input);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.type = 'button';
  cancel.textContent = t('review.cancel');
  const confirm = document.createElement('button');
  confirm.className = 'btn btn-accent';
  confirm.type = 'button';
  confirm.textContent = t('review.consolidate');
  actions.append(cancel, confirm);

  pop.append(title, envLabel, availEl, input, actions);
  document.body.append(pop);

  const rect = btn.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.right + window.scrollX - popRect.width;
  let top = rect.bottom + window.scrollY + 6;
  if (left < 8) left = 8;
  // Clamp right edge so the popover stays inside the viewport horizontally.
  const maxLeft = window.scrollX + document.documentElement.clientWidth - popRect.width - 8;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  // If the natural placement would land below the visible viewport, flip it
  // above the button so the user actually sees it.
  const viewportBottom = window.scrollY + window.innerHeight;
  if (top + popRect.height > viewportBottom - 8) {
    top = Math.max(window.scrollY + 8, rect.top + window.scrollY - popRect.height - 6);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  let docClickTimer = null;
  const close = () => {
    pop.remove();
    if (docClickTimer) { clearTimeout(docClickTimer); docClickTimer = null; }
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  };
  const onDocClick = (e) => {
    if (pop.contains(e.target) || btn.contains(e.target)) return;
    close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && document.activeElement === input) {
      e.preventDefault();
      doSave();
    }
  };
  const doSave = async () => {
    const val = parseAmountInput(input.value);
    if (!Number.isFinite(val) || Math.abs(val) < 0.005) { close(); return; }
    close();
    await onSave(Math.round(val * 100) / 100);
  };
  confirm.addEventListener('click', doSave);
  cancel.addEventListener('click', close);
  // Defer the outside-click listener so the click that just opened the
  // popover can't trigger the capture handler on its way to bubbling.
  docClickTimer = setTimeout(() => {
    docClickTimer = null;
    document.addEventListener('click', onDocClick, true);
  }, 0);
  document.addEventListener('keydown', onKey);

  input.focus();
  input.select();
}

// Not optimistic: the session publishes the new ledger only once the write has
// landed, so the button shows it is working and the page repaints on success.
const consolidating = new Set();

async function consolidateEnvelope(envelopeId, amount) {
  const r = await dispatchOrReport(session, 'allocation.consolidate', {
    lines: [{ envelope: envelopeId, amount }],
    payee: t('review.consolidationNote'),
  });
  if (!r) return false;
  updateStatusBar();
  toast(t('review.consolidated'));
  return true;
}

// ── Review renderer ────────────────────────────────────────────────────────

function renderReview(container, month, runReview) {
  if (!state.envelopes.length && !state.transactions.length) {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <p>${escHtml(t('review.emptyState'))}</p>
      </div>
    `;
    return;
  }

  const res = session.query('review.month', { month });
  if (!res.ok) {
    console.error('review.month failed:', res.error?.code ?? res);
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <p>${escHtml(t('review.emptyState'))}</p>
      </div>
    `;
    return;
  }
  const { isFuture, isCurrent, isPast, asOf, rows, totals, categoryTotals, negativeCount } = res.value;

  // Header pill: only meaningful for the current month
  const pageRootEl = container.closest('.page');
  const chipEl = pageRootEl && pageRootEl.querySelector('#review-view-chip');
  if (chipEl) setViewChip(chipEl, { isPast, asOf });
  const pillEl = pageRootEl && pageRootEl.querySelector('#review-assign-pill');
  if (pillEl) {
    // Booked, whatever the lens: everything entered.
    const unallocated = isCurrent ? (ask('balances', { lens: 'booked' })?.unallocated ?? null) : null;
    if (unallocated !== null) {
      pillEl.hidden = false;
      pillEl.classList.remove('is-zero', 'is-pos', 'is-neg');
      if (Math.abs(unallocated) < 0.005) {
        pillEl.classList.add('is-zero');
        pillEl.textContent = t('review.balanced');
      } else if (unallocated > 0) {
        pillEl.classList.add('is-pos');
        pillEl.textContent = t('review.underAssigned')(fmt(unallocated));
      } else {
        pillEl.classList.add('is-neg');
        pillEl.textContent = t('review.overAssigned')(fmt(Math.abs(unallocated)));
      }
      const bookedText = pillEl.textContent;
      const todayPool = ask('balances', { lens: 'today' });
      pillEl.textContent = t('lens.booked') + ' · ' + bookedText;
      if (todayPool) pillEl.append(node('span', todayPool.unallocated < -0.005 ? 'workspace-negative' : '', t('overview.poolBasis')(t('lens.today')) + ': ' + fmt(todayPool.unallocated)));
    } else {
      pillEl.hidden = true;
      pillEl.textContent = '';
    }
  }

  if (!rows.length) {
    // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>${escHtml(t('review.noDataForMonth')(month))}</p>
      </div>
    `;
    return;
  }

  // "Start [NextMonth]" column header
  const [yearStr, monthStr] = month.split('-');
  const curYear = parseInt(yearStr, 10);
  const curM    = parseInt(monthStr, 10);

  const nextMonthDate = new Date(curYear, curM, 1);
  const nextMonthLabel = nextMonthDate.toLocaleString(langLocale(), { month: 'short' });

  // Group rows by category, as the query groups them: a row without one
  // (null or undefined) under null.
  const byCategory = new Map();
  for (const row of rows) {
    const cat = row.category ?? null;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(row);
  }

  // Each category's subtotals, keyed as the rows are grouped.
  const catTotalsByCategory = new Map(categoryTotals.map(c => [c.category ?? null, c.totals]));

  let tbodyHtml = '';

  for (const [cat, catRows] of byCategory) {
    // The category's subtotal row heads its envelopes; it used to follow
    // them, so each total read as belonging to the group below (U20).
    let envRowsHtml = '';

    for (const row of catRows) {
      const currentBalanceHtml = fmtColored(row.balance, 'danger');
      const projectedHtml = fmtColored(row.projected, 'danger');
      const balanceStackHtml = `<div class="review-stack2"><div>${currentBalanceHtml}</div><div>${projectedHtml}</div></div>`;
      const actualHtml    = row.actual > 0.005 ? `<span style="color:var(--danger-text)">${fmt(row.actual)}</span>` : `<span>${fmt(row.actual)}</span>`;
      const scheduledHtml = row.scheduled > 0.005 ? `<span style="color:var(--warning)">${fmt(row.scheduled)}</span>` : `<span>${fmt(row.scheduled)}</span>`;
      const remainingBudgetStackHtml = `<div class="review-stack2"><div>${scheduledHtml}</div><div>${fmt(row.planned)}</div></div>`;
      const minStartStackHtml = `<div class="review-stack2"><div>${fmt(row.required)}</div><div>${fmt(row.startNext)}</div></div>`;
      const surplusHtml   = row.surplus > 0.005
        ? `<span style="color:var(--success-text)">${fmt(row.surplus)}</span>`
        : row.surplus < -0.005
          ? `<span style="color:var(--danger-text)">${fmt(row.surplus)}</span>`
          : `<span>${fmt(row.surplus)}</span>`;

      const emergencyBadge = row.isEmergency
        ? ` <span title="${escHtml(t('review.emergencyBadgeTitle'))}" style="font-size:11px;background:var(--warning-soft,#fff3cd);color:var(--warning,#b45309);border-radius:4px;padding:1px 5px;vertical-align:middle;">${escHtml(t('review.emergencyBadge'))}</span>`
        : '';

      const { consolidateDelta } = row;
      const canConsolidate = isCurrent && Math.abs(consolidateDelta) >= 0.005;
      const consolidateBtnTitle = t('review.consolidateBtnTitle');
      const mergeIconSvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4 V12 a4 4 0 0 0 4 4 H18"/><path d="M14 12 L18 16 L14 20"/></svg>';
      const actionHtml = canConsolidate
        ? `<button class="btn btn-sm btn-icon" data-consolidate-id="${escHtml(row.envelope_id)}" data-default-amount="${escHtml(String(consolidateDelta))}" data-env-name="${escHtml(row.envName)}" title="${escHtml(consolidateBtnTitle)}" aria-label="${escHtml(consolidateBtnTitle)}" style="vertical-align:middle;">${mergeIconSvg}</button>`
        : '';

      envRowsHtml += `
        <tr data-env-row="${escHtml(row.envelope_id)}">
          <td style="padding-left:24px;">
            <a href="#" class="env-link" data-envelope-id="${escHtml(row.envelope_id)}"
              style="color:inherit;text-decoration:none;cursor:pointer;">${escHtml(row.envName)}</a>${emergencyBadge}${actionHtml ? ' ' + actionHtml : ''}
          </td>
          <td>${balanceStackHtml}</td>
          <td>${actualHtml}</td>
          <td>${remainingBudgetStackHtml}</td>
          <td>${fmt(row.D)}</td>
          <td>${minStartStackHtml}</td>
          <td>${surplusHtml}</td>
        </tr>
      `;
    }

    const catTotals = catTotalsByCategory.get(cat);

    tbodyHtml += `
      <tr class="review-cat-row">
        <td style="font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);">
          ${escHtml(cat)}
        </td>
        <td><div class="review-stack2"><div>${fmt(catTotals.balance)}</div><div>${fmt(catTotals.projected)}</div></div></td>
        <td>${fmt(catTotals.actual)}</td>
        <td><div class="review-stack2"><div>${fmt(catTotals.scheduled)}</div><div>${fmt(catTotals.planned)}</div></div></td>
        <td>${fmt(catTotals.D)}</td>
        <td><div class="review-stack2"><div>${fmt(catTotals.required)}</div><div>${fmt(catTotals.startNext)}</div></div></td>
        <td>${fmt(catTotals.surplus)}</td>
      </tr>
    ` + envRowsHtml;
  }

  const footerSurplusHtml = totals.surplus > 0.005
    ? `<span style="color:var(--success-text)">${fmt(totals.surplus)}</span>`
    : totals.surplus < -0.005
      ? `<span style="color:var(--danger-text)">${fmt(totals.surplus)}</span>`
      : `<span>${fmt(totals.surplus)}</span>`;

  const tfootHtml = `
    <tfoot>
      <tr style="border-top:2px solid var(--border); font-weight:700;">
        <td>${escHtml(t('review.total'))}</td>
        <td><div class="review-stack2"><div>${fmt(totals.balance)}</div><div>${fmt(totals.projected)}</div></div></td>
        <td>${fmt(totals.actual)}</td>
        <td><div class="review-stack2"><div>${fmt(totals.scheduled)}</div><div>${fmt(totals.planned)}</div></div></td>
        <td>${fmt(totals.D)}</td>
        <td><div class="review-stack2"><div>${fmt(totals.required)}</div><div>${fmt(totals.startNext)}</div></div></td>
        <td>${footerSurplusHtml}</td>
      </tr>
    </tfoot>
  `;

  // The shared rule (js/state/closed-periods.js): closed by hand or by the
  // automatic rule. Only a month that has ended can be closed (month.close
  // refuses the rest), so the current month shows the button disabled with
  // the reason and a future month none; a closed month can always be
  // reopened. A past month is otherwise read-only: no consolidation.
  const isClosed = isMonthClosed(state.meta, month, appNow());
  const canClose = isClosed || monthHasEnded(month, appNow());
  const closeBtnLabel = isClosed ? t('review.reopenMonth') : t('review.closeMonth');
  const closedBadgeHtml = isClosed
    ? `<span class="chip review-closed-badge" style="background:var(--warning-soft,#fff3cd);color:var(--warning,#b45309);">🔒 ${escHtml(t('review.closedBadge'))}</span>`
    : '';
  const closeBtnHtml = isFuture && !isClosed
    ? ''
    : `<button class="btn btn-ghost btn-sm" id="review-close-month" data-month="${escHtml(month)}" style="font-size:12px;"${canClose ? '' : ` disabled title="${escHtml(t('review.closeNotYet')(fmtMonthLang(month)))}"`}>${escHtml(closeBtnLabel)}</button>`;
  const pastNoteHtml = isPast
    ? `<span class="muted review-past-note" style="font-size:12px;margin-right:auto;">${escHtml(t('review.pastReadOnly')(fmtDateLang(asOf)))}</span>`
    : '';

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="card" style="padding:0; overflow:visible;">
      <div style="display:flex;align-items:center;justify-content:flex-end;padding:8px 12px;gap:8px;border-bottom:1px solid var(--border);">
        ${pastNoteHtml}
        ${closedBadgeHtml}
        ${closeBtnHtml}
      </div>
      <details class="review-legend">
        <summary>${escHtml(t('review.legend.title'))}</summary>
        <dl>
          <dt>${escHtml(t('review.colCurrent'))} / ${escHtml(t('review.colProjectedEnd'))}</dt><dd>${escHtml(t('review.legend.current'))}</dd>
          <dt>${escHtml(t('review.colActual'))}</dt><dd>${escHtml(t('review.legend.actual'))}</dd>
          <dt>${escHtml(t('review.colRemaining'))} / ${escHtml(t('review.colBudgetted'))}</dt><dd>${escHtml(t('review.legend.remaining'))}</dd>
          <dt>${escHtml(t('review.colDeposit'))}</dt><dd>${escHtml(t('review.legend.deposit'))}</dd>
          <dt>${escHtml(t('review.colMinReq'))} / ${escHtml(t('review.colStartOf')(nextMonthLabel))}</dt><dd>${escHtml(t('review.legend.minReq'))}</dd>
          <dt>${escHtml(t('review.colSurplusGap'))}</dt><dd>${escHtml(t('review.legend.surplus'))}</dd>
          <dt>${escHtml(t('review.consolidateBtnTitle'))}</dt><dd>${escHtml(t('review.legend.consolidate'))}</dd>
        </dl>
      </details>
      <div id="review-table-wrap" data-scroll-cue="sticky">
        <table class="tx-table sticky-thead">
          <thead>
            <tr>
              <th>${escHtml(t('review.colEnvelope'))}</th>
              <th><div class="review-stack2-head"><span>${escHtml(isFuture ? t('review.colProjectedStart') : isPast ? t('review.colMonthEnd') : t('review.colCurrent'))}</span><span class="muted">${escHtml(t('review.colProjectedEnd'))}</span></div></th>
              <th>${escHtml(t('review.colActual'))}</th>
              <th><div class="review-stack2-head"><span>${escHtml(t('review.colRemaining'))}</span><span class="muted">${escHtml(t('review.colBudgetted'))}</span></div></th>
              <th>${escHtml(t('review.colDeposit'))}</th>
              <th><div class="review-stack2-head"><span>${escHtml(t('review.colMinReq'))}</span><span class="muted">${escHtml(t('review.colStartOf')(nextMonthLabel))}</span></div></th>
              <th>${escHtml(t('review.colSurplusGap'))}</th>
            </tr>
          </thead>
          <tbody>${tbodyHtml}</tbody>
          ${tfootHtml}
        </table>
      </div>
    </div>
  `;

  const tableWrap = container.querySelector('#review-table-wrap');
  const detail = disclosure(t('workspace.fullReview'), [], false);
  tableWrap.before(detail); detail.append(container.querySelector('.review-legend'), tableWrap);
  const summary = node('section', 'workspace-review-summary');
  summary.append(node('h3', '', t('workspace.reviewFocus')));
  const filters = node('div', 'workspace-nav');
  const cards = node('div', 'workspace-review-cards');
  const choices = [];
  for (const [key, predicate] of [['needsFunding',r => r.surplus < -0.005],['surplus',r => r.surplus > 0.005],['all',() => true]]) {
    const matching = rows.filter(predicate);
    const btn = node('button', 'btn btn-sm btn-ghost', t('workspace.' + key) + ' · ' + matching.length);
    btn.type = 'button';
    choices.push([key,btn]);
    btn.addEventListener('click', () => {
      choices.forEach(([k,b]) => b.setAttribute('aria-pressed', String(k === key)));
      cards.replaceChildren();
      if (!matching.length) cards.append(node('p', 'muted', t('workspace.noExceptions')));
      for (const row of matching) {
        const card = node('article', 'workspace-review-card');
        card.append(node('h4', '', row.envName));
        const figures = node('dl', 'workspace-review-figures');
        for (const [label, value] of [[t('review.colProjectedEnd'),row.projected],[t('review.colMinReq'),row.required],[t('review.colSurplusGap'),row.surplus]]) {
          figures.append(node('dt','',label),node('dd',value < -0.005 ? 'workspace-negative' : '',fmt(value)));
        }
        card.append(figures);
        const original = [...tableWrap.querySelectorAll('button[data-consolidate-id]')].find(b => b.dataset.consolidateId === row.envelope_id);
        if (original) {
          const action = node('button', 'btn btn-sm btn-ghost', t('workspace.adjustReserve'));
          action.type = 'button';
          action.addEventListener('click', () => { detail.open = true; original.scrollIntoView?.({block:'center'}); original.click(); });
          card.append(action);
        }
        cards.append(card);
      }
    });
    filters.append(btn);
  }
  summary.append(filters,cards); detail.before(summary);
  choices[0][1].click();

  const closeBtn = container.querySelector('#review-close-month');
  if (closeBtn) {
    closeBtn.addEventListener('click', async () => {
      const isClosedNow = isMonthClosed(state.meta, month, appNow());
      const message = isClosedNow
        ? t('review.reopenConfirm')(fmtMonthLang(month))
        : t('review.closeConfirm')(fmtMonthLang(month), negativeCount);
      const ok = await confirmDialog(message, {
        title: isClosedNow ? t('review.reopenMonth') : t('review.closeMonth'),
        okLabel: isClosedNow ? t('review.reopenMonth') : t('review.closeMonth'),
        cancelLabel: t('addTx.cancel'),
      });
      if (!ok) return;
      const r = await dispatchOrReport(session, isClosedNow ? 'month.reopen' : 'month.close', { month }, undefined, { failKey: 'review.closeFailed' });
      if (r) runReview();
    });
  }

  // Clicking envelope name → expand inline row listing posted + scheduled
  // expenses for that envelope in the selected month.
  container.querySelectorAll('a.env-link[data-envelope-id]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEnvelopeDetail(container, a.dataset.envelopeId, month);
    });
  });

  // Consolidate buttons. The popover offers the envelope's booked balance over
  // every row (the answer's `available`), not the row's as-of-now balance.
  const availableById = new Map(rows.map(r => [r.envelope_id, r.available]));
  container.querySelectorAll('button[data-consolidate-id]').forEach(btn => {
    btn.disabled = consolidating.has(btn.dataset.consolidateId);
    if (btn.disabled) btn.setAttribute('aria-busy', 'true');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const envelopeId = btn.dataset.consolidateId;
      const envName = btn.dataset.envName || '';
      const defaultAmount = parseFloat(btn.dataset.defaultAmount) || 0;
      const available = availableById.get(envelopeId) ?? 0;
      openConsolidatePopover(btn, {
        envName,
        available,
        defaultAmount,
        onSave: async (amount) => {
          if (consolidating.has(envelopeId)) return;
          consolidating.add(envelopeId);
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
          let done = false;
          try {
            done = await consolidateEnvelope(envelopeId, amount);
          } finally {
            consolidating.delete(envelopeId);
            container.querySelectorAll('button[data-consolidate-id]').forEach(current => {
              if (current.dataset.consolidateId === envelopeId) { current.disabled = false; current.removeAttribute('aria-busy'); }
            });
          }
          if (done) runReview?.();
        },
      });
    });
  });

  // Sticky thead: the thead <th>s use position:sticky on the main window
  // scroll (see .tx-table.sticky-thead in app.css). We just need to keep the
  // --sticky-top-offset custom property equal to the height of the page's
  // sticky-top wrapper so the header row pins directly beneath it.
  container._reviewResizeObserver?.disconnect();
  const pageRoot = container.closest('.page');
  const wrap     = pageRoot && pageRoot.querySelector('#review-sticky');
  const table    = container.querySelector('table.sticky-thead');

  if (wrap && table) {
    const applyOffset = () => {
      const h = Math.ceil(wrap.getBoundingClientRect().height);
      if (h > 0) table.style.setProperty('--sticky-top-offset', `${h}px`);
    };
    applyOffset();
    const ro = new ResizeObserver(applyOffset);
    ro.observe(wrap);
    container._reviewResizeObserver = ro;
  }
}

