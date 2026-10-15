// Self-scheduled envelope templates: a template carrying its own `schedule`
// fires on a calendar, independent of any income occurrence.
//
// The bug this closes: `computeScheduledOccurrences` drops any month whose
// amount rounds to zero, and the income-linked fill is emitted inside that
// occurrence loop — so zeroing a scheduled income silently took its fill
// template down with it.

import { describe, it, expect } from 'vitest';
import {
  materializeDueTemplateFills,
  forecastTemplateFills,
  computeEnvelopeUpcomingDeltas,
  computeEnvelopeBalances,
  computeAccountBalances,
  computeUnallocated,
  materializeDueBudgetItems,
} from '../js/engine.js';

const envs = [
  { id: 'e1', name: 'Groceries' },
  { id: 'e2', name: 'Transport' },
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
    { envelope_id: 'e2', mode: 'add', amount: 200 },
  ],
  schedule: {
    enabled: true,
    payment_day: 1,
    day_type: 'exact',
    since: '2026-10-01',
    months: allMonths,
  },
  ...over,
});

const idGen = () => { let n = 0; return () => `t${++n}`; };

describe('materializeDueTemplateFills', () => {
  it('fires on its own pay day with no income item in sight', () => {
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, [], new Date(2026, 10, 15), idGen(),
    );
    expect(newTxs).toHaveLength(2); // Oct 1 and Nov 1
    expect(newTxs[0]).toMatchObject({
      type: 'fill',
      source: 'allocation',
      status: 'posted',
      date: '2026-10-01',
      payee: 'Start of month',
      template_id: 'tpl1',
      from_budget: 'tpl:tpl1:2026-10',
    });
    expect(newTxs[0].lines).toEqual([
      { envelope_id: 'e1', mode: 'add', amount: 300 },
      { envelope_id: 'e2', mode: 'add', amount: 200 },
    ]);
    expect(newTxs[1].from_budget).toBe('tpl:tpl1:2026-11');
  });

  it('is idempotent on re-run', () => {
    const today = new Date(2026, 10, 15);
    const first = materializeDueTemplateFills([tpl()], [], envs, [], today, idGen());
    const second = materializeDueTemplateFills([tpl()], [], envs, first.newTxs, today, idGen());
    expect(second.newTxs).toEqual([]);
  });

  it('respects tombstones so a deleted fill stays deleted', () => {
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, [], new Date(2026, 10, 15), idGen(),
      'FI', ['tpl:tpl1:2026-10'],
    );
    expect(newTxs.map(t => t.from_budget)).toEqual(['tpl:tpl1:2026-11']);
  });

  it('emits nothing when the schedule is absent or disabled', () => {
    const today = new Date(2026, 10, 15);
    const noSched = tpl({ schedule: undefined });
    const off = tpl({ schedule: { ...tpl().schedule, enabled: false } });
    expect(materializeDueTemplateFills([noSched], [], envs, [], today, idGen()).newTxs).toEqual([]);
    expect(materializeDueTemplateFills([off], [], envs, [], today, idGen()).newTxs).toEqual([]);
  });

  it('emits nothing for a malformed payment_day or months block', () => {
    const today = new Date(2026, 10, 15);
    const badDay = tpl({ schedule: { ...tpl().schedule, payment_day: 0 } });
    const badMonths = tpl({ schedule: { ...tpl().schedule, months: null } });
    expect(materializeDueTemplateFills([badDay], [], envs, [], today, idGen()).newTxs).toEqual([]);
    expect(materializeDueTemplateFills([badMonths], [], envs, [], today, idGen()).newTxs).toEqual([]);
  });

  it('drops lines whose envelope is archived or missing', () => {
    const t0 = tpl({
      lines: [
        { envelope_id: 'e1', mode: 'add', amount: 300 },
        { envelope_id: 'gone', mode: 'add', amount: 100 },
        { envelope_id: 'nope', mode: 'add', amount: 50 },
      ],
    });
    const { newTxs } = materializeDueTemplateFills(
      [t0], [], envs, [], new Date(2026, 9, 15), idGen(),
    );
    expect(newTxs[0].lines).toEqual([{ envelope_id: 'e1', mode: 'add', amount: 300 }]);
  });

  it('emits nothing when no line survives the archived filter', () => {
    const t0 = tpl({ lines: [{ envelope_id: 'gone', mode: 'add', amount: 100 }] });
    const { newTxs } = materializeDueTemplateFills(
      [t0], [], envs, [], new Date(2026, 9, 15), idGen(),
    );
    expect(newTxs).toEqual([]);
  });

  it('honours per-month toggles and skipped occurrences', () => {
    const t0 = tpl({
      schedule: {
        ...tpl().schedule,
        months: { Oct: true, Nov: false, Dec: true },
        skipped: ['2026-12'],
      },
    });
    const { newTxs } = materializeDueTemplateFills(
      [t0], [], envs, [], new Date(2026, 11, 31), idGen(),
    );
    expect(newTxs.map(t => t.from_budget)).toEqual(['tpl:tpl1:2026-10']);
  });

  it('applies working-day adjustment', () => {
    // 2026-11-01 is a Sunday.
    const t0 = tpl({ schedule: { ...tpl().schedule, day_type: 'next_work_day', since: '2026-11-01' } });
    const { newTxs } = materializeDueTemplateFills(
      [t0], [], envs, [], new Date(2026, 10, 15), idGen(), 'FI',
    );
    expect(newTxs.map(t => t.date)).toEqual(['2026-11-02']);
  });

  it('resolves a dynamic template against the budget', () => {
    const budgetItems = [{
      id: 'b1', envelope_id: 'e1', include: true, kind: 'expense',
      monthly_schedule: allMonths, default_amount: 120,
    }];
    const dyn = tpl({
      kind: 'dynamic',
      lines: undefined,
      assignments: [{ envelope_id: 'e1', mode: 'add', percent: 100 }],
    });
    const { newTxs } = materializeDueTemplateFills(
      [dyn], budgetItems, envs, [], new Date(2026, 9, 15), idGen(),
    );
    expect(newTxs[0].lines).toEqual([{ envelope_id: 'e1', mode: 'add', amount: 120 }]);
  });

  it('backfills from the 1st of the current month when since is absent', () => {
    const t0 = tpl({ schedule: { ...tpl().schedule, since: undefined } });
    const { newTxs } = materializeDueTemplateFills(
      [t0], [], envs, [], new Date(2026, 9, 20), idGen(),
    );
    expect(newTxs.map(t => t.from_budget)).toEqual(['tpl:tpl1:2026-10']);
  });

  it('is the only fill source — a stale income template_id adds nothing', () => {
    // Both legs used to fire independently on the same month, under two key
    // namespaces. The income-linked leg is gone, so an item still carrying
    // `template_id` posts its income and nothing else, and the template's own
    // schedule remains the single source of the allocation.
    const items = [{
      id: 'tpl1', kind: 'income', as_schedule: true, account_id: 'a1',
      monthly_schedule: allMonths, payment_day: 1, default_amount: 2000,
      template_id: 'tpl1', as_schedule_since: '2026-10-01',
    }];
    const accts = [{ id: 'a1', name: 'Checking' }];
    const today = new Date(2026, 9, 15);
    const fromIncome = materializeDueBudgetItems(
      items, accts, envs, [], today, idGen(), [tpl()], 'FI',
    ).newTxs;
    const fromTemplate = materializeDueTemplateFills(
      [tpl()], items, envs, fromIncome, today, idGen(),
    ).newTxs;

    expect(fromIncome.map(t => t.from_budget)).toEqual(['tpl1:2026-10']);
    expect(fromTemplate.map(t => t.from_budget)).toEqual(['tpl:tpl1:2026-10']);
  });

  it('normalises an unrecognised line mode to add, and stores a set line as its delta with the target', () => {
    // Ported from the deleted income-linked forecaster's coverage: mode
    // normalisation lives in `liveTemplateLines`, which only the template
    // path reaches now.
    const mixed = tpl({
      lines: [
        { envelope_id: 'e1', mode: 'set', amount: 100 },
        { envelope_id: 'e2', mode: 'sideways', amount: 50 },
      ],
    });
    const { newTxs } = materializeDueTemplateFills(
      [mixed], [], envs, [], new Date(2026, 9, 15), idGen(),
    );
    expect(newTxs[0].lines).toEqual([
      { envelope_id: 'e1', mode: 'add', amount: 100, set_target: 100 },
      { envelope_id: 'e2', mode: 'add', amount: 50 },
    ]);
  });
});

describe('self-scheduled fills draw on unallocated', () => {
  it('moves money envelope-side without touching any account balance', () => {
    const accts = [{ id: 'a1', name: 'Checking', initialBalance: 1000 }];
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, [], new Date(2026, 9, 15), idGen(),
    );
    // source: 'allocation' — only source: 'new_income' debits an account.
    expect(computeAccountBalances(accts, newTxs).get('a1')).toBe(1000);
    expect(computeEnvelopeBalances(newTxs).get('e1')).toBe(300);
    expect(computeEnvelopeBalances(newTxs).get('e2')).toBe(200);
  });

  it('drives unallocated negative rather than skipping the month', () => {
    const accts = [{ id: 'a1', name: 'Checking', initialBalance: 200 }];
    const { newTxs } = materializeDueTemplateFills(
      [tpl()], [], envs, [], new Date(2026, 9, 15), idGen(),
    );
    // 500 allocated against a 200 pool: the fill posts in full and unallocated
    // goes negative rather than the month being skipped.
    const unallocated = computeUnallocated(
      computeAccountBalances(accts, newTxs),
      computeEnvelopeBalances(newTxs),
      accts,
    );
    expect(unallocated).toBe(-300);
  });
});

describe('forecastTemplateFills', () => {
  it('emits rows from tomorrow with a dedup key matching from_budget', () => {
    const rows = forecastTemplateFills(
      [tpl()], [], envs, new Date(2026, 9, 15), '2026-12-31',
    );
    expect(rows.map(r => r.forecast_dedup_key)).toEqual([
      'tpl:tpl1:2026-11', 'tpl:tpl1:2026-12',
    ]);
    expect(rows[0]).toMatchObject({
      is_forecast: true,
      status: 'scheduled',
      type: 'fill',
      source: 'allocation',
      template_id: 'tpl1',
      date: '2026-11-01',
    });
  });

  it('dedup key is byte-identical to the materialised from_budget', () => {
    const today = new Date(2026, 9, 15);
    const posted = materializeDueTemplateFills([tpl()], [], envs, [], today, idGen()).newTxs;
    const forecast = forecastTemplateFills([tpl()], [], envs, today, '2026-12-31', { fromDateStr: '2026-10-01' });
    const postedKeys = new Set(posted.map(t => t.from_budget));
    const suppressed = forecast.filter(r => postedKeys.has(r.forecast_dedup_key));
    expect(suppressed.map(r => r.forecast_dedup_key)).toEqual(['tpl:tpl1:2026-10']);
  });

  it('returns nothing when the window is already closed', () => {
    expect(forecastTemplateFills([tpl()], [], envs, new Date(2026, 9, 15), '2026-10-01')).toEqual([]);
  });
});

describe('computeEnvelopeUpcomingDeltas with fills', () => {
  it('counts an upcoming self-scheduled fill, not just outgoing expenses', () => {
    const accts = [{ id: 'a1', name: 'Checking' }];
    const items = [{
      id: 'b1', kind: 'expense', as_schedule: true, account_id: 'a1',
      envelope_id: 'e1', monthly_schedule: allMonths, payment_day: 20,
      default_amount: 80, as_schedule_since: '2026-10-01',
    }];
    const t0 = tpl({ schedule: { ...tpl().schedule, payment_day: 25 } });
    const today = new Date(2026, 9, 15);

    const without = computeEnvelopeUpcomingDeltas([], items, accts, envs, today, 'FI');
    const with_ = computeEnvelopeUpcomingDeltas([], items, accts, envs, today, 'FI', [t0]);

    expect(without.get('e1')).toBe(-80);      // expense only
    expect(with_.get('e1')).toBe(220);        // -80 expense + 300 fill
    expect(with_.get('e2')).toBe(200);
  });

  it('ignores set-mode lines, which are not expressible as a delta', () => {
    const accts = [{ id: 'a1', name: 'Checking' }];
    const t0 = tpl({
      lines: [
        { envelope_id: 'e1', mode: 'set', amount: 300 },
        { envelope_id: 'e2', mode: 'add', amount: 200 },
      ],
      schedule: { ...tpl().schedule, payment_day: 25 },
    });
    const deltas = computeEnvelopeUpcomingDeltas([], [], accts, envs, new Date(2026, 9, 15), 'FI', [t0]);
    expect(deltas.has('e1')).toBe(false);
    expect(deltas.get('e2')).toBe(200);
  });

  it('a posted fill suppresses its forecast twin', () => {
    const accts = [{ id: 'a1', name: 'Checking' }];
    const t0 = tpl({ schedule: { ...tpl().schedule, payment_day: 25 } });
    const today = new Date(2026, 9, 15);
    const posted = [{
      id: 'x1', type: 'fill', date: '2026-10-25', status: 'posted', source: 'allocation',
      from_budget: 'tpl:tpl1:2026-10', template_id: 'tpl1',
      lines: [{ envelope_id: 'e1', mode: 'add', amount: 300 }],
    }];
    const deltas = computeEnvelopeUpcomingDeltas(posted, [], accts, envs, today, 'FI', [t0]);
    // The real row is future-dated, so it counts once via realFuture — not
    // twice by also counting the forecast.
    expect(deltas.get('e1')).toBe(300);
  });
});
