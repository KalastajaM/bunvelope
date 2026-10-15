// js/ui/sankey/layout.js — the Sankey's pure half: where each node and link
// goes, and the view transforms the Money flow page applies before drawing
// (drop a column on a phone, focus one category, the table/CSV rows). No DOM.
// The flow itself comes from js/engine/flows.js.
// Design: docs/superpowers/specs/2026-10-02-money-flow-sankey-design.md

import { round2 } from '../../utils.js';
import { csvCell } from '../charts/model.js';

/** @typedef {import('../../engine/flows.js').Flow} Flow */
/** @typedef {import('../../engine/flows.js').FlowNode} FlowNode */
/** @typedef {import('../../engine/flows.js').FlowLink} FlowLink */
/** @typedef {FlowNode & { x: number, y: number, w: number, h: number }} PlacedNode */
/** @typedef {FlowLink & { width: number, x0: number, y0: number, x1: number, y1: number, path: string }} PlacedLink */

const r1 = n => Math.round(n * 10) / 10;

/**
 * Place a flow's nodes and links in a `width` × `height` box.
 *
 * Columns (whatever numbers the flow uses) are spaced evenly. One scale
 * serves every column, the largest that fits the fullest one, so a euro is
 * the same height everywhere. Nodes keep the flow's order, stack with `gap`
 * between them and each column is centred. A link's ends stack along its
 * source's right edge in the order of their targets, and along its target's
 * left edge in the order of their sources, so bands do not cross needlessly.
 * Each link's `path` is a closed ribbon, to be filled.
 * A node too small to see is drawn `minNodeHeight` tall.
 *
 * @param {Flow} flow
 * @param {{ width: number, height: number, nodeWidth?: number, gap?: number, minNodeHeight?: number }} opts
 * @returns {{ width: number, height: number, nodeWidth: number, nodes: PlacedNode[], links: PlacedLink[] }}
 */
export function layoutSankey(flow, { width, height, nodeWidth = 12, gap = 10, minNodeHeight = 2 }) {
  const inOf = new Map(), outOf = new Map();
  for (const l of flow.links) {
    inOf.set(l.target, (inOf.get(l.target) || 0) + l.value);
    outOf.set(l.source, (outOf.get(l.source) || 0) + l.value);
  }
  const valueOf = n => Math.max(inOf.get(n.id) || 0, outOf.get(n.id) || 0, 0);

  const columns = [...new Set(flow.nodes.map(n => n.column))].sort((a, b) => a - b);
  const colIndex = new Map(columns.map((c, i) => [c, i]));
  const byCol = columns.map(c => flow.nodes.filter(n => n.column === c));

  let k = Infinity;
  for (const ns of byCol) {
    const total = ns.reduce((s, n) => s + valueOf(n), 0);
    if (total > 0) k = Math.min(k, (height - gap * (ns.length - 1)) / total);
  }
  if (!Number.isFinite(k) || k < 0) k = 0;

  const step = columns.length > 1 ? (width - nodeWidth) / (columns.length - 1) : 0;
  /** @type {Map<string, PlacedNode>} */
  const placed = new Map();
  for (const ns of byCol) {
    const hs = ns.map(n => Math.max(minNodeHeight, valueOf(n) * k));
    const total = hs.reduce((s, h) => s + h, 0) + gap * (ns.length - 1);
    let y = Math.max(0, (height - total) / 2);
    ns.forEach((n, i) => {
      placed.set(n.id, { ...n, x: step * /** @type {number} */ (colIndex.get(n.column)), y, w: nodeWidth, h: hs[i] });
      y += hs[i] + gap;
    });
  }

  const links = flow.links.filter(l => placed.has(l.source) && placed.has(l.target) && l.value > 0);
  const nodeOf = id => /** @type {PlacedNode} */ (placed.get(id));
  /** @type {Map<FlowLink, number>} */ const y0Of = new Map();
  /** @type {Map<FlowLink, number>} */ const y1Of = new Map();
  // Each node's band of links is centred on it (it only differs from the
  // node's own extent when the minimum height made the node taller).
  for (const n of placed.values()) {
    const out = links.filter(l => l.source === n.id).sort((a, b) => nodeOf(a.target).y - nodeOf(b.target).y);
    let y = n.y + (n.h - out.reduce((s, l) => s + l.value * k, 0)) / 2;
    for (const l of out) { y0Of.set(l, y + (l.value * k) / 2); y += l.value * k; }
    const inc = links.filter(l => l.target === n.id).sort((a, b) => nodeOf(a.source).y - nodeOf(b.source).y);
    y = n.y + (n.h - inc.reduce((s, l) => s + l.value * k, 0)) / 2;
    for (const l of inc) { y1Of.set(l, y + (l.value * k) / 2); y += l.value * k; }
  }

  return {
    width, height, nodeWidth,
    nodes: [...placed.values()],
    links: links.map(l => {
      const x0 = nodeOf(l.source).x + nodeWidth;
      const x1 = nodeOf(l.target).x;
      const y0 = /** @type {number} */ (y0Of.get(l));
      const y1 = /** @type {number} */ (y1Of.get(l));
      const xm = (x0 + x1) / 2;
      const h = (l.value * k) / 2;
      // A filled ribbon between two Bézier edges, not a thick stroked
      // centreline: a stroke as wide as its horizontal run folds over itself.
      const edge = (ya, yb) => `C${r1(xm)},${r1(ya)} ${r1(xm)},${r1(yb)}`;
      return {
        ...l, width: l.value * k, x0, y0, x1, y1,
        path: `M${r1(x0)},${r1(y0 - h)}${edge(y0 - h, y1 - h)} ${r1(x1)},${r1(y1 - h)}`
          + `L${r1(x1)},${r1(y1 + h)}${edge(y1 + h, y0 + h)} ${r1(x0)},${r1(y0 + h)}Z`,
      };
    }),
  };
}

/**
 * The flow without one column's nodes and the links into and out of them.
 * The phone view drops the envelopes (column 3).
 * @param {Flow} flow
 * @param {number} column
 * @returns {Flow}
 */
export function dropColumn(flow, column) {
  const nodes = flow.nodes.filter(n => n.column !== column);
  const ids = new Set(nodes.map(n => n.id));
  return { ...flow, nodes, links: flow.links.filter(l => ids.has(l.source) && ids.has(l.target)) };
}

/**
 * One category and its envelopes, as two columns: the focus view. Empty when
 * the flow has no such category.
 * @param {Flow} flow
 * @param {string} categoryNodeId  e.g. 'cat:housing'
 * @returns {Flow}
 */
export function focusCategory(flow, categoryNodeId) {
  const cat = flow.nodes.find(n => n.id === categoryNodeId && n.kind === 'category');
  if (!cat) return { nodes: [], links: [], totals: { in: 0, out: 0 } };
  const links = flow.links.filter(l => l.source === cat.id);
  const targets = new Set(links.map(l => l.target));
  return {
    nodes: [{ ...cat, column: 0 }, ...flow.nodes.filter(n => targets.has(n.id)).map(n => ({ ...n, column: 1 }))],
    links,
    totals: { in: cat.value, out: cat.value },
  };
}

/**
 * The flow's links with their nodes: the table view's rows, in flow order.
 * @param {Flow} flow
 * @returns {Array<{ from: FlowNode, to: FlowNode, value: number }>}
 */
export function flowTable(flow) {
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  return flow.links
    .filter(l => byId.has(l.source) && byId.has(l.target))
    .map(l => ({ from: /** @type {FlowNode} */ (byId.get(l.source)), to: /** @type {FlowNode} */ (byId.get(l.target)), value: l.value }));
}

/**
 * CSV of the table rows: a BOM, CRLF line ends and formula-safe text cells,
 * like the charts' CSV.
 * @param {Array<{ from: FlowNode, to: FlowNode, value: number }>} rows
 * @param {(node: FlowNode) => string} labelOf
 * @param {[string, string, string]} headers
 * @returns {string}
 */
export function flowCsv(rows, labelOf, headers) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push([csvCell(labelOf(r.from)), csvCell(labelOf(r.to)), String(round2(r.value))].join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
