import { infoButton } from '../ui/info-button.js';
import { node, disclosure } from '../ui/planning-workspace.js';
import { buildStressExpenses } from './stress-expenses.js';
import { currentBudgetSession } from '../state/budget-session.js';
// js/pages/stress.js — Stress Scenarios page
import { state, navigate, session, activeLensInput, now } from '../app.js';
import { isIncomeLikeItem, itemDateStatus } from '../engine.js';
import { isoDate } from '../core/context.js';
import { t } from '../ui/i18n.js';
import { fmt, fmtNum, escHtml } from '../utils.js';
import { moneyEl } from '../ui/money.js';
import { ask } from '../ui/query.js';
import { openEditBudgetItem } from './budget-plan.js';
import { openSheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/dialog.js';
import { reportDispatchFailure, dispatchBatchOrReport } from '../ui/save-error.js';
import { itemFieldApplies } from '../core/entity-fields.js';
import { setItemFields, viewOf as liveView, pendingOverrides, scenarioCuts, flushItems, onItemSettled } from '../ui/plan-item-live.js';
import { onBudgetSessionChange } from '../state/budget-session.js';
import { isAiFeatureEnabled, aiInsights } from '../ai/client.js';
import { aiErrorText } from '../ai/render.js';
import { formatAiText } from '../ai/money-text.js';
import {
  SCENARIOS, CAT_CHOICES, scenarioHits, stressCutPct, setStressCutPct, clearStressCuts, clampFrac,
  itemsNeedingCutExpansion, expandFlatCuts, cutScenariosFor, isTransferItem,
} from '../engine/stress.js';

let expandedScenario = null; // 'A'..'E' or null
let originalCutPct = new Map(); // `${itemId}|${scenario}` -> cut pct snapshot at page open
let pageContainer = null;

// Opens the plan-item editor and repaints this page after a save or delete,
// so the totals and the flat-ladder queue reflect the edit. The editor sends
// the pending live edits first (flushItems), so it opens on committed state.
function editItem(id) {
  openEditBudgetItem(id, {
    onChange: () => {
      if (pageContainer?.querySelector('#stress-page')) rerenderTable(pageContainer);
    },
  });
}

// ── Live edits: cut sliders, per-row reset and the category popover ─────────
// Each control queues its fields in the plan-item live queue
// (js/ui/plan-item-live.js), shared with the Plan page; they go out as one
// budgetItem.update per item after 400 ms of quiet, the last value per field
// winning. Until the update lands the page renders the stored item with the
// pending fields over it (viewOf). The settle listener repaints the page as it
// is now (pageContainer), not the render that queued the edit.
//
// There is no guard for a "fake" folder (the old scheduleSave skipped one):
// nothing sets such a flag any more. A missing budget is refused by the session
// (no_budget) and the page renders nothing without one.
onItemSettled(settleCutEdit);

// Slider positions while the thumb is still moving (`input`), before `change`
// queues them: id -> { scenario: fraction }. Kept apart from the queue so a drag
// repaints the totals without sending anything.
const cutDrafts = new Map();
// A drag belongs to the budget it was made in.
onBudgetSessionChange(() => cutDrafts.clear());

/** The stored item with the unsaved edits (queued, and this page's drag) over it. */
function viewOf(item) {
  const view = liveView(item);
  const draft = cutDrafts.get(item.id);
  return draft ? { ...view, stress_cut_pcts: draft } : view;
}

/** An item whose end month has passed: nothing left to decide about its cuts. */
function hasEnded(item) {
  return itemDateStatus(item, now()).status === 'ended';
}

/**
 * Every plan item as this page shows it: stored state plus unsaved edits.
 * Not dated, and read for names, categories and cuts only: every amount comes
 * from the `stress.runway` answer, which dates the same view.
 */
function viewItems() {
  return state.budgetItems.map(viewOf);
}

/**
 * The unsaved edits as `stress.runway` takes them, in the order viewOf lays
 * them: the queue's pending fields, then this page's drag over them (an
 * item's entries apply in order), each cut map with its scenario keys only
 * (scenarioCuts: a stored map can hold another key, which the query refuses).
 */
function itemOverrides() {
  const out = pendingOverrides(state.budgetItems);
  for (const it of state.budgetItems) {
    const draft = cutDrafts.get(it.id);
    if (draft) out.push({ id: it.id, fields: { stress_cut_pcts: scenarioCuts(draft) } });
  }
  return out;
}

/**
 * The page's figures: one `stress.runway` query over the active lens, today
 * and the unsaved edits, with the per-item amounts when `detail`. Null when
 * it fails (warned): the caller then leaves the figures on screen as they are.
 */
function askRunway(detail) {
  return ask('stress.runway', {
    ...activeLensInput(), date: isoDate(now()), itemOverrides: itemOverrides(), detail,
  });
}

/** The answer's per-item amounts by id. */
function amountsById(answer) {
  return new Map((answer.items || []).map(m => [m.id, m]));
}

/** On a failure (the queue has dropped what was pending), show state and say why; true when said. */
function settleCutEdit(id, r) {
  const status = pageContainer?.querySelector('#stress-save-state');
  if (status) status.textContent = r.ok ? t('workspace.savedCuts') : t('overview.unavailable');
  if (r.ok) return false;
  cutDrafts.delete(id);
  if (!pageContainer?.querySelector('#stress-page')) return false;
  rerenderTable(pageContainer);
  reportDispatchFailure(r.error);
  return true;
}

/**
 * Whether the item's kind takes stress fields (not a transfer or a loan
 * payment). A legacy item of another kind can still carry a category and a
 * cut; it is shown as it is, but gets no control that sets them and is not
 * expanded: the command stores a field that does not apply as its off value,
 * so any such edit would silently zero the cut.
 */
const takesStress = (it) => itemFieldApplies('stress_category', it.kind);

/** A copy the stress model's mutating helpers may write to. */
function withOwnCuts(item) {
  return { ...item, stress_cut_pcts: item.stress_cut_pcts ? { ...item.stress_cut_pcts } : item.stress_cut_pcts };
}

/** Cut fractions as the engine reads them (a legacy whole percent is clamped). */
function clampedCuts(map) {
  return Object.fromEntries(Object.entries(map).map(([s, v]) => [s, clampFrac(v)]));
}

/** The stored item `id` with its unsaved edits, or null. */
function currentItem(id) {
  const stored = state.budgetItems.find(x => x.id === id);
  return stored ? viewOf(stored) : null;
}

/** A scenario's runway in months as the bars draw it: Infinity when unlimited, 0 when there is no usable cash. */
function runwayOf(sc) {
  if (sc.runway === 'unlimited') return Infinity;
  if (sc.runway === 'none') return 0;
  return sc.months;
}

function runwayClass(mo) {
  if (mo === Infinity || mo >= 6) return 'stress-runway--ok';
  if (mo >= 3) return 'stress-runway--mid';
  return 'stress-runway--bad';
}

function scenarioLabel(s) { return s === 'Baseline' ? t('stress.baseline') : s; }
function scenarioDesc(s)  { return s === 'Baseline' ? t('stress.baselineDesc') : t('stress.cat' + s); }

function envLabel(item) {
  const env = state.envelopes.find(e => e.id === item.envelope_id);
  if (!env) return item.description || t('stress.deletedEnvelope');
  const base = env.category ? `${env.category} · ${env.name}` : env.name;
  return item.description ? `${base} — ${item.description}` : base;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function buildSummaryRow(sc) {
  const scenario = sc.scenario;
  const row = document.createElement('div');
  row.className = 'stress-row';
  row.dataset.scenario = scenario;
  if (scenario !== 'Baseline') {
    row.classList.add('stress-row--clickable');
    row.tabIndex = 0; row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(expandedScenario === scenario));
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } });
  }
  if (expandedScenario === scenario) row.classList.add('stress-row--expanded');

  const scCell = document.createElement('div');
  scCell.className = 'stress-cell stress-cell--label';
  const badge = document.createElement('span');
  badge.className = `stress-badge stress-badge--${scenario.toLowerCase()}`;
  badge.textContent = scenarioLabel(scenario);
  const desc = document.createElement('span');
  desc.className = 'stress-desc muted';
  desc.textContent = scenarioDesc(scenario) + (scenario === 'Baseline' ? '' : ' · ' + t('workspace.severity' + scenario));
  scCell.append(badge, desc);
  row.append(scCell);

  // income, expense, net, delta, runway
  for (const cls of ['--num', '--num', '--num', '--num', '--runway']) {
    const cell = document.createElement('div');
    cell.className = `stress-cell stress-cell${cls}`;
    row.append(cell);
  }
  paintSummaryRow(row, sc);
  return row;
}

/** Fill a scenario row's figure cells from its `stress.runway` answer (a first paint or a live tick). */
function paintSummaryRow(row, sc) {
  // cells: [label, income, expense, net, delta, runway]
  const [, incCell, expCell, netCell, dCell, rwCell] = row.querySelectorAll('.stress-cell');
  incCell.replaceChildren(moneyEl(sc.income, { size: 'md' }));
  expCell.replaceChildren(moneyEl(sc.expense, { size: 'md' }));
  netCell.classList.toggle('stress-negative', sc.netNegative);
  netCell.replaceChildren(moneyEl(sc.net, { size: 'md', signed: true }));

  dCell.classList.remove('stress-negative', 'stress-positive', 'muted');
  if (sc.scenario === 'Baseline') {
    dCell.textContent = '—';
    dCell.classList.add('muted');
  } else {
    if (sc.deltaSign < 0) dCell.classList.add('stress-negative');
    else if (sc.deltaSign > 0) dCell.classList.add('stress-positive');
    dCell.replaceChildren(moneyEl(sc.delta, { size: 'md', signed: true }));
  }

  const runway = runwayOf(sc);
  const rwLabel = document.createElement('span');
  rwLabel.className = 'stress-runway-label';
  rwLabel.textContent = runway === Infinity
    ? t('workspace.noBurn')
    : `${fmtNum(runway, { decimals: 1 })} ${t('stress.months')}`;
  const rwBar = document.createElement('div');
  rwBar.className = 'stress-runway-bar ' + runwayClass(runway);
  const rwFill = document.createElement('div');
  rwFill.className = 'stress-runway-fill';
  const pct = runway === Infinity ? 100 : Math.max(2, Math.min(100, (runway / 12) * 100));
  rwFill.style.width = pct + '%';
  rwBar.append(rwFill);
  rwBar.hidden = runway === Infinity;
  rwBar.title = t('workspace.runwayScale');
  rwCell.replaceChildren(rwLabel, rwBar);
  for (const [cell, key] of [[incCell,'colIncome'],[expCell,'colExpenses'],[netCell,'colNet'],[dCell,'colDelta'],[rwCell,'colRunway']]) cell.dataset.label = t('stress.' + key);
}

function buildDetail(scenario, amounts) {
  const detail = document.createElement('div');
  detail.className = 'stress-detail';

  const title = document.createElement('div');
  title.className = 'stress-detail-title';
  title.textContent = t('stress.detailTitle')(scenario);
  detail.append(title);

  const hits = viewItems()
    .filter(it => it.include !== false && scenarioHits(scenario, it) && amounts.has(it.id))
    .map(it => ({ it, money: amounts.get(it.id) }));

  if (hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted stress-detail-empty';
    empty.textContent = t('stress.detailEmpty');
    detail.append(empty);
    return detail;
  }

  // Defensive: a transfer never carries a stress_category, so `hits` (built
  // from scenarioHits) already excludes it in practice — this guard is here
  // in case a category ever leaks onto one (e.g. a kind switched and back).
  const incomeHits = hits.filter(h => !isTransferItem(h.it) && isIncomeLikeItem(h.it));
  const expenseHits = hits.filter(h => !isTransferItem(h.it) && !isIncomeLikeItem(h.it));

  function headRow() {
    const head = document.createElement('div');
    head.className = 'stress-detail-trow stress-detail-thead';
    head.innerHTML =
      `<span></span><span></span><span>${escHtml(t('stress.cutCol'))}</span>` +
      `<span class="col-num">${escHtml(t('stress.baselineCol'))}</span>` +
      `<span class="col-num">${escHtml(t('stress.adjustedCol'))}</span>` +
      `<span class="col-num">${escHtml(t('stress.impactCol'))}</span>`;
    return head;
  }

  function buildFlatSection(label, rows) {
    if (!rows.length) return null;
    const sec = document.createElement('div');
    sec.className = 'stress-detail-section';
    const h = document.createElement('div');
    h.className = 'stress-detail-sec-head';
    h.textContent = label;
    sec.append(h);
    const tbl = document.createElement('div');
    tbl.className = 'stress-detail-table';
    tbl.append(headRow());
    for (const { it, money } of rows) {
      tbl.append(buildDetailRow(it, money, scenario));
    }
    sec.append(tbl);
    return sec;
  }

  function buildGroupedExpenseSection(label, rows) {
    if (!rows.length) return null;
    const sec = document.createElement('div');
    sec.className = 'stress-detail-section';
    const h = document.createElement('div');
    h.className = 'stress-detail-sec-head';
    h.textContent = label;
    sec.append(h);

    // Group by envelope id. Unknown/missing envelope goes to '__none__'.
    const groups = new Map(); // envKey -> { name, rows: [] }
    for (const entry of rows) {
      const env = state.envelopes.find(e => e.id === entry.it.envelope_id);
      const key = env ? env.id : '__none__';
      const name = env
        ? (env.category ? `${env.category} · ${env.name}` : env.name)
        : t('stress.catNone');
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key).rows.push(entry);
    }

    const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const g of sorted) {
      const gh = document.createElement('div');
      gh.className = 'stress-detail-envgroup';
      gh.textContent = g.name;
      sec.append(gh);
      const tbl = document.createElement('div');
      tbl.className = 'stress-detail-table';
      tbl.append(headRow());
      for (const { it, money } of g.rows) {
        tbl.append(buildDetailRow(it, money, scenario));
      }
      sec.append(tbl);
    }
    return sec;
  }

  const incSec = buildFlatSection(t('stress.detailIncome'), incomeHits);
  const expSec = buildGroupedExpenseSection(t('stress.detailExpense'), expenseHits);
  if (incSec) detail.append(incSec);
  if (expSec) detail.append(expSec);

  return detail;
}

function buildDetailRow(it, money, scenario) {
  const r = document.createElement('div');
  r.className = 'stress-detail-trow';
  r.dataset.itemId = it.id;

  // 1) Name
  const name = document.createElement('span');
  name.className = 'stress-detail-name';
  name.textContent = isIncomeLikeItem(it)
    ? (it.description || t('stress.incomeLabel'))
    : (envLabel(it) || it.description || t('stress.itemFallback'));
  r.append(name);

  // 2) Category chip (button opens popover; a plain chip for a kind that
  // takes no stress fields)
  const chipWrap = document.createElement('span');
  chipWrap.className = 'stress-cat-wrap';
  const editable = takesStress(it);
  const chipBtn = document.createElement(editable ? 'button' : 'span');
  if (editable) chipBtn.type = 'button';
  chipBtn.className = `chip bp-stress-chip bp-stress-${it.stress_category.toLowerCase()}${editable ? ' stress-cat-btn' : ''}`;
  chipBtn.dataset.role = 'cat-btn';
  chipBtn.textContent = t('budgetPlan.stressChip')(it.stress_category);
  if (editable) {
    chipBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCatPopover(chipWrap, it);
    });
  }
  chipWrap.append(chipBtn);
  r.append(chipWrap);

  // 3) Slider (with reset button)
  const sliderWrap = document.createElement('span');
  sliderWrap.className = 'stress-slider-wrap';

  if (!editable) {
    // Shown as stored, without a control.
    const pctLabel = document.createElement('span');
    pctLabel.className = 'stress-slider-pct';
    pctLabel.dataset.role = 'pct';
    pctLabel.textContent = `${Math.round(stressCutPct(it, scenario) * 100)}%`;
    sliderWrap.append(pctLabel);
  } else {
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'stress-slider-reset';
    resetBtn.title = t('stress.resetCut');
    resetBtn.setAttribute('aria-label', t('stress.resetCut'));
    resetBtn.textContent = '\u21BA'; // anticlockwise open circle arrow
    resetBtn.addEventListener('click', (e) => e.stopPropagation());

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.className = 'stress-slider';
    const initialCut = Math.round(stressCutPct(it, scenario) * 100);
    slider.value = String(initialCut);
    const pctLabel = document.createElement('span');
    pctLabel.className = 'stress-slider-pct';
    pctLabel.dataset.role = 'pct';
    pctLabel.textContent = `${initialCut}%`;

    const originalPct = Math.round((originalCutPct.get(`${it.id}|${scenario}`) ?? 0) * 100);
    function refreshResetState() {
      const cur = Math.round(stressCutPct(currentItem(it.id) ?? it, scenario) * 100);
      resetBtn.disabled = cur === originalPct;
    }
    refreshResetState();

    slider.addEventListener('input', () => {
      const v = Math.max(0, Math.min(100, Number(slider.value) || 0));
      // The drag moves a copy; `change` queues the resulting cuts.
      const draft = withOwnCuts(currentItem(it.id) ?? it);
      setStressCutPct(draft, scenario, v / 100);
      if (draft.stress_cut_pcts) cutDrafts.set(it.id, clampedCuts(draft.stress_cut_pcts));
      pctLabel.textContent = `${v}%`;
      refreshResetState();
      updateLive();
    });
    slider.addEventListener('change', () => {
      const cuts = cutDrafts.get(it.id);
      if (cuts) setItemFields(it.id, { stress_cut_pcts: cuts });
      cutDrafts.delete(it.id);
    });
    slider.addEventListener('click', (e) => e.stopPropagation());

    resetBtn.addEventListener('click', () => {
      const next = withOwnCuts(currentItem(it.id) ?? it);
      setStressCutPct(next, scenario, originalPct / 100);
      cutDrafts.delete(it.id);
      if (next.stress_cut_pcts) setItemFields(it.id, { stress_cut_pcts: clampedCuts(next.stress_cut_pcts) });
      slider.value = String(originalPct);
      pctLabel.textContent = `${originalPct}%`;
      refreshResetState();
      updateLive();
    });

    sliderWrap.append(resetBtn, slider, pctLabel);
  }
  r.append(sliderWrap);

  // 4) Baseline
  const baseCell = document.createElement('span');
  baseCell.className = 'col-num muted';
  baseCell.dataset.role = 'base';
  baseCell.textContent = fmt(money.annual);
  r.append(baseCell);

  // 5) Adjusted
  const adjCell = document.createElement('span');
  adjCell.className = 'col-num';
  adjCell.dataset.role = 'adj';
  adjCell.textContent = fmt(money.adjusted[scenario]);
  r.append(adjCell);

  // 6) Impact
  const impCell = document.createElement('span');
  impCell.className = 'col-num';
  impCell.dataset.role = 'impact';
  paintImpact(impCell, money, scenario);
  r.append(impCell);

  r.classList.add('stress-detail-trow--clickable');
  r.addEventListener('click', () => editItem(it.id));

  return r;
}

/** An item's impact in `scenario` (stressed minus annual), coloured by its sign. */
function paintImpact(cell, money, scenario) {
  const impact = money.impact[scenario];
  const sign = money.impactSign[scenario];
  cell.classList.remove('stress-negative', 'stress-positive');
  if (sign < 0) cell.classList.add('stress-negative');
  else if (sign > 0) cell.classList.add('stress-positive');
  cell.textContent = (impact >= 0 ? '+' : '') + fmt(impact);
}

// Live-update summary row cells and any open detail row's adj/impact,
// without full rerender (preserves slider focus).
function updateLive() {
  const tableHost = document.querySelector('#stress-table');
  if (!tableHost) return;
  const answer = askRunway(expandedScenario != null);
  if (!answer) return;

  const byScenario = new Map(answer.scenarios.map(sc => [sc.scenario, sc]));
  tableHost.querySelectorAll('.stress-row[data-scenario]').forEach(row => {
    const sc = byScenario.get(row.dataset.scenario);
    if (sc) paintSummaryRow(row, sc);
  });

  // Detail rows
  const detail = tableHost.querySelector('.stress-detail');
  if (detail && expandedScenario) {
    const amounts = amountsById(answer);
    detail.querySelectorAll('.stress-detail-trow[data-item-id]').forEach(row => {
      const money = amounts.get(row.dataset.itemId);
      if (!money) return;
      const baseCell = row.querySelector('[data-role="base"]');
      const adjCell = row.querySelector('[data-role="adj"]');
      const impCell = row.querySelector('[data-role="impact"]');
      if (baseCell) baseCell.textContent = fmt(money.annual);
      if (adjCell) adjCell.textContent = fmt(money.adjusted[expandedScenario]);
      if (impCell) paintImpact(impCell, money, expandedScenario);
    });
  }
}

function openCatPopover(anchor, painted) {
  // Close any open popover first
  document.querySelectorAll('.stress-cat-popover').forEach(p => p.remove());
  // The row holds the item from its last repaint; mark the category it has now.
  const item = currentItem(painted.id) ?? painted;

  const pop = document.createElement('div');
  pop.className = 'stress-cat-popover';
  pop.addEventListener('click', e => e.stopPropagation());

  const choices = [...CAT_CHOICES, null];
  for (const c of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stress-cat-opt';
    if (c === item.stress_category) b.classList.add('stress-cat-opt--active');
    if (c) {
      b.classList.add(`bp-stress-${c.toLowerCase()}`);
      b.textContent = `${c} — ${c === 'Z' ? t('stress.catZ') : t('stress.cat' + c)}`;
    } else {
      b.textContent = t('stress.clearCat');
    }
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const fields = { stress_category: c };
      // A cleared or Z category carries no cut (as on the Plan page): the
      // stale cuts must not outlive the category.
      if (!c || c === 'Z') {
        const next = withOwnCuts(currentItem(item.id) ?? item);
        clearStressCuts(next);
        fields.stress_cut_pcts = next.stress_cut_pcts ?? null;
        fields.stress_cut_pct = next.stress_cut_pct;
        cutDrafts.delete(item.id);
      }
      setItemFields(item.id, fields);
      pop.remove();
      // Category change can move an item in/out of the hit list — full rerender.
      const pageRoot = document.getElementById('stress-page')?.parentElement;
      if (pageRoot) rerenderTable(pageRoot);
    });
    pop.append(b);
  }

  anchor.append(pop);

  const close = (ev) => {
    if (!pop.contains(ev.target)) {
      pop.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

function buildNoStressSection(amounts) {
  const wrap = document.createElement('div');
  wrap.className = 'card stress-unconfigured';

  const head = document.createElement('div');
  head.className = 'stress-unconfigured-head';
  const h = document.createElement('h3');
  h.textContent = t('stress.noStressTitle');
  head.append(h);
  wrap.append(head);

  // A transfer never carries a stress_category (the editor hides that field
  // for it), so without this guard every transfer would permanently show up
  // here as "needs a category" — it never needs one.
  const missing = viewItems().filter(it =>
    it.include !== false && takesStress(it) && !hasEnded(it)
      && (!it.stress_category || (!SCENARIOS.includes(it.stress_category) && it.stress_category !== 'Z'))
      && amounts.has(it.id)
  );

  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.style.marginBottom = '8px';
  sub.textContent = missing.length === 0
    ? t('stress.noStressEmpty')
    : t('stress.noStressSub')(missing.length);
  wrap.append(sub);

  if (missing.length === 0) return wrap;

  const list = document.createElement('div');
  list.className = 'stress-missing-list';
  for (const it of missing) {
    const row = document.createElement('div');
    row.className = 'stress-missing-row';

    const name = document.createElement('span');
    name.className = 'stress-missing-name';
    name.textContent = isIncomeLikeItem(it)
      ? (it.description || t('stress.incomeLabel'))
      : envLabel(it);
    row.append(name);

    const amt = document.createElement('span');
    amt.className = 'muted';
    amt.textContent = fmt(amounts.get(it.id).annual) + ' ' + t('stress.perYear');
    row.append(amt);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = t('stress.configure');
    btn.addEventListener('click', () => {
      sessionStorage.setItem('budget-plan-filter', it.description || envLabel(it));
      navigate('budget-plan');
    });
    row.append(btn);

    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

/** The full repaint. False when the query failed and the page was left as it was. */
function rerenderTable(container) {
  const tableHost = container.querySelector('#stress-table');
  if (!tableHost) return false;
  const answer = askRunway(true);
  if (!answer) return false;
  const amounts = amountsById(answer);
  tableHost.innerHTML = '';

  const thead = document.createElement('div');
  thead.className = 'stress-row stress-row--head';
  thead.innerHTML =
    `<div class="stress-cell">${escHtml(t('stress.colScenario'))}</div>` +
    `<div class="stress-cell stress-cell--num">${escHtml(t('stress.colIncome'))}</div>` +
    `<div class="stress-cell stress-cell--num">${escHtml(t('stress.colExpenses'))}</div>` +
    `<div class="stress-cell stress-cell--num">${escHtml(t('stress.colNet'))}</div>` +
    `<div class="stress-cell stress-cell--num">${escHtml(t('stress.colDelta'))}</div>` +
    `<div class="stress-cell">${escHtml(t('stress.colRunway'))}</div>`;
  tableHost.append(thead);

  for (const sc of answer.scenarios) {
    const s = sc.scenario;
    const row = buildSummaryRow(sc);
    if (s !== 'Baseline') {
      row.addEventListener('click', () => {
        const shown = expandedScenario;
        expandedScenario = expandedScenario === s ? null : s;
        if (!rerenderTable(container)) expandedScenario = shown;
      });
    }
    tableHost.append(row);

    if (expandedScenario === s) {
      tableHost.append(buildDetail(s, amounts));
    }
  }

  const flatHost = container.querySelector('#stress-flat');
  if (flatHost) {
    const wasOpen = flatHost.querySelector('details')?.open || false;
    flatHost.innerHTML = '';
    const section = buildFlatLadderSection(answer.flatLadder, amounts);
    if (section) {
      section.open = wasOpen;
      flatHost.append(section);
    }
  }

  const noStressHost = container.querySelector('#stress-nostress');
  if (noStressHost) {
    noStressHost.innerHTML = '';
    noStressHost.append(buildNoStressSection(amounts));
  }

  const extraHost = container.querySelector('#stress-expenses');
  const extras = buildStressExpenses(answer.extraExpenses || [], () => rerenderTable(container));
  if (extraHost) extraHost.replaceWith(extras);
  else tableHost.parentElement.after(extras);

  const cashEl = container.querySelector('#stress-cash');
  if (cashEl) cashEl.textContent = fmt(answer.usableCash);
  const reservedEl = container.querySelector('#stress-reserved');
  if (reservedEl) {
    if (answer.bufferFloor > 0.005) {
      reservedEl.hidden = false;
      const val = reservedEl.querySelector('strong');
      if (val) val.textContent = fmt(answer.bufferFloor);
    } else {
      reservedEl.hidden = true;
    }
  }
  return true;
}

// ── Main render ──────────────────────────────────────────────────────────────
export async function render(container) {
  pageContainer = container;
  expandedScenario = null;
  originalCutPct = new Map();
  for (const it of state.budgetItems) {
    for (const s of SCENARIOS) {
      originalCutPct.set(`${it.id}|${s}`, stressCutPct(it, s));
    }
  }

  if (!state.budgetFolder || !state.budgetItems.length) {
    // eslint-disable-next-line no-restricted-syntax -- escHtml-wrapped
    container.innerHTML = `<div class="page"><div class="card">${escHtml(t('stress.empty'))}</div></div>`;
    return;
  }

  // eslint-disable-next-line no-restricted-syntax -- all interpolated values are escHtml-wrapped or locale strings
  container.innerHTML = `
    <div class="page working-money" id="stress-page">
      <div class="page-head">
        <div>
          <h1>${escHtml(t('stress.title'))}</h1>
        </div>
        <div class="actions">
          <span class="chip stress-year-chip">${escHtml(t('stress.annualChip'))}</span>
        </div>
      </div>

      <details class="card stress-rule">
        <summary>${escHtml(t('stress.ruleTitle'))}</summary>
        <p style="margin:8px 0 0">${escHtml(t('stress.ruleBody'))}</p>
      </details>

      <div class="card stress-summary">
        <div class="stress-hint muted">${escHtml(t('stress.scenarioHint'))} · <span>${escHtml(t('workspace.usableCash'))}: <strong id="stress-cash">—</strong></span> <span id="stress-reserved" hidden>· ${escHtml(t('stress.reservedCash'))}: <strong>—</strong></span></div>
        <div id="stress-table" class="stress-table" data-scroll-cue="sticky"></div>
      </div>

      <div id="stress-flat"></div>
      <div id="stress-nostress"></div>
    </div>
  `;

  container.querySelector('.page-head h1').append(infoButton('emergencyRunway'));

  const assumptions = disclosure(t('workspace.assumptions'), []);
  assumptions.classList.add('workspace-assumptions');
  assumptions.append(node('p', '', t('workspace.stressAssumptions')), node('p', 'muted', t('workspace.runwayScale')));
  const saveStatus = node('p', 'workspace-save-state', t('workspace.savedCuts'));
  saveStatus.id = 'stress-save-state'; saveStatus.setAttribute('role', 'status');
  container.querySelector('#stress-page').addEventListener('change', event => {
    if (event.target.matches('input[type=range]')) saveStatus.textContent = t('common.saving');
  });
  container.querySelector('.stress-summary').before(saveStatus);
  container.querySelector('.stress-summary').before(assumptions);
  rerenderTable(container);

  if (isAiFeatureEnabled('whatif')) {
    const actions = container.querySelector('#stress-page .page-head .actions');
    if (actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.textContent = '✨ ' + t('ai.whatif.btn');
      btn.style.marginLeft = '8px';
      btn.addEventListener('click', () => openWhatifSheet());
      actions.append(btn);
    }
  }
}

/**
 * Optional reference for equal scenario cuts. These are valid for cancellations
 * and costs already reduced to their minimum; equality alone needs no action.
 * The query supplies the dated items, and legacy expansion preserves values.
 * Returns null when there are no equal cuts to show.
 */
function buildFlatLadderSection(flatIds, amounts) {
  const view = new Map(viewItems().map(it => [it.id, it]));
  const flat = flatIds.map(id => view.get(id)).filter(Boolean);
  if (!flat.length) return null;

  const wrap = document.createElement('details');
  wrap.className = 'card stress-rule';
  wrap.id = 'stress-flat-card';

  const head = document.createElement('summary');
  head.textContent = t('stress.flatLadderTitle');
  wrap.append(head);

  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.style.marginBottom = '8px';
  sub.textContent = t('stress.flatLadderSub')(flat.length);
  wrap.append(sub);
  // Equal cuts can reflect a real spending floor, including zero.
  const note = document.createElement('div');
  note.className = 'muted stress-flat-note';
  note.style.cssText = 'font-size:12px;margin-bottom:8px;';
  note.textContent = t('stress.flatLadderNote');
  wrap.append(note);

  // A kind that takes no stress fields is not expanded (see takesStress).
  const legacy = itemsNeedingCutExpansion(viewItems().filter(takesStress));
  if (legacy.length) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = t('stress.expandFlatCutsBtn');
    btn.addEventListener('click', async () => {
      const generation = currentBudgetSession();
      const folder = state.budgetFolder;
      const current = () => generation === currentBudgetSession() && folder === state.budgetFolder;
      // Flush before asking: the count and cuts must reflect saved edits.
      if (await flushItems() === false || !current()) return;
      const count = itemsNeedingCutExpansion(state.budgetItems.filter(takesStress)).length;
      if (!count) return;
      const ok = await confirmDialog(
        t('stress.expandFlatCutsConfirm').replace('{count}', String(count)),
      );
      if (!ok || !current()) return;
      const before = state.budgetItems;
      const steps = expandFlatCuts(before)
        .filter((it, i) => it !== before[i] && takesStress(it))
        .map(it => ({
          name: 'budgetItem.update',
          // The map only, as expandFlatCuts produced it: the stored scalar stays.
          input: { id: it.id, fields: { stress_cut_pcts: it.stress_cut_pcts } },
        }));
      if (!steps.length) return;
      // One batch: every item or none, one undo step, one write.
      if (!await dispatchBatchOrReport(session, steps)) return;
      toast(t('stress.expandFlatCutsDone').replace('{count}', String(steps.length)));
      navigate('stress');
    });
    wrap.append(btn);
  }

  const list = document.createElement('div');
  list.className = 'stress-missing-list';
  for (const it of flat) {
    const row = document.createElement('div');
    row.className = 'stress-missing-row';

    const name = document.createElement('span');
    name.className = 'stress-missing-name';
    name.textContent = isIncomeLikeItem(it)
      ? (it.description || t('stress.incomeLabel'))
      : envLabel(it);
    row.append(name);

    const scs = cutScenariosFor(it);
    const pct = Math.round(stressCutPct(it, scs[0]) * 100);
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = t('stress.flatLadderRow')(pct, `${scs[0]}–${scs[scs.length - 1]}`)
      + ' · ' + fmt(amounts.get(it.id).annual) + ' ' + t('stress.perYear');
    row.append(detail);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = t('stress.flatLadderEdit');
    btn.addEventListener('click', () => editItem(it.id));
    row.append(btn);

    list.append(row);
  }
  wrap.append(list);
  return wrap;
}

function openWhatifSheet() {
  const content = document.createElement('div');
  content.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

  const ta = document.createElement('textarea');
  ta.className = 'form-input';
  ta.rows = 3;
  ta.placeholder = t('ai.whatif.placeholder');
  ta.style.cssText = 'resize:vertical;min-height:72px;padding:8px 10px;';
  content.append(ta);

  const submitRow = document.createElement('div');
  submitRow.dataset.sheetActions = '';
  submitRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost';
  closeBtn.textContent = t('common.close');
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-accent';
  submit.textContent = t('ai.whatif.submit');
  submitRow.append(closeBtn, submit);
  content.append(submitRow);

  const answerHost = document.createElement('div');
  answerHost.style.cssText = 'min-height:24px;';
  content.append(answerHost);

  let inFlight = false;
  submit.addEventListener('click', async () => {
    const input = ta.value.trim();
    if (!input || inFlight) return;
    inFlight = true;
    submit.disabled = true;
    answerHost.replaceChildren(skeleton());
    try {
      const out = await aiInsights('whatif', { input });
      renderWhatifAnswer(answerHost, out);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'ai-error';
      note.textContent = aiErrorText(err);
      answerHost.replaceChildren(note);
    } finally {
      inFlight = false;
      submit.disabled = false;
    }
  });

  const sheet = openSheet({ title: t('ai.whatif.title'), content, wide: true });
  closeBtn.addEventListener('click', () => sheet.close());
}

function skeleton() {
  const d = document.createElement('div');
  d.className = 'ai-error';
  d.textContent = t('common.loading');
  return d;
}

function renderWhatifAnswer(host, out) {
  host.replaceChildren();
  if (!out || !out.answer) {
    const e = document.createElement('div');
    e.className = 'ai-error';
    e.textContent = t('ai.whatif.empty');
    host.append(e);
    return;
  }
  const p = document.createElement('p');
  p.style.whiteSpace = 'pre-wrap';
  p.style.lineHeight = '1.5';
  p.textContent = formatAiText(out.answer);
  host.append(p);
  if (Array.isArray(out.assumptions) && out.assumptions.length) {
    const h = document.createElement('div');
    h.className = 'sub';
    h.style.cssText = 'margin-top:12px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.04em;';
    h.textContent = t('ai.whatif.assumptions');
    host.append(h);
    const ol = document.createElement('ol');
    ol.style.margin = '6px 0 0 18px';
    for (const a of out.assumptions) {
      const li = document.createElement('li');
      li.textContent = formatAiText(a);
      ol.append(li);
    }
    host.append(ol);
  }
  if (Array.isArray(out.numbers) && out.numbers.length) {
    const tbl = document.createElement('table');
    tbl.style.cssText = 'margin-top:12px;font-size:13px;border-collapse:collapse;';
    for (const row of out.numbers) {
      const tr = document.createElement('tr');
      const tdL = document.createElement('td');
      tdL.style.cssText = 'padding:4px 12px 4px 0;color:var(--muted);';
      tdL.textContent = formatAiText(row.label || '');
      const tdR = document.createElement('td');
      tdR.style.cssText = 'padding:4px 0;text-align:right;font-variant-numeric:tabular-nums;';
      tdR.textContent = fmt(Number(row.value) || 0);
      tr.append(tdL, tdR);
      tbl.append(tr);
    }
    host.append(tbl);
  }
}
