// js/ui/health-chart.js — step chart for the envelope health check.
//
// Built with createElementNS rather than an SVG string: no innerHTML, so no
// escaping rule to get wrong, and the caller gets a live element it can append.
//
// A step line rather than an interpolated one because balance IS a step
// function — it changes only on event days, and drawing a slope between two
// events claims money moved on days it did not.

import { fmt } from '../utils.js';

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function niceBound(v) {
  if (v <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  if (n <= 1) return pow;
  if (n <= 2) return 2 * pow;
  if (n <= 5) return 5 * pow;
  return 10 * pow;
}

/**
 * daily: [{ date, balance }] — one point per day, ascending.
 * low / high: { date, balance } — annotated markers.
 * Returns an <svg> element sized to its viewBox, scaling to the container.
 */
export function healthChart({ daily, low, high, ariaLabel = '', width = 720, height = 240 }) {
  const padL = 56, padR = 16, padT = 16, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height,
    role: 'img',
    preserveAspectRatio: 'none',
  });
  const title = el('title');
  title.textContent = ariaLabel;
  svg.append(title);
  if (ariaLabel) svg.setAttribute('aria-label', ariaLabel);

  if (!daily || daily.length === 0) return svg;

  const values = daily.map(d => d.balance);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const max = niceBound(rawMax) || 1;
  const min = rawMin < 0 ? -niceBound(Math.abs(rawMin)) : 0;
  const range = (max - min) || 1;

  const xFor = i => padL + (daily.length === 1 ? plotW / 2 : (plotW * i) / (daily.length - 1));
  const yFor = v => padT + (plotH * (max - v)) / range;
  const zeroY = yFor(0);

  // Danger bands: one rect per run of consecutive below-zero days, rather than
  // one per day — a year underwater is a handful of rects, not 365.
  let runStart = -1;
  for (let i = 0; i <= daily.length; i++) {
    const negative = i < daily.length && daily[i].balance < -0.005;
    if (negative && runStart < 0) runStart = i;
    if (!negative && runStart >= 0) {
      const x1 = xFor(runStart);
      const x2 = xFor(i - 1);
      let deepest = 0;
      for (let j = runStart; j < i; j++) deepest = Math.min(deepest, daily[j].balance);
      svg.append(el('rect', {
        x: x1.toFixed(2),
        y: zeroY.toFixed(2),
        width: Math.max(1, x2 - x1).toFixed(2),
        height: Math.max(1, yFor(deepest) - zeroY).toFixed(2),
        fill: 'var(--rose, #ef4444)',
        'fill-opacity': '0.18',
      }));
      runStart = -1;
    }
  }

  // Y grid + labels at min, 0 and max. An envelope that never goes negative
  // has min === 0, so dedupe or the zero line is drawn and labelled twice.
  const gridValues = [...new Set([min, 0, max])];
  for (const v of gridValues) {
    const y = yFor(v);
    svg.append(el('line', {
      x1: padL, y1: y.toFixed(2), x2: (padL + plotW).toFixed(2), y2: y.toFixed(2),
      stroke: v === 0 ? 'var(--ink, #111)' : 'var(--faint, #ddd)',
      'stroke-width': v === 0 ? 1.5 : 1,
      'stroke-opacity': v === 0 ? 0.5 : 1,
    }));
    const label = el('text', {
      x: padL - 8, y: (y + 4).toFixed(2), 'text-anchor': 'end',
      'font-size': 10, fill: 'var(--muted, #666)',
    });
    label.textContent = fmt(v, { decimals: 0 });
    svg.append(label);
  }

  // Month ticks on the first of each month.
  daily.forEach((point, i) => {
    if (!point.date.endsWith('-01')) return;
    const x = xFor(i);
    const label = el('text', {
      x: x.toFixed(2), y: height - 8, 'text-anchor': 'middle',
      'font-size': 10, fill: 'var(--muted, #666)',
    });
    label.textContent = point.date.slice(5, 7);
    svg.append(label);
  });

  // Step polyline: hold the previous value across to the new x, then step.
  const pts = [];
  daily.forEach((point, i) => {
    const x = xFor(i);
    if (i > 0) pts.push(`${x.toFixed(2)},${yFor(daily[i - 1].balance).toFixed(2)}`);
    pts.push(`${x.toFixed(2)},${yFor(point.balance).toFixed(2)}`);
  });
  svg.append(el('polyline', {
    points: pts.join(' '),
    fill: 'none',
    stroke: 'var(--accent-ink, #3b82f6)',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
  }));

  // Low / high markers.
  for (const [point, colour] of [[low, 'var(--rose, #ef4444)'], [high, 'var(--mint, #10b981)']]) {
    if (!point) continue;
    const i = daily.findIndex(d => d.date === point.date);
    if (i < 0) continue;
    svg.append(el('circle', {
      cx: xFor(i).toFixed(2), cy: yFor(point.balance).toFixed(2), r: 4,
      fill: colour, stroke: 'var(--bg, #fff)', 'stroke-width': 1.5,
    }));
  }

  return svg;
}
