import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { stressCutPct } from '../js/engine/stress.js';

it('the example budget models partial cuts as fractions, not total removal', () => {
  const items = JSON.parse(readFileSync(new URL('../budgets/example-project/budget-items.json', import.meta.url), 'utf8'));
  // Assign a supported scenario category to exercise the stored percentage.
  expect(stressCutPct({ ...items.find(x => x.id === 'item-groceries'), stress_category: 'A' }, 'A')).toBe(0.15);
  expect(stressCutPct({ ...items.find(x => x.id === 'item-transport'), stress_category: 'A' }, 'A')).toBe(0.25);
  for (const item of items) {
    expect(item.stress_cut_pct).toBeGreaterThanOrEqual(0);
    expect(item.stress_cut_pct).toBeLessThanOrEqual(1);
  }
});
