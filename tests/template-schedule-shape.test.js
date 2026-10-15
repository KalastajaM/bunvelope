// The load-time normalizer and the bundle validator for a template's
// `schedule` block. A self-scheduled template posts real fills, so a
// half-formed schedule from a hand-edited JSON file must not reach the
// occurrence walker — dropping it means the template simply doesn't fire.

import { describe, it, expect } from 'vitest';
import { normalizeTemplates } from '../js/state/normalize-templates.js';
import { validateCollection } from '../js/storage/validators.js';

const wellFormed = {
  enabled: true,
  payment_day: 1,
  day_type: 'next_work_day',
  since: '2026-10-01',
  months: { Oct: true, Nov: true, Dec: true },
  skipped: ['2026-12'],
};

const withSchedule = schedule => [{ id: 'tpl1', name: 'T', kind: 'manual', lines: [], schedule }];

describe('normalizeTemplates — schedule', () => {
  it('passes a well-formed schedule through intact', () => {
    expect(normalizeTemplates(withSchedule(wellFormed))[0].schedule).toEqual(wellFormed);
  });

  it('leaves templates without a schedule untouched', () => {
    const out = normalizeTemplates([{ id: 'tpl1', name: 'T', kind: 'manual', lines: [] }]);
    expect('schedule' in out[0]).toBe(false);
  });

  it('drops a schedule with an unusable payment_day', () => {
    for (const payment_day of [0, -1, 32, 'x', null, undefined, NaN]) {
      const out = normalizeTemplates(withSchedule({ ...wellFormed, payment_day }));
      expect('schedule' in out[0], `payment_day ${payment_day}`).toBe(false);
    }
  });

  it('drops a schedule with no usable months', () => {
    expect('schedule' in normalizeTemplates(withSchedule({ ...wellFormed, months: null }))[0]).toBe(false);
    expect('schedule' in normalizeTemplates(withSchedule({ ...wellFormed, months: {} }))[0]).toBe(false);
    expect('schedule' in normalizeTemplates(withSchedule({
      ...wellFormed, months: { Oct: false, Nov: false },
    }))[0]).toBe(false);
  });

  it('coerces month values to booleans and discards unknown keys', () => {
    const out = normalizeTemplates(withSchedule({
      ...wellFormed,
      months: { Oct: 250, Nov: true, Dec: false, Smarch: true },
    }));
    expect(out[0].schedule.months).toEqual({ Oct: true, Nov: true });
  });

  it('falls back to exact for an unknown day_type', () => {
    expect(normalizeTemplates(withSchedule({ ...wellFormed, day_type: 'whenever' }))[0].schedule.day_type)
      .toBe('exact');
    expect(normalizeTemplates(withSchedule({ ...wellFormed, day_type: undefined }))[0].schedule.day_type)
      .toBe('exact');
  });

  it('drops a malformed since rather than the whole schedule', () => {
    const out = normalizeTemplates(withSchedule({ ...wellFormed, since: '01/10/2026' }));
    expect(out[0].schedule.enabled).toBe(true);
    expect('since' in out[0].schedule).toBe(false);
  });

  it('filters malformed skipped keys', () => {
    const out = normalizeTemplates(withSchedule({
      ...wellFormed, skipped: ['2026-12', 'nope', '2026-12-01', 42],
    }));
    expect(out[0].schedule.skipped).toEqual(['2026-12']);
  });

  it('keeps a disabled schedule but flags it disabled', () => {
    const out = normalizeTemplates(withSchedule({ ...wellFormed, enabled: false }));
    expect(out[0].schedule.enabled).toBe(false);
  });

  it('floors a fractional payment_day', () => {
    expect(normalizeTemplates(withSchedule({ ...wellFormed, payment_day: 5.9 }))[0].schedule.payment_day)
      .toBe(5);
  });
});

describe('validateEnvelopeTemplates — schedule', () => {
  const check = schedule => validateCollection('envelopeTemplates', withSchedule(schedule));

  it('accepts a well-formed schedule', () => {
    expect(check(wellFormed).ok).toBe(true);
  });

  it('accepts a template with no schedule at all', () => {
    expect(validateCollection('envelopeTemplates', [{ id: 'tpl1' }]).ok).toBe(true);
  });

  it('flags each malformed field', () => {
    expect(check({ ...wellFormed, enabled: 'yes' }).errors.some(e => e.includes('enabled'))).toBe(true);
    expect(check({ ...wellFormed, payment_day: 44 }).errors.some(e => e.includes('payment_day'))).toBe(true);
    expect(check({ ...wellFormed, day_type: 'whenever' }).errors.some(e => e.includes('day_type'))).toBe(true);
    expect(check({ ...wellFormed, since: '2026' }).errors.some(e => e.includes('since'))).toBe(true);
    expect(check({ ...wellFormed, months: [] }).errors.some(e => e.includes('months'))).toBe(true);
    expect(check({ ...wellFormed, skipped: '2026-12' }).errors.some(e => e.includes('skipped'))).toBe(true);
  });

  it('flags a non-boolean month value and an unknown month key', () => {
    const r = check({ ...wellFormed, months: { Oct: 250, Smarch: true } });
    expect(r.errors.some(e => e.includes('months.Oct'))).toBe(true);
    expect(r.errors.some(e => e.includes('Smarch'))).toBe(true);
  });

  it('flags a malformed skipped entry by index', () => {
    const r = check({ ...wellFormed, skipped: ['2026-12', 'nope'] });
    expect(r.errors.some(e => e.includes('skipped[1]'))).toBe(true);
  });
});
