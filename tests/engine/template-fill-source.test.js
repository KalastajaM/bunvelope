// Template fill source envelope (schedule.source_envelope_id / source_since)
// and schedule `until` bounds — added 2026-08-20.
//
// The regression this closes: giving a template its own `schedule` (the
// 2026-08-19 fix) silently disconnected the Salary-Buffer funding regime —
// post-due and every forecast emitted the fill from unallocated forever,
// the buffer envelope never depleted, and free-to-allocate absorbed the
// draw as a phantom overallocation. The funding side now lives ON the
// schedule, so the materialiser and the forecaster can never disagree with
// each other or with a manual `fill --from-envelope` about where the money
// comes from.

import { describe, it, expect } from 'vitest';
import {
  materializeDueTemplateFills,
  forecastTemplateFills,
  computeEnvelopeBalances,
  computeAccountBalances,
  computeUnallocated,
  computeScheduledOccurrences,
  walkMonthlySchedule,
  templateFillSourceId,
  computeTemplateSourceDraws,
  fillDisplayTotal,
  forecastPlannedExpenses,
  projectEnvelopeBalance,
} from '../../js/engine.js';

const envs = [
  { id: 'e1', name: 'Groceries' },
  { id: 'e2', name: 'Transport' },
  { id: 'buf', name: 'Salary Buffer' },
  { id: 'gone', name: 'Old', archived: true },
];

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const tpl = over => ({
  id: 'tpl1',
  name: 'Start of month',
  kind: 'manual',
  lines: [
    { envelope_id: 'e1', mode: 'add', amount: 300 },
    { envelope_id: 'e2', mode: 'add', amount: 200.55 },
  ],
  schedule: {
    enabled: true,
    payment_day: 1,
    day_type: 'exact',
    since: '2026-10-01',
    months: allMonths,
    source_envelope_id: 'buf',
    source_since: '2026-11-01',
    ...(over?.schedule || {}),
  },
  ...(over ? Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'schedule')) : {}),
});

const idGen = () => { let n = 0; return () => `t${++n}`; };

describe('materializeDueTemplateFills with a source envelope', () => {
  it('draws the source from source_since on, with an offsetting negative line, and not before', () => {
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, [], new Date(2026, 10, 15), idGen(),
    );
    expect(newTxs).toHaveLength(2); // Oct 1 (pre-source) and Nov 1 (sourced)
    const [oct, nov] = newTxs;
    expect(oct.date).toBe('2026-10-01');
    expect(oct.source_envelope_id).toBeUndefined();
    expect(oct.lines).toHaveLength(2);
    expect(nov.date).toBe('2026-11-01');
    expect(nov.source_envelope_id).toBe('buf');
    expect(nov.lines).toHaveLength(3);
    const src = nov.lines.at(-1);
    expect(src).toMatchObject({ envelope_id: 'buf', mode: 'add' });
    expect(src.amount).toBeCloseTo(-500.55, 2);
    // the sourced fill is envelope-neutral and touches no account
    const eb = computeEnvelopeBalances([nov]);
    expect((eb.get('e1') ?? 0) + (eb.get('e2') ?? 0) + (eb.get('buf') ?? 0)).toBeCloseTo(0, 6);
    const ab = computeAccountBalances([{ id: 'a1', initialBalance: 0 }], [nov]);
    expect(computeUnallocated(ab, eb)).toBeCloseTo(0, 6);
  });

  it('declines the source silently when it is archived, missing, or a target line', () => {
    for (const bad of [
      tpl({ schedule: { source_envelope_id: 'gone' } }),
      tpl({ schedule: { source_envelope_id: 'nope' } }),
      tpl({ schedule: { source_envelope_id: 'e1' } }),
    ]) {
      const { newTxs } = materializeDueTemplateFills(
        [bad], [], envs, [], new Date(2026, 11, 15), idGen(),
      );
      expect(newTxs.length).toBeGreaterThan(0);
      for (const t of newTxs) {
        expect(t.source_envelope_id).toBeUndefined();
        expect(t.lines.every(l => l.amount > 0)).toBe(true);
      }
    }
  });

  it('templateFillSourceId compares the occurrence date, so a fill exactly ON source_since draws', () => {
    const t = tpl();
    const lines = t.lines;
    const envById = new Map(envs.map(e => [e.id, e]));
    expect(templateFillSourceId(t, '2026-10-31', lines, envById)).toBeNull();
    expect(templateFillSourceId(t, '2026-11-01', lines, envById)).toBe('buf');
  });

  it('the forecast twin carries the identical source lines', () => {
    const rows = forecastTemplateFills(
      [tpl()], [], envs, new Date(2026, 9, 15), '2026-12-31', {},
    );
    const nov = rows.find(r => r.date === '2026-11-01');
    const dec = rows.find(r => r.date === '2026-12-01');
    expect(nov.source_envelope_id).toBe('buf');
    expect(nov.lines.at(-1).amount).toBeCloseTo(-500.55, 2);
    expect(dec.source_envelope_id).toBe('buf');
    // pre-source months forecast without the source line
    const oct = rows.find(r => r.date === '2026-10-16' || r.date === '2026-10-01');
    if (oct) expect(oct.source_envelope_id).toBeUndefined();
  });
});

describe('schedule until bounds', () => {
  it('a template stops firing after schedule.until, in both the materialiser and the forecaster', () => {
    const bounded = tpl({ schedule: { until: '2026-11-30' } });
    const { newTxs } = materializeDueTemplateFills(
      [bounded], [], envs, [], new Date(2027, 2, 15), idGen(),
    );
    expect(newTxs.map(t => t.date)).toEqual(['2026-10-01', '2026-11-01']);
    const rows = forecastTemplateFills(
      [bounded], [], envs, new Date(2026, 9, 15), '2027-06-30', {},
    );
    expect(rows.every(r => r.date <= '2026-11-30')).toBe(true);
  });

  it('a budget item stops recurring after as_schedule_until instead of firing again next year', () => {
    const item = {
      id: 'salary', as_schedule: true, payment_day: 5,
      monthly_schedule: { ...allMonths, Jan: false },
      default_amount: 1000,
      as_schedule_since: '2026-08-01',
      as_schedule_until: '2026-09-30',
    };
    const occ = computeScheduledOccurrences(item, '2026-01-01', '2027-12-31', {});
    expect(occ.map(o => o.date)).toEqual(['2026-08-05', '2026-09-05']);
  });

  it('walkMonthlySchedule ignores a malformed until', () => {
    const spec = { months: allMonths, payment_day: 1, since: '2026-01-01', until: 'garbage' };
    const occ = walkMonthlySchedule(spec, '2026-01-01', '2026-03-31', {});
    expect(occ).toHaveLength(3);
  });
});


// ── 2026-08-20 adversarial-review regressions ───────────────────────────────

describe('review regressions', () => {
  it('fillDisplayTotal shows a sourced fill at the money moved INTO envelopes, not double', () => {
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, [], new Date(2026, 10, 15), idGen(),
    );
    const nov = newTxs.find(t => t.date === '2026-11-01');
    expect(nov.source_envelope_id).toBe('buf');
    expect(fillDisplayTotal(nov)).toBeCloseTo(500.55, 2);   // not 1001.10
    // an unsourced fill is unchanged
    const oct = newTxs.find(t => t.date === '2026-10-01');
    expect(fillDisplayTotal(oct)).toBeCloseTo(500.55, 2);
  });

  it('the source envelope DEPLETES in the health projection — no synthetic self-refill', () => {
    // Fund the buffer, materialise two sourced fills (posted drain lines),
    // then project the buffer forward: the negative scheduled fills must be
    // recognised (not the history fallback) and the balance must fall.
    const transactions = [
      { id: 'seed', type: 'adjustment', target: 'envelope', target_id: 'buf',
        amount: 5000, date: '2026-10-01', status: 'posted', payee: 'Fund buffer' },
    ];
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, transactions, new Date(2026, 11, 6), idGen(),
    );
    const all = [...transactions, ...newTxs];
    const projection = projectEnvelopeBalance({
      envelopeId: 'buf',
      transactions: all,
      budgetItems: [],
      envelopes: envs,
      accounts: [],
      envelopeTemplates: [tpl()],
      today: new Date(2026, 11, 6),
      months: 12,
    });
    expect(projection.fillSource).not.toBe('history');
    // one sourced fill has posted (Nov is pre... source_since 2026-11-01 → Nov+Dec posted = 2 drains)
    const opening = projection.months?.[0]?.opening ?? projection.closing;
    expect(projection.closing).toBeLessThan(opening - 3 * 500);
    expect(projection.firstNegative).toBeTruthy();
  });

  it('history fallback never synthesises refills from net-negative hand activity', () => {
    // an envelope with only outflow fill lines in trailing history
    const transactions = [
      { id: 'd1', type: 'fill', date: '2026-10-05', status: 'posted', payee: 'Drain', source: 'allocation',
        lines: [{ envelope_id: 'buf', mode: 'add', amount: -300 }] },
      { id: 'd2', type: 'fill', date: '2026-11-05', status: 'posted', payee: 'Drain', source: 'allocation',
        lines: [{ envelope_id: 'buf', mode: 'add', amount: -300 }] },
    ];
    const projection = projectEnvelopeBalance({
      envelopeId: 'buf', transactions, budgetItems: [], envelopes: envs, accounts: [],
      envelopeTemplates: [], today: new Date(2026, 11, 6), months: 6,
    });
    expect(projection.fillSource).toBe('none');
  });

  it('forecastPlannedExpenses honours as_schedule_until', () => {
    const item = {
      id: 'ending-plan', kind: 'expense', include: true, envelope_id: 'e1',
      default_amount: -100, monthly_schedule: { ...allMonths },
      as_schedule: false, as_schedule_until: '2026-10-31', payment_day: 15,
    };
    const rows = forecastPlannedExpenses([item], [], envs, new Date(2026, 8, 1), '2027-03-31', {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.date <= '2026-10-31')).toBe(true);
  });

  it('source_since compares the RAW schedule date, so prev_work_day cannot skip the first drawn month', () => {
    // 2026-11-01 is a Sunday; prev_work_day moves the pay date to Oct 30.
    const shifted = tpl({ schedule: { day_type: 'prev_work_day' } });
    const { newTxs } = materializeDueTemplateFills(
      [shifted], [], envs, [], new Date(2026, 10, 15), idGen(),
    );
    const nov = newTxs.find(t => t.from_budget === 'tpl:tpl1:2026-11');
    expect(nov).toBeTruthy();
    expect(nov.date < '2026-11-01').toBe(true);          // adjusted into October
    expect(nov.source_envelope_id).toBe('buf');          // still drawn from the buffer
  });
});

// The chip that explains a source envelope's monthly drain reads from this
// helper, so every case where the engine DECLINES the source must also be a
// case where nothing is announced — a chip promising a drain that never
// happens is worse than no chip.
describe('computeTemplateSourceDraws', () => {
  it('keys the draw by the SOURCE envelope, not the targets', () => {
    const m = computeTemplateSourceDraws([tpl()]);
    expect([...m.keys()]).toEqual(['buf']);
    expect(m.get('buf')).toEqual([{ id: 'tpl1', name: 'Start of month', sourceSince: '2026-11-01' }]);
  });

  it('says nothing for a template with no schedule, a disabled one, or no source', () => {
    expect(computeTemplateSourceDraws([{ id: 'a', name: 'A', lines: [] }]).size).toBe(0);
    expect(computeTemplateSourceDraws([tpl({ schedule: { enabled: false } })]).size).toBe(0);
    expect(computeTemplateSourceDraws([tpl({ schedule: { source_envelope_id: '' } })]).size).toBe(0);
  });

  it('declines exactly where templateFillSourceId declines: source is a target', () => {
    const selfFunded = tpl({ lines: [{ envelope_id: 'buf', mode: 'add', amount: 10 }] });
    expect(templateFillSourceId(selfFunded, '2026-12-01', selfFunded.lines, new Map(envs.map(e => [e.id, e])))).toBe(null);
    expect(computeTemplateSourceDraws([selfFunded]).size).toBe(0);

    // A set-mode line no longer declines (2026-09-24): its draw is the delta
    // that lands the target, resolved at posting / in the forecast walk.
    const setMode = tpl({ lines: [{ envelope_id: 'e1', mode: 'set', amount: 10 }] });
    expect(templateFillSourceId(setMode, '2026-12-01', setMode.lines, new Map(envs.map(e => [e.id, e])))).toBe('buf');
    expect(computeTemplateSourceDraws([setMode]).get('buf')).toHaveLength(1);
  });

  it('reads a dynamic template\'s assignments as the conflict surface', () => {
    const dyn = {
      id: 'd1', name: 'Dynamic', kind: 'dynamic',
      assignments: [{ envelope_id: 'buf', mode: 'add', percent: 100 }],
      schedule: { enabled: true, payment_day: 1, months: allMonths, source_envelope_id: 'buf' },
    };
    expect(computeTemplateSourceDraws([dyn]).size).toBe(0);
    const ok = { ...dyn, assignments: [{ envelope_id: 'e1', mode: 'add', percent: 100 }] };
    expect(computeTemplateSourceDraws([ok]).get('buf')).toHaveLength(1);
  });

  it('drops a schedule whose until has already passed, but only when asOf is given', () => {
    const ended = tpl({ schedule: { until: '2026-12-31' } });
    expect(computeTemplateSourceDraws([ended], { asOf: '2027-01-01' }).size).toBe(0);
    expect(computeTemplateSourceDraws([ended], { asOf: '2026-12-31' }).size).toBe(1);
    expect(computeTemplateSourceDraws([ended]).size).toBe(1);
  });

  it('collects several templates drawing on one envelope', () => {
    const second = tpl({ id: 'tpl2', name: 'Mid month' });
    const m = computeTemplateSourceDraws([tpl(), second]);
    expect(m.get('buf').map(x => x.id)).toEqual(['tpl1', 'tpl2']);
  });
});
