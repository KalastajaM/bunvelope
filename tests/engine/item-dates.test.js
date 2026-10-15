import { describe, it, expect } from 'vitest';
import { itemStartMonth, itemEndMonth, itemDateBounds, itemDateStatus, planItemsAsOf } from '../../js/engine/item-dates.js';

const ALL = Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => [m, true]));
const oct2026 = new Date(2026, 9, 2);
const item = (extra) => ({ id: 'x', kind: 'expense', default_amount: -100, monthly_schedule: { ...ALL }, extra_buffer: 0, ...extra });

describe('item bounds', () => {
  it('reads start/end, falling back to the month of as_schedule_until', () => {
    expect(itemStartMonth(item({ start_month: '2026-10' }))).toBe('2026-10');
    expect(itemEndMonth(item({ as_schedule_until: '2026-10-31' }))).toBe('2026-10');
    expect(itemEndMonth(item({ end_month: '2026-12', as_schedule_until: '2026-10-31' }))).toBe('2026-12');
    expect(itemStartMonth(item({ start_month: 'bad' }))).toBe(null);
  });
  it('turns months into walker dates', () => {
    expect(itemDateBounds(item({ start_month: '2026-10', end_month: '2027-02' }))).toEqual({ since: '2026-10-01', until: '2027-02-28' });
    expect(itemDateBounds(item({}))).toEqual({ since: null, until: null });
    expect(itemDateBounds(item({ as_schedule_until: '2026-10-15' }))).toEqual({ since: null, until: '2026-10-15' });
    expect(itemDateBounds(item({ end_month: '2026-12', as_schedule_until: '2026-10-15' })).until).toBe('2026-12-31');
  });
});

describe('itemDateStatus', () => {
  it('is ended after the end month, upcoming before the start month, else active', () => {
    expect(itemDateStatus(item({ end_month: '2026-09' }), oct2026).status).toBe('ended');
    expect(itemDateStatus(item({ end_month: '2026-10' }), oct2026).status).toBe('active');
    expect(itemDateStatus(item({ start_month: '2026-11' }), oct2026).status).toBe('upcoming');
    expect(itemDateStatus(item({ start_month: '2026-10' }), oct2026).status).toBe('active');
  });
  it('needs a clock', () => {
    expect(() => itemDateStatus(item({}), undefined)).toThrow(TypeError);
  });
});

describe('planItemsAsOf', () => {
  const on = (it) => Object.entries(it.monthly_schedule).filter(([, v]) => v !== false).map(([m]) => m);
  it('returns undated items by reference', () => {
    const a = item({});
    expect(planItemsAsOf([a], oct2026)[0]).toBe(a);
  });
  it('keeps the months inside the dates within the 12 months from refDate', () => {
    const [tomas] = planItemsAsOf([item({ end_month: '2026-12' })], oct2026);
    expect(on(tomas)).toEqual(['Oct', 'Nov', 'Dec']);
    const [starware] = planItemsAsOf([item({ start_month: '2026-10' })], oct2026);
    expect(on(starware)).toHaveLength(12);
    const [late] = planItemsAsOf([item({ start_month: '2027-03' })], oct2026);
    expect(on(late)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  });
  it('rolls the window across the year end', () => {
    const [x] = planItemsAsOf([item({ start_month: '2027-01', end_month: '2027-01' })], new Date(2026, 11, 15));
    expect(on(x)).toEqual(['Jan']);
  });
  it('zeroes the buffer of an item with no month left', () => {
    const [ended] = planItemsAsOf([item({ end_month: '2026-09', extra_buffer: 300 })], oct2026);
    expect(on(ended)).toEqual([]);
    expect(ended.extra_buffer).toBe(0);
  });
  it('does not mutate the stored item and keeps months already off', () => {
    const a = item({ end_month: '2026-12', monthly_schedule: { ...ALL, Nov: false } });
    const [v] = planItemsAsOf([a], oct2026);
    expect(on(v)).toEqual(['Oct', 'Dec']);
    expect(a.monthly_schedule.Jan).toBe(true);
  });
  it('needs a clock', () => {
    expect(() => planItemsAsOf([item({})], null)).toThrow(TypeError);
  });
});
