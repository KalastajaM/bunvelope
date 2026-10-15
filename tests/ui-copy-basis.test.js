// @vitest-environment jsdom
// User-facing wording: the Unallocated alert names its basis (the forecast
// walk), so "below 0 now" does not contradict the lens figure beside it; the
// data-check dialog is "Things to check", not developer wording.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { alertText } from '../js/pages/net-worth-simulation.js';
import { _DICTS_FOR_TEST, loadLocale } from '../js/ui/i18n.js';

describe('Unallocated alert', () => {
  it('says it is the forecast figure', () => {
    const text = alertText(
      { kind: 'unallocated-negative', id: null, firstDate: '2026-10-05', low: -1200, lowDate: '2026-11-01' },
      { accounts: [], envelopes: [], todayIso: '2026-10-05' },
    );
    expect(text.startsWith('Forecast Unallocated below 0 now')).toBe(true);
  });
});

describe('data-check dialog wording', () => {
  it('is titled "Things to check" in every locale, with no schema/invariant jargon', async () => {
    await loadLocale('fi');
    await loadLocale('nl');
    expect(_DICTS_FOR_TEST.en.invariants.dialogTitle).toBe('Things to check');
    for (const lang of ['en', 'fi', 'nl']) {
      const inv = _DICTS_FOR_TEST[lang].invariants;
      for (const key of ['dialogTitle', 'badgeHint', 'allClear', 'problemUnknown']) {
        expect(inv[key]).not.toMatch(/schema|invariant|skeema|rajoite/i);
      }
    }
  });
});
