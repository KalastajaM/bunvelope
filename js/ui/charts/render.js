// js/ui/charts/render.js — draws a chart from the model: SVG for line, bar
// and pie; HTML rows for the item list (horizontal bars, and the pie's
// legend), which gives real buttons, CSS truncation and keyboard focus.
// Stateless: index.js calls it again on every repaint.

import { fmtPct } from '../../utils.js';
import {
  paletteFor, zoomWindow, yRange, xForIndex, isSeriesVisible, visibleItems, num,
  isStacked, stackSeries, visibleRefLines,
} from './model.js';
import { stackLayers } from './stack.js';

const NS = 'http://www.w3.org/2000/svg';
const PAD = { t: 14, r: 12, b: 26 };
const CHAR_PX = 6.5;     // average glyph width of the 10 px tick font
const X_LABEL_PX = 64;   // room one x label needs before the labels thin out
const MAX_DOTS = 36;     // above this many points the dots are noise

function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}
const f1 = n => n.toFixed(1);

/**
 * A line or bar chart at a pixel width, plus the geometry interact.js and
 * the tooltip need.
 * @param {Map<number, any[]>} markers  `markersByIndex(spec)`, computed once
 *   per mount by index.js and passed in here so a repaint (resize, toggle,
 *   zoom) never recomputes it.
 */
export function renderSeries(spec, state, width, uid, markers) {
  const height = spec.height ?? 260;
  const win = zoomWindow(spec, state);
  const { min, max } = yRange(spec, state);
  const ticks = [0, 1, 2, 3, 4].map(i => min + ((max - min) * i) / 4);
  const tickText = ticks.map(v => spec.format(v));
  const plotL = Math.max(40, Math.max(...tickText.map(s => s.length)) * CHAR_PX + 10);
  const plotT = PAD.t;
  const plotW = Math.max(10, width - plotL - PAD.r);
  const plotH = Math.max(10, height - PAD.t - PAD.b);
  const range = max - min || 1;
  const yFor = v => plotT + (plotH * (max - v)) / range;
  const xFor = i => xForIndex(spec.kind, i, win, plotL, plotW);

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'bv-chart-svg' });
  ticks.forEach((v, i) => {
    const y = f1(yFor(v));
    svg.append(svgEl('line', { x1: plotL, x2: plotL + plotW, y1: y, y2: y, class: 'bv-chart-grid' }));
    svg.append(svgEl('text', { x: plotL - 6, y: f1(yFor(v) + 3.5), 'text-anchor': 'end', class: 'bv-chart-tick' }, tickText[i]));
  });
  const count = win.to - win.from + 1;
  const stride = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotW / X_LABEL_PX))));
  const labelIdx = [];
  for (let i = win.from; i <= win.to; i += stride) labelIdx.push(i);
  // The stride rarely lands exactly on the final point; without this it can
  // go missing (e.g. "Today"), which reads as data cut off rather than shown.
  const lastLabelled = labelIdx[labelIdx.length - 1];
  if (lastLabelled !== win.to) {
    if (win.to - lastLabelled < stride * 0.6) labelIdx[labelIdx.length - 1] = win.to;
    else labelIdx.push(win.to);
  }
  for (const i of labelIdx) {
    svg.append(svgEl('text', { x: f1(xFor(i)), y: height - 8, 'text-anchor': 'middle', class: 'bv-chart-tick' }, spec.x[i].label));
  }

  if (spec.kind === 'bar') drawBars(svg, spec, state, win, plotL, plotW, yFor);
  else drawLines(svg, spec, state, win, xFor, yFor, uid, plotT, plotH);
  for (const r of visibleRefLines(spec, state)) {
    const y = f1(yFor(num(r.value)));
    svg.append(svgEl('line', { x1: plotL, x2: plotL + plotW, y1: y, y2: y, stroke: r.color || 'var(--ink-2)', class: 'bv-chart-ref' }));
  }
  // Markers sit on the bottom edge of the plot, an upward triangle per x point.
  const bottom = plotT + plotH;
  for (const i of markers.keys()) {
    if (i < win.from || i > win.to) continue;
    const x = xFor(i);
    svg.append(svgEl('polygon', { points: `${f1(x - 5)},${f1(bottom)} ${f1(x + 5)},${f1(bottom)} ${f1(x)},${f1(bottom - 8)}`, class: 'bv-chart-marker' }));
  }

  if (min <= 0 && max >= 0) {
    const y0 = f1(yFor(0));
    svg.append(svgEl('line', { x1: plotL, x2: plotL + plotW, y1: y0, y2: y0, class: 'bv-chart-zero' }));
  }
  const cross = svgEl('line', { x1: 0, x2: 0, y1: plotT, y2: plotT + plotH, class: 'bv-chart-cross', visibility: 'hidden' });
  const sel = svgEl('rect', { x: 0, y: plotT, width: 0, height: plotH, class: 'bv-chart-sel', visibility: 'hidden' });
  svg.append(cross, sel);
  return {
    svg: /** @type {SVGSVGElement} */ (/** @type {unknown} */ (svg)),
    geom: { kind: spec.kind, win, plotL, plotT, plotW, plotH, xFor, cross, sel },
  };
}

function drawLines(svg, spec, state, win, xFor, yFor, uid, plotT, plotH) {
  const idx = [];
  for (let i = win.from; i <= win.to; i++) idx.push(i);
  const pt = (values, i) => `${f1(xFor(i))},${f1(yFor(num(values[i])))}`;
  const colorOf = new Map(spec.series.map((s, i) => [s.id, s.color || paletteFor(i)]));
  const band = spec.band;

  if (band && isSeriesVisible(spec, state, band.low)) {
    const lo = spec.series.find(s => s.id === band.low);
    const hi = spec.series.find(s => s.id === band.high);
    if (lo && hi) {
      const points = [...idx.map(i => pt(hi.values, i)), ...[...idx].reverse().map(i => pt(lo.values, i))];
      svg.append(svgEl('polygon', { points: points.join(' '), fill: colorOf.get(band.around) ?? paletteFor(0), class: 'bv-chart-band' }));
    }
  }

  const stacked = isStacked(spec, state);
  const stackIds = new Set(stacked ? spec.stack.ids : []);
  if (stacked) {
    const { layers } = stackLayers(stackSeries(spec, state), win.from, win.to);
    for (const layer of layers) {
      const upper = idx.map((i, k) => `${f1(xFor(i))},${f1(yFor(layer.hi[k]))}`);
      const lower = idx.map((i, k) => `${f1(xFor(i))},${f1(yFor(layer.lo[k]))}`).reverse();
      svg.append(svgEl('polygon', { points: [...upper, ...lower].join(' '), fill: colorOf.get(layer.id), class: 'bv-chart-stack' }));
    }
  }

  spec.series.forEach((s, si) => {
    if (stackIds.has(s.id)) return;
    if (band && (s.id === band.low || s.id === band.high)) return;
    if (!isSeriesVisible(spec, state, s.id)) return;
    const color = colorOf.get(s.id);
    const line = idx.map(i => pt(s.values, i)).join(' ');
    if (spec.area) {
      // Unique per chart: two area charts on one page must not share a gradient id.
      const gid = `bvc-${uid}-${si}`;
      const grad = svgEl('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 });
      grad.append(
        svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.4 }),
        svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }),
      );
      const defs = svgEl('defs');
      defs.append(grad);
      const bottom = f1(plotT + plotH);
      svg.append(defs, svgEl('polygon', {
        points: `${f1(xFor(idx[0]))},${bottom} ${line} ${f1(xFor(idx[idx.length - 1]))},${bottom}`,
        fill: `url(#${gid})`,
      }));
    }
    svg.append(svgEl('polyline', { points: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (idx.length <= MAX_DOTS) {
      for (const i of idx) {
        svg.append(svgEl('circle', { cx: f1(xFor(i)), cy: f1(yFor(num(s.values[i]))), r: 2.5, fill: 'var(--surface)', stroke: color, 'stroke-width': 1.5 }));
      }
    }
    if (spec.pointLabels) {
      for (const i of idx) {
        const v = num(s.values[i]);
        svg.append(svgEl('text', { x: f1(xFor(i)), y: f1(Math.max(plotT + 8, yFor(v) - 8)), 'text-anchor': 'middle', class: 'bv-chart-pointlabel' }, spec.format(v)));
      }
    }
  });
}

function drawBars(svg, spec, state, win, plotL, plotW, yFor) {
  const shown = spec.series
    .map((s, i) => ({ s, color: s.color || paletteFor(i) }))
    .filter(({ s }) => isSeriesVisible(spec, state, s.id));
  const slot = plotW / (win.to - win.from + 1);
  const gap = Math.max(2, slot * 0.18);
  const bw = Math.max(1, (slot - gap) / Math.max(1, shown.length));
  const y0 = yFor(0);
  for (let i = win.from; i <= win.to; i++) {
    shown.forEach(({ s, color }, k) => {
      const y = yFor(num(s.values[i]));
      svg.append(svgEl('rect', {
        x: f1(plotL + (i - win.from) * slot + gap / 2 + k * bw), y: f1(Math.min(y, y0)),
        width: f1(bw), height: f1(Math.abs(y0 - y)), fill: color, rx: 2,
      }));
    });
  }
}

/**
 * The item rows: a horizontal bar chart, or the pie's legend. Each row is a
 * button when it has somewhere to go (a key and an onSelect), and carries a
 * hide button.
 * @param {{ hideLabel: (name: string) => string, onHide: (id: string) => void, onSelect: (item: any) => void }} o
 */
export function renderItems(spec, state, { hideLabel, onHide, onSelect }) {
  const items = visibleItems(spec, state);
  const max = Math.max(0, ...items.map(it => Math.abs(it.value))) || 1;
  const list = document.createElement('ul');
  list.className = 'bv-chart-items';
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'bv-chart-item';
    li.dataset.id = it.id;

    const clickable = !!spec.onSelect && it.key != null;
    const main = document.createElement(clickable ? 'button' : 'div');
    main.className = 'bv-chart-item-main';
    main.dataset.focusKey = `item:${it.id}`;
    if (clickable) {
      main.setAttribute('type', 'button');
      main.addEventListener('click', () => onSelect(it));
    } else {
      main.tabIndex = 0;
    }
    if (spec.kind === 'pie') {
      const sw = document.createElement('span');
      sw.className = 'bv-chart-swatch';
      sw.style.background = it.color;
      main.append(sw);
    }
    const label = document.createElement('span');
    label.className = 'bv-chart-item-label';
    label.textContent = it.label;
    label.title = it.label;
    main.append(label);
    if (spec.kind === 'hbar') {
      const track = document.createElement('span');
      track.className = 'bv-chart-item-track';
      const bar = document.createElement('span');
      bar.className = 'bv-chart-item-bar';
      bar.style.width = `${(Math.abs(it.value) / max) * 100}%`;
      bar.style.background = it.color;
      track.append(bar);
      main.append(track);
    }
    const value = document.createElement('span');
    value.className = 'bv-chart-item-value';
    value.textContent = spec.format(it.value);
    const share = document.createElement('span');
    share.className = 'bv-chart-item-share';
    share.textContent = fmtPct(it.share);
    value.append(share);
    main.append(value);

    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'bv-chart-hide';
    hide.textContent = '×';
    hide.setAttribute('aria-label', hideLabel(it.label));
    hide.dataset.focusKey = `hide:${it.id}`;
    hide.addEventListener('click', () => onHide(it.id));

    li.append(main, hide);
    list.append(li);
  }
  return list;
}

/**
 * The pie itself. Decorative for assistive tech: the legend rows beside it
 * carry every label, value and share.
 */
export function renderPie(spec, state, width, onSelect) {
  const items = visibleItems(spec, state);
  const size = Math.max(120, Math.min(spec.height ?? 220, width));
  const c = size / 2;
  const r = c - 4;
  const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'bv-chart-svg', 'aria-hidden': 'true' });
  const total = items.reduce((s, it) => s + it.value, 0);
  const at = a => `${f1(c + r * Math.cos(a))} ${f1(c + r * Math.sin(a))}`;
  let a0 = -Math.PI / 2;
  for (const it of items) {
    const a1 = a0 + (it.value / total) * Math.PI * 2;
    const shape = items.length === 1
      ? svgEl('circle', { cx: c, cy: c, r, fill: it.color })
      : svgEl('path', { d: `M ${c} ${c} L ${at(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${at(a1)} Z`, fill: it.color });
    shape.setAttribute('class', 'bv-chart-slice');
    shape.setAttribute('data-id', it.id);
    if (spec.onSelect && it.key != null) {
      shape.setAttribute('style', 'cursor:pointer');
      shape.addEventListener('click', () => onSelect(it));
    }
    svg.append(shape);
    a0 = a1;
  }
  return /** @type {SVGSVGElement} */ (/** @type {unknown} */ (svg));
}
