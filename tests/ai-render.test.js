// tests/ai-render.test.js — the app, not the model, formats money in AI prose.
//
// The model writes ⟦amt:123.45⟧ tokens; formatAiText swaps each for fmt(number)
// so currency, symbol and grouping follow the budget's locale. Plain text
// passes through, and a malformed token never shows its brackets.

import { describe, it, expect, beforeEach } from 'vitest';
import { setFormatDefaults, fmt } from '../js/utils.js';
import { formatAiText, bareAiNumbers, createAiStreamText } from '../js/ai/money-text.js';

beforeEach(() => setFormatDefaults({ currency: 'EUR', locale: 'fi-FI' }));

describe('formatAiText', () => {
  it('formats a token with the budget currency (EUR)', () => {
    expect(formatAiText('Spent ⟦amt:1234.5⟧ on food')).toBe(`Spent ${fmt(1234.5)} on food`);
    expect(fmt(1234.5)).toContain('€');
  });

  it('follows the budget currency and locale (USD)', () => {
    setFormatDefaults({ currency: 'USD', locale: 'en-US' });
    const out = formatAiText('Rent is ⟦amt:1234.5⟧.');
    expect(out).toBe(`Rent is ${fmt(1234.5)}.`);
    expect(out).toContain('$');
    expect(out).toContain('1,234.50');
  });

  it('formats several tokens in one string', () => {
    expect(formatAiText('⟦amt:10⟧ of ⟦amt:20.25⟧')).toBe(`${fmt(10)} of ${fmt(20.25)}`);
  });

  it('formats negatives with the app minus', () => {
    const out = formatAiText('Over by ⟦amt:-45.5⟧');
    expect(out).toBe(`Over by ${fmt(-45.5)}`);
    expect(out).toContain('−');
    expect(formatAiText('⟦amt:−3⟧')).toBe(fmt(-3));
  });

  it('accepts the number shapes a model plausibly writes', () => {
    expect(formatAiText('⟦amt:1234.56⟧')).toBe(fmt(1234.56));
    expect(formatAiText('⟦amt:1,234.56⟧')).toBe(fmt(1234.56));
    expect(formatAiText('⟦amt:1,234⟧')).toBe(fmt(1234));
    expect(formatAiText('⟦amt:1.234,56⟧')).toBe(fmt(1234.56));
    expect(formatAiText('⟦amt:1 234,56⟧')).toBe(fmt(1234.56));
    expect(formatAiText('⟦amt:1 234,56⟧')).toBe(fmt(1234.56));
    expect(formatAiText('⟦amt:1234,56⟧')).toBe(fmt(1234.56));
    expect(formatAiText('⟦amt:12,5⟧')).toBe(fmt(12.5));
    expect(formatAiText('⟦amt:1,23⟧')).toBe(fmt(1.23));
    expect(formatAiText('⟦amt: 12 ⟧')).toBe(fmt(12));
    expect(formatAiText('⟦amt:12.345.678,9⟧')).toBe(fmt(12345678.9));
  });

  it('accepts one currency symbol or code and a minus before the digits', () => {
    expect(formatAiText('⟦amt:€-40⟧')).toBe(fmt(-40));
    expect(formatAiText('⟦amt:-€40⟧')).toBe(fmt(-40));
    expect(formatAiText('⟦amt:EUR -40⟧')).toBe(fmt(-40));
    expect(formatAiText('⟦amt:$ 12.5⟧')).toBe(fmt(12.5));
    expect(formatAiText('⟦amt:USD 1,234.50⟧')).toBe(fmt(1234.5));
    expect(formatAiText('⟦amt:- 40⟧')).toBe(fmt(-40));
  });

  it('drops a token it cannot read exactly rather than show a wrong amount', () => {
    const bad = [
      '1e3', '1e999', '1.5k', '2m', '12abc', '12 34', '1,2345', '1.234,567', '1.2345',
      '1,234.567', '12.', '.5', '--5', '€ EUR 5', '5-', '40 €', '+5', '1 23', '1,23,45', 'NaN', 'Infinity',
    ];
    for (const b of bad) {
      expect(formatAiText(`a ⟦amt:${b}⟧ b`), b).toBe('a b');
    }
  });

  it('the exponent case that overflows is dropped, not shown as 1', () => {
    expect(formatAiText('x ⟦amt:1e999⟧ y')).toBe('x y');
    expect(formatAiText('x ⟦amt:1e999⟧ y')).not.toContain(fmt(1));
  });

  it('matches the tag case-insensitively and accepts "amount"', () => {
    expect(formatAiText('⟦AMT:12⟧')).toBe(fmt(12));
    expect(formatAiText('⟦Amt:12⟧')).toBe(fmt(12));
    expect(formatAiText('⟦amount:12⟧')).toBe(fmt(12));
    expect(formatAiText('⟦AMOUNT:-3.5⟧')).toBe(fmt(-3.5));
  });

  it('leaves plain text (no tokens) exactly as written', () => {
    const plain = 'You spent € 50,00 on food, 12 times.';
    expect(formatAiText(plain)).toBe(plain);
    expect(formatAiText('')).toBe('');
    expect(formatAiText(null)).toBe('');
    expect(formatAiText(undefined)).toBe('');
  });

  it('coerces non-strings', () => {
    expect(formatAiText(42)).toBe('42');
  });

  it('never shows brackets for a malformed token, and collapses the gap', () => {
    expect(formatAiText('a ⟦amt:abc⟧ b')).toBe('a b');
    expect(formatAiText('a ⟦amt:⟧ b')).toBe('a b');
    expect(formatAiText('a ⟦amt:abc⟧, b')).toBe('a, b');
    expect(formatAiText('⟦amt:abc⟧ b')).toBe('b');
    expect(formatAiText('total ⟦amt:12abc⟧ end')).toBe('total end');
  });

  it('resolves an unclosed token the same strict way', () => {
    expect(formatAiText('total ⟦amt:12')).toBe(`total ${fmt(12)}`);
    expect(formatAiText('total ⟦amt:12.5 and more')).toBe(`total ${fmt(12.5)} and more`);
    expect(formatAiText('total ⟦amt:1 234,56')).toBe(`total ${fmt(1234.56)}`);
    expect(formatAiText('total ⟦amt:EUR -40 left')).toBe(`total ${fmt(-40)} left`);
    // nothing of a malformed unclosed token stays visible
    expect(formatAiText('total ⟦amt:abc')).toBe('total');
    expect(formatAiText('total ⟦amt:abc and more')).toBe('total and more');
    expect(formatAiText('total ⟦amt:1e3 left')).toBe('total left');
    expect(formatAiText('total ⟦amt:')).toBe('total');
    expect(formatAiText('total ⟦am')).toBe('total am');
  });

  it('strips lone brackets without leaving a double space', () => {
    expect(formatAiText('x ⟧ y ⟦ z')).toBe('x y z');
    expect(formatAiText('x⟧y')).toBe('xy');
  });

  it('reads an unclosed token with spaces after the minus or symbol, or drops it whole', () => {
    expect(formatAiText('a ⟦amt:- 40 left')).toBe(`a ${fmt(-40)} left`);
    expect(formatAiText('a ⟦amt:-€ 40 left')).toBe(`a ${fmt(-40)} left`);
    expect(formatAiText('a ⟦amt:€ 40 left')).toBe(`a ${fmt(40)} left`);
    expect(formatAiText('a ⟦amt:€ -40 left')).toBe(`a ${fmt(-40)} left`);
    expect(formatAiText('a ⟦amt:EUR - 40 left')).toBe(`a ${fmt(-40)} left`);
    expect(formatAiText('a ⟦amt:$ 1,234.50 left')).toBe(`a ${fmt(1234.5)} left`);
    // never digits left behind
    expect(formatAiText('a ⟦amt:- 1e3 left')).toBe('a left');
    expect(formatAiText('a ⟦amt:€ 12abc left')).toBe('a left');
    // garbage before the digits: the garbage goes, the prose after it is left as written
    expect(formatAiText('a ⟦amt:and 40 left')).toBe('a 40 left');
    expect(formatAiText('a ⟦amt:USD left')).toBe('a left');
  });

  it('drops a closed token with an invalid body whole, whatever its length', () => {
    const long = 'is the amount of money that you have to pay, plus a lot of more text here';
    expect(formatAiText(`a ⟦amt:12 ${long}⟧ b`)).toBe('a b');
    expect(formatAiText(`a ⟦amt:${long} 12⟧ b`)).toBe('a b');
    expect(formatAiText(`a ⟦amt:${'9'.repeat(60)}⟧ b`)).toBe('a b');
  });

  it('drops amounts above the money cap or with lost precision', () => {
    for (const b of ['99999999999999999999', '12345678901234567.89', '1000000000000', '1,000,000,000,000.00']) {
      expect(formatAiText(`a ⟦amt:${b}⟧ b`), b).toBe('a b');
    }
    expect(formatAiText('⟦amt:999999999999.99⟧')).toBe(fmt(999999999999.99));
    expect(formatAiText('a ⟦amt:99999999999999999999 b')).toBe('a b');
  });

  it('a stray opening tag before a valid token does not swallow it', () => {
    expect(formatAiText('⟦amt:⟦amt:12⟧')).toBe(fmt(12));
    expect(formatAiText('x ⟦amt: ⟦amt:12⟧ y')).toBe(`x ${fmt(12)} y`);
    expect(formatAiText('⟦amt:abc ⟦amt:12⟧')).toBe(fmt(12));
  });

  it('never re-reads formatted output', () => {
    // a formatted amount followed by an unclosed tag: each stays independent
    expect(formatAiText('⟦amt:5⟧ and ⟦amt:7')).toBe(`${fmt(5)} and ${fmt(7)}`);
  });
});

describe('createAiStreamText', () => {
  const feed = (chunks) => {
    const s = createAiStreamText();
    const shown = [];
    for (const c of chunks) shown.push(s.push(c));
    return { s, shown, final: s.finish() };
  };

  it('formats a token split across deltas and never shows a partial one', () => {
    const chunks = ['Spent ⟦a', 'mt:12', '34.5', '⟧ on food'];
    const { shown, final, s } = feed(chunks);
    for (const text of shown) expect(text).not.toMatch(/[⟦⟧]|amt/);
    expect(shown[0]).toBe('Spent ');
    expect(shown[3]).toBe(`Spent ${fmt(1234.5)} on food`);
    expect(final).toBe(`Spent ${fmt(1234.5)} on food`);
    // the raw text (what is stored) keeps the token, unformatted
    expect(s.raw).toBe('Spent ⟦amt:1234.5⟧ on food');
  });

  it('splits at the opening bracket and at the closing bracket', () => {
    const { shown } = feed(['a ⟦', 'amt:5', '⟧', '!']);
    expect(shown).toEqual(['a ', 'a ', `a ${fmt(5)}`, `a ${fmt(5)}!`]);
  });

  it('shows a lone hold-back prefix as soon as it stops being a token', () => {
    const { shown } = feed(['a ⟦x']);
    expect(shown[0]).toBe('a x');
  });

  it('finish resolves a token that never closed', () => {
    const { shown, final } = feed(['total ⟦amt:12']);
    expect(shown[0]).toBe('total ');
    expect(final).toBe(`total ${fmt(12)}`);
  });

  it('holds back a case-variant or "amount" tag split across deltas', () => {
    const { shown, final } = feed(['a ⟦AM', 'OUNT:1', '2⟧!']);
    expect(shown).toEqual(['a ', 'a ', `a ${fmt(12)}!`]);
    expect(final).toBe(`a ${fmt(12)}!`);
  });

  it('passes plain streamed text through', () => {
    const { shown, final } = feed(['Hello ', 'there.']);
    expect(shown).toEqual(['Hello ', 'Hello there.']);
    expect(final).toBe('Hello there.');
  });
});

describe('bareAiNumbers', () => {
  it('turns a token into the bare magnitude for matched text', () => {
    expect(bareAiNumbers('coffee ⟦amt:12.5⟧')).toBe('coffee 12.50');
    expect(bareAiNumbers('⟦amt:-40⟧')).toBe('40.00');
    expect(bareAiNumbers('⟦amt:1.234,56⟧')).toBe('1234.56');
  });

  it('drops an unreadable token and leaves plain text alone', () => {
    expect(bareAiNumbers('a ⟦amt:1e3⟧ b')).toBe('a b');
    expect(bareAiNumbers('K-Market "12,50"')).toBe('K-Market "12,50"');
    expect(bareAiNumbers(undefined)).toBe('');
  });
});
