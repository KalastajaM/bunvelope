// One formatter, one set of options. Both `fmt` (string) and `fmtParts`
// (split pieces, for `moneyEl`) come from js/utils.js — js/ui/money.js used
// to export a rival `fmt` whose sign option was spelled `sign`, whose NaN
// rendered as the word "NaN", and whose renderer cut the number at a
// hardcoded comma.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fmt, fmtParts, fmtNum, fmtPct, setFormatDefaults } from '../js/utils.js';

// fi-FI groups thousands with a NARROW NO-BREAK SPACE, not a plain space —
// spelling it out keeps these expectations honest about what ships.
const NB = '\u00a0';

// `moneyEl` itself is not exercised here: the suite runs in the 'node'
// environment with no DOM, and the renderer only concatenates what
// `fmtParts` hands it. The pieces it used to get wrong — where the number is
// cut, and what a non-number renders as — are pinned below.

beforeEach(() => setFormatDefaults({ currency: 'EUR', locale: 'fi-FI' }));
afterEach(() => setFormatDefaults({ currency: 'EUR', locale: 'fi-FI' }));

describe('fmt', () => {
  it('formats the canonical app style', () => {
    expect(fmt(1234.56)).toBe(`€ 1${NB}234,56`);
    expect(fmt(0)).toBe('€ 0,00');
  });

  it('uses a real minus sign, never a hyphen', () => {
    expect(fmt(-1234.5)).toBe(`€ −1${NB}234,50`);
  });

  it('adds a plus only when asked, and only to real positives', () => {
    expect(fmt(12, { signed: true })).toBe('€ +12,00');
    expect(fmt(12)).toBe('€ 12,00');
    expect(fmt(0, { signed: true })).toBe('€ 0,00');
  });

  it('does not sign an amount that rounds to zero', () => {
    // −0.004 prints as 0,00; a minus in front of it would be a lie.
    expect(fmt(-0.004)).toBe('€ 0,00');
    expect(fmt(0.004, { signed: true })).toBe('€ 0,00');
  });

  it('honours a decimals override', () => {
    expect(fmt(1234.56, { decimals: 0 })).toBe(`€ 1${NB}235`);
  });

  it('answers a dash for anything that is not a finite number', () => {
    expect(fmt(null)).toBe('—');
    expect(fmt(undefined)).toBe('—');
    expect(fmt(NaN)).toBe('—');
    expect(fmt(Infinity)).toBe('—');
    expect(fmt('')).toBe('—');
  });
});

describe('fmtParts', () => {
  it('splits at the locale decimal separator, not at a hardcoded comma', () => {
    expect(fmtParts(1234.56)).toEqual({
      currency: '€', prefix: '', whole: `1${NB}234`, frac: '56', decimal: ',',
    });
    setFormatDefaults({ currency: 'USD', locale: 'en-US' });
    const usd = fmtParts(1234.56);
    expect(usd.whole).toBe('1,234');
    expect(usd.frac).toBe('56');
    expect(usd.decimal).toBe('.');
  });

  it('has no fraction at all when decimals is 0', () => {
    const p = fmtParts(1234.56, { decimals: 0 });
    expect(p.whole).toBe(`1${NB}235`);
    expect(p.frac).toBe('');
  });

  it('is null for non-numbers, which is how fmt knows to say —', () => {
    expect(fmtParts(NaN)).toBeNull();
    expect(fmtParts(null)).toBeNull();
  });

  it('agrees with fmt, by construction', () => {
    for (const v of [0, 1, -1, 1234.56, -0.004, 999999.999]) {
      const p = fmtParts(v);
      expect(`${p.currency} ${p.prefix}${p.whole}${p.decimal}${p.frac}`).toBe(fmt(v));
    }
  });
});

// Plain numbers and percentages follow the same locale as money. Pages used
// `toFixed`, which always writes a dot, so "+13.12%" and "227.203677" sat
// next to "€ 4 000,00" on the same screen.
describe('fmtNum', () => {
  it('uses the locale separator and grouping', () => {
    expect(fmtNum(1234567)).toBe(`1${NB}234${NB}567`);
    expect(fmtNum(145.63, { decimals: 1 })).toBe('145,6');
  });

  it('keeps up to maxDecimals and drops trailing zeros', () => {
    expect(fmtNum(227.203677, { maxDecimals: 8 })).toBe('227,203677');
    expect(fmtNum(259, { maxDecimals: 8 })).toBe('259');
  });

  it('signs like fmt and renders non-numbers as a dash', () => {
    expect(fmtNum(-2.5, { decimals: 1 })).toBe('−2,5');
    expect(fmtNum(2.5, { decimals: 1, signed: true })).toBe('+2,5');
    expect(fmtNum(NaN)).toBe('—');
    expect(fmtNum(null)).toBe('—');
  });

  it('follows an en-US budget', () => {
    setFormatDefaults({ currency: 'USD', locale: 'en-US' });
    expect(fmtNum(1234.5, { decimals: 1 })).toBe('1,234.5');
  });
});

describe('fmtPct', () => {
  it('takes percent units and uses the locale style', () => {
    expect(fmtPct(13.123)).toBe(`13,1${NB}%`);
    expect(fmtPct(13.123, { decimals: 2 })).toBe(`13,12${NB}%`);
  });

  it('uses a real minus, a plus only when asked, and no sign on a rounded zero', () => {
    expect(fmtPct(-1.7)).toBe(`−1,7${NB}%`);
    expect(fmtPct(13.1, { signed: true })).toBe(`+13,1${NB}%`);
    expect(fmtPct(-0.04)).toBe(`0,0${NB}%`);
    expect(fmtPct(0.04, { signed: true })).toBe(`0,0${NB}%`);
  });

  it('follows an en-US budget and renders non-numbers as a dash', () => {
    setFormatDefaults({ currency: 'USD', locale: 'en-US' });
    expect(fmtPct(13.1, { signed: true })).toBe('+13.1%');
    expect(fmtPct(Infinity)).toBe('—');
  });
});
