// `sinceOnSave`: the `as_schedule_since` a plan-item save writes. Shared by the
// editor sheet and the list's Enabled/Disabled chip so both save paths apply
// the same restart rules.

import { describe, it, expect } from 'vitest';
import { sinceOnSave } from '../js/core/plan-item-rules.js';

const TODAY = '2026-09-28';
const prev = {
  kind: 'expense', as_schedule: true, as_schedule_since: '2026-01-01', include: true,
};

describe('sinceOnSave', () => {
  it('is null when the item does not post on a schedule', () => {
    expect(sinceOnSave({ prevItem: prev, nextInclude: true, nextKind: 'expense', asSchedule: false, today: TODAY }))
      .toBeNull();
  });

  it('starts today for a new item', () => {
    expect(sinceOnSave({ prevItem: null, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe(TODAY);
  });

  it('starts today when scheduling is switched on', () => {
    const planned = { ...prev, as_schedule: false, as_schedule_since: null };
    expect(sinceOnSave({ prevItem: planned, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe(TODAY);
  });

  it('keeps the existing date for an unchanged scheduled item', () => {
    expect(sinceOnSave({ prevItem: prev, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe('2026-01-01');
  });

  it('falls back to today when a scheduled item has no date yet', () => {
    const noSince = { ...prev, as_schedule_since: null };
    expect(sinceOnSave({ prevItem: noSince, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe(TODAY);
  });

  it('restarts today when the kind changes', () => {
    expect(sinceOnSave({ prevItem: prev, nextInclude: true, nextKind: 'income', asSchedule: true, today: TODAY }))
      .toBe(TODAY);
  });

  it('restarts today when a disabled item is enabled again (no backfill)', () => {
    const off = { ...prev, include: false };
    expect(sinceOnSave({ prevItem: off, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe(TODAY);
  });

  it('keeps the date when an item is disabled, or stays disabled', () => {
    expect(sinceOnSave({ prevItem: prev, nextInclude: false, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe('2026-01-01');
    const off = { ...prev, include: false };
    expect(sinceOnSave({ prevItem: off, nextInclude: false, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe('2026-01-01');
  });

  it('does not treat a legacy item without `include` as re-enabled', () => {
    const legacy = { ...prev };
    delete legacy.include;
    expect(sinceOnSave({ prevItem: legacy, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }))
      .toBe('2026-01-01');
  });
});
