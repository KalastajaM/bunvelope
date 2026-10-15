import { describe, it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery, runBatch, runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import { projectEnvelopeBalance } from '../js/engine/envelope-forecast.js';
const newId = vi.fn(() => 'saved-transfer');
const ctx = makeCtx({ now: new Date(2026, 9, 7, 12), newId });
const fill = (id, amount) => ({ id: 'fill:' + id, type: 'fill', date: '2026-10-01', status: 'posted', lines: [{ envelope_id: id, mode: 'add', amount }] });
const budget = () => ({ meta: { schemaVersion: 8, country: 'FI' }, accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'food', name: 'Food' }, { id: 'fun', name: 'Fun' }], budgetItems: [], envelopeTemplates: [],
  transactions: [fill('food', 50), fill('fun', 200), { id: 'expense', type: 'expense', account: 'bank', envelope_id: 'food', amount: 100, date: '2026-10-10', status: 'scheduled' }] });
const query = (d, source, c = ctx) => runQuery(registry, d, 'envelope.funding', { envelope: 'food', ...(source ? { source } : {}) }, c);
const answer = (d, source, c) => { const r = query(d, source, c); expect(r.ok, JSON.stringify(r)).toBe(true); return r.value; };

describe('envelope funding suggestions', () => {
  it('offers read-only candidates and writes exactly the previewed same-day transfer only through the session pipeline', () => {
    const d = budget(), original = structuredClone(d); newId.mockClear();
    expect(answer(d).candidates).toEqual([{ id: 'fun', name: 'Fun', amount: 50, available: 200 }]);
    const r = answer(d, 'fun');
    expect(r.preview).toMatchObject({ canApply: true, remainingGap: 0, blockers: [] });
    expect(r.preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'food', before: expect.objectContaining({ spare: -50 }), after: expect.objectContaining({ spare: 0 }) }),
      expect.objectContaining({ id: 'fun', after: expect.objectContaining({ spare: 150 }) }),
    ]));
    expect(d).toEqual(original); expect(newId).not.toHaveBeenCalled();
    const saved = runBatch(registry, d, [{ name: 'envelope.fund', input: { envelope: 'food', source: 'fun', expected: JSON.stringify(r) } }], ctx, { checks: applyCommitChecks });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const after = saved.value.after;
    expect(after.transactions.at(-1)).toMatchObject({ type: 'envelope_transfer', amount: 50, date: '2026-10-07' });
    expect(after.accounts).toEqual(d.accounts);
    expect(projectEnvelopeBalance({ ...after, envelopeId: 'food', today: ctx.today, months: 12 }).low.balance).toBe(0);
  });
  it('splits a combined preview proportionally in cents, independently of selection order', () => {
    const d = budget(); d.envelopes.push({ id: 'travel', name: 'Travel' }); d.transactions.push(fill('travel', 100));
    const read = sources => runQuery(registry, d, 'envelope.funding', { envelope: 'food', sources }, ctx);
    const r = read(['fun', 'travel']);
    expect(r.ok).toBe(true);
    expect(r.value.preview).toMatchObject({ total: 50, remainingGap: 0, canApply: true });
    expect(r.value.preview.sources.map(c => c.amount)).toEqual([33.33, 16.67]);
    expect(read(['travel', 'fun'])).toEqual(r);
    for (const sources of [[], ['fun', 'fun'], ['food'], ['missing']]) expect(read(sources).ok).toBe(false);
    expect(runQuery(registry, d, 'envelope.funding', { envelope: 'food', source: 'fun', sources: ['travel'] }, ctx).ok).toBe(false);
  });
  it('uses all eligible money for partial combined funding without exceeding source limits', () => {
    const d = budget(); d.transactions[1] = fill('fun', 10.01);
    d.envelopes.push({ id: 'travel', name: 'Travel' }); d.transactions.push(fill('travel', 20.02));
    const r = runQuery(registry, d, 'envelope.funding', { envelope: 'food', sources: ['fun', 'travel'] }, ctx);
    expect(r.value.preview).toMatchObject({ total: 30.03, remainingGap: 19.97, canApply: true });
    expect(r.value.preview.steps.map(s => s.input.amount)).toEqual([20.02, 10.01]);
  });
  it('checks combined indirect effects even when each individual transfer is safe', () => {
    const d = budget(); d.transactions[1] = fill('fun', 30);
    d.envelopes.push({ id: 'travel', name: 'Travel' }, { id: 'third', name: 'Third' });
    d.transactions.push(fill('travel', 30), fill('third', 40));
    d.envelopeTemplates = ['fun', 'travel'].map(id => ({ id: 'refill-' + id, name: id,
      lines: [{ envelope_id: id, mode: 'set', amount: 30 }],
      schedule: { enabled: true, payment_day: 1, months: { Nov: true }, since: '2026-10-01', source_envelope_id: 'third' } }));
    expect(answer(d, 'fun').preview.canApply).toBe(true);
    expect(answer(d, 'travel').preview.canApply).toBe(true);
    const r = runQuery(registry, d, 'envelope.funding', { envelope: 'food', sources: ['fun', 'travel'] }, ctx);
    expect(r.value.preview.canApply).toBe(false);
    expect(r.value.preview.steps).toEqual([]);
    expect(r.value.preview.blockers).toContainEqual({ kind: 'reserve', id: 'third', name: 'Third' });
  });
  it('caps the transfer at the source goal surplus and identifies partial funding', () => {
    const d = budget(); d.envelopes[1] = { ...d.envelopes[1], goal_amount: 180, goal_date: '2026-11-01' };
    const r = answer(d, 'fun');
    expect(r.preview).toMatchObject({ source: { amount: 20 }, canApply: true, remainingGap: 30 });
    expect(r.preview.goals[0].after).toMatchObject({ status: 'onTrack', projected: 180 });
  });
  it('protects the source reserve floor', () => {
    const d = budget(); d.budgetItems = [{ id: 'buffer', kind: 'expense', envelope_id: 'fun', default_amount: 0, include: true, extra_buffer: 190 }];
    expect(answer(d, 'fun').preview).toMatchObject({ source: { amount: 10 }, canApply: true, remainingGap: 40 });
  });
  it.each(['2028-01-01', '2026-09-01', '2026-11-01'])('does not offer money needed by an unassessed or underfunded goal (%s)', date => {
    const d = budget(); d.envelopes[1] = { ...d.envelopes[1], goal_amount: 250, goal_date: date };
    expect(answer(d).candidates).toEqual([]); expect(query(d, 'fun').ok).toBe(false);
  });
  it('excludes archived sources and refuses a disappeared or same-envelope selection', () => {
    const d = budget(); d.envelopes[1].archived = true;
    expect(answer(d).candidates).toEqual([]);
    for (const source of ['fun', 'food', 'missing']) expect(query(d, source).ok).toBe(false);
  });
  it('shows no candidates once the target gap is covered', () => {
    const d = budget(); d.transactions[0] = fill('food', 200);
    expect(answer(d)).toMatchObject({ gap: 0, candidates: [], preview: null });
  });
  it('blocks a source refill that would push another envelope below its reserve', () => {
    const d = budget(); d.envelopes.push({ id: 'third', name: 'Third' }); d.transactions.push(fill('third', 25));
    d.envelopeTemplates = [{ id: 'refill', name: 'Refill source', lines: [{ envelope_id: 'fun', mode: 'set', amount: 200 }],
      schedule: { enabled: true, payment_day: 1, months: { Nov: true }, since: '2026-10-01', source_envelope_id: 'third' } }];
    const r = answer(d, 'fun');
    expect(r.preview.canApply).toBe(false); expect(r.preview.steps).toEqual([]);
    expect(r.preview.blockers).toContainEqual({ kind: 'reserve', id: 'third', name: 'Third' });
    expect(r.preview.changes.find(e => e.id === 'third').after.spare).toBe(-25);
  });
  it('protects indirectly affected savings goals even when their envelope stays positive', () => {
    const d = budget(); d.envelopes.push({ id: 'third', name: 'Third', goal_amount: 280, goal_date: '2026-11-15' }); d.transactions.push(fill('third', 300));
    d.envelopeTemplates = [{ id: 'refill', name: 'Refill source', lines: [{ envelope_id: 'fun', mode: 'set', amount: 200 }],
      schedule: { enabled: true, payment_day: 1, months: { Nov: true }, since: '2026-10-01', source_envelope_id: 'third' } }];
    expect(answer(d, 'fun').preview.blockers).toContainEqual({ kind: 'goal', id: 'third', name: 'Third' });
    d.envelopes[2].goal_date = '2028-01-01';
    expect(answer(d, 'fun').preview.blockers).toContainEqual({ kind: 'unknownGoal', id: 'third', name: 'Third' });
  });
  it('refuses a transfer erased by a monthly reset before the largest gap', () => {
    const d = budget(); d.envelopes[0].rollover = 'zero-monthly';
    d.transactions[2].date = '2026-11-10';
    const r = answer(d, 'fun');
    expect(r.preview.canApply).toBe(false);
    expect(r.preview.blockers).toContainEqual({ kind: 'noImprovement', id: 'food', name: 'Food' });
    expect(r.preview.steps).toEqual([]);
  });
  it('catches an earlier daily shortfall even when the other envelope minimum is unchanged', () => {
    const d = budget(); d.envelopes.push({ id: 'third', name: 'Third' });
    d.transactions.push(fill('third', 25), { id: 'later', type: 'expense', envelope_id: 'third', account: 'bank', amount: 200, date: '2027-01-10', status: 'scheduled' });
    d.envelopeTemplates = [{ id: 'refill', name: 'Refill source', lines: [{ envelope_id: 'fun', mode: 'set', amount: 200 }],
      schedule: { enabled: true, payment_day: 15, months: { Oct: true }, since: '2026-10-01', source_envelope_id: 'third' } },
      { id: 'third-refill', name: 'Reset third', lines: [{ envelope_id: 'third', mode: 'set', amount: 100 }],
        schedule: { enabled: true, payment_day: 1, months: { Dec: true }, since: '2026-10-01' } }];
    const r = answer(d, 'fun');
    const third = r.preview.changes.find(e => e.id === 'third');
    expect(third.before.spare).toBe(-100); expect(third.after.spare).toBe(-100);
    expect(r.preview.blockers).toContainEqual({ kind: 'reserve', id: 'third', name: 'Third' });
    expect(r.preview.canApply).toBe(false);
  });
  it('rechecks the reviewed forecast at command execution and refuses changes or a new day', () => {
    const d = budget(); const r = answer(d, 'fun');
    const input = { envelope: 'food', source: 'fun', expected: JSON.stringify(r) };
    const tomorrow = makeCtx({ now: new Date(2026, 9, 8, 12), newId });
    expect(runCommand(registry, d, 'envelope.fund', input, tomorrow)).toMatchObject({ ok: false, error: { code: 'funding_preview_changed' } });
    d.transactions[1] = fill('fun', 10);
    expect(runCommand(registry, d, 'envelope.fund', input, ctx)).toMatchObject({ ok: false, error: { code: 'funding_preview_changed' } });
    expect(runCommand(registry, budget(), 'envelope.fund', { ...input, expected: '{}' }, ctx).ok).toBe(false);
  });
  it('uses the injected date and clamps a leap-day forecast', () => {
    const d = budget(); const clock = makeCtx({ now: new Date(2028, 1, 29, 12), newId });
    expect(answer(d, undefined, clock)).toMatchObject({ date: '2028-02-29', end: '2029-02-27' });
  });
});
