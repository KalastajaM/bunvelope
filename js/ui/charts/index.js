// js/ui/charts/index.js — mountChart(spec): one chart with its toolbar,
// legend, tooltip, table view and CSV. The pure logic is in model.js, the
// drawing in render.js, the pointer and keyboard handling in interact.js.
// Design: docs/superpowers/specs/2026-09-27-interactive-charts-design.md

import { t } from '../i18n.js';
import { fmtNum } from '../../utils.js';
import { announce } from '../announce.js';
import { downloadBlob, sanitiseFilename } from '../download.js';
import {
  isEmpty, reconcileState, legendEntries, toggleSeries, toggleItem, showAllItems, withZoom,
  isSeriesVisible, tooltipRows, tableData, toCsv, visibleItems, zoomWindow, canZoom, num, setStacked,
  hiddenItemCountInView,
} from './model.js';
import { renderSeries, renderItems, renderPie } from './render.js';
import { attachSeriesInteraction, attachItemInteraction } from './interact.js';
import { markersByIndex, withMarkerNote } from './markers.js';
import { loadChartState, saveChartState, getSessionChartState, setSessionChartState } from './persist.js';

let uidSeq = 0;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(text, onClick, focusKey, className = 'btn btn-sm btn-ghost') {
  const b = /** @type {HTMLButtonElement} */ (el('button', className, text));
  b.type = 'button';
  b.dataset.focusKey = focusKey;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {any} input  { id, kind, title, format, height, x, series, band, area, pointLabels, gaps, items, onSelect }
 * Optional toolbarStart and summaryActions DOM nodes share the toolbar and
 * summary row with page controls. Their identity survives chart repaints.
 * @returns {HTMLElement}
 */
export function mountChart(input) {
  const format = input.format ?? (v => fmtNum(v, { maxDecimals: 2 }));
  const spec = { ...input, format, x: input.x ?? [], series: input.series ?? [], items: input.items ?? [] };
  const uid = ++uidSeq;
  const isSeries = spec.kind === 'line' || spec.kind === 'bar';

  const fig = el('figure', `bv-chart bv-chart--${spec.kind}`);
  if (isEmpty(spec)) {
    fig.append(el('div', 'bv-chart-empty', t('common.noData')));
    return fig;
  }
  if (spec.onSelect) fig.classList.add('bv-chart--clickable');
  if (canZoom(spec)) fig.classList.add('bv-chart--zoomable');

  let state = reconcileState(spec, getSessionChartState(spec.id) ?? loadChartState(spec.id));
  const markers = markersByIndex(spec);
  setSessionChartState(spec.id, state);
  let view = 'chart';
  let width = 0;
  let wasConnected = false;
  /** @type {number | null} */
  let cursor = null;
  /** @type {any} */
  let geom = null;
  let controller = new AbortController();
  // A touch crosshair stays after the finger lifts; a tap anywhere else
  // clears it. The listener only exists while a cursor is actually showing,
  // so an idle chart (the common case: most charts on a page are never
  // touched) carries no document-level listener at all.
  /** @type {AbortController | null} */
  let outside = null;
  const onOutside = e => {
    if (cursor != null && !fig.contains(/** @type {Node} */ (e.target))) showCursor(null);
  };

  const toolbar = el('div', 'bv-chart-toolbar');
  const body = el('div', 'bv-chart-body');
  const legend = el('div', 'bv-chart-legend');
  const tip = el('div', 'bv-chart-tip');
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  const summary = el('p', spec.scaleControl ? 'bv-chart-change' : 'bv-chart-sr');
  summary.id = `bvc-sum-${uid}`;
  if (spec.summaryActions) {
    const footer = el('div', 'bv-chart-footer');
    footer.append(summary, spec.summaryActions);
    fig.append(toolbar, body, legend, footer);
  } else fig.append(toolbar, body, legend, summary);

  const headers = () => ({ label: isSeries ? t('chart.colPeriod') : t('chart.colItem'), value: t('chart.colValue') });

  /** Apply a new state and repaint, keeping keyboard focus on the same control. */
  function update(next) {
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && fig.contains(active) ? active.dataset.focusKey : undefined;
    state = next;
    setSessionChartState(spec.id, next);
    saveChartState(spec.id, next);
    paint();
    if (!focusKey) return;
    const again = fig.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)
      ?? fig.querySelector('[data-focus-key="show-all"]');
    if (again instanceof HTMLElement) again.focus();
    else if (isSeries) fig.focus();
  }

  function select(i) {
    if (spec.onSelect) spec.onSelect({ key: spec.x[i].key });
    else markers.get(i)?.find(m => m.onSelect)?.onSelect();
  }

  /** Move the crosshair and tooltip to x index i (null hides them). */
  function showCursor(i, speak = false, force = false) {
    // Same index, already showing, no announcement needed: nothing to redraw.
    // `paint()` still forces a redraw since the geometry underneath may have
    // changed (resize, zoom, a toggled series) even though the index didn't.
    if (!force && i === cursor && i != null && !tip.hidden && !speak) return;
    cursor = i;
    if (i != null && !outside) {
      outside = new AbortController();
      document.addEventListener('pointerdown', onOutside, { signal: outside.signal });
    } else if (i == null && outside) {
      outside.abort();
      outside = null;
    }
    if (!geom) return;
    if (i == null) {
      geom.cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      fig.classList.remove('bv-chart--marker-hot');
      return;
    }
    const x = geom.xFor(i);
    geom.cross.setAttribute('x1', String(x));
    geom.cross.setAttribute('x2', String(x));
    geom.cross.setAttribute('visibility', 'visible');
    // Only charts without their own onSelect fall back to a marker's action
    // on select (see interact.js), so only those get the pointer cursor hint.
    fig.classList.toggle('bv-chart--marker-hot', !spec.onSelect && markers.has(i));
    const spoken = [spec.x[i].label];
    tip.replaceChildren(el('div', 'bv-chart-tip-head', spec.x[i].label));
    for (const r of tooltipRows(spec, state, i, t('chart.range'))) {
      const text = r.band ? t('chart.rangeValue')(format(r.low), format(r.high))
        : r.missing ? t('common.noData') : format(r.value);
      const sw = el('span', r.band ? 'bv-chart-swatch bv-chart-swatch--band' : r.ref ? 'bv-chart-swatch bv-chart-swatch--ref' : 'bv-chart-swatch');
      if (r.ref) sw.style.color = r.color;
      else sw.style.background = r.color;
      const row = el('div', 'bv-chart-tip-row');
      row.append(sw, el('span', '', r.name), el('span', 'v', text));
      tip.append(row);
      spoken.push(`${r.name} ${text}`);
    }
    for (const m of markers.get(i) || []) {
      tip.append(el('div', 'bv-chart-tip-marker', m.label));
      spoken.push(m.label);
    }
    tip.hidden = false;
    // Beside the crosshair, flipped to its left near the right edge.
    const w = tip.offsetWidth;
    tip.style.left = `${x + 12 + w > body.clientWidth ? Math.max(0, x - 12 - w) : x + 12}px`;
    tip.style.top = `${geom.plotT}px`;
    if (speak) announce(spoken.join(', '));
  }

  function downloadCsv() {
    const text = toCsv(tableData(spec, state, headers()));
    downloadBlob(`${sanitiseFilename(spec.csvName ?? spec.title)}.csv`, new Blob([text], { type: 'text/csv;charset=utf-8' }));
  }

  function paintToolbar() {
    toolbar.replaceChildren();
    if (spec.toolbarStart) {
      toolbar.classList.add('bv-chart-toolbar--split');
      toolbar.append(spec.toolbarStart);
    }
    if (spec.scaleControl && spec.kind === 'line' && !state.stacked) {
      const group = el('div', 'bv-chart-scale');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', t('chart.scale'));
      for (const mode of ['fit', 'zero']) {
        const control = button(t(`chart.scale_${mode}`), () => update({ ...state, yScale: mode }), `scale:${mode}`);
        control.setAttribute('aria-pressed', String(state.yScale === mode));
        group.append(control);
      }
      toolbar.append(group);
    }
    if (state.zoom) toolbar.append(button(t('chart.resetZoom'), () => update(withZoom(spec, state, null)), 'reset'));
    const hiddenInView = hiddenItemCountInView(spec, state);
    if (hiddenInView) {
      const chip = el('span', 'bv-chart-chip', t('chart.hiddenCount')(hiddenInView));
      chip.append(button(t('chart.showAll'), () => update(showAllItems(state)), 'show-all'));
      toolbar.append(chip);
    }
    if (spec.kind === 'line' && spec.stack) {
      const stack = button(t('chart.stacked'), () => update(setStacked(spec, state, !state.stacked)), 'stack');
      stack.setAttribute('aria-pressed', String(!!state.stacked));
      toolbar.append(stack);
    }
    toolbar.append(button(view === 'chart' ? t('chart.table') : t('chart.chart'), () => {
      view = view === 'chart' ? 'table' : 'chart';
      update(state);
    }, 'view'));
    const csv = button(t('chart.csv'), downloadCsv, 'csv');
    csv.setAttribute('aria-label', t('chart.downloadCsv'));
    csv.title = t('chart.downloadCsv');
    toolbar.append(csv);
  }

  function paintLegend() {
    legend.replaceChildren();
    if (!isSeries) return;
    const entries = legendEntries(spec, t('chart.range'));
    if (entries.length < 2) return; // one series: nothing to toggle
    for (const e of entries) {
      const b = button('', () => update(toggleSeries(spec, state, e.id)), `legend:${e.id}`, 'bv-chart-legend-item');
      b.setAttribute('aria-pressed', String(!state.hiddenSeries.has(e.id)));
      const sw = el('span', e.band ? 'bv-chart-swatch bv-chart-swatch--band' : e.ref ? 'bv-chart-swatch bv-chart-swatch--ref' : 'bv-chart-swatch');
      if (e.ref) sw.style.color = e.color;
      else sw.style.background = e.color;
      b.append(sw, el('span', '', e.name));
      legend.append(b);
    }
  }

  function paintSummary() {
    if (isSeries) {
      const win = zoomWindow(spec, state);
      const first = spec.series.find(s => isSeriesVisible(spec, state, s.id));
      const base = t('chart.summarySeries')(
        win.to - win.from + 1, spec.x[win.from].label, spec.x[win.to].label,
        format(num(first?.values[win.from])), format(num(first?.values[win.to])),
      );
      summary.textContent = withMarkerNote(base, markers, t('chart.summaryMarkers')(markers.size));
      if (spec.scaleControl) {
        const changes = spec.series.filter(s => isSeriesVisible(spec, state, s.id)
          && s.id !== spec.band?.low && s.id !== spec.band?.high).map(s => {
          const start = s.values[win.from], end = s.values[win.to];
          if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
          return t('chart.change')(s.name, spec.x[win.from].label, spec.x[win.to].label, format(start), format(end), format(end - start));
        }).filter(Boolean);
        summary.textContent = withMarkerNote(`${t('chart.scale')}: ${t(`chart.scale_${state.stacked ? 'zero' : state.yScale}`)}. ${changes.join(' ')}`, markers, t('chart.summaryMarkers')(markers.size));
      }
    } else {
      const items = visibleItems(spec, state);
      summary.textContent = t('chart.summaryItems')(items.length, format(items.reduce((s, it) => s + it.value, 0)));
    }
  }

  function renderTable() {
    const data = tableData(spec, state, headers());
    const wrap = el('div', 'bv-chart-table-wrap');
    wrap.setAttribute('data-scroll-cue', '');
    const table = el('table', 'tx-table bv-chart-table');
    const headRow = document.createElement('tr');
    data.columns.forEach((c, i) => {
      const th = /** @type {HTMLTableCellElement} */ (el('th', i ? 'num' : '', c));
      th.scope = 'col';
      headRow.append(th);
    });
    const thead = document.createElement('thead');
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const r of data.rows) {
      const tr = document.createElement('tr');
      const th = /** @type {HTMLTableCellElement} */ (el('th', '', r.label));
      th.scope = 'row';
      tr.append(th);
      for (const v of r.values) tr.append(el('td', 'num', v == null ? '—' : format(v)));
      tbody.append(tr);
    }
    table.append(el('caption', 'bv-chart-sr', spec.title), thead, tbody);
    wrap.append(table);
    return wrap;
  }

  function paint() {
    controller.abort();
    controller = new AbortController();
    paintToolbar();
    paintLegend();
    paintSummary();
    geom = null;
    body.replaceChildren();
    if (isSeries) {
      // Arrow-key/+/− key hints only make sense in chart view; the table has
      // nothing to key through, so it drops the tab stop and the hint too.
      if (view === 'table') {
        fig.removeAttribute('tabindex');
        fig.setAttribute('aria-label', spec.title);
      } else {
        fig.tabIndex = 0;
        const hint = withMarkerNote(t('chart.keyHint'), markers, t('chart.keyHintMarkers'));
        fig.setAttribute('aria-label', `${spec.title}. ${hint}`);
      }
    }
    if (view === 'table') {
      body.append(renderTable());
      return;
    }
    if (isSeries) {
      if (!width) return;
      const r = renderSeries(spec, state, width, uid, markers);
      geom = r.geom;
      r.svg.setAttribute('role', 'img');
      r.svg.setAttribute('aria-label', spec.title);
      r.svg.setAttribute('aria-describedby', summary.id);
      body.append(r.svg, tip);
      if (cursor != null && (cursor < geom.win.from || cursor > geom.win.to)) cursor = null;
      showCursor(cursor, false, true);
      attachSeriesInteraction({
        root: fig, svg: r.svg, geom, spec, n: spec.x.length,
        getCursor: () => cursor, setCursor: showCursor,
        setZoom: zoom => update(withZoom(spec, state, zoom)), select, signal: controller.signal,
      });
      return;
    }
    const onItem = it => spec.onSelect?.({ key: it.key });
    const list = renderItems(spec, state, {
      hideLabel: t('chart.hideItem'), onHide: id => update(toggleItem(spec, state, id)), onSelect: onItem,
    });
    if (spec.kind === 'pie') {
      if (!width) return;
      const wrap = el('div', 'bv-chart-pie');
      wrap.append(renderPie(spec, state, width, onItem), list);
      body.append(wrap);
    } else {
      body.append(list);
    }
    attachItemInteraction({ body, signal: controller.signal });
  }

  // Draw at the real width. ResizeObserver delivers at most once per frame,
  // which is the batching. A chart is usually built before it is attached,
  // so a detached delivery is ignored until it has been connected once; after
  // that, detaching (a page change) stops the observer and the listeners.
  const ro = new ResizeObserver(entries => {
    if (!fig.isConnected) {
      if (wasConnected) {
        ro.disconnect();
        controller.abort();
        outside?.abort();
        outside = null;
      }
      return;
    }
    wasConnected = true;
    const w = Math.floor(entries[0].contentRect.width);
    if (!w || w === width) return;
    width = w;
    if (spec.kind !== 'hbar') paint();
  });
  ro.observe(body);

  paint();
  return fig;
}
