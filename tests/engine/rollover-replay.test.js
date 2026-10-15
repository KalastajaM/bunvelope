// tests/engine/rollover-replay.test.js — a stored fill is add-only (owner
// decision 2026-10-04): a template's set line is stored as its delta with the
// target in `set_target`. A fill for November dated in October is replayed by
// October's month-end sweep, and the sweep must replay it as the target, as it
// did a stored set line, both when posting (applyEnvelopeRollovers) and in
// the envelope projection (projectEnvelopeBalance).
import { describe, it, expect } from 'vitest';
import { txRolloverReplayEffect, computeEnvelopeBalances } from '../../js/engine/balances.js';
import { applyEnvelopeRollovers } from '../../js/engine/policies.js';
import { projectEnvelopeBalance } from '../../js/engine/envelope-forecast.js';

const ENVELOPES = [{ id: 'groc', name: 'Groceries', rollover: 'zero-monthly' }];
const OWN = { id: 'own', type: 'envelope_transfer', date: '2026-10-10', status: 'posted', amount: 100, from_envelope_id: null, to_envelope_id: 'groc' };
// November's top-up to 300, posted on 30 Oct onto October's 100.
const early = (line) => ({
  id: 'fill', type: 'fill', date: '2026-10-30', status: 'posted', source: 'allocation',
  lines: [line], from_budget: 'tpl:tpl:2026-11', template_id: 'tpl',
});
const RESOLVED = early({ envelope_id: 'groc', mode: 'add', amount: 200, set_target: 300 });
const PLAIN = early({ envelope_id: 'groc', mode: 'add', amount: 200 });

describe('txRolloverReplayEffect', () => {
  it('replays a resolved set line as its target, anything else as its balance effect', () => {
    expect(txRolloverReplayEffect(RESOLVED, 'groc')).toEqual({ mode: 'set', value: 300 });
    expect(txRolloverReplayEffect(PLAIN, 'groc')).toEqual({ mode: 'add', amount: 200 });
    expect(txRolloverReplayEffect(RESOLVED, 'other')).toBeNull();
    expect(txRolloverReplayEffect(OWN, 'groc')).toEqual({ mode: 'add', amount: 100 });
  });
});

describe("October's sweep keeps November's early top-up on its target", () => {
  const sweep = (fill) => applyEnvelopeRollovers(ENVELOPES, [OWN, fill], new Date(2026, 10, 2), () => 'ro').newTxs;
  const novBalance = (txs) => computeEnvelopeBalances(txs, { asOf: new Date(2026, 10, 15) }).get('groc');

  it('posting: no sweep is needed, the envelope stands on 300', () => {
    const rows = sweep(RESOLVED);
    expect(rows).toEqual([]);
    expect(novBalance([OWN, RESOLVED])).toBe(300);
  });

  it('posting: a met target (a zero line) still keeps October\'s money for November', () => {
    const met = early({ envelope_id: 'groc', mode: 'add', amount: 0, set_target: 100 });
    expect(sweep(met)).toEqual([]);
    expect(novBalance([OWN, met])).toBe(100);
  });

  it('control: a plain early add is replayed as an add, and October\'s 100 is swept', () => {
    const rows = sweep(PLAIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'adjustment', amount: -100, date: '2026-10-31' });
  });

  it('projection: the month-end walk lands on the same 300', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'groc', transactions: [OWN, RESOLVED], budgetItems: [], envelopeTemplates: [],
      accounts: [], envelopes: ENVELOPES, today: new Date(2026, 9, 30), months: 2,
    });
    expect(p.daily.find(d => d.date === '2026-11-01')?.balance).toBe(300);
  });
});
