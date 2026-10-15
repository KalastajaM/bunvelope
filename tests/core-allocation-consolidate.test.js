// tests/core-allocation-consolidate.test.js — allocation.consolidate: the
// Review page's former consolidateEnvelope merge rule through the
// command pipeline. One same-day `source: 'consolidation'` fill, one line per
// envelope; a repeat replaces that envelope's line, zero removes it. The Review
// page dispatching it is covered in page-review.test.js.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 15, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });

const income = { id: 'i1', type: 'income', date: '2026-10-01', payee: 'Job', amount: 300, envelope_id: 'groc', account: 'chk', status: 'posted' };
const today = (over = {}) => ({
  id: 'c1', type: 'fill', date: '2026-10-15', status: 'posted', source: 'consolidation', payee: 'Envelope consolidation',
  lines: [{ envelope_id: 'fun', amount: -20, mode: 'add' }], ...over,
});
const data = (transactions = [income]) => deepFreeze({
  meta: {}, budgetItems: [], envelopeTemplates: [],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }, { id: 'buf', name: 'Buffer' }],
  transactions,
});
const consolidate = (d, input) => runCommand(registry, d, 'allocation.consolidate', input, ctx());
const line = (envelope, amount) => ({ envelope, amount });

describe('allocation.consolidate', () => {
  it('creates today\'s consolidation fill when there is none, and returns it', () => {
    const r = consolidate(data(), { lines: [line('groc', -300)] });
    expect(r.ok).toBe(true);
    const row = {
      id: 'n1', type: 'fill', date: '2026-10-15', status: 'posted', source: 'consolidation',
      payee: 'Envelope consolidation', lines: [{ envelope_id: 'groc', amount: -300, mode: 'add' }],
    };
    expect(r.value.value).toEqual(row);
    expect(r.value.changes).toEqual({ transactions: [income, row] });
  });

  it('takes the payee the caller gives (the page passes its translated label)', () => {
    const r = consolidate(data(), { lines: [line('groc', -5)], payee: 'Kirjekuoren tasapainotus' });
    expect(r.value.value.payee).toBe('Kirjekuoren tasapainotus');
  });

  it('adds a second envelope to today\'s fill instead of creating another', () => {
    const existing = today();
    const r = consolidate(data([income, existing]), { lines: [line('groc', -100)] });
    const merged = { ...existing, lines: [{ envelope_id: 'fun', amount: -20, mode: 'add' }, { envelope_id: 'groc', amount: -100, mode: 'add' }] };
    expect(r.value.value).toEqual(merged);
    expect(r.value.changes.transactions).toEqual([income, merged]);
  });

  it('replaces the envelope\'s line on a repeat, never stacks it, and keeps the payee', () => {
    const existing = today({ payee: 'Typed earlier' });
    const r = consolidate(data([existing, income]), { lines: [line('fun', -40)] });
    expect(r.value.value).toEqual({ ...existing, lines: [{ envelope_id: 'fun', amount: -40, mode: 'add' }] });
    expect(r.value.changes.transactions.map(x => x.id)).toEqual(['c1', 'i1']);
  });

  it('a zero amount removes the envelope\'s line, and the fill once it has none', () => {
    const two = today({ lines: [{ envelope_id: 'fun', amount: -20, mode: 'add' }, { envelope_id: 'groc', amount: -5, mode: 'add' }] });
    const r = consolidate(data([income, two]), { lines: [line('fun', 0)] });
    expect(r.value.value.lines).toEqual([{ envelope_id: 'groc', amount: -5, mode: 'add' }]);
    const last = consolidate(data([income, today()]), { lines: [line('fun', '0.004')] });
    expect(last.value).toMatchObject({ value: null, changes: { transactions: [income] } });
    expect(last.value.diff.transactions.removed).toHaveLength(1);
  });

  it('a zero amount with nothing to remove changes nothing', () => {
    expect(consolidate(data(), { lines: [line('groc', 0)] }).value).toMatchObject({ value: null, changes: {} });
    const existing = today();
    expect(consolidate(data([income, existing]), { lines: [line('groc', 0)] }).value).toMatchObject({ value: existing, changes: {} });
  });

  it('merges only into a consolidation fill dated the same day', () => {
    const yesterday = today({ id: 'c0', date: '2026-10-14' });
    const otherFill = today({ id: 'f1', source: 'allocation' });
    const r = consolidate(data([yesterday, otherFill]), { lines: [line('groc', -1)] });
    expect(r.value.value.id).toBe('n1');
    expect(r.value.changes.transactions.slice(0, 2)).toEqual([yesterday, otherFill]);
  });

  it('honours an explicit date: it merges into that day\'s fill', () => {
    const d = data([today({ date: '2026-10-01' })]);
    const r = consolidate(d, { lines: [line('groc', -2)], date: '2026-10-01' });
    expect(r.value.value).toMatchObject({ id: 'c1', date: '2026-10-01' });
    expect(consolidate(d, { lines: [line('groc', -2)] }).value.value).toMatchObject({ id: 'n1', date: '2026-10-15' });
  });

  it('applies several lines in order, as successive single-envelope consolidations', () => {
    const r = consolidate(data(), { lines: [line('groc', -10), line('fun', 5.5), line('groc', '-12.344')] });
    expect(r.value.value.lines).toEqual([
      { envelope_id: 'groc', amount: -12.34, mode: 'add' },
      { envelope_id: 'fun', amount: 5.5, mode: 'add' },
    ]);
    expect(r.value.changes.transactions).toHaveLength(2);
  });

  it('needs at least one line, on a known envelope', () => {
    expect(consolidate(data(), { lines: [] }).error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'lines', message: 'needs at least one line' }] } });
    expect(consolidate(data(), {}).error.code).toBe('bad_input');
    expect(consolidate(data(), { lines: [line('nope', -1)] }).error.code).toBe('bad_input');
  });

  it('writes an app-generated row: payee aliases are left alone', () => {
    expect(registry.get('allocation.consolidate').payeeAliases).toBe(false);
  });
});

it('removes a legacy empty same-day consolidation on a zero line', () => {
  const r = consolidate(data([income, today({ lines: [] })]), { lines: [line('groc', 0)] });
  expect(r.ok).toBe(true);
  expect(r.value.changes.transactions).toEqual([income]);
  expect(r.value.value).toBeNull();
});
