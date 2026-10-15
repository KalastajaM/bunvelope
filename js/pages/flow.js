// flow.js — Money flow page: a Sankey of where the money comes from and
// where it goes, for the plan (a month or the year) or for the posted
// transactions in a date range. The numbers are the flow.plan and flow.actual
// queries (js/core/queries/flow-*.js); the drawing is js/ui/sankey/.
// Design: docs/superpowers/specs/2026-10-02-money-flow-sankey-design.md

import { addPageHelp } from '../ui/info-button.js';
import { state, navigate, now } from '../app.js';
import { ask } from '../ui/query.js';
import { isoDate } from '../core/context.js';
import { renderSankey } from '../ui/sankey/render.js';
import { dropColumn, focusCategory, flowTable, flowCsv } from '../ui/sankey/layout.js';
import { paletteFor } from '../ui/charts/model.js';
import { loadChartPrefs, saveChartPrefs } from '../ui/charts/persist.js';
import { RANGE_PRESETS, resolveRangePreset } from '../ui/date-range.js';
import { loadPageFilter, savePageFilter, exclusionCount, budgetKeyOf } from '../ui/page-filter.js';
import { openExcludePicker, exclusionChip } from '../ui/exclude-picker.js';
import { emptyState } from '../ui/empty-state.js';
import { downloadBlob, sanitiseFilename } from '../ui/download.js';
import { fmt } from '../utils.js';
import { t, fmtDateLang, fmtMonthLang, trEnv, trCat } from '../ui/i18n.js';

const PREFS_ID = 'flow';
const PRESET_LABEL_KEYS = { ytd: 'reports.presetYtd', '12m': 'reports.preset12m', '6m': 'reports.preset6m', '3m': 'reports.preset3m', all: 'reports.presetAll' };
/** Below this card width only Budget → categories is drawn (the phone view). */
const NARROW = 600;

// Fixed colours for the nodes that are not categories: income green and
// saving blue as the Charts page's Income / Saving series.
const FIXED_COLORS = {
  source: '#10b981', fromSavings: '#3b82f6', saving: '#3b82f6', borrowed: '#64748b', debt: '#64748b',
  budget: '#94a3b8', unspent: '#a3a3a3', shortfall: '#ef4444',
};
// Categories skip the palette's first three (blue, red, green), which the
// fixed nodes above already mean something by.
const categoryColor = i => paletteFor(i + 3);

// ── Page state: the persisted choices, plus this session's month and focus ─

/** @type {{ month: string | null, focus: string | null }} */
const session = { month: null, focus: null };

function monthOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadPrefs() {
  const p = loadChartPrefs(PREFS_ID);
  return {
    mode: p.mode === 'actual' ? 'actual' : 'plan',
    period: p.period === 'year' ? 'year' : 'month',
    preset: RANGE_PRESETS.includes(p.preset) || p.preset === 'custom' ? p.preset : 'ytd',
    from: typeof p.from === 'string' ? p.from : null,
    to: typeof p.to === 'string' ? p.to : null,
    view: p.view === 'table' ? 'table' : 'diagram',
  };
}

// ── Small DOM helpers ───────────────────────────────────────────────────────

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(text, className, onClick) {
  const b = /** @type {HTMLButtonElement} */ (el('button', className, text));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** A `.seg` group of on/off buttons, one of them pressed. */
function seg(label, options, current, onPick) {
  const g = el('span', 'seg');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const b = button(text, value === current ? 'on' : '', () => { if (value !== current) onPick(value); });
    b.setAttribute('aria-pressed', String(value === current));
    g.append(b);
  }
  return g;
}

function divider() {
  const s = el('span');
  s.style.cssText = 'width:1px;height:20px;background:var(--border);margin:0 4px';
  return s;
}

// ── Render ──────────────────────────────────────────────────────────────────

export function render(container) {
  const prefs = loadPrefs();
  // One clock for the render: the default month, the range and the year's date.
  const today = now();
  const month = session.month ?? monthOf(today);
  const save = patch => { saveChartPrefs(PREFS_ID, { ...prefs, ...patch }); render(container); };

  const budgetName = budgetKeyOf(state.budgetFolder);
  const excluded = loadPageFilter('flow', budgetName, { envelopes: new Set(state.envelopes.map(e => e.id)) },
    undefined, { prune: state.envelopes.length > 0 });
  const exEnv = new Set(excluded.envelopes);
  const nExcluded = exclusionCount(excluded);

  const range = resolveRangePreset(prefs, today);
  const focused = session.focus;
  // A focused category shows all its envelopes (0: none folded into Other).
  const input = { excludeEnvelopes: [...exEnv], ...(focused ? { topPerCategory: 0 } : {}) };
  // A failed query is drawn as the empty state.
  const full = prefs.mode === 'plan'
    // The plan within each item's start/end month: the year is the coming 12
    // months, a month the plan as that month sees it.
    ? ask('flow.plan', prefs.period === 'year' ? { period: 'year', date: isoDate(today), ...input } : { period: 'month', month, ...input })
    : ask('flow.actual', { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}), ...input });
  // A focus whose category is gone (another period, an exclusion) lapses.
  if (focused && !full?.nodes.some(n => n.id === focused)) session.focus = null;

  // ── Labels and colours ────────────────────────────────────────────────────
  const envById = new Map(state.envelopes.map(e => [e.id, e]));
  const catIndex = new Map((full?.nodes ?? []).filter(n => n.kind === 'category').map((n, i) => [n.category, i]));
  const labelOf = n => {
    switch (n.kind) {
      case 'source':
        if (n.other) return t('flow.otherIncome')(n.other);
        if (n.label === '(no payee)') return t('invariants.txContextNoPayee');
        return n.label || t('flow.unnamedIncome');
      case 'category': return trCat(n.category);
      case 'envelope': {
        if (n.other) return t('flow.otherEnvelopes')(n.other);
        const env = n.key ? envById.get(n.key) : null;
        return env ? trEnv(env) : (n.label || t('common.unassigned'));
      }
      default: return t(`flow.${n.kind}`);
    }
  };
  const colorOf = n => (n.kind === 'category' || n.kind === 'envelope'
    ? categoryColor(catIndex.get(n.category) ?? 0)
    : FIXED_COLORS[n.kind] ?? '#94a3b8');

  // ── Head and filters ──────────────────────────────────────────────────────
  const page = el('div', 'page');
  const top = el('div', 'page-sticky-top-wrap');
  const head = el('div', 'page-head');
  const headCol = el('div');
  const sub = prefs.mode === 'plan'
    ? (prefs.period === 'year' ? t('flow.planYearSub') : t('flow.planMonthSub')(fmtMonthLang(month)))
    : (!range.from && !range.to
      ? t('reports.allTime')
      : t('reports.rangeTo')(range.from ? fmtDateLang(range.from) : '—', range.to ? fmtDateLang(range.to) : t('reports.today')));
  const heading = el('h1', null, t('flow.title'));
  addPageHelp(heading, 'flow.purpose');
  headCol.append(heading, el('div', 'sub', nExcluded ? `${sub} ${t('pageFilter.filtered')}` : sub));
  head.append(headCol);

  const filters = el('div', 'filters flow-filters');
  filters.append(seg(t('flow.mode'), [['plan', t('flow.plan')], ['actual', t('flow.actual')]], prefs.mode,
    mode => { session.focus = null; save({ mode }); }));
  filters.append(divider());
  if (prefs.mode === 'plan') {
    filters.append(seg(t('flow.period'), [['month', t('flow.month')], ['year', t('flow.year')]], prefs.period,
      period => { session.focus = null; save({ period }); }));
    if (prefs.period === 'month') {
      const picker = /** @type {HTMLInputElement} */ (el('input', 'flow-month'));
      picker.type = 'month';
      picker.value = month;
      picker.setAttribute('aria-label', t('flow.month'));
      picker.addEventListener('change', () => {
        if (!/^\d{4}-\d{2}$/.test(picker.value)) return;
        session.month = picker.value;
        render(container);
      });
      filters.append(picker);
    }
  } else {
    for (const p of RANGE_PRESETS) {
      filters.append(button(t(PRESET_LABEL_KEYS[p]), `btn btn-sm ${prefs.preset === p ? 'btn-accent' : 'btn-ghost'}`,
        () => save({ preset: p, from: null, to: null })));
    }
    const dateInput = (value, label) => {
      const i = /** @type {HTMLInputElement} */ (el('input'));
      i.type = 'date';
      i.value = value ?? '';
      i.setAttribute('aria-label', label);
      return i;
    };
    const fromIn = dateInput(prefs.preset === 'custom' ? prefs.from : null, t('reports.from'));
    const toIn = dateInput(prefs.preset === 'custom' ? prefs.to : null, t('reports.to'));
    const onCustom = () => {
      const from = fromIn.value || null, to = toIn.value || null;
      save(from || to ? { preset: 'custom', from, to } : { preset: 'ytd', from: null, to: null });
    };
    fromIn.addEventListener('change', onCustom);
    toIn.addEventListener('change', onCustom);
    filters.append(divider(), fromIn, toIn);
  }
  filters.append(divider());
  const excludeBtn = button(t('pageFilter.exclude'), 'btn btn-sm btn-ghost', () => openPicker());
  filters.append(excludeBtn);
  const saveExcluded = sel => {
    savePageFilter('flow', budgetName, sel);
    render(container);
    container.querySelector('.flow-exclude')?.focus();
  };
  excludeBtn.classList.add('flow-exclude');
  if (nExcluded) filters.append(exclusionChip({ count: nExcluded, onClear: () => saveExcluded({ envelopes: [] }) }));
  const openPicker = () => {
    /** @type {Map<string, { id: string, label: string }[]>} */
    const byCategory = new Map();
    for (const e of state.envelopes) {
      if (e.archived && !exEnv.has(e.id)) continue;
      const cat = e.category || '';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)?.push({ id: e.id, label: trEnv(e) });
    }
    openExcludePicker({
      title: t('flow.excludeTitle'),
      sections: [{
        id: 'envelopes', label: t('pageFilter.envelopes'),
        groups: [...byCategory].map(([cat, items]) => ({ label: cat ? trCat(cat) : t('common.unassigned'), items })),
      }],
      selected: excluded,
      onApply: saveExcluded,
    });
  };

  top.append(head, filters);
  page.append(top);

  // ── The card ──────────────────────────────────────────────────────────────
  const card = el('section', 'card');
  page.append(card);
  container.replaceChildren(page);

  if (!full || full.totals.in === 0) {
    const plan = prefs.mode === 'plan';
    card.append(emptyState({
      icon: 'chart',
      title: t(plan ? 'flow.emptyPlanTitle' : 'flow.emptyActualTitle'),
      body: t(plan ? 'flow.emptyPlanBody' : 'flow.emptyActualBody'),
      action: {
        label: t(plan ? 'flow.openPlan' : 'flow.openTransactions'),
        onClick: () => navigate(plan ? 'budget-plan' : 'transactions'),
      },
    }));
    return;
  }

  const toolbar = el('div', 'flow-toolbar');
  const toolbarStart = el('div');
  if (session.focus) {
    toolbarStart.append(button(t('flow.allCategories'), 'btn btn-sm btn-ghost', () => {
      session.focus = null;
      render(container);
    }));
  } else {
    toolbarStart.append(el('span', 'sub', t('flow.hint')));
  }
  const toolbarEnd = el('div', 'flow-toolbar-end');
  toolbarEnd.append(seg(t('flow.mode'), [['diagram', t('chart.chart')], ['table', t('chart.table')]], prefs.view,
    view => save({ view })));
  toolbar.append(toolbarStart, toolbarEnd);
  const body = el('div', 'flow-body');
  card.append(toolbar, body);

  const viewFlow = () => {
    if (session.focus) return focusCategory(full, session.focus);
    // A phone has room for two columns: the Budget and where it goes.
    // The sources stay in the table view; a category opens its envelopes.
    return body.clientWidth < NARROW ? dropColumn(dropColumn(full, 3), 0) : full;
  };

  const csvName = () => {
    const what = prefs.mode === 'plan' ? (prefs.period === 'year' ? t('flow.year') : month) : `${range.from ?? 'all'} ${range.to ?? 'today'}`;
    return `${t('flow.title')} ${what}${nExcluded ? ` ${t('pageFilter.filtered')}` : ''}`;
  };
  const csvBtn = button(t('chart.csv'), 'btn btn-sm btn-ghost', () => {
    const rows = flowTable(session.focus ? focusCategory(full, session.focus) : full);
    const text = flowCsv(rows, labelOf, [t('flow.colFrom'), t('flow.colTo'), t('flow.colAmount')]);
    downloadBlob(`${sanitiseFilename(csvName())}.csv`, new Blob([text], { type: 'text/csv;charset=utf-8' }));
  });
  csvBtn.setAttribute('aria-label', t('chart.downloadCsv'));
  csvBtn.title = t('chart.downloadCsv');
  toolbarEnd.append(csvBtn);

  const paint = () => {
    const flow = viewFlow();
    if (prefs.view === 'table') {
      body.replaceChildren(table(flow));
      return;
    }
    const width = Math.max(280, Math.floor(body.clientWidth));
    const perColumn = new Map();
    for (const n of flow.nodes) perColumn.set(n.column, (perColumn.get(n.column) || 0) + 1);
    const most = Math.max(1, ...perColumn.values());
    const height = Math.max(width < NARROW ? 260 : 340, most * 30 + 20);
    body.replaceChildren(renderSankey({
      flow, width, height, labelOf, colorOf, format: v => fmt(v),
      ariaLabel: t('flow.aria')(fmt(flow.totals.in)),
      canActivate: n => (n.kind === 'category' && !session.focus)
        || (n.kind === 'envelope' && !!n.key && prefs.mode === 'actual'),
      onActivate: n => {
        if (n.kind === 'category') {
          session.focus = n.id;
          render(container);
          // Keyboard users land on the focused category, not the page top.
          container.querySelector('.bv-sankey-node')?.focus();
        } else if (n.key) {
          navigate('transactions', { envelope: n.key, dateFrom: range.from || '', dateTo: range.to || '' });
        }
      },
    }));
  };

  const table = flow => {
    const wrap = el('div', 'bv-chart-table-wrap');
    const tbl = el('table', 'tx-table bv-chart-table');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, t('flow.colFrom')), el('th', null, t('flow.colTo')), el('th', 'num', t('flow.colAmount')));
    thead.append(hr);
    const tbody = el('tbody');
    for (const r of flowTable(flow)) {
      const tr = el('tr');
      tr.append(el('td', null, labelOf(r.from)), el('td', null, labelOf(r.to)), el('td', 'num', fmt(r.value)));
      tbody.append(tr);
    }
    tbl.append(thead, tbody);
    wrap.append(tbl);
    return wrap;
  };

  paint();

  // Repaint at the card's new width (a window resize, the rail collapsing),
  // until the page is replaced.
  let lastWidth = body.clientWidth;
  let timer = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!body.isConnected) { observer.disconnect(); return; }
      if (body.clientWidth !== lastWidth) { lastWidth = body.clientWidth; paint(); }
    }, 120);
  });
  observer.observe(body);
}
