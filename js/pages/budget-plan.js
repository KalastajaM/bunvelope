import { addPageHelp } from '../ui/info-button.js';
import { node } from '../ui/planning-workspace.js';
import { listColumns, listColumnRow } from '../ui/list-columns.js';
import { itemFieldApplies } from '../core/entity-fields.js';
import { state, runDueScheduled, now } from '../app.js';
import { alertDialog } from '../ui/dialog.js';
import { showVersionConflictDialog } from '../ui/save-error.js';
import { setItemFields, viewOf, pendingOverrides, pendingFields, flushItems, onItemSettled } from '../ui/plan-item-live.js';
import { onBudgetSessionChange, currentBudgetSession } from '../state/budget-session.js';
import { describeError } from '../core/errors.js';
import { isoDate } from '../core/context.js';
import { ask } from '../ui/query.js';
import { QUARTERS, _buildMonthCell, paintCell, wireMonthCell, collectScheduleFromCells } from './budget-plan-cells.js';
import { fmt, escHtml } from '../utils.js';
import { t, fmtDateShortLang, fmtMonthLang } from '../ui/i18n.js';
import { itemDateStatus } from '../engine.js';
import { icon } from '../ui/icon.js';
import {
  clampFrac, cutScenariosFor, stressCutPct, setStressCutPct, clearStressCuts,
} from '../engine/stress.js';
import { openBudgetItemEditor } from './budget-plan-editor.js';
import { transferRowName } from './budget-plan-transfer.js';
import { needsAttention, statusText } from '../ui/item-funding-view.js';
import { openEnvelopeHealth } from './envelope-health.js';
import {
  MONTHS, envelopeCategory, envelopeLabel, envelopeName, showToast,
} from './budget-plan-shared.js';



// ── Module-level state ────────────────────────────────────────────────────────
let filterText = '';
let filterCategory = '';
let filterEnabled   = 'all'; // 'all' | 'enabled' | 'disabled'
let filterEmergency = 'all'; // 'all' | 'yes' | 'no'
let filterStress    = '';    // '' | 'A'|'B'|'C'|'D'|'E'|'Z' | 'none'
let filterFunding   = 'all'; // 'all' | 'attention' (fill %: short)
// Fill % status per item id, refreshed at the top of every table render
// (memoized, see js/state/item-funding-index.js).
let fundingIdx = new Map();
// The render in progress's `plan.items` answer, its items by id: each item's
// annual amount over the coming 12 months (start/end months applied) and a
// loan payment's rate, with the pending live edits over the stored items.
// Rows and edits stay on the stored item. Null when the query failed: the
// figures are then left off.
let planFigures = null;
const annualOf = (item) => planFigures?.byId.get(item.id)?.annual;
/** A section's (or an envelope's) total: the sum of its displayed rows. */
const totalOf = (items) => items.reduce((s, it) => s + (it.include !== false ? annualOf(it) ?? 0 : 0), 0);
/** "3 items · € 1 200,00", or the count alone when the figures are off. */
const headText = (items) => (planFigures
  ? `${t('budgetPlan.sectionCount')(items.length)} · ${fmt(totalOf(items))}`
  : t('budgetPlan.sectionCount')(items.length));






// ── Helper: render status / count / values in the shared header order ───────────────
function renderBpStats(host, income, budget, diff, itemCount) {
  host.textContent = '';
  host.classList.add('bp-stats', 'page-head-meta');

  const incomeSpan = document.createElement('span');
  incomeSpan.className = 'bp-stat';
  incomeSpan.textContent = t('budgetPlan.income')(fmt(income));

  const budgetSpan = document.createElement('span');
  budgetSpan.className = 'bp-stat';
  budgetSpan.textContent = t('budgetPlan.budget')(fmt(budget));

  const pill = document.createElement('span');
  pill.className = 'bp-diff-pill';
  if (Math.abs(diff) < 0.005) {
    pill.classList.add('is-zero');
    pill.textContent = t('budgetPlan.onBudget');
  } else if (diff > 0) {
    pill.classList.add('is-pos');
    pill.textContent = t('budgetPlan.underBudget')(fmt(diff));
  } else {
    pill.classList.add('is-neg');
    pill.textContent = t('budgetPlan.overBudget')(fmt(Math.abs(diff)));
  }

  const itemsSpan = document.createElement('span');
  itemsSpan.className = 'bp-stat bp-stat-muted';
  itemsSpan.textContent = t('budgetPlan.itemsCount')(itemCount);

  host.append(pill, itemsSpan, incomeSpan, budgetSpan);
}

// ── Helper: get unique categories from envelopes ─────────────────────────────
function getCategories() {
  const activeEnvIds = new Set(
    state.envelopes
      .filter(e => !e.archived && !(e.name || '').startsWith('(deleted:'))
      .map(e => e.id),
  );
  const cats = new Set();
  for (const it of state.budgetItems) {
    if (!activeEnvIds.has(it.envelope_id)) continue;
    const cat = envelopeCategory(it.envelope_id);
    if (cat) cats.add(cat);
  }
  return [...cats].sort();
}

// ── Helper: filter items ─────────────────────────────────────────────────────
let filterUpcoming = false;
let upcomingDates = new Map();
function getFilteredItems(items) {
  const lc = filterText.toLowerCase();
  return items.filter(it => {
    if (filterUpcoming && !upcomingDates.has(it.id)) return false;
    if (filterEnabled === 'enabled'  && it.include === false) return false;
    if (filterEnabled === 'disabled' && it.include !== false) return false;
    if (filterEmergency === 'yes' && !it.include_in_emergency_budget) return false;
    if (filterEmergency === 'no'  &&  it.include_in_emergency_budget) return false;
    // Transfers are never stress cuts, so they are not "missing" a category.
    if (filterStress === 'none' && (it.stress_category || it.kind === 'account_transfer')) return false;
    if (filterStress && filterStress !== 'none' && it.stress_category !== filterStress) return false;
    if (filterCategory && envelopeCategory(it.envelope_id) !== filterCategory) return false;
    if (filterFunding === 'attention' && !needsAttention(fundingIdx.get(it.id)?.status)) return false;
    if (lc) {
      const name = envelopeName(it.envelope_id);
      const cat  = envelopeCategory(it.envelope_id);
      const match =
        (name ?? '').toLowerCase().includes(lc) ||
        (cat ?? '').toLowerCase().includes(lc) ||
        (it.description ?? '').toLowerCase().includes(lc);
      if (!match) return false;
    }
    return true;
  });
}



// ── Live edits: row chips, cut sliders and the schedule popover ─────────────
// Each control queues its fields in the plan-item live queue
// (js/ui/plan-item-live.js), shared with the Stress page; they go out as one
// budgetItem.update per item after 400 ms of quiet, the last value per field
// winning. Until the update lands the page renders the stored item with the
// pending fields over it (viewOf), so a control follows the user's hand while
// state is unchanged. The settle listener works on the page as it is now
// (pageHost), not on the render that queued the edit.
let pageHost = null;
// Items whose Enabled chip was switched on: once an update leaves the item
// enabled in state, an occurrence due today posts now, as after an editor save,
// rather than on the next app load.
const postDueOnSettle = new Set();
onItemSettled(settleLiveEdit);
// The flags belong to the budget whose items were re-enabled.
onBudgetSessionChange(() => postDueOnSettle.clear());

/** Feedback for a landed update; true when this page told the user about a failure. */
function settleLiveEdit(id, r) {
  // The update can land after the user navigated away; the queue then says a
  // failure through the global toast.
  const page = pageHost?.querySelector('#bp-page') || null;
  if (r.ok) {
    if (page) showToast(page, t('budgetPlan.savedToast'));
    const saved = state.budgetItems.find(it => it.id === id);
    if (postDueOnSettle.has(id) && saved && saved.include !== false) {
      postDueOnSettle.delete(id);
      if (saved.as_schedule) {
        runDueScheduled().catch(err => console.error('runDueScheduled after re-enable failed:', err));
      }
    }
    return false;
  }
  // Nothing was written (the queue has dropped what was pending): show state.
  if (pendingFields(id)?.include !== true) postDueOnSettle.delete(id);
  if (!page) return false;
  closeActivePopover();
  rerenderTable(pageHost);
  if (r.error.code === 'version_conflict') showVersionConflictDialog();
  else showToast(page, t('common.saveFailed')(describeError(r.error, t)), 'error');
  return true;
}

/** A copy the stress model's mutating helpers may write to. */
function withOwnCuts(item) {
  return { ...item, stress_cut_pcts: item.stress_cut_pcts ? { ...item.stress_cut_pcts } : item.stress_cut_pcts };
}

/** Cut fractions as the engine reads them (a legacy whole percent is clamped). */
function clampedCuts(map) {
  return Object.fromEntries(Object.entries(map).map(([s, v]) => [s, clampFrac(v)]));
}

/**
 * The item as it is now: the stored row by id with the pending edits over it.
 * A row's controls hold the item from the last repaint, which an edit since
 * (committed or pending) has outdated; a popover that sends a whole map
 * (cuts, schedule) must start from this, or it sends the old values back.
 */
function currentView(item) {
  return viewOf(state.budgetItems.find(x => x.id === item.id) ?? item);
}

// ── Build month cell HTML for the schedule grid ──────────────────────────────






// ── Render the detail sheet ──────────────────────────────────────────────────
// `onChange` lets a caller on another page (Stress) repaint after a save or
// delete; this page's own rerenderTable finds no #bp-list there and no-ops.
// One editor at a time: a second click while the pending edits are still being
// sent would otherwise open a second sheet once they land.
let editorOpening = false;
export async function openEditBudgetItem(itemId, { onChange } = {}) {
  if (editorOpening) return;
  editorOpening = true;
  const generation = currentBudgetSession();
  const folder = state.budgetFolder;
  try {
    // Pending live edits go out first, so the editor opens on committed state.
    if (await flushItems() === false) return;
    if (currentBudgetSession() !== generation || state.budgetFolder !== folder) return;
    const idx = state.budgetItems.findIndex(it => it.id === itemId);
    if (idx < 0) return;
    const host = document.querySelector('#bp-page') || document.body;
    const rerender = (c) => { rerenderTable(c); onChange?.(); };
    openBudgetItemEditor(host, idx, { rerenderTable: rerender });
  } finally {
    editorOpening = false;
  }
}



// ── Popover: edit stress category + cut % directly from the row chip ─────────
const STRESS_CAT_CHOICES = ['A','B','C','D','E','Z'];

// Single active row-chip popover. Closing it removes its outside-click handler.
// `dismiss(quiet)` removes the DOM/listener; when quiet=true skips the rerender
// (used when another popover is opening, which will rebuild the row itself).
let _activePopoverClose = null;
function closeActivePopover() {
  if (_activePopoverClose) {
    const fn = _activePopoverClose;
    _activePopoverClose = null;
    fn(true);
  }
}

// The top layer keeps editors clear of the horizontally scrollable columns.
function mountRowPopover(anchor, pop) {
  anchor.append(pop);
  if (typeof pop.showPopover !== 'function') return;
  pop.setAttribute('popover', 'manual');
  pop.style.cssText = 'position:fixed;inset:auto;margin:0;width:max-content;min-width:0;color:inherit;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;';
  pop.showPopover();
  const rect = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - box.width - 12))}px`;
  pop.style.top = `${Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - box.height - 12))}px`;
}

function openStressPopover(anchor, painted) {
  closeActivePopover();
  const container = document.querySelector('#bp-page');
  const item = currentView(painted);
  // The sliders move a copy: `input` follows the hand here, `change` queues
  // the resulting cuts.
  const draft = withOwnCuts(item);

  const pop = document.createElement('div');
  pop.className = 'stress-cat-popover';
  pop.addEventListener('click', e => e.stopPropagation());

  // Category buttons (+ clear)
  const choices = [...STRESS_CAT_CHOICES, null];
  for (const c of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stress-cat-opt';
    if (c === item.stress_category) b.classList.add('stress-cat-opt--active');
    if (c) {
      b.classList.add(`bp-stress-${c.toLowerCase()}`);
      b.textContent = `${c} — ${c === 'Z' ? t('stress.catZ') : t('stress.cat' + c)}`;
    } else {
      b.textContent = t('bp.stressPopover.clear');
    }
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const fields = { stress_category: c };
      if (!c || c === 'Z') {
        const next = withOwnCuts(currentView(item));
        clearStressCuts(next);
        fields.stress_cut_pcts = next.stress_cut_pcts ?? null;
        fields.stress_cut_pct = next.stress_cut_pct;
      }
      setItemFields(item.id, fields);
      closePop();
    });
    pop.append(b);
  }

  // Cut% sliders — one per applicable scenario (category gates which apply).
  for (const s of cutScenariosFor(item)) {
    const sliderRow = document.createElement('div');
    sliderRow.className = 'bp-stress-slider-row';
    const lbl = document.createElement('span');
    lbl.className = 'bp-stress-slider-lbl';
    lbl.style.flexShrink = '0';
    lbl.textContent = `${s} — ${t('stress.cat' + s)}`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.className = 'stress-slider';
    const initialCut = Math.round(stressCutPct(item, s) * 100);
    slider.value = String(initialCut);
    const pct = document.createElement('span');
    pct.className = 'stress-slider-pct';
    pct.textContent = `${initialCut}%`;
    slider.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, Number(slider.value) || 0));
      setStressCutPct(draft, s, v / 100);
      pct.textContent = `${v}%`;
    });
    slider.addEventListener('change', () => {
      if (draft.stress_cut_pcts) setItemFields(item.id, { stress_cut_pcts: clampedCuts(draft.stress_cut_pcts) });
    });
    slider.addEventListener('click', e => e.stopPropagation());
    sliderRow.append(lbl, slider, pct);
    pop.append(sliderRow);
  }

  mountRowPopover(anchor, pop);

  let closed = false;
  function closePop(quiet = false) {
    if (closed) return;
    closed = true;
    pop.remove();
    document.removeEventListener('click', onOutside, true);
    _activePopoverClose = null;
    if (!quiet) rerenderTable(container);
  }
  function onOutside(ev) {
    if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
    // Another chip-button will open its own popover and invoke closeActivePopover();
    // let it handle the close so we don't rerender the row its anchor lives on.
    if (ev.target.closest?.('.stress-cat-btn, .bp-freq-btn')) return;
    // Prevent the same click from bubbling to the row and opening the edit sheet.
    ev.stopPropagation();
    ev.preventDefault();
    closePop();
  }
  _activePopoverClose = closePop;
  setTimeout(() => {
    if (!closed) document.addEventListener('click', onOutside, true);
  }, 0);
}

// ── Popover: edit monthly schedule directly from the row freq chip ───────────
function openSchedulePopover(anchor, painted) {
  closeActivePopover();
  const container = document.querySelector('#bp-page');
  // The cells start from the item as it is now; the schedule they send is the
  // whole map.
  const item = currentView(painted);

  const pop = document.createElement('div');
  pop.className = 'bp-sched-popover';
  pop.addEventListener('click', e => e.stopPropagation());

  const title = document.createElement('div');
  title.className = 'bp-section-label';
  title.textContent = t('bp.schedulePopover.title');
  pop.append(title);

  const sched = document.createElement('div');
  sched.className = 'bp-sched';

  const cells = [];
  QUARTERS.forEach(q => {
    const row = document.createElement('div');
    row.className = 'bp-sched-row';
    const qLbl = document.createElement('div');
    qLbl.className = 'bp-qlabel';
    qLbl.textContent = q.label;
    row.append(qLbl);
    q.months.forEach(mon => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'bp-mcell';
      cell.dataset.mon = mon;
      const val = item.monthly_schedule?.[mon];
      const active = val !== undefined && val !== false;
      const customVal = typeof val === 'number' ? Math.abs(val) : undefined;
      paintCell(cell, { active, customVal });
      row.append(cell);
      cells.push(cell);
    });
    // Spacer to match the sheet's layout (no per-quarter total in the popover)
    const spacer = document.createElement('div');
    row.append(spacer);
    sched.append(row);
  });
  pop.append(sched);

  const onChange = () => {
    setItemFields(item.id, { monthly_schedule: collectScheduleFromCells(cells) });
  };

  cells.forEach(cell => {
    wireMonthCell(cell, {
      getDefaultAmt: () => Math.abs(item.default_amount ?? 0),
      allowCustom: () => item.transfer_mode !== 'target_balance',
      onChange,
    });
  });

  mountRowPopover(anchor, pop);

  let closed = false;
  function closePop(quiet = false) {
    if (closed) return;
    closed = true;
    pop.remove();
    document.removeEventListener('click', onOutside, true);
    _activePopoverClose = null;
    if (!quiet) rerenderTable(container);
  }
  function onOutside(ev) {
    if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
    // Another chip-button will open its own popover and invoke closeActivePopover();
    // let it handle the close so we don't rerender the row its anchor lives on.
    if (ev.target.closest?.('.stress-cat-btn, .bp-freq-btn')) return;
    // Prevent the same click from bubbling to the row and opening the edit sheet.
    ev.stopPropagation();
    ev.preventDefault();
    closePop();
  }
  _activePopoverClose = closePop;
  setTimeout(() => {
    if (!closed) document.addEventListener('click', onOutside, true);
  }, 0);
}

// ── Build a single list row (shared column layout) ─────────────────
function buildRow(item, idx, inSubGroup = false) {
  const isIncome = item.kind === 'income';
  const isDividend = item.kind === 'investment_transfer' && item.direction === 'dividend';
  const isTransfer = item.kind === 'account_transfer';
  const annual = annualOf(item);
  const defaultAmt = Math.abs(item.default_amount ?? 0);
  const envName = isIncome
    ? (item.description || t('budgetPlan.incomeGroup'))
    : isDividend
      ? (item.description || (item.symbol ? t('budgetPlan.dividendOf')(item.symbol) : t('budgetPlan.dividend')))
      : isTransfer
        ? (item.description || transferRowName(item, state.accounts))
        : (envelopeName(item.envelope_id) || envelopeLabel(item.envelope_id));
  const monthsSet = new Set(MONTHS.filter(m => {
    const v = item.monthly_schedule?.[m];
    return v !== undefined && v !== false;
  }));
  const monthsCount = monthsSet.size;

  const row = document.createElement('div');
  row.className = 'bp-list-row';
  row.dataset.idx = String(idx);
  if (item.envelope_id) row.dataset.envelopeId = item.envelope_id;
  if (item.include === false) row.classList.add('bp-list-row--excluded');

  // Middle: name + meta
  const col = document.createElement('div');
  col.className = 'bp-row-col';

  const name = document.createElement('div');
  name.className = 'bp-row-name';
  name.textContent = inSubGroup
    ? (item.description || envName || t('budgetPlan.noDescription'))
    : (envName || t('budgetPlan.noEnvelopeRow'));
  col.append(name);

  const meta = document.createElement('div');
  meta.className = 'bp-row-meta';
  const settings = document.createElement('div');
  settings.className = 'bp-row-settings';
  const schedule = document.createElement('div');
  schedule.className = 'bp-row-schedule';

  if (isDividend) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = t('budgetPlan.dividend');
    meta.append(chip);
  }

  if (!inSubGroup && item.description && item.description !== envName) {
    const desc = document.createElement('span');
    desc.className = 'muted bp-row-desc';
    desc.textContent = item.description;
    meta.append(desc);
  }

  // A loan payment says which loan it pays and at what rate the interest
  // part is estimated.
  const loanRate = item.kind === 'loan_payment' ? planFigures?.byId.get(item.id)?.loanRate : null;
  if (loanRate != null) {
    const loan = (state.accounts || []).find(a => a.id === item.to_account_id);
    const loanInfo = document.createElement('span');
    loanInfo.className = 'muted bp-row-desc';
    loanInfo.textContent = t('budgetPlan.loanRowMeta')(loan?.name || '?', loanRate);
    meta.append(loanInfo);
  }

  if (item.stress_category && itemFieldApplies('stress_category', item.kind)) {
    const stressWrap = document.createElement('span');
    stressWrap.className = 'stress-cat-wrap';
    const stressChip = document.createElement('button');
    stressChip.type = 'button';
    const catLower = item.stress_category.toLowerCase();
    stressChip.className = `chip bp-stress-chip bp-stress-${catLower} stress-cat-btn`;
    const vals = cutScenariosFor(item).map(s => Math.round(stressCutPct(item, s) * 100));
    let cutText = '';
    let cutRange = '';
    if (vals.length) {
      const min = Math.min(...vals), max = Math.max(...vals);
      if (max > 0) {
        cutText = (min === max) ? ` −${max}%` : ` −${min}…${max}%`;
        cutRange = (min === max) ? `${max}%` : `${min}–${max}%`;
      }
    }
    stressChip.textContent = `${t('budgetPlan.stressChip')(item.stress_category)}${cutText}`;
    // "Cat. C −35…50%" meant nothing without the Stress page open; the
    // tooltip names the category and what the percentage is (ux-review U19).
    stressChip.title = t('budgetPlan.stressChipTitle')(t(`stress.cat${item.stress_category}`), cutRange);
    stressChip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openStressPopover(stressWrap, item);
    });
    stressWrap.append(stressChip);
    stressWrap.addEventListener('click', event => event.stopPropagation());
    settings.append(stressWrap);
  }

  const freqText = monthsCount === 12
    ? t('budgetPlan.everyMonth')
    : monthsCount === 0
      ? t('budgetPlan.noMonthsScheduled')
      : t('budgetPlan.monthsPerYear')(monthsCount);
  const freqWrap = document.createElement('span');
  freqWrap.className = 'bp-freq-wrap';
  const freq = document.createElement('button');
  freq.type = 'button';
  if (item.as_schedule) {
    freq.className = 'chip bp-row-freq bp-freq-btn';
    freq.append(icon('calendar', 12), document.createTextNode(` ${freqText}`));
  } else {
    freq.className = 'muted bp-row-freq bp-freq-btn';
    freq.textContent = freqText;
  }
  freq.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openSchedulePopover(freqWrap, item);
  });
  freqWrap.append(freq);
  schedule.append(freqWrap);
  if (upcomingDates.has(item.id)) schedule.append(node('span', 'muted bp-next-date', t('workspace.nextDue') + ': ' + upcomingDates.get(item.id)));

  // Start / end month. An ended item is dimmed like a switched-off one (it
  // counts nothing); one not started yet, or one that ends, says when. A
  // click on the chip opens the editor with the row.
  const dates = itemDateStatus(item, now());
  if (dates.status === 'ended') row.classList.add('bp-list-row--excluded');
  const dateText = dates.status === 'ended' ? t('budgetPlan.endedChip')(fmtMonthLang(dates.end))
    : dates.status === 'upcoming' ? t('budgetPlan.fromChip')(fmtMonthLang(dates.start))
      : dates.end ? t('budgetPlan.untilChip')(fmtMonthLang(dates.end)) : '';
  if (dateText) {
    const dateChip = document.createElement('span');
    dateChip.className = 'chip bp-date-chip';
    dateChip.textContent = dateText;
    schedule.append(dateChip);
  }


  col.append(meta);
  row.append(col, schedule, settings);

  // Enabled and Emergency controls share the settings column with stress.
  function makeChipToggle({ checked, onLabel, offLabel, onClass, offClass, onChange, onIcon = null }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip bp-toggle-chip ${checked ? onClass : offClass}`;
    const paintLabel = (on) => {
      btn.replaceChildren();
      if (on && onIcon) btn.append(icon(onIcon, 12), document.createTextNode(' '));
      btn.append(document.createTextNode(on ? onLabel : offLabel));
    };
    paintLabel(checked);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const next = !btn.classList.contains(onClass);
      btn.classList.toggle(onClass, next);
      btn.classList.toggle(offClass, !next);
      paintLabel(next);
      onChange(next);
    });
    return btn;
  }

  const enabledChip = makeChipToggle({
    // Only an explicit `include: false` is disabled, as in the engine.
    checked: item.include !== false,
    onLabel: t('budgetPlan.enabledChip'),
    offLabel: t('budgetPlan.disabledChip'),
    onClass: 'bp-toggle-chip--on',
    offClass: 'bp-toggle-chip--off',
    onChange: (v) => {
      // The command stamps as_schedule_since: a re-enabled scheduled item
      // resumes from today, not from the months it skipped.
      row.classList.toggle('bp-list-row--excluded', !v);
      if (v) postDueOnSettle.add(item.id);
      else postDueOnSettle.delete(item.id);
      setItemFields(item.id, { include: v });
    },
  });
  enabledChip.title = t('budgetPlan.disabledHint');
  settings.append(enabledChip);

  if (item.kind !== 'income' && item.kind !== 'investment_transfer' && item.kind !== 'account_transfer') {
    const emergChip = makeChipToggle({
      checked: !!item.include_in_emergency_budget,
      onLabel: t('budgetPlan.emergencyChipOn'),
      onIcon: 'shield',
      offLabel: t('budgetPlan.emergencyChipOff'),
      onClass: 'bp-toggle-chip--emerg-on',
      offClass: 'bp-toggle-chip--emerg-off',
      onChange: (v) => {
        setItemFields(item.id, { include_in_emergency_budget: v });
      },
    });
    settings.append(emergChip);
  }

  if (Math.abs(item.extra_buffer ?? 0) > 0) {
    const bufChip = document.createElement('span');
    bufChip.className = 'chip bp-buffer-chip';
    bufChip.textContent = `🛟 ${t('bp.bufferBadge')} ${fmt(Math.abs(item.extra_buffer))}`;
    bufChip.title = t('bp.bufferBadgeHint');
    settings.append(bufChip);
  }

  // Fill %: only an item that needs acting on gets a chip, so the list stays
  // calm; it opens the envelope's health check, where the why and the fix are.
  const funding = fundingIdx.get(item.id);
  if (funding && needsAttention(funding.status)) {
    const fChip = document.createElement('button');
    fChip.type = 'button';
    fChip.className = 'env-goal-tag env-goal-tag--behind bp-funding-chip';
    fChip.textContent = funding.shortDate
      ? `${statusText(funding)} · ${fmtDateShortLang(funding.shortDate)}`
      : statusText(funding);
    fChip.title = t('budgetPlan.fundingChipTitle');
    fChip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const env = state.envelopes.find(e => e.id === funding.envelopeId);
      if (env) openEnvelopeHealth(env);
    });
    meta.append(fChip);
  }

  // Right: annual (big) + default (small)
  const amtWrap = document.createElement('div');
  amtWrap.className = 'bp-row-amt';

  const annualEl = document.createElement('div');
  annualEl.className = 'bp-row-annual';
  annualEl.textContent = isTransfer && item.transfer_mode === 'target_balance'
    ? fmt(item.target_balance) : annual == null ? '' : annual > 0 ? fmt(annual) : '—';
  amtWrap.append(annualEl);

  const dfltEl = document.createElement('div');
  dfltEl.className = 'muted bp-row-default';
  dfltEl.textContent = isTransfer && item.transfer_mode === 'target_balance'
    ? t('budgetPlan.targetBalance') : defaultAmt > 0 ? t('budgetPlan.rowDefault')(fmt(defaultAmt)) : '';
  amtWrap.append(dfltEl);

  row.append(amtWrap);
  listColumnRow(row, 'plan');

  // Sends the pending live edits first, one editor at a time.
  row.addEventListener('click', () => openEditBudgetItem(item.id));
  return row;
}

// ── Render/refresh the list + footer ─────────────────────────────────────────
function rerenderTable(container) {
  const upcoming = ask('upcoming', {days:30, date:isoDate(now())});
  upcomingDates = new Map();
  for (const row of upcoming?.coming || []) {
    const id = row.forecast_budget_item_id ?? state.budgetItems.find(item => typeof row.from_budget === 'string' && row.from_budget.startsWith(item.id + ':'))?.id;
    if (id && !upcomingDates.has(id)) upcomingDates.set(id, row.date);
  }

  // Fill % per item; a failed query leaves the chips and the filter's matches off.
  const funding = ask('plan.funding', { date: isoDate(now()) });
  fundingIdx = new Map((funding?.items || []).map(item => [item.itemId, item]));
  const viewItems = state.budgetItems.map(viewOf);
  // The figures for the plan as shown: the stored items with the pending live
  // edits over them, one query per repaint.
  const answer = ask('plan.items', { date: isoDate(now()), itemOverrides: pendingOverrides(state.budgetItems) });
  planFigures = answer ? { byId: new Map(answer.items.map(m => [m.id, m])), totals: answer.totals } : null;
  const filtered = getFilteredItems(viewItems);
  const listHost = container.querySelector('#bp-list');
  const statsEl = container.querySelector('#bp-stats');
  const totalEl = container.querySelector('#bp-annual-total');
  if (!listHost) return;

  const idxOf = new Map();
  viewItems.forEach((it, i) => idxOf.set(it, i));

  listHost.innerHTML = '';
  listColumns(listHost, 'plan', filtered.length > 0, container.querySelector('#bp-column-head'));

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.cssText = 'text-align:center;padding:40px;color:var(--muted);';
    empty.textContent = viewItems.length === 0
      ? t('budgetPlan.emptyNoItems')
      : filterFunding === 'attention' && !filterText && !filterCategory && filterEnabled === 'all'
        && filterEmergency === 'all' && !filterStress
        ? t('budgetPlan.fundingAllOnTrack')
        : t('budgetPlan.emptyNoMatch');
    listHost.append(empty);
  } else {
    // Group by envelope category; income items grouped under "Income".
    // Dividend items live with Income (they're cash income tied to a
    // holding, not an envelope category). Transfers get their own "Transfers"
    // group — they have no envelope category either, and are neither income
    // nor spending.
    const byCat = new Map();
    for (const it of filtered) {
      const isIncomeLikeRow = it.kind === 'income'
        || (it.kind === 'investment_transfer' && it.direction === 'dividend');
      const cat = isIncomeLikeRow
        ? t('budgetPlan.incomeGroup')
        : it.kind === 'account_transfer'
          ? t('budgetPlan.transfersGroup')
          : !it.envelope_id ? t('addTx.unallocated')
            : (envelopeCategory(it.envelope_id) || t('budgetPlan.uncategorised'));
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(it);
    }
    const incomeLabel = t('budgetPlan.incomeGroup');
    const transfersLabel = t('budgetPlan.transfersGroup');
    // Income first, Transfers right after it, everything else alphabetical.
    const groupRank = (c) => (c === incomeLabel ? 0 : c === transfersLabel ? 1 : 2);
    const cats = [...byCat.keys()].sort((a, b) => {
      const ra = groupRank(a), rb = groupRank(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });

    for (const cat of cats) {
      const items = byCat.get(cat);

      const header = document.createElement('div');
      header.className = 'bp-list-section-head';
      const left = document.createElement('span');
      left.textContent = cat;
      const right = document.createElement('span');
      right.textContent = headText(items);
      header.append(left, right);
      listHost.append(header);

      // Sub-group by envelope when the category contains items from 2+
      // envelopes. Income and Transfers never sub-group: neither kind has an
      // envelope (a transfer's items would all collapse into one "no
      // envelope" bucket anyway, since envelope_id is always null for them).
      const uniqueEnvIds = new Set(items.filter(it => it.kind !== 'income').map(it => it.envelope_id));
      const needsSubGroup = cat !== incomeLabel && cat !== transfersLabel && uniqueEnvIds.size > 1;

      if (!needsSubGroup) {
        items.forEach(it => listHost.append(buildRow(it, idxOf.get(it))));
      } else {
        const byEnv = new Map();
        for (const it of items) {
          const eid = it.envelope_id || '';
          if (!byEnv.has(eid)) byEnv.set(eid, []);
          byEnv.get(eid).push(it);
        }
        for (const [eid, envItems] of byEnv) {
          // Every envelope needs a boundary, including single-item envelopes.
          const subHead = document.createElement('div');
          subHead.className = 'bp-list-sub-head';
          const sLeft = document.createElement('span');
          sLeft.textContent = envelopeName(eid) || eid;
          const sRight = document.createElement('span');
          sRight.textContent = headText(envItems);
          subHead.append(sLeft, sRight);
          listHost.append(subHead);
          envItems.forEach(it => listHost.append(buildRow(it, idxOf.get(it), true)));
        }
      }
    }
  }

  // Grand total footer — show the expense budget total (income is separate).
  // Left as it was when the figures are off.
  if (planFigures) {
    const { income: annualIncome, budget: annualBudget, diff } = planFigures.totals;
    if (totalEl) totalEl.textContent = fmt(annualBudget);

    const includedCount = viewItems.filter(it => it.include !== false).length;
    if (statsEl) renderBpStats(statsEl, annualIncome, annualBudget, diff, includedCount);
  }

  // Category filter options
  const catSelect = container.querySelector('#bp-filter-cat');
  if (catSelect) {
    const current = catSelect.value;
    const cats = getCategories();
    catSelect.innerHTML = `<option value="">${escHtml(t('budgetPlan.allCategories'))}</option>` +
      cats.map(c => `<option value="${escHtml(c)}" ${c === current ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
  }
}

// ── Main render ───────────────────────────────────────────────────────────────
export async function render(container) {
  pageHost = container;
  filterUpcoming = false;
  filterText = '';
  filterCategory = '';
  filterEnabled   = 'all';
  filterEmergency = 'all';
  filterStress    = '';
  filterFunding   = 'all';

  // Deep links: `{ envelopeId }` focuses a row (below, after the render);
  // `{ funding: 'attention' }` (the Overview's fill % line) opens filtered.
  const focus = state.pendingFilter;
  state.pendingFilter = null;
  if (focus && typeof focus === 'object' && focus.funding === 'attention') filterFunding = 'attention';

  // Check sessionStorage filter pre-fill
  const preFilter = sessionStorage.getItem('budget-plan-filter');
  if (preFilter) {
    filterText = preFilter;
    sessionStorage.removeItem('budget-plan-filter');
  }

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="page" id="bp-page">
      <div class="page-sticky-top-wrap">
        <div class="page-head">
          <div>
            <h1>${escHtml(t('budgetPlan.title'))}</h1>
            <div class="sub" id="bp-stats"></div>
          </div>
          <div class="actions">
            <button class="btn btn-accent" id="bp-add">${escHtml(t('budgetPlan.addItem'))}</button>
          </div>
        </div>

        <div class="filters">
          <div class="bp-filter-group">
            <div class="search">
              <span class="search-icon-slot" aria-hidden="true"></span>
              <input type="text" id="bp-search" placeholder="${escHtml(t('budgetPlan.searchPlaceholder'))}" value="${escHtml(filterText)}">
            </div>
            <label class="bp-filter-hint" for="bp-search">${escHtml(t('budgetPlan.filterHintSearch'))}</label>
          </div>
          <div class="bp-filter-group">
            <select id="bp-filter-cat">
              <option value="">${escHtml(t('budgetPlan.allCategories'))}</option>
            </select>
            <label class="bp-filter-hint" for="bp-filter-cat">${escHtml(t('budgetPlan.filterHintCategory'))}</label>
          </div>
          <div class="bp-filter-group">
            <select id="bp-filter-enabled">
              <option value="all">${escHtml(t('budgetPlan.allItems'))}</option>
              <option value="enabled">${escHtml(t('budgetPlan.enabledOnly'))}</option>
              <option value="disabled">${escHtml(t('budgetPlan.disabledOnly'))}</option>
            </select>
            <label class="bp-filter-hint" for="bp-filter-enabled">${escHtml(t('budgetPlan.filterHintEnabled'))}</label>
          </div>
          <div class="bp-filter-group">
            <select id="bp-filter-emergency">
              <option value="all">${escHtml(t('budgetPlan.allItems'))}</option>
              <option value="yes">${escHtml(t('budgetPlan.inEmergency'))}</option>
              <option value="no">${escHtml(t('budgetPlan.notInEmergency'))}</option>
            </select>
            <label class="bp-filter-hint" for="bp-filter-emergency">${escHtml(t('budgetPlan.filterHintEmergency'))}</label>
          </div>
          <div class="bp-filter-group">
            <select id="bp-filter-stress">
              <option value="">${escHtml(t('budgetPlan.allItems'))}</option>
              ${['A','B','C','D','E','Z'].map(c => `<option value="${c}">${escHtml(t('budgetPlan.stressFilterCat')(c))}</option>`).join('')}
              <option value="none">${escHtml(t('budgetPlan.noStressCategory'))}</option>
            </select>
            <label class="bp-filter-hint" for="bp-filter-stress">${escHtml(t('budgetPlan.filterHintStress'))}</label>
          </div>
          <div class="bp-filter-group">
            <select id="bp-filter-funding">
              <option value="all">${escHtml(t('budgetPlan.allItems'))}</option>
              <option value="attention" ${filterFunding === 'attention' ? 'selected' : ''}>${escHtml(t('budgetPlan.fundingAttention'))}</option>
            </select>
            <label class="bp-filter-hint" for="bp-filter-funding">${escHtml(t('budgetPlan.filterHintFunding'))}</label>
          </div>
          <button class="btn bp-filter-clear" id="bp-filter-clear" style="display:none;align-self:flex-start">${escHtml(t('budgetPlan.clearFilters'))}</button>
        </div>
        <div id="bp-column-head" class="money-column-head"></div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <div id="bp-list" class="bp-list"></div>
        <div class="bp-list-footer">
          <span>${escHtml(t('budgetPlan.annualTotalIncluded'))}</span>
          <span id="bp-annual-total" class="bp-list-footer-value">${escHtml(fmt(0))}</span>
        </div>
      </div>

      ${state.envelopes.length === 0 ? `
        <div class="card" style="margin-top:12px;font-size:13px;color:var(--ink-2)">
          ${escHtml(t('budgetPlan.noEnvelopesLede'))}
          <a href="#" data-go-envelopes style="color:var(--accent-ink);text-decoration:underline">${escHtml(t('budgetPlan.noEnvelopesLink'))}</a>
          ${escHtml(t('budgetPlan.noEnvelopesTail'))}
        </div>` : ''}
    </div>
  `;

  addPageHelp(container.querySelector('.page-head h1'), 'tour.steps.budget.body', { guide: 'planning' });

  function hasActiveFilter() {
    return !!(filterText || filterCategory || filterEnabled !== 'all' || filterEmergency !== 'all' || filterStress
      || filterFunding !== 'all' || filterUpcoming);
  }
  function updateClearBtn() {
    const btn = container.querySelector('#bp-filter-clear');
    if (btn) btn.style.display = hasActiveFilter() ? '' : 'none';
    const selected = filterUpcoming ? 'upcoming' : filterEnabled === 'disabled' ? 'disabled' : filterFunding === 'attention' ? 'needsFunding' : filterEnabled === 'all' ? 'all' : null;
    container.querySelectorAll('.workspace-task-filters button[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === selected)));

  }

  // Swap the search-icon placeholder for the SVG icon helper.
  const iconSlot = container.querySelector('.search-icon-slot');
  if (iconSlot) {
    iconSlot.style.display = 'inline-flex';
    iconSlot.append(icon('search', 16));
  }

  const advancedFilters = ['enabled', 'emergency', 'stress', 'funding'].map(key =>
    container.querySelector('#bp-filter-' + key).closest('.bp-filter-group'));
  const advancedFields = node('div', 'bp-advanced-fields');
  advancedFields.append(...advancedFilters);
  advancedFields.id = 'bp-advanced-fields';
  const advanced = node('button', 'btn btn-sm btn-ghost bp-more-filters', t('workspace.advancedFilters'));
  advanced.type = 'button';
  advanced.setAttribute('aria-controls', advancedFields.id);
  function showAdvanced(open) {
    advancedFields.hidden = !open;
    advanced.setAttribute('aria-expanded', String(open));
  }
  advanced.addEventListener('click', () => showAdvanced(advancedFields.hidden));
  showAdvanced(filterFunding !== 'all');
  container.querySelector('.filters').append(advancedFields);

  const tasks = node('div', 'workspace-nav workspace-task-filters');
  tasks.setAttribute('aria-label', t('workspace.views'));
  for (const [label, enabled, funding] of [['all','all','all'],['needsFunding','enabled','attention'],['upcoming','enabled','all'],['disabled','disabled','all']]) {
    const btn = node('button', 'btn btn-sm btn-ghost', t('workspace.' + label));
    btn.dataset.view = label;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const enabledSelect = container.querySelector('#bp-filter-enabled');
      const fundingSelect = container.querySelector('#bp-filter-funding');
      enabledSelect.value = enabled; fundingSelect.value = funding;
      filterEnabled = enabled; filterFunding = funding; filterUpcoming = label === 'upcoming';
      tasks.querySelectorAll('button[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      showAdvanced(enabled !== 'all' || funding !== 'all');
      updateClearBtn(); rerenderTable(container);
    });
    tasks.append(btn);
  }
  tasks.append(advanced);
  container.querySelector('#bp-filter-cat').closest('.bp-filter-group').after(tasks);

  const SEARCH_DEBOUNCE_MS = 150;
  let searchTimer = null;
  container.querySelector('#bp-search').addEventListener('input', e => {
    filterText = e.target.value;
    updateClearBtn();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => rerenderTable(container), SEARCH_DEBOUNCE_MS);
  });

  container.querySelector('#bp-filter-cat').addEventListener('change', e => {
    filterCategory = e.target.value;
    updateClearBtn();
    rerenderTable(container);
  });

  container.querySelector('#bp-filter-enabled').addEventListener('change', e => {
    filterEnabled = e.target.value;
    updateClearBtn();
    rerenderTable(container);
  });

  container.querySelector('#bp-filter-emergency').addEventListener('change', e => {
    filterEmergency = e.target.value;
    updateClearBtn();
    rerenderTable(container);
  });

  container.querySelector('#bp-filter-stress').addEventListener('change', e => {
    filterStress = e.target.value;
    updateClearBtn();
    rerenderTable(container);
  });

  container.querySelector('#bp-filter-funding').addEventListener('change', e => {
    filterFunding = e.target.value;
    updateClearBtn();
    rerenderTable(container);
  });

  container.querySelector('#bp-filter-clear').addEventListener('click', () => {
    filterUpcoming = false;
    tasks.querySelectorAll('button[data-view]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    filterText = '';
    filterCategory = '';
    filterEnabled = 'all';
    filterEmergency = 'all';
    filterStress = '';
    filterFunding = 'all';
    container.querySelector('#bp-search').value = '';
    container.querySelector('#bp-filter-cat').value = '';
    container.querySelector('#bp-filter-enabled').value = 'all';
    container.querySelector('#bp-filter-emergency').value = 'all';
    container.querySelector('#bp-filter-stress').value = '';
    container.querySelector('#bp-filter-funding').value = 'all';
    updateClearBtn();
    rerenderTable(container);
  });

  container.querySelector('#bp-add').addEventListener('click', async () => {
    if (state.envelopes.length === 0) {
      await alertDialog(t('budgetPlan.needEnvelopeFirst'));
      return;
    }
    openBudgetItemEditor(container, -1, { rerenderTable });
  });

  const envLink = container.querySelector('[data-go-envelopes]');
  if (envLink) {
    envLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const { navigate } = await import('../app.js');
      navigate('envelopes');
    });
  }

  updateClearBtn();
  rerenderTable(container);

  if (focus?.editId) {
    const idx = state.budgetItems.findIndex(item => item.id === focus.editId);
    if (idx >= 0) openBudgetItemEditor(container, idx, { rerenderTable });
  }

  if (focus?.prefillScheduled && typeof focus.prefillScheduled === 'object') {
    openBudgetItemEditor(container, -1, { rerenderTable, prefillScheduled: focus.prefillScheduled });
  }

  // Deep-link focus: scroll to + flash the row matching state.pendingFilter.envelopeId
  if (focus && typeof focus === 'object' && focus.envelopeId) {
    requestAnimationFrame(() => {
      const row = container.querySelector(`[data-envelope-id="${focus.envelopeId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('bp-row-flash');
        setTimeout(() => row.classList.remove('bp-row-flash'), 1600);
      }
    });
  }
}
