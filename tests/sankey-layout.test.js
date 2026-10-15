// The Sankey's pure half (js/ui/sankey/layout.js): node and link placement,
// and the view transforms the Money flow page applies before drawing.
import { describe, it, expect } from 'vitest';
import { layoutSankey, dropColumn, focusCategory, flowTable, flowCsv } from '../js/ui/sankey/layout.js';
import { buildActualFlow } from '../js/engine/flows.js';

const envelopes = [
  { id: 'rent', name: 'Rent', category: 'housing' },
  { id: 'power', name: 'Power', category: 'housing' },
  { id: 'groc', name: 'Groceries', category: 'food' },
  { id: 'gum', name: 'Gum', category: 'food' },
];
const accounts = [{ id: 'chk', type: 'checking' }, { id: 'sav', type: 'savings' }];
const tx = (type, amount, extra) => ({ type, amount, date: '2026-09-02', account: 'chk', ...extra });
const flow = buildActualFlow([
  tx('income', 3000, { payee: 'Employer' }),
  tx('income', 100, { payee: 'Interest' }),
  tx('expense', 1000, { envelope_id: 'rent' }),
  tx('expense', 100, { envelope_id: 'power' }),
  tx('expense', 400, { envelope_id: 'groc' }),
  tx('expense', 0.5, { envelope_id: 'gum' }),
  tx('account_transfer', 500, { from_account: 'chk', to_account: 'sav', account: undefined }),
], accounts, envelopes, { from: null, to: null });

const opts = { width: 800, height: 400 };

describe('layoutSankey', () => {
  const L = layoutSankey(flow, opts);
  const byId = new Map(L.nodes.map(n => [n.id, n]));

  it('places every column across the width', () => {
    expect(new Set(L.nodes.map(n => n.x))).toEqual(new Set([0, (800 - 12) / 3, 2 * (800 - 12) / 3, 800 - 12]));
  });

  it('uses one scale for every column', () => {
    const k = n => n.h / n.value;
    // Budget (col 1) and housing (col 2) and rent (col 3): same px per euro.
    expect(k(byId.get('budget'))).toBeCloseTo(k(byId.get('cat:housing')), 6);
    expect(k(byId.get('cat:housing'))).toBeCloseTo(k(byId.get('env:rent')), 6);
  });

  it('never overlaps nodes within a column, and keeps them inside the height', () => {
    for (const col of new Set(L.nodes.map(n => n.x))) {
      const ns = L.nodes.filter(n => n.x === col).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ns.length; i++) expect(ns[i].y).toBeGreaterThanOrEqual(ns[i - 1].y + ns[i - 1].h);
      expect(ns[0].y).toBeGreaterThanOrEqual(0);
      expect(ns[ns.length - 1].y + ns[ns.length - 1].h).toBeLessThanOrEqual(400 + 1e-6);
    }
  });

  it('gives a tiny node the minimum height', () => {
    expect(byId.get('env:gum').h).toBe(2);
  });

  it('stacks link ends inside their nodes, in the order of the other side', () => {
    for (const n of L.nodes) {
      const out = L.links.filter(l => l.source === n.id);
      const sum = out.reduce((s, l) => s + l.width, 0);
      expect(sum).toBeLessThanOrEqual(n.h + 1e-6);
      for (const l of out) {
        expect(l.y0 - l.width / 2).toBeGreaterThanOrEqual(n.y - 1e-6);
        expect(l.y0 + l.width / 2).toBeLessThanOrEqual(n.y + n.h + 1e-6);
      }
      const ys = out.map(l => l.y0);
      const targetYs = out.map(l => byId.get(l.target).y);
      expect([...ys].sort((a, b) => a - b)).toEqual(ys.slice().sort((a, b) => a - b));
      expect(ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b])).toEqual(targetYs.map((_, i) => i).sort((a, b) => targetYs[a] - targetYs[b]));
    }
  });

  it('draws each link from the source’s right edge to the target’s left edge', () => {
    const l = L.links.find(x => x.source === 'budget' && x.target === 'cat:housing');
    expect(l.x0).toBeCloseTo(byId.get('budget').x + 12, 6);
    expect(l.x1).toBeCloseTo(byId.get('cat:housing').x, 6);
    expect(l.path.startsWith('M')).toBe(true);
    expect(l.path).toContain('C');
  });

  it('is deterministic', () => {
    expect(layoutSankey(flow, opts)).toEqual(L);
  });

  it('lays out an empty flow as nothing', () => {
    expect(layoutSankey({ nodes: [], links: [], totals: { in: 0, out: 0 } }, opts)).toMatchObject({ nodes: [], links: [] });
  });
});

describe('view transforms', () => {
  it('dropColumn removes a column and every link into it', () => {
    const f = dropColumn(flow, 3);
    expect(f.nodes.some(n => n.column === 3)).toBe(false);
    const ids = new Set(f.nodes.map(n => n.id));
    for (const l of f.links) { expect(ids.has(l.source)).toBe(true); expect(ids.has(l.target)).toBe(true); }
    expect(layoutSankey(f, opts).nodes.map(n => n.x).sort((a, b) => a - b).at(-1)).toBe(800 - 12);
  });

  it('focusCategory keeps the category and its envelopes, as two columns', () => {
    const f = focusCategory(flow, 'cat:housing');
    expect(f.nodes.map(n => [n.id, n.column])).toEqual([['cat:housing', 0], ['env:rent', 1], ['env:power', 1]]);
    expect(f.links.map(l => l.target)).toEqual(['env:rent', 'env:power']);
    expect(f.totals).toEqual({ in: 1100, out: 1100 });
  });

  it('focusCategory of a missing category is empty', () => {
    expect(focusCategory(flow, 'cat:nope').nodes).toEqual([]);
  });

  it('flowTable pairs every link with its nodes; flowCsv escapes', () => {
    const rows = flowTable(flow);
    expect(rows).toHaveLength(flow.links.length);
    expect(rows[0]).toMatchObject({ from: { id: 'src:Employer' }, to: { id: 'budget' }, value: 3000 });
    const csv = flowCsv(rows.slice(0, 1), n => (n.id === 'budget' ? '=Budget, all' : 'Employer'), ['From', 'To', 'Amount']);
    expect(csv).toBe('﻿From,To,Amount\r\nEmployer,"\'=Budget, all",3000\r\n');
  });
});
