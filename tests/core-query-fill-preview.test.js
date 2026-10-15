// tests/core-query-fill-preview.test.js — the Fill sheet's "after" spare as a
// query: `fill.preview`, each asked envelope's spare and low date once the
// pending lines are filled.
//
// The equivalence helper copies fill-line.js `spareAfterFill` and the sheet's
// `spareInput` (fill-envelopes.js L27-60) verbatim, with `state` → the
// fixture and `appNow()` / `todayIso()` → the fixed clock; the sheet's lines
// carry `envelope_id`, the query's `envelope`. The answer must equal the
// sheet's figures.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { projectEnvelopeBalance, envelopeFloor } from '../js/engine/envelope-forecast.js';
import { fillLineForRow } from '../js/pages/fill-line.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const NOW = at(2026, 9, 15);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ALL = () => Object.fromEntries(MONTHS.map(m => [m, true]));

// 15 Sep 2026. Groceries spends 300 a month, filled 250 a month by a
// template: short. A second template tops Target up to 500 (a set line) and
// adds 100 to Other, both drawn from Buffer, so Buffer's walk depends on
// Target's balance: a fill to Target changes what Buffer pays. Old is archived.
const data = (extra = {}) => deepFreeze({
  meta: { country: 'FI', scheduledTombstones: [] },
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 0 }],
  envelopes: [
    { id: 'groc', name: 'Groceries' },
    { id: 'buf', name: 'Buffer' },
    { id: 'tgt', name: 'Target' },
    { id: 'other', name: 'Other' },
    { id: 'old', name: 'Old', archived: true },
  ],
  budgetItems: [
    { id: 'gi', kind: 'expense', envelope_id: 'groc', description: 'Groceries', default_amount: -300, extra_buffer: 20, include: true, monthly_schedule: ALL(), as_schedule: false },
    { id: 'ti', kind: 'expense', envelope_id: 'tgt', description: 'Target spend', default_amount: -200, extra_buffer: 0, include: true, monthly_schedule: ALL(), as_schedule: false },
  ],
  envelopeTemplates: [
    { id: 'gt', name: 'Groceries fill', kind: 'manual', lines: [{ envelope_id: 'groc', mode: 'add', amount: 250 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: ALL() } },
    { id: 'st', name: 'Top up from buffer', kind: 'manual',
      lines: [{ envelope_id: 'tgt', mode: 'set', amount: 500 }, { envelope_id: 'other', mode: 'add', amount: 100 }],
      schedule: { enabled: true, payment_day: 25, day_type: 'exact', months: ALL(), since: '2026-01-01', source_envelope_id: 'buf' } },
  ],
  transactions: [
    { id: 'i1', type: 'income', date: '2026-08-01', payee: 'Job', amount: 9000, account: 'chk', status: 'posted' },
    { id: 'f1', type: 'fill', date: '2026-08-02', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 300 }, { envelope_id: 'buf', mode: 'add', amount: 5000 },
        { envelope_id: 'tgt', mode: 'add', amount: 200 }, { envelope_id: 'old', mode: 'add', amount: 10 }] },
    { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 120.5, account: 'chk', envelope_id: 'groc', status: 'posted' },
  ],
  ...extra,
});

// fill-line.js spareAfterFill, verbatim.
function round2(n) { return Math.round(n * 100) / 100; }
function spareAfterFill(input, envelopeId, lines, dateStr) {
  const hypothetical = {
    id: 'preview:fill',
    type: 'fill',
    date: dateStr,
    status: 'posted',
    source: 'allocation',
    lines,
  };
  const projection = projectEnvelopeBalance({
    ...input,
    envelopeId,
    transactions: [...(input.transactions || []), hypothetical],
  });
  if (projection.unresolved || !projection.low) return null;
  const floor = envelopeFloor(input.budgetItems, envelopeId);
  return { spare: round2(projection.low.balance - floor), lowDate: projection.low.date };
}
// The sheet's spareInput (fill-envelopes.js L27-60) and its checkShortfalls
// call per asked envelope; `lines` are the query's, renamed to the sheet's.
function sheetAfter(state, appNow, lines, ids) {
  const active = (state.envelopes || []).filter(e => !e.archived);
  const spareInput = {
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: active,
    today: appNow,
    months: 12,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  };
  const sheetLines = lines.map(l => ({ envelope_id: l.envelope, amount: l.amount, mode: 'add' }));
  const today = isoOf(appNow);
  return {
    envelopes: ids.map(id => {
      const after = spareAfterFill(spareInput, id, sheetLines, today);
      return after ? { id, spare: after.spare, lowDate: after.lowDate } : { id, spare: null, lowDate: null };
    }),
  };
}

const ASKED = ['groc', 'buf', 'tgt', 'other'];
const CASES = [
  ['an add line to one envelope', [{ envelope: 'groc', amount: 80, mode: 'add' }]],
  ['lines to several envelopes, one negative (a Set below the balance)', [
    { envelope: 'groc', amount: 25.5, mode: 'add' }, { envelope: 'other', amount: -40, mode: 'add' }, { envelope: 'buf', amount: 300, mode: 'add' }]],
  ['a line to the set-mode target, which moves what the source draws', [{ envelope: 'tgt', amount: 150, mode: 'add' }]],
  ['no lines', []],
];

describe('fill.preview — equals the Fill sheet\'s spareAfterFill', () => {
  for (const [label, lines] of CASES) {
    it(label, () => {
      const d = data();
      const a = answer('fill.preview', { lines, envelopes: ASKED }, d);
      expect(a).toEqual(sheetAfter(d, NOW, lines, ASKED));
      jsonSafe(a);
    });
  }

  it('the answer is per asked envelope, in the order asked, an envelope with no entry included', () => {
    const d = data();
    const a = answer('fill.preview', { lines: [{ envelope: 'groc', amount: 50 }], envelopes: ['other', 'groc'] }, d);
    expect(a.envelopes.map(e => e.id)).toEqual(['other', 'groc']);
    expect(a).toEqual(sheetAfter(d, NOW, [{ envelope: 'groc', amount: 50 }], ['other', 'groc']));
  });

  it('a fill to the set-mode target lowers the source\'s draw: Buffer\'s spare rises by the fill', () => {
    const d = data();
    const before = answer('fill.preview', { lines: [], envelopes: ['buf'] }, d).envelopes[0];
    const after = answer('fill.preview', { lines: [{ envelope: 'tgt', amount: 150 }], envelopes: ['buf'] }, d).envelopes[0];
    expect(after.spare).toBe(round2(before.spare + 150));
  });

  it('with no lines, each spare is the envelope\'s spare (envelopes.month)', () => {
    const d = data();
    const month = answer('envelopes.month', { envelopes: ASKED }, d).envelopes;
    const preview = answer('fill.preview', { lines: [], envelopes: ASKED }, d).envelopes;
    expect(preview).toEqual(month.map(e => ({ id: e.id, spare: e.spare.spare, lowDate: e.spare.lowDate })));
  });

  it('an archived envelope cannot be projected: spare and lowDate null', () => {
    const d = data();
    expect(answer('fill.preview', { lines: [{ envelope: 'groc', amount: 10 }], envelopes: ['old'] }, d))
      .toEqual({ envelopes: [{ id: 'old', spare: null, lowDate: null }] });
  });

  it('date is the fill\'s date and the projection\'s first day', () => {
    const d = data();
    const lines = [{ envelope: 'groc', amount: 80 }];
    expect(answer('fill.preview', { lines, envelopes: ASKED, date: '2026-10-03' }, d)).toEqual(sheetAfter(d, at(2026, 10, 3), lines, ASKED));
  });

  it('refuses an unknown envelope, a mode other than add, and missing lines or envelopes', () => {
    const d = data();
    expect(ask('fill.preview', { lines: [{ envelope: 'nope', amount: 1 }], envelopes: ['groc'] }, d).error.code).toBe('bad_input');
    expect(ask('fill.preview', { lines: [], envelopes: ['nope'] }, d).error.code).toBe('bad_input');
    expect(ask('fill.preview', { lines: [{ envelope: 'groc', amount: 1, mode: 'set' }], envelopes: ['groc'] }, d).error.code).toBe('bad_input');
    expect(ask('fill.preview', { envelopes: ['groc'] }, d).error.code).toBe('bad_input');
    expect(ask('fill.preview', { lines: [] }, d).error.code).toBe('bad_input');
  });

  it('runs against deep-frozen data without mutating it', () => {
    const d = data();
    const before = JSON.stringify(d);
    answer('fill.preview', { lines: [{ envelope: 'tgt', amount: 150 }], envelopes: ASKED }, d);
    expect(JSON.stringify(d)).toBe(before);
  });
});

// The owner's Groceries, 15 Sep 2026 (ported from the retired
// tests/fill-spare-after.test.js, whose helper this query replaced): planned
// 800/month, filled 400 on the 1st and 400 on the 15th, 224.62 spent so far.
// A "Set 400" on the Fill sheet swept the 175.38 still meant for the rest of
// the month into other envelopes, and the card then read "175.38 short" with
// nothing on the sheet having said so. This is the figure the sheet warns
// with. A second envelope (Other) stands in for the old fixture's unknown
// "elsewhere": the query refuses an id the budget does not have.
describe('fill.preview — the owner\'s Groceries', () => {
  const G = 'groceries';
  const template = (id, day) => ({
    id, name: id,
    lines: [{ envelope_id: G, amount: 400, mode: 'add' }],
    schedule: { enabled: true, day_type: 'exact', payment_day: day, months: ALL() },
  });
  const groceries = () => deepFreeze({
    meta: { country: 'FI', scheduledTombstones: [] },
    accounts: [{ id: 'bank', type: 'bank' }],
    envelopes: [{ id: G, name: 'Groceries', rollover: 'zero-monthly' }, { id: 'other', name: 'Other' }],
    budgetItems: [{
      id: 'item-g', envelope_id: G, kind: 'expense', default_amount: -800,
      monthly_schedule: ALL(), payment_day: 0, include: true, as_schedule: false, extra_buffer: 0,
    }],
    envelopeTemplates: [template('som', 1), template('mid', 15)],
    transactions: [
      { id: 'f1', type: 'fill', date: '2026-09-01', status: 'posted', template_id: 'som',
        from_budget: 'tpl:som:2026-09', lines: [{ envelope_id: G, amount: 400, mode: 'add' }] },
      { id: 'e1', type: 'expense', date: '2026-09-07', envelope_id: G, amount: 87.32 },
      { id: 'e2', type: 'expense', date: '2026-09-14', envelope_id: G, amount: 137.30 },
      { id: 'f2', type: 'fill', date: '2026-09-15', status: 'posted', template_id: 'mid',
        from_budget: 'tpl:mid:2026-09', lines: [{ envelope_id: G, amount: 400, mode: 'add' }] },
    ],
  });
  // The sheet's line for a row: its Set target or Add amount against the
  // booked balance, renamed to the query's field.
  const lineFor = (d, mode, value) => {
    const curBal = answer('balances', { lens: 'booked' }, d).envelopes.find(e => e.id === G).balance;
    const l = fillLineForRow({ envelopeId: G, mode, value, curBal });
    return { envelope: l.envelope_id, amount: l.amount, mode: 'add' };
  };
  const spareAfter = (d, lines) => answer('fill.preview', { lines, envelopes: [G] }, d).envelopes[0];

  it('starts from the reported state: 575.38 held, exactly the rest of the plan', () => {
    const d = groceries();
    expect(answer('balances', { lens: 'booked' }, d).envelopes.find(e => e.id === G).balance).toBe(575.38);
    expect(spareAfter(d, []).spare).toBe(0);
    expect(answer('envelopes.month', { envelopes: [G] }, d).envelopes[0].spare.spare).toBe(0);
  });

  it('a Set 400 leaves the envelope 175.38 short by month end', () => {
    const d = groceries();
    const line = lineFor(d, 'set', 400);
    expect(line.amount).toBe(-175.38);
    expect(spareAfter(d, [line])).toEqual({ id: G, spare: -175.38, lowDate: '2026-09-30' });
  });

  it('a top-up does not raise spare past the month-end sweep', () => {
    // Zero-monthly: the extra 50 is swept to unallocated on 30 Sep, and the
    // walk touches 0 again before October's fill. Not a uniform +50 shift,
    // which is why the sheet re-projects rather than adding the delta.
    const d = groceries();
    expect(spareAfter(d, [lineFor(d, 'add', 50)]).spare).toBe(0);
  });

  it('a partial sweep leaves exactly that much short', () => {
    const d = groceries();
    expect(spareAfter(d, [lineFor(d, 'set', 500)]).spare).toBe(-75.38);
  });

  it('ignores lines for other envelopes', () => {
    const d = groceries();
    expect(spareAfter(d, [{ envelope: 'other', amount: -100, mode: 'add' }]).spare).toBe(0);
  });

  it('refuses an envelope the budget does not have', () => {
    const d = groceries();
    expect(ask('fill.preview', { lines: [], envelopes: ['missing'] }, d).error.code).toBe('bad_input');
  });
});
