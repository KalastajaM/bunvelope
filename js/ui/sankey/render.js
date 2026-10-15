// js/ui/sankey/render.js — draws a Sankey: links, nodes and labels as SVG,
// hover and focus highlighting with a tooltip, keyboard activation. The
// placement is layout.js; what the nodes mean, their names and colours come
// from the page.

import { t } from '../i18n.js';
import { layoutSankey } from './layout.js';

/** @typedef {import('../../engine/flows.js').Flow} Flow */
/** @typedef {import('../../engine/flows.js').FlowNode} FlowNode */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Below this a node has no room for its label; the tooltip carries it. */
const MIN_LABEL_HEIGHT = 11;
/** From this height an edge-column label has room for a second line. */
const TWO_LINE_HEIGHT = 28;

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** `s` cut to `max` characters with an ellipsis. */
function clip(s, max) {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/**
 * @param {{
 *   flow: Flow, width: number, height: number,
 *   labelOf: (node: FlowNode) => string,
 *   colorOf: (node: FlowNode) => string,
 *   format: (value: number) => string,
 *   canActivate?: (node: FlowNode) => boolean,
 *   onActivate?: (node: FlowNode) => void,
 *   ariaLabel: string,
 * }} opts
 * @returns {HTMLElement}
 */
export function renderSankey({ flow, width, height, labelOf, colorOf, format, canActivate = () => false, onActivate, ariaLabel }) {
  const narrow = width < 600;
  const gutterL = narrow ? 92 : 150;
  const gutterR = narrow ? 92 : 170;
  const L = layoutSankey(flow, { width: Math.max(40, width - gutterL - gutterR), height });
  const nodeById = new Map(L.nodes.map(n => [n.id, n]));
  const lastX = Math.max(0, ...L.nodes.map(n => n.x));
  const total = flow.totals.in || 1;
  const share = v => t('flow.share')(Math.round((v / total) * 1000) / 10);

  const wrap = el('div', 'bv-sankey');
  const svg = svgEl('svg', {
    class: 'bv-sankey-svg', viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'group', 'aria-label': ariaLabel,
  });
  const root = svgEl('g', { transform: `translate(${gutterL},0)` });
  svg.append(root);
  const tip = el('div', 'bv-chart-tip');
  tip.hidden = true;
  wrap.append(svg, tip);

  // ── Highlight and tooltip ───────────────────────────────────────────────
  /** @type {Element[]} */
  let hot = [];
  const clearHot = () => {
    for (const e of hot) e.classList.remove('is-hot');
    hot = [];
    svg.classList.remove('has-hot');
    tip.hidden = true;
  };
  const setHot = (elements, head, rows, at) => {
    clearHot();
    hot = elements;
    for (const e of hot) e.classList.add('is-hot');
    svg.classList.add('has-hot');
    tip.replaceChildren(el('div', 'bv-chart-tip-head', head));
    for (const [k, v] of rows) {
      const row = el('div', 'bv-sankey-tip-row');
      row.append(el('span', null, k), el('span', 'v', v));
      tip.append(row);
    }
    tip.hidden = false;
    const left = Math.min(Math.max(0, at.x + 12), Math.max(0, width - 200));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, at.y + 12)}px`;
  };
  const pointerAt = e => {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ── Links ───────────────────────────────────────────────────────────────
  /** @type {Map<string, Element[]>} link elements by node id */
  const linksOf = new Map();
  /** @type {Map<string, Element>} */
  const nodeEls = new Map();
  const linkLayer = svgEl('g', { class: 'bv-sankey-links' });
  for (const l of L.links) {
    const from = /** @type {FlowNode} */ (nodeById.get(l.source));
    const to = /** @type {FlowNode} */ (nodeById.get(l.target));
    // A band takes the colour of where the money goes, except into the
    // Budget hub, where it keeps the colour of where it came from.
    const color = colorOf(to.kind === 'budget' ? from : to);
    const path = svgEl('path', { class: 'bv-sankey-link', d: l.path, fill: color });
    for (const id of [l.source, l.target]) {
      if (!linksOf.has(id)) linksOf.set(id, []);
      /** @type {Element[]} */ (linksOf.get(id)).push(path);
    }
    const describe = e => setHot(
      [path, nodeEls.get(l.source), nodeEls.get(l.target)].filter(Boolean),
      `${labelOf(from)} → ${labelOf(to)}`,
      [[format(l.value), share(l.value)]],
      pointerAt(e),
    );
    path.addEventListener('pointermove', describe);
    path.addEventListener('pointerleave', clearHot);
    linkLayer.append(path);
  }
  root.append(linkLayer);

  // ── Nodes and labels ────────────────────────────────────────────────────
  const nodeLayer = svgEl('g', { class: 'bv-sankey-nodes' });
  const labelLayer = svgEl('g', { class: 'bv-sankey-labels', 'aria-hidden': 'true' });
  for (const n of L.nodes) {
    const name = labelOf(n);
    const amount = format(n.value);
    const active = canActivate(n);
    const g = svgEl('g', {
      class: `bv-sankey-node${active ? ' is-clickable' : ''}`, tabindex: 0,
      role: active ? 'button' : 'img', 'aria-label': `${name}, ${amount}`,
    });
    g.append(svgEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 2, fill: colorOf(n) }));
    // A wider invisible target, so a 2 px node can still be pointed at.
    g.append(svgEl('rect', { class: 'bv-sankey-hit', x: n.x - 4, y: n.y - 2, width: n.w + 8, height: n.h + 4 }));
    nodeEls.set(n.id, g);
    const describe = at => setHot([g, ...(linksOf.get(n.id) || [])], name, [[amount, share(n.value)]], at);
    g.addEventListener('pointermove', e => describe(pointerAt(e)));
    g.addEventListener('pointerleave', clearHot);
    // Keyboard focus shows the tooltip; focus a click leaves behind does not.
    g.addEventListener('focus', () => {
      if (g.matches(':focus-visible')) describe({ x: gutterL + n.x + n.w, y: n.y });
    });
    g.addEventListener('blur', clearHot);
    if (active && onActivate) {
      g.addEventListener('click', () => onActivate(n));
      g.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(n); }
      });
    }
    nodeLayer.append(g);

    if (n.h < MIN_LABEL_HEIGHT) continue;
    const first = n.x === 0;
    const last = n.x === lastX && lastX > 0;
    // In a gutter, a node with room for two lines puts its amount under the
    // name, so the name is not cut short by it; elsewhere they share a line.
    const room = first ? gutterL : last ? gutterR : 190;
    const twoLines = (first || last) && n.h >= TWO_LINE_HEIGHT;
    const perLine = Math.floor((room - 8) / 6.6);
    const x = first ? n.x - 6 : n.x + n.w + 6;
    const text = svgEl('text', {
      class: 'bv-sankey-label', x, y: n.y + n.h / 2, dy: twoLines ? '-0.25em' : '0.35em',
      'text-anchor': first ? 'end' : 'start',
    });
    // On one line, a name that leaves no room for the amount keeps the line
    // to itself: the amount is in the tooltip and the aria-label.
    const withAmount = twoLines || name.length + amount.length + 1 <= perLine;
    const nameSpan = svgEl('tspan');
    nameSpan.textContent = clip(name, Math.max(4, perLine));
    text.append(nameSpan);
    if (withAmount) {
      const amtSpan = svgEl('tspan', twoLines ? { class: 'bv-sankey-amt', x, dy: '1.2em' } : { class: 'bv-sankey-amt', dx: 6 });
      amtSpan.textContent = amount;
      text.append(amtSpan);
    }
    labelLayer.append(text);
  }
  root.append(nodeLayer, labelLayer);
  svg.addEventListener('pointerleave', clearHot);
  return wrap;
}
