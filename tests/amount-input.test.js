import { describe, it, expect } from 'vitest';
import { evalExpression, evalPercent, looksLikeFormula, looksLikePercentage, parseAmountInput } from '../js/ui/amount-input.js';

describe('parseAmountInput', () => {
  it('accepts comma as decimal separator (the split-editor regression)', () => {
    // parseFloat('50,34') silently truncates to 50; the live split handlers
    // (clamp, auto-add-remaining, validation sums) run before the blur-time
    // normalization and used to corrupt "50,34" into "50.00".
    expect(parseAmountInput('50,34')).toBe(50.34);
    expect(parseAmountInput('0,5')).toBe(0.5);
    expect(parseAmountInput('-5,5')).toBe(-5.5);
  });

  it('reads dot decimals and integers unchanged', () => {
    expect(parseAmountInput('50.34')).toBe(50.34);
    expect(parseAmountInput('50')).toBe(50);
  });

  it('preserves high-precision values (units / price-per-unit fields)', () => {
    expect(parseAmountInput('0,123456')).toBe(0.123456);
    expect(parseAmountInput('123.45678')).toBe(123.45678);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseAmountInput(' 50,34 ')).toBe(50.34);
  });

  it('stays as lenient as parseFloat on partial mid-typing input', () => {
    expect(parseAmountInput('50,')).toBe(50);
    expect(parseAmountInput('50.')).toBe(50);
  });

  it('passes finite numbers through', () => {
    expect(parseAmountInput(50.34)).toBe(50.34);
    expect(parseAmountInput(NaN)).toBeNaN();
    expect(parseAmountInput(Infinity)).toBeNaN();
  });

  it('returns NaN when no number can be read', () => {
    expect(parseAmountInput('')).toBeNaN();
    expect(parseAmountInput('abc')).toBeNaN();
    expect(parseAmountInput(null)).toBeNaN();
    expect(parseAmountInput(undefined)).toBeNaN();
  });

  it('reads a grouped amount — the app prints them, users paste them back', () => {
    // fi-FI groups with U+00A0. Pasting "€ 1 234,56" back into a field used
    // to read 1: parseFloat stopped at the space.
    expect(parseAmountInput('1\u00a0234,56')).toBe(1234.56);
    expect(parseAmountInput('€ 1\u00a0234,56')).toBe(1234.56);
    expect(parseAmountInput('1 234,56 €')).toBe(1234.56);
  });

  it('reads the minus sign the app prints (U+2212), not just the hyphen', () => {
    expect(parseAmountInput('−1 234,56')).toBe(-1234.56);
  });

  it('lets the last separator decide the decimal point when both appear', () => {
    expect(parseAmountInput('1,234.56')).toBe(1234.56); // en-US
    expect(parseAmountInput('1.234,56')).toBe(1234.56); // nl-NL / de-DE
  });

  it('treats a repeated separator as grouping', () => {
    expect(parseAmountInput('1.234.567')).toBe(1234567);
    expect(parseAmountInput('1,234,567')).toBe(1234567);
  });

  it('leaves the one genuinely ambiguous case alone', () => {
    // "1,234" is 1.234 to a Finn and 1234 to an American. It has always
    // meant the former here; nothing in the input says otherwise.
    expect(parseAmountInput('1,234')).toBe(1.234);
  });

  it('supports the `|| 0` call-site pattern', () => {
    expect(parseAmountInput('50,34') || 0).toBe(50.34);
    expect(parseAmountInput('') || 0).toBe(0);
  });
});

describe('evalExpression', () => {
  it('evaluates basic arithmetic', () => {
    expect(evalExpression('1000-750')).toBe(250);
    expect(evalExpression('1+2+3')).toBe(6);
    expect(evalExpression('10*5')).toBe(50);
    expect(evalExpression('100/4')).toBe(25);
  });

  it('respects operator precedence', () => {
    expect(evalExpression('2+3*4')).toBe(14);
    expect(evalExpression('20-4/2')).toBe(18);
  });

  it('handles parentheses', () => {
    expect(evalExpression('(2+3)*4')).toBe(20);
    expect(evalExpression('100/(2+3)')).toBe(20);
  });

  it('handles unary minus and plus', () => {
    expect(evalExpression('-5')).toBe(-5);
    expect(evalExpression('-(2+3)')).toBe(-5);
    expect(evalExpression('10+-3')).toBe(7);
    expect(evalExpression('+5')).toBe(5);
  });

  it('handles decimals', () => {
    expect(evalExpression('1.5+2.5')).toBe(4);
    expect(evalExpression('0.1*10')).toBeCloseTo(1, 10);
  });

  it('handles whitespace', () => {
    expect(evalExpression('  1000 - 750  ')).toBe(250);
    expect(evalExpression('( 2 + 3 ) * 4')).toBe(20);
  });

  it('throws on malformed input', () => {
    expect(() => evalExpression('1+')).toThrow();
    expect(() => evalExpression('(1+2')).toThrow();
    expect(() => evalExpression('1 2')).toThrow();
    expect(() => evalExpression('')).toThrow();
  });
});

describe('looksLikeFormula', () => {
  it('detects expressions with operators', () => {
    expect(looksLikeFormula('1000-750')).toBe(true);
    expect(looksLikeFormula('5*2')).toBe(true);
    expect(looksLikeFormula('1+2')).toBe(true);
  });

  it('treats leading minus as a sign, not a formula', () => {
    expect(looksLikeFormula('-5')).toBe(false);
    expect(looksLikeFormula('-12.34')).toBe(false);
  });

  it('returns false for plain numbers and empty input', () => {
    expect(looksLikeFormula('100')).toBe(false);
    expect(looksLikeFormula('12.34')).toBe(false);
    expect(looksLikeFormula('')).toBe(false);
    expect(looksLikeFormula(null)).toBe(false);
  });
});

describe('evalPercent', () => {
  it('converts a plain percentage of the base', () => {
    expect(evalPercent('50%', 100)).toBe(50);
    expect(evalPercent('100%', 80)).toBe(80);
    expect(evalPercent('25%', 80)).toBe(20);
  });

  it('uses the base as "remaining" (caller-supplied)', () => {
    // Mirrors the user's spec: total €100, one row already at €50, second row
    // typed as "50%" → 50% of remaining 50 = 25.
    expect(evalPercent('50%', 50)).toBe(25);
  });

  it('accepts comma as decimal separator', () => {
    expect(evalPercent('50,5%', 100)).toBe(50.5);
  });

  it('tolerates surrounding whitespace and spaces around %', () => {
    expect(evalPercent(' 25 % ', 80)).toBe(20);
  });

  it('rounds to 2dp', () => {
    expect(evalPercent('33.333%', 100)).toBe(33.33);
  });

  it('returns the raw computed value when >100% — caller clamps', () => {
    expect(evalPercent('150%', 50)).toBe(75);
  });

  it('preserves the sign of negative percentages', () => {
    expect(evalPercent('-50%', 100)).toBe(-50);
  });

  it('returns null when the syntax does not match', () => {
    expect(evalPercent('50', 100)).toBeNull();
    expect(evalPercent('', 100)).toBeNull();
    expect(evalPercent('50%50', 100)).toBeNull();
    expect(evalPercent('abc%', 100)).toBeNull();
    expect(evalPercent('%50', 100)).toBeNull();
  });

  it('returns null for non-positive or non-finite base', () => {
    expect(evalPercent('50%', 0)).toBeNull();
    expect(evalPercent('50%', -10)).toBeNull();
    expect(evalPercent('50%', NaN)).toBeNull();
    expect(evalPercent('50%', Infinity)).toBeNull();
  });

  it('returns null for non-string raw input', () => {
    expect(evalPercent(50, 100)).toBeNull();
    expect(evalPercent(null, 100)).toBeNull();
    expect(evalPercent(undefined, 100)).toBeNull();
  });
});

describe('looksLikePercentage', () => {
  it('matches strings with a trailing percent sign', () => {
    expect(looksLikePercentage('50%')).toBe(true);
    expect(looksLikePercentage(' 50 % ')).toBe(true);
    expect(looksLikePercentage('50,5%')).toBe(true);
    expect(looksLikePercentage('-50%')).toBe(true);
  });

  it('rejects strings that do not match the syntax', () => {
    expect(looksLikePercentage('50')).toBe(false);
    expect(looksLikePercentage('50%50')).toBe(false);
    expect(looksLikePercentage('%50')).toBe(false);
    expect(looksLikePercentage('')).toBe(false);
    expect(looksLikePercentage(null)).toBe(false);
    expect(looksLikePercentage(undefined)).toBe(false);
  });
});


describe('strict amount submission parsing', () => {
  it.each(['12oops', '12+oops', '', 'Infinity', '2/'])('refuses a partial number: %s', raw => {
    expect(parseAmountInput(raw, { strict: true })).toBeNaN();
  });
  it('keeps grouped and localized pasted values while leaving live parsing lenient', () => {
    expect(parseAmountInput('€ 1 234,56', { strict: true })).toBe(1234.56);
    expect(parseAmountInput('1,234.56', { strict: true })).toBe(1234.56);
    expect(parseAmountInput('−15,25', { strict: true })).toBe(-15.25);
    expect(parseAmountInput('12oops')).toBe(12);
  });
});
