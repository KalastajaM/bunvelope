// The type-to-filter combobox's up/down positioning decision.
import { describe, it, expect } from 'vitest';
import { shouldOpenUpward } from '../js/ui/select-combobox.js';

describe('shouldOpenUpward', () => {
  it('stays down when there is enough room below', () => {
    expect(shouldOpenUpward(100, 300, 280)).toBe(false);
  });

  it('flips up when there is not enough room below but more room above', () => {
    expect(shouldOpenUpward(300, 100, 280)).toBe(true);
  });

  it('stays down when neither side has enough room but above is no better', () => {
    expect(shouldOpenUpward(50, 100, 280)).toBe(false);
  });

  it('stays down when space below exactly meets what is needed', () => {
    expect(shouldOpenUpward(300, 280, 280)).toBe(false);
  });
});
