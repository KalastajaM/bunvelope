// The shared forecast helpers that every consumer surface now routes through.
//
// The bug these guard: each surface used to compose its dedup key by hand as
// `${forecast_budget_item_id}:${forecast_month_key}`. That is correct only for
// the expense/income/investment legs. A fill's key is not the item:month pair,
// and a self-scheduled template fill has no budget item at all — so a
// hand-composed key never matched, and a posted fill would show up twice: once
// real, once as a forecast that should have been suppressed.

import { describe, it, expect } from 'vitest';
import {
  forecastKey,
  forecastAllFills,
  fillDisplayTotal,
  fillSetLineCount,
  materializeDueTemplateFills,
} from '../js/engine.js';

const envs = [{ id: 'e1', name: 'Groceries' }, { id: 'e2', name: 'Transport' }];
const accts = [{ id: 'a1', name: 'Checking' }];

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const selfScheduled = {
  id: 'tpl1',
  name: 'Start of month',
  kind: 'manual',
  lines: [
    { envelope_id: 'e1', mode: 'add', amount: 300 },
    { envelope_id: 'e2', mode: 'add', amount: 200 },
  ],
  schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: allMonths },
};

const incomeLinked = {
  id: 'tpl2',
  name: 'Payday split',
  kind: 'manual',
  lines: [{ envelope_id: 'e1', mode: 'add', amount: 150 }],
};

const incomeItem = {
  id: 'inc1', kind: 'income', as_schedule: true, account_id: 'a1',
  monthly_schedule: allMonths, payment_day: 25, default_amount: 2000,
  template_id: 'tpl2', as_schedule_since: '2026-10-01',
};

describe('forecastKey', () => {
  it('uses the explicit dedup key when present', () => {
    expect(forecastKey({ forecast_dedup_key: 'tpl:tpl1:2026-10' })).toBe('tpl:tpl1:2026-10');
  });

  it('falls back to item:month for the expense/income legs', () => {
    expect(forecastKey({ forecast_budget_item_id: 'b1', forecast_month_key: '2026-10' }))
      .toBe('b1:2026-10');
  });

  it('never returns the undefined-prefixed key for a template fill', () => {
    // The exact regression: a self-scheduled fill has no budget item, so the
    // hand-composed form produced "undefined:2026-10" and matched nothing.
    const row = forecastAllFills([], [selfScheduled], accts, envs, new Date(2026, 9, 15), '2026-11-30')[0];
    expect(forecastKey(row)).toBe('tpl:tpl1:2026-11');
    expect(forecastKey(row)).not.toContain('undefined');
  });

  it('is total for a null-ish row rather than throwing', () => {
    expect(forecastKey(null)).toBe('');
  });
});

describe('forecastAllFills', () => {
  it('returns self-scheduled fills, the only source there is now', () => {
    // Window opens tomorrow (Oct 16), so the self-scheduled fill's Oct 1
    // occurrence is already behind it — Nov 1 is its first forecast row.
    const rows = forecastAllFills(
      [incomeItem], [selfScheduled, incomeLinked], accts, envs,
      new Date(2026, 9, 15), '2026-11-15',
    );
    expect(rows.map(r => forecastKey(r))).toEqual(['tpl:tpl1:2026-11']);
  });

  it('ignores a stale template_id left on an income item', () => {
    // `incomeLinked` is a template with no schedule of its own, and
    // `incomeItem` still points at it. Neither may produce a fill: the
    // income-linked leg is gone, and an unscheduled template fires never.
    expect(forecastAllFills(
      [incomeItem], [incomeLinked], accts, envs, new Date(2026, 9, 15), '2026-12-31',
    )).toEqual([]);
  });
});

describe('a posted fill suppresses its forecast twin', () => {
  it('matches byte-for-byte on the key the materialiser wrote', () => {
    const today = new Date(2026, 9, 15);
    const posted = materializeDueTemplateFills(
      [selfScheduled], [], envs, [], today, (() => { let n = 0; return () => `t${++n}`; })(),
    ).newTxs;
    expect(posted).toHaveLength(1);

    const taken = new Set(posted.map(t => t.from_budget));
    // Forecast over a window that includes the already-posted October.
    const rows = forecastAllFills(
      [], [selfScheduled], accts, envs, today, '2026-12-31', { fromDateStr: '2026-10-01' },
    );
    const surviving = rows.filter(r => !taken.has(forecastKey(r)));

    expect(rows.map(r => forecastKey(r))).toContain('tpl:tpl1:2026-10');
    expect(surviving.map(r => forecastKey(r))).toEqual(['tpl:tpl1:2026-11', 'tpl:tpl1:2026-12']);
  });

  it('the old hand-composed key would NOT have suppressed it', () => {
    // Pins why forecastKey exists. If someone reverts a call site to composing
    // the key inline, this documents the consequence.
    const row = forecastAllFills(
      [], [selfScheduled], accts, envs, new Date(2026, 9, 15), '2026-11-30',
    )[0];
    const handComposed = `${row.forecast_budget_item_id}:${row.forecast_month_key}`;
    expect(handComposed).toBe('undefined:2026-11');
    expect(handComposed).not.toBe(forecastKey(row));
  });
});

describe('fillDisplayTotal', () => {
  it('sums add-mode lines', () => {
    expect(fillDisplayTotal({ type: 'fill', lines: selfScheduled.lines })).toBe(500);
  });

  it('excludes set-mode lines, which overwrite rather than contribute', () => {
    expect(fillDisplayTotal({ type: 'fill', lines: [
      { envelope_id: 'e1', mode: 'set', amount: 300 },
      { envelope_id: 'e2', mode: 'add', amount: 200 },
    ] })).toBe(200);
  });

  // Stored fills are add-only since 2026-10-04: a set line is its delta, with
  // the target in set_target, and a delta is negative when the envelope held
  // more than its target. That surplus goes back; it is not money added.
  it('nets a resolved set line by its sign, so a returned surplus is not shown as added', () => {
    expect(fillDisplayTotal({ type: 'fill', lines: [
      { envelope_id: 'e1', mode: 'add', amount: -40, set_target: 300 },
      { envelope_id: 'e2', mode: 'add', amount: 100 },
    ] })).toBe(60);
    expect(fillDisplayTotal({ type: 'fill', lines: [
      { envelope_id: 'e1', mode: 'add', amount: -40, set_target: 300 },
    ] })).toBe(-40);
    expect(Object.is(fillDisplayTotal({ type: 'fill', lines: [
      { envelope_id: 'e1', mode: 'add', amount: 0, set_target: 300 },
    ] }), 0)).toBe(true);
  });

  it('keeps a legacy negative line without set_target at its magnitude', () => {
    expect(fillDisplayTotal({ type: 'fill', lines: [
      { envelope_id: 'e1', mode: 'add', amount: -40 },
      { envelope_id: 'e2', mode: 'add', amount: 100 },
    ] })).toBe(140);
  });

  it('is 0 for anything that is not a fill', () => {
    expect(fillDisplayTotal({ type: 'expense', amount: 50 })).toBe(0);
    expect(fillDisplayTotal({ type: 'fill' })).toBe(0);
    expect(fillDisplayTotal(null)).toBe(0);
  });

  it('never produces the -0.00 the dashboard used to render', () => {
    // `Math.abs(it.amount || 0)` on a fill gave 0 and a minus sign.
    const row = forecastAllFills([], [selfScheduled], accts, envs, new Date(2026, 9, 15), '2026-11-30')[0];
    expect(row.amount).toBeUndefined();
    expect(fillDisplayTotal(row)).toBe(500);
  });
});

describe('fillSetLineCount', () => {
  it('counts the lines the display total leaves out, so the UI can say they exist', () => {
    const mixed = { type: 'fill', lines: [
      { envelope_id: 'a', amount: 100 },
      { envelope_id: 'b', amount: 250, mode: 'set' },
      { envelope_id: 'c', amount: 40, mode: 'set' },
    ] };
    expect(fillDisplayTotal(mixed)).toBe(100);
    expect(fillSetLineCount(mixed)).toBe(2);
    expect(fillSetLineCount({ type: 'fill', lines: [{ envelope_id: 'a', amount: 5 }] })).toBe(0);
    expect(fillSetLineCount({ type: 'expense', amount: 5 })).toBe(0);
    expect(fillSetLineCount(null)).toBe(0);
  });
});
