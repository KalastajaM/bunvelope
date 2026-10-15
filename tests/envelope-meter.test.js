import { describe, it, expect } from 'vitest';
import { envelopeMeterState } from '../js/ui/envelope-meter.js';

describe('envelopeMeterState', () => {
  it('Car Charging: funded balance but short and over plan is not "funded"', () => {
    const s = envelopeMeterState({ balance: 80, planned: 75, spent: 81.61, spare: { spare: -50 } });
    expect(s.isFunded).toBe(false);
    expect(s.overPlan).toBe(true);
    expect(s.meterPct).toBe(100);
  });

  it('the meter shows spent against plan, even when the envelope is funded', () => {
    const s = envelopeMeterState({ balance: 200, planned: 100, spent: 30, spare: { spare: 70 } });
    expect(s.isFunded).toBe(true);
    expect(s.meterPct).toBe(30);
  });

  it('short without overspending is not funded either', () => {
    expect(envelopeMeterState({ balance: 120, planned: 100, spent: 10, spare: { spare: -5 } }).isFunded).toBe(false);
  });

  it('keeps over and tight as before', () => {
    expect(envelopeMeterState({ balance: -10, planned: 100, spent: 50 }).isOver).toBe(true);
    expect(envelopeMeterState({ balance: -10, planned: 100, spent: 50, balanceCovered: true }).isOver).toBe(false);
    expect(envelopeMeterState({ balance: 10, planned: 100, spent: 90 }).isTight).toBe(true);
  });

  it('overspent is one state whatever the balance: never also tight', () => {
    // €400 of €100 spent with an empty envelope, and €500 of €201 with money left.
    const empty = envelopeMeterState({ balance: 0, planned: 100, spent: 400 });
    const left = envelopeMeterState({ balance: 500, planned: 201, spent: 500 });
    for (const s of [empty, left]) {
      expect(s).toMatchObject({ overPlan: true, isTight: false, isFunded: false, meterPct: 100 });
    }
  });

  it('without a spent figure it falls back to plan minus balance', () => {
    expect(envelopeMeterState({ balance: 40, planned: 100 }).meterPct).toBe(60);
  });
  it('measures spend against the month\'s own plan when given, and tight/funded against the average', () => {
    // Allowance Boys: 200 paid as planned in a month that plans 200, 33.33 on average.
    const s = envelopeMeterState({ balance: 400, planned: 33.33, monthPlanned: 200, spent: 200, spare: { spare: 400 } });
    expect(s.overPlan).toBe(false);
    expect(s.meterPct).toBe(100);
    expect(s.isFunded).toBe(true);
    // A month that plans nothing: spending is not "over plan", the meter is empty.
    const none = envelopeMeterState({ balance: 400, planned: 33.33, monthPlanned: 0, spent: 50 });
    expect(none).toMatchObject({ overPlan: false, meterPct: 0 });
    // Without monthPlanned, the average still decides (older callers).
    expect(envelopeMeterState({ balance: 400, planned: 33.33, spent: 200 }).overPlan).toBe(true);
  });
});
