import { moneyEl } from '../ui/money.js';
// reports.js — Charts page. Five reports with a shared date-range filter.
// The figures are the report queries' (js/core/queries/reports-*.js,
// plan-allocation.js, envelopes-history.js); the page owns the range, the
// filters, the colours and the labels.

import { addPageHelp } from '../ui/info-button.js';
import { state, navigate, now, activeLensInput } from '../app.js';
import { txPayeeLabel } from '../engine.js';
import { ask } from '../ui/query.js';
import { isoDate } from '../core/context.js';
import { mountChart } from '../ui/charts/index.js';
import { resolveRangePreset } from '../ui/date-range.js';
import { fmt, escHtml } from '../utils.js';
import { t, fmtDateLang, fmtMonthLang, trEnv, trCat } from '../ui/i18n.js';
import { skeletonCard, paintYield } from '../ui/skeleton.js';
import { loadChartPrefs, saveChartPrefs } from '../ui/charts/persist.js';
import { readEnvelopePicks, picksToSave, readTopNPrefs, sortEnvelopeRows, envelopeCount, TOP_N_CHOICES } from './reports-prefs.js';
import { openEnvelopePicker } from './reports-envelope-picker.js';
import { loadPageFilter, savePageFilter, exclusionCount, budgetKeyOf } from '../ui/page-filter.js';
import { openExcludePicker, exclusionChip } from '../ui/exclude-picker.js';
import { openPayeeMergeSheet } from '../payee-merge-sheet.js';
import { getHiddenPayees } from '../state/payee-aliases.js';

// ── Module-state filter (survives re-renders within the page) ─────────────

const filter = {
  preset: 'ytd', // 'ytd' | '12m' | '6m' | '3m' | 'all' | 'custom'
  from: null,
  to: null,
};

function resolveRange() {
  return resolveRangePreset(filter, now());
}

/** The range in words, for the head. @param {{ from: string|null, to: string|null }} r the render's range */
function rangeDescription(r) {
  if (!r.from && !r.to) return t('reports.allTime');
  return t('reports.rangeTo')(r.from ? fmtDateLang(r.from) : '—', r.to ? fmtDateLang(r.to) : t('reports.today'));
}

// The CSV download otherwise carries no hint of which date range it covers
// (Reports' own filter, not the file's contents); every chart's csvName goes
// through here with the render's range, so the name dates what the figures
// cover even across midnight.
function csvNameFor(title, filtered, r) {
  return `${title} ${r.from ?? 'all'} ${r.to ?? 'today'}${filtered ? ` ${t('pageFilter.filtered')}` : ''}`;
}

// ── Card helper ───────────────────────────────────────────────────────────


// The cash-flow series, by the key the query answers under. `id` is the
// series' stable chart id (saved legend state keys on it, so it keeps the
// English name the engine used to give the series); the name shown follows
// the UI language; the colours are the ones the engine used to carry.
const SPENDING_COLOR = '#ef4444';
const SAVING_COLOR = '#3b82f6';
const SERIES = [
  { key: 'income', id: 'Income', labelKey: 'reports.kpiIncome', color: '#10b981' },
  { key: 'spending', id: 'Spending', labelKey: 'reports.kpiSpending', color: SPENDING_COLOR },
  { key: 'saving', id: 'Saving', labelKey: 'reports.kpiSaving', color: SAVING_COLOR },
];

/**
 * A ranked answer's rows with its folded rest as the chart's last row: key
 * null (so it is not clickable) and the English "Other (n)" label the engine
 * used to give it. A failed query is no rows.
 * @param {{ rows: { key: string | null, label: string, value: number }[], other: { count: number, value: number } | null } | null} answer
 */
function withOther(answer) {
  if (!answer) return [];
  return answer.other
    ? [...answer.rows, { key: null, label: `Other (${answer.other.count})`, value: answer.other.value }]
    : answer.rows;
}

function card(title, bodyHtml, subtitle = '') {
  return `
    <section class="card" style="margin-bottom:16px">
      <div class="card-title">
        <h3>${escHtml(title)}</h3>
        ${subtitle ? `<span class="sub">${escHtml(subtitle)}</span>` : ''}
      </div>
      ${bodyHtml}
    </section>
  `;
}

// Each chart card holds an empty slot; the chart is mounted into it after the
// template is set (a chart is a live element, not markup).
const SLOT = '<div class="chart-slot"></div>';

// ── Main render ───────────────────────────────────────────────────────────

export async function render(container) {
  // Paint skeleton placeholders before computing aggregates, so the page
  // shows instantly even on large datasets. The actual content swaps in once
  // computation finishes (still synchronous, but allows a paint cycle).
  const skelPage = document.createElement('div');
  skelPage.className = 'page';
  const skelTop = document.createElement('div');
  skelTop.className = 'page-sticky-top-wrap';
  const skelHead = document.createElement('div');
  skelHead.className = 'page-head';
  const skelCol = document.createElement('div');
  const skelH1 = document.createElement('h1');
  skelH1.textContent = t('reports.title');
  skelCol.append(skelH1);
  skelHead.append(skelCol);
  skelTop.append(skelHead);
  skelPage.append(skelTop, skeletonCard(), skeletonCard({ lineWidth: '24%', blockHeight: 160 }));
  container.replaceChildren(skelPage);
  // Yield to the event loop so the skeleton paints before we block on aggregates.
  await paintYield();
  // The container is the shared #app. If the user navigated away, or a newer
  // render of this page (a filter change) replaced the skeleton, during the
  // yield, the container is no longer ours to fill.
  if (!skelPage.isConnected) return;

  // One clock for the render: the range and every query's date.
  const today = now();
  const date = isoDate(today);
  const range = resolveRangePreset(filter, today);
  const rangeInput = { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) };

  // Page filters: excluded envelopes and payees, saved per budget. Payees
  // are a whole-transaction property, so the range queries drop their rows
  // (`excludePayees`); envelopes are per split line (`excludeEnvelopes`).
  const budgetName = budgetKeyOf(state.budgetFolder);
  // Pruned once data has loaded: an excluded payee merged away (or an
  // envelope deleted) is then dropped from storage, not only from view, so
  // it cannot come back into force unseen.
  const excluded = loadPageFilter('reports', budgetName, {
    envelopes: new Set(state.envelopes.map(e => e.id)),
    payees: new Set(state.transactions.map(txPayeeLabel)),
  }, undefined, { prune: state.transactions.length > 0 });
  const exEnv = new Set(excluded.envelopes);
  const exPay = new Set(excluded.payees);
  const nExcluded = exclusionCount(excluded);
  const exInput = { excludeEnvelopes: [...exEnv], excludePayees: [...exPay] };

  // The range's figures, on the stored rows (spending within a selected
  // range, whatever the lens). The 12-month averages are over the calendar
  // months ending with the range's end (or with last month, for a range that
  // runs to today), from the budget's first month with data.
  const topPrefs = readTopNPrefs(loadChartPrefs('reports-spend-by-envelope'));
  const spendEnv = ask('reports.spending', { groupBy: 'envelope', ...rangeInput, topN: topPrefs.topN, ...exInput });
  const byEnvelope = sortEnvelopeRows(withOther(spendEnv), topPrefs.sort);
  const cash = ask('reports.cashflow', { ...rangeInput, date, ...exInput });
  // Current-balance concepts (as opposed to the spending/income figures
  // above, which are spend-within-a-selected-range and stay on raw history
  // regardless of lens): these follow the global balance lens so they read
  // identically to the same envelope's balance on the Envelopes page or
  // Dashboard, per js/engine/lens.js.
  const lens = activeLensInput();
  const balances = ask('reports.balances', { ...lens, topN: 15, excludeEnvelopes: exInput.excludeEnvelopes });
  const planned = ask('plan.allocation', { top: 10, date, excludeEnvelopes: exInput.excludeEnvelopes });
  const allocation = withOther(planned);

  // Picked envelopes get their own line beside the total (saved per chart).
  const envPrefs = loadChartPrefs('reports-envelope-balance-history');
  const picks = readEnvelopePicks(envPrefs, state.envelopes.filter(e => !exEnv.has(e.id)));
  const history = ask('envelopes.history', {
    ...lens, months: 12, date, ...(picks.length ? { envelopes: picks } : {}), excludeEnvelopes: exInput.excludeEnvelopes,
  });
  const envById = new Map(state.envelopes.map(e => [e.id, e]));
  const spendPay = ask('reports.spending', { groupBy: 'payee', ...rangeInput, topN: 12, ...exInput });
  const byPayee = withOther(spendPay);

  // A failed query leaves its figures off: a dash in the KPI strip, an
  // empty chart and no count in the card's subtitle.
  const totals = cash?.totals ?? { income: 0, spending: 0, saving: 0, net: 0 };

  const presetBtn = (k, lbl) => `
    <button class="btn btn-sm ${filter.preset === k ? 'btn-accent' : 'btn-ghost'} reports-preset"
            data-preset="${k}">${lbl}</button>
  `;

  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  container.innerHTML = `
    <div class="page">
      <div class="page-sticky-top-wrap">
      <div class="page-head">
        <div>
          <h1>${escHtml(t('reports.title'))}</h1>
          <div class="sub">${escHtml(rangeDescription(range))}${nExcluded ? ` ${escHtml(t('pageFilter.filtered'))}` : ''}</div>
        </div>
      </div>

      <div class="filters">
        ${presetBtn('ytd', escHtml(t('reports.presetYtd')))}
        ${presetBtn('12m', escHtml(t('reports.preset12m')))}
        ${presetBtn('6m',  escHtml(t('reports.preset6m')))}
        ${presetBtn('3m',  escHtml(t('reports.preset3m')))}
        ${presetBtn('all', escHtml(t('reports.presetAll')))}
        <span style="width:1px;height:20px;background:var(--border);margin:0 4px"></span>
        <input type="date" id="reports-from" aria-label="${escHtml(t('reports.from'))}" value="${escHtml(filter.from ?? '')}">
        <input type="date" id="reports-to" aria-label="${escHtml(t('reports.to'))}" value="${escHtml(filter.to ?? '')}">
        <span style="width:1px;height:20px;background:var(--border);margin:0 4px"></span>
        <button type="button" class="btn btn-sm btn-ghost" id="reports-exclude">${escHtml(t('pageFilter.exclude'))}</button>
        <span id="reports-exclusion-chip"></span>
      </div>
      </div>

      <div class="kpi-row">
        <div class="kpi reports-kpi" data-kpi="income" role="button" tabindex="0" style="cursor:pointer">
          <div class="lbl">${escHtml(t('reports.kpiIncome'))}</div>
          <div data-summary="income" class="val money-metric" style="color:var(--success-text)"></div>
        </div>
        <div class="kpi reports-kpi" data-kpi="expense" role="button" tabindex="0" style="cursor:pointer">
          <div class="lbl">${escHtml(t('reports.kpiSpending'))}</div>
          <div data-summary="spending" class="val money-metric" style="color:var(--danger-text)"></div>
        </div>
        <div class="kpi">
          <div class="lbl">${escHtml(t('reports.kpiSaving'))}</div>
          <div data-summary="saving" class="val money-metric"></div>
        </div>
        <div class="kpi reports-kpi" data-kpi="all" role="button" tabindex="0" style="cursor:pointer">
          <div class="lbl">${escHtml(t('reports.kpiNet'))}</div>
          <div data-summary="net" class="val money-metric" style="${totals.net < 0 ? 'color:var(--danger-text)' : ''}"></div>
        </div>
      </div>

      <div data-chart="income-vs-spending">${card(t('reports.incomeVsSpending'), SLOT, cash ? t('reports.monthsCount')(cash.months.length) : '')}</div>

      <div data-chart="spend-by-month">${card(t('reports.spendingByMonth'), SLOT)}</div>

      <div data-chart="saving-by-month">${card(t('reports.savingByMonth'), SLOT)}</div>

      <div data-chart="envelope-balance-history">${card(t('reports.envBalanceOverTime'), SLOT, history ? t('reports.monthsAllEnv')(history.months.length) : '')}</div>

      <div class="reports-pair">
        <div data-chart="spend-by-envelope">${card(t('reports.spendingByEnvelope'), SLOT, spendEnv ? t('reports.envelopesCount')(envelopeCount(spendEnv)) : '')}</div>

        <div data-chart="spend-by-payee">${card(t('reports.spendingByPayee'), SLOT, spendPay ? t('reports.payeesCount')(byPayee.length) : '')}</div>

        <div data-chart="envelope-balances">${card(t('reports.envBalancesCurrent'), SLOT, t('reports.redOverspent'))}</div>

        <div data-chart="budget-allocation">${card(t('reports.budgetAllocation'), SLOT, planned ? t('reports.envelopesCount')(allocation.length) : '')}</div>
      </div>
    </div>
  `;
  for (const host of container.querySelectorAll('[data-summary]')) {
    host.append(moneyEl(cash ? totals[host.dataset.summary] : null, { role: 'summary' }));
  }


  addPageHelp(container.querySelector('.page-head h1'), 'tour.steps.reports.body');

  // Preset button handlers.
  for (const btn of container.querySelectorAll('.reports-preset')) {
    btn.addEventListener('click', () => {
      filter.preset = btn.dataset.preset;
      filter.from = null;
      filter.to = null;
      render(container);
    });
  }

  // Custom-range inputs.
  const fromInput = container.querySelector('#reports-from');
  const toInput   = container.querySelector('#reports-to');
  const onCustom = () => {
    filter.from = fromInput.value || null;
    filter.to   = toInput.value   || null;
    if (filter.from || filter.to) filter.preset = 'custom';
    render(container);
  };
  fromInput.addEventListener('change', onCustom);
  toInput.addEventListener('change',   onCustom);

  // ── Click-through: KPIs and chart elements navigate to filtered transactions.
  const periodFilter = () => {
    const r = resolveRange();
    return { dateFrom: r.from || '', dateTo: r.to || '' };
  };

  container.querySelectorAll('.reports-kpi').forEach(el => {
    const go = () => {
      const kpi = el.dataset.kpi; // 'income' | 'expense' | 'all'
      const base = periodFilter();
      const f = kpi === 'all' ? base : { ...base, type: kpi };
      navigate('transactions', f);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  // ── Charts. Each one's onSelect is its click-through to Transactions.
  const mount = (name, spec) => container.querySelector(`[data-chart="${name}"] .chart-slot`).append(mountChart(spec));
  const monthX = points => points.map(p => ({ key: p.month, label: fmtMonthLang(p.month) }));
  const goMonth = ({ key }) => navigate('transactions', `month:${key}`);
  const goEnvelope = ({ key }) => navigate('transactions', { envelope: key, ...periodFilter() });

  mount('income-vs-spending', {
    id: 'reports-income-vs-spending', kind: 'line', title: t('reports.incomeVsSpending'),
    csvName: csvNameFor(t('reports.incomeVsSpending'), nExcluded, range), format: fmt, height: 280,
    x: cash ? monthX(cash.income) : [],
    series: cash ? SERIES.map(s => ({ id: s.id, name: t(s.labelKey), color: s.color, values: cash[s.key].map(p => p.value) })) : [],
    // One average per series, starting hidden: three dashed lines on top of
    // three series is a lot; each is one legend click away. The query has no
    // average for a series with none to draw (no data, or all zero within the
    // window, e.g. a Saving series before any saving activity): a flat zero
    // line is not an "average" worth drawing.
    refLines: cash ? SERIES.filter(s => cash.averages[s.key] != null).map(s => ({
      id: `avg-${s.id}`, name: t('reports.avg12Of')(t(s.labelKey)), value: cash.averages[s.key], color: s.color, hidden: true,
    })) : [],
    onSelect: goMonth,
  });
  mount('spend-by-month', {
    id: 'reports-spend-by-month', kind: 'bar', title: t('reports.spendingByMonth'),
    csvName: csvNameFor(t('reports.spendingByMonth'), nExcluded, range), format: fmt,
    x: cash ? monthX(cash.spendingByMonth) : [],
    series: cash ? [{ id: 'spending', name: t('reports.kpiSpending'), color: SPENDING_COLOR, values: cash.spendingByMonth.map(p => p.value) }] : [],
    // None at exactly zero either: a flat zero line is not an "average".
    refLines: cash?.averages.spendingByMonth != null
      ? [{ id: 'avg12', name: t('reports.avg12'), value: cash.averages.spendingByMonth, color: SPENDING_COLOR }] : [],
    onSelect: goMonth,
  });
  mount('saving-by-month', {
    id: 'reports-saving-by-month', kind: 'bar', title: t('reports.savingByMonth'),
    csvName: csvNameFor(t('reports.savingByMonth'), nExcluded, range), format: fmt,
    x: cash ? monthX(cash.savingByMonth) : [],
    series: cash ? [{ id: 'saving', name: t('reports.kpiSaving'), color: SAVING_COLOR, values: cash.savingByMonth.map(p => p.value) }] : [],
    onSelect: goMonth,
  });
  mount('envelope-balance-history', {
    id: 'reports-envelope-balance-history', kind: 'line', title: t('reports.envBalanceOverTime'),
    csvName: csvNameFor(t('reports.envBalanceOverTime'), nExcluded, range), format: fmt,
    x: history ? monthX(history.totals) : [],
    series: !history ? [] : [
      { id: 'total', name: t('reports.totalEnvBalance'), values: history.totals.map(p => p.value) },
      // Category · Name keeps two picked envelopes with the same name (in
      // different categories) from producing two identically-labelled lines.
      ...picks.map(id => {
        const env = envById.get(id);
        const name = env && env.category ? `${trCat(env.category)} · ${trEnv(env)}` : trEnv(env);
        return {
          id: `env:${id}`, name,
          values: history.byEnvelope.find(e => e.id === id).points.map(p => p.value),
        };
      }),
    ],
  });
  mount('spend-by-envelope', {
    id: 'reports-spend-by-envelope', kind: 'hbar', title: t('reports.spendingByEnvelope'),
    csvName: csvNameFor(t('reports.spendingByEnvelope'), nExcluded, range), format: fmt,
    items: byEnvelope, onSelect: goEnvelope,
  });
  mount('spend-by-payee', {
    id: 'reports-spend-by-payee', kind: 'hbar', title: t('reports.spendingByPayee'),
    csvName: csvNameFor(t('reports.spendingByPayee'), nExcluded, range), format: fmt,
    // The engine's "(no payee)" bucket has nowhere useful to click through to
    // (a payee search for the literal label would just match rows that also
    // say "(no payee)"), so it gets no key — the row shows but is not a button.
    items: byPayee.map(p => (p.label === '(no payee)' ? { ...p, key: null } : p)),
    onSelect: ({ key }) => navigate('transactions', { search: `"${String(key).replace(/"/g, '')}"`, ...periodFilter() }),
  });
  mount('envelope-balances', {
    id: 'reports-envelope-balances', kind: 'hbar', title: t('reports.envBalancesCurrent'),
    csvName: csvNameFor(t('reports.envBalancesCurrent'), nExcluded, range), format: fmt,
    items: (balances?.rows ?? []).map(b => ({ ...b, color: b.value < 0 ? 'var(--danger)' : 'var(--success)' })),
    onSelect: goEnvelope,
  });
  mount('budget-allocation', {
    id: 'reports-budget-allocation', kind: 'pie', title: t('reports.budgetAllocation'),
    csvName: csvNameFor(t('reports.budgetAllocation'), nExcluded, range), format: fmt, height: 220,
    items: allocation, onSelect: goEnvelope,
  });

  // ── Controls above two charts; each saves its choice and re-renders.
  const controlsFor = name => {
    const row = document.createElement('div');
    row.className = 'reports-chart-controls';
    container.querySelector(`[data-chart="${name}"] .chart-slot`).before(row);
    return row;
  };
  const segButton = (text, pressed, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm btn-ghost';
    b.textContent = text;
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onClick);
    return b;
  };
  const seg = (labelText, buttons) => {
    const g = document.createElement('span');
    g.className = 'seg';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', labelText);
    const l = document.createElement('span');
    l.textContent = labelText;
    g.append(l, ...buttons);
    return g;
  };

  const saveTop = patch => {
    saveChartPrefs('reports-spend-by-envelope', { ...topPrefs, ...patch });
    render(container);
  };
  controlsFor('spend-by-envelope').append(
    seg(t('reports.showTop'), TOP_N_CHOICES.map(n =>
      segButton(n ? String(n) : t('reports.topAll'), topPrefs.topN === n, () => saveTop({ topN: n })))),
    seg(t('reports.sortBy'), [
      segButton(t('reports.sortAmount'), topPrefs.sort === 'amount', () => saveTop({ sort: 'amount' })),
      segButton(t('reports.sortName'), topPrefs.sort === 'name', () => saveTop({ sort: 'name' })),
    ]),
  );

  const pickBtn = segButton(t('reports.envelopesButton')(picks.length), false, () => openEnvelopePicker({
    envelopes: state.envelopes.filter(e => !exEnv.has(e.id)), picked: picks,
    onApply: ids => {
      saveChartPrefs('reports-envelope-balance-history', { ...envPrefs, envelopes: picksToSave(envPrefs.envelopes, ids, exEnv) });
      render(container);
    },
  }));
  pickBtn.removeAttribute('aria-pressed');
  controlsFor('envelope-balance-history').append(pickBtn);

  // ── Page filters: chip, the Exclude… picker, and the balance-card note.
  const saveExcluded = sel => {
    savePageFilter('reports', budgetName, sel);
    // The picker/chip that triggered this closed itself already; once the
    // page has re-rendered around the new filter, return focus to the
    // Exclude… button rather than dropping it back to the document body.
    render(container).then(() => container.querySelector('#reports-exclude')?.focus());
  };
  if (nExcluded) {
    container.querySelector('#reports-exclusion-chip')
      .append(exclusionChip({ count: nExcluded, onClear: () => saveExcluded({ envelopes: [], payees: [] }) }));
  }
  container.querySelector('#reports-exclude').addEventListener('click', () => {
    /** @type {Map<string, { id: string, label: string }[]>} */
    const byCategory = new Map();
    for (const e of state.envelopes) {
      if (e.archived && !exEnv.has(e.id)) continue;
      const cat = e.category || '';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push({ id: e.id, label: trEnv(e) });
    }
    // Payees seen in the selected period, largest spending first, then any
    // payee already excluded (so it can be included again). Hidden payees are
    // left out unless already excluded; the saved-filter validation above
    // still allows every payee.
    const spendByPayee = new Map((ask('reports.spending', { groupBy: 'payee', ...rangeInput, topN: 0 })?.rows ?? []).map(r => [r.key, r.value]));
    const inPeriod = state.transactions.filter(tx => {
      const d = String(tx.date || '').slice(0, 10);
      return (!range.from || d >= range.from) && (!range.to || d <= range.to);
    });
    const hidden = getHiddenPayees(state.meta);
    // "(no payee)" is a bucket label, not a real payee to exclude by name; it
    // only appears here when a stored exclusion already names it, so it can
    // still be un-excluded.
    const payees = [...new Set([...inPeriod.map(txPayeeLabel), ...exPay])]
      .filter(p => exPay.has(p) || (!hidden.has(p.toLowerCase()) && p !== '(no payee)'))
      .sort((a, b) => (spendByPayee.get(b) || 0) - (spendByPayee.get(a) || 0) || a.localeCompare(b));
    openExcludePicker({
      title: t('pageFilter.reportsTitle'),
      sections: [
        {
          id: 'envelopes', label: t('pageFilter.envelopes'),
          groups: [...byCategory].map(([cat, items]) => ({ label: cat ? trCat(cat) : t('common.unassigned'), items })),
        },
        {
          id: 'payees', label: t('pageFilter.payees'),
          groups: [{ label: '', items: payees.map(p => ({ id: p, label: p === '(no payee)' ? t('invariants.txContextNoPayee') : p })) }],
          pinSelected: true,
          cap: 100,
          action: { label: t('pageFilter.tidyPayees'), onClick: () => openPayeeMergeSheet() },
        },
      ],
      selected: excluded,
      onApply: saveExcluded,
    });
  });
  if (exPay.size) {
    // Not 'budget-allocation': that card is the envelopes' planned amounts,
    // not a spending total, so payee exclusions never affect it and the note
    // would be misleading there.
    for (const name of ['envelope-balances', 'envelope-balance-history']) {
      const note = document.createElement('p');
      note.className = 'reports-card-note';
      note.textContent = t('pageFilter.payeeBalanceNote');
      container.querySelector(`[data-chart="${name}"] .chart-slot`).after(note);
    }
  }
}
