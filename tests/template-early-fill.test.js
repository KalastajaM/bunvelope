// "Fill now" on a scheduled template, run as the next scheduled fill early:
// the occurrence it replaces is found, skipped via `schedule.skipped`, and the
// materialiser then leaves that month alone, so the envelopes fill once.

import { describe, it, expect } from 'vitest';
import { materializeDueTemplateFills, forecastTemplateFills, templateFillKey } from '../js/engine.js';
import { nextPendingTemplateFill } from '../js/core/template-pending.js';
import { withSkippedMonth } from '../js/core/entity-fields.js';

const envs = [
  { id: 'e1', name: 'Groceries' },
  { id: 'e2', name: 'Transport' },
  { id: 'buf', name: 'Buffer' },
];

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const tpl = over => ({
  id: 'tpl1',
  name: 'Payday split',
  kind: 'manual',
  lines: [
    { envelope_id: 'e1', mode: 'add', amount: 300 },
    { envelope_id: 'e2', mode: 'add', amount: 200 },
  ],
  schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-01-01', months: allMonths },
  ...over,
});

const today = new Date(2026, 8, 10); // 2026-09-10

describe('nextPendingTemplateFill', () => {
  it('finds the next occurrence of a scheduled template', () => {
    expect(nextPendingTemplateFill(tpl(), { envelopes: envs, today }))
      .toEqual({ date: '2026-09-25', monthKey: '2026-09' });
  });

  it('is null for a template without a schedule', () => {
    expect(nextPendingTemplateFill(tpl({ schedule: undefined }), { envelopes: envs, today })).toBeNull();
    expect(nextPendingTemplateFill(tpl({ schedule: { ...tpl().schedule, enabled: false } }), { envelopes: envs, today }))
      .toBeNull();
  });

  it('is null once the schedule has ended', () => {
    const ended = tpl({ schedule: { ...tpl().schedule, until: '2026-08-31' } });
    expect(nextPendingTemplateFill(ended, { envelopes: envs, today })).toBeNull();
  });

  it('passes over an occurrence already skipped, posted or deleted', () => {
    const skipped = withSkippedMonth(tpl(), '2026-09');
    expect(nextPendingTemplateFill(skipped, { envelopes: envs, today })?.monthKey).toBe('2026-10');

    const posted = [{ id: 'x', type: 'fill', date: '2026-09-25', from_budget: templateFillKey('tpl1', '2026-09') }];
    expect(nextPendingTemplateFill(tpl(), { envelopes: envs, transactions: posted, today })?.monthKey).toBe('2026-10');

    const tombstones = [templateFillKey('tpl1', '2026-09')];
    expect(nextPendingTemplateFill(tpl(), { envelopes: envs, tombstones, today })?.monthKey).toBe('2026-10');
  });

  it('reaches a year ahead for a template active in one month only', () => {
    const yearly = tpl({ schedule: { ...tpl().schedule, payment_day: 5, months: { Sep: true } } });
    expect(nextPendingTemplateFill(yearly, { envelopes: envs, today })?.date).toBe('2027-09-05');
  });
});

describe('run early, then the schedule', () => {
  it('the skipped month does not materialise, the one after does', () => {
    const skipped = withSkippedMonth(tpl(), '2026-09');
    const { newTxs } = materializeDueTemplateFills(
      [skipped], [], envs, [], new Date(2026, 9, 26), () => 'id',
    );
    const months = newTxs.map(tx => tx.from_budget);
    expect(months).not.toContain(templateFillKey('tpl1', '2026-09'));
    expect(months).toContain(templateFillKey('tpl1', '2026-10'));
  });

  it('the skipped month drops out of the forecast', () => {
    const rows = forecastTemplateFills([withSkippedMonth(tpl(), '2026-09')], [], envs, today, '2026-10-31');
    expect(rows.map(r => r.forecast_month_key)).toEqual(['2026-10']);
  });
});

describe('withSkippedMonth', () => {
  it('adds the month once, keeps earlier skips, and leaves the input alone', () => {
    const base = tpl({ schedule: { ...tpl().schedule, skipped: ['2026-12'] } });
    const out = withSkippedMonth(withSkippedMonth(base, '2026-09'), '2026-09');
    expect(out.schedule.skipped).toEqual(['2026-09', '2026-12']);
    expect(out.schedule.payment_day).toBe(25);
    expect(base.schedule.skipped).toEqual(['2026-12']);
  });
});
