// Regression guard for the 2026-09-24 set-mode forecast work: a budget with no
// set-mode TEMPLATE line must project exactly as it did before — every
// envelope's walk, fill source, recommendations, and the Forecast lens
// balances. Refreshed 2026-10-07 for historical account shares and daily
// undated spending (including partial final months), and 2026-10-08 for the
// newly fictional example fixture (synthetic baselines unchanged). See
// `_no-set-golden.js` for the fixtures and how to regenerate it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { snapshot, GOLDEN_PATH } from './_no-set-golden.js';

describe('forecast without set-mode template lines', () => {
  // Projects every fixture budget: past the 5 s default under full-suite load.
  it('matches the reviewed forecast baseline on the example and synthetic budgets', { timeout: 20000 }, () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    const now = snapshot();
    expect(Object.keys(now)).toEqual(Object.keys(golden));
    for (const key of Object.keys(golden)) {
      expect(now[key], key).toEqual(golden[key]);
    }
  });
});
