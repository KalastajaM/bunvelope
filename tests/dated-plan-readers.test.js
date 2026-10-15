// tests/dated-plan-readers.test.js — every plain plan reader is fed the dated
// plan.
//
// The readers below sum a plan item's twelve months as "a year" and take no
// date. A caller that hands them `state.budgetItems` directly ignores the
// items' start and end months, and an item that ended still counts in full.
// So every file outside the engine that calls one must also use the dated
// view (`datedPlanItems` from js/app.js, or the engine's `planItemsAsOf`, or
// `planItemsForDynamicFill` for what a dynamic template fills from).
// A new call site fails here until its author decides which items it reads.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const READERS = [
  'computeAnnual', 'computeAnnualTotals', 'buildExpenseCalendar', 'computeMonthlyPlanByEnvelope',
  'aggregateBudgetAllocation', 'annualAmount', 'adjustedAnnual', 'resolveTemplateLines', 'itemsWithFlatLadder',
  'buildPlanFlow',
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('plain plan readers read the dated plan', () => {
  const files = walk(join(ROOT, 'js'))
    .map(p => relative(ROOT, p))
    .filter(p => !p.startsWith('js/engine/') && p !== 'js/engine.js');
  const callers = files.filter(p => {
    const src = readFileSync(join(ROOT, p), 'utf8');
    return READERS.some(r => new RegExp(`\\b${r}\\(`).test(src));
  });

  it('finds the callers (the scan works)', () => {
    expect(callers).toContain('js/core/queries/plan-items.js');
  });

  it('every caller uses datedPlanItems or planItemsAsOf', () => {
    const undated = callers.filter(p => !/\b(datedPlanItems|planItemsAsOf|planItemsForDynamicFill)\b/.test(readFileSync(join(ROOT, p), 'utf8')));
    expect(undated).toEqual([]);
  });
});
