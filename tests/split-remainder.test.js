import { describe, it, expect } from 'vitest';
import { remainderTarget } from '../js/ui/split-remainder.js';

const L = (value, auto = false) => ({ value, auto });

describe('remainderTarget (UX 2026-10-05)', () => {
  it('the single empty line takes the remainder', () => {
    expect(remainderTarget([L('60'), L('')], 0)).toBe(1);
    expect(remainderTarget([L(''), L('60'), L('5')], 1)).toBe(0);
  });

  it('with no empty line, the last other line when the form filled it', () => {
    expect(remainderTarget([L('60'), L('40', true)], 0)).toBe(1);
    expect(remainderTarget([L('100', true), L('30')], 1)).toBe(0);
    expect(remainderTarget([L('60'), L('40')], 0)).toBe(-1);
  });

  it('nothing when two lines are empty, or there is no other line', () => {
    expect(remainderTarget([L('60'), L(''), L(' ')], 0)).toBe(-1);
    expect(remainderTarget([L('60')], 0)).toBe(-1);
  });
});
