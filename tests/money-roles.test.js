// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { moneyEl } from '../js/ui/money.js';
import { fmt, setFormatDefaults, setCurrencyAfterAmount } from '../js/utils.js';
afterEach(() => { setFormatDefaults({ currency: 'EUR', locale: 'fi-FI' }); setCurrencyAfterAmount(false); });
it.each(['hero', 'summary', 'table', 'inline'])('%s preserves canonical signs, decimals, missing values and locale order', role => {
  for (const locale of ['fi-FI', 'nl-NL', 'en-US']) {
    setFormatDefaults({ currency: 'EUR', locale });
    for (const after of [false, true]) {
      setCurrencyAfterAmount(after);
      for (const value of [-123456789.12, 12.34, -0.001, 0, null, NaN]) {
        const node = moneyEl(value, { role, signed: true });
        expect(node.textContent).toBe(fmt(value, { signed: true }));
        expect(node.querySelector('.cur')).toBeNull();
      }
    }
  }
});
