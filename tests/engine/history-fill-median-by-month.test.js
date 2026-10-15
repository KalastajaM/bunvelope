// §2.8 — `fillSource: history` medianed the individual fill TRANSACTIONS and
// called the result a per-calendar-month rate.
//
// resolveMonthlyFill's own docstring says `amount` is "a PER-CALENDAR-MONTH
// total for this envelope — the sum of every line landing on it in a month,
// not a per-fill figure", and projectEnvelopeBalance's `fillDelta` depends on
// the two agreeing. The scheduled branch thirty lines earlier already buckets
// into a byMonth map, with a comment saying exactly why. Only the history
// fallback skipped it.
//
// The consequence: on an envelope hand-filled sparsely, v1 sees only the
// fills, gets a positive median, and synthesises twelve monthly fills that
// never happen. The projection never dips, `low` and `spare` are both too
// high, and the recommendation engine can advise TRIMMING an envelope that is
// actually short.
import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance } from '../../js/engine.js';

const ENVELOPES = [{ id: 'env', name: 'Env' }];
const TODAY = new Date(2026, 0, 1); // six whole months back: 2025-08 … 2026-01

const fill = (id, date, amount) => ({
  id, type: 'fill', date, status: 'posted',
  lines: [{ envelope_id: 'env', mode: 'add', amount }],
});

const resolve = transactions => projectEnvelopeBalance({
  envelopeId: 'env', transactions, budgetItems: [], envelopeTemplates: [],
  accounts: [], envelopes: ENVELOPES, today: TODAY, months: 12,
});

describe('the history fill median is over months, not fill rows', () => {
  it('three fills in ONE month and none in the other five decline', () => {
    // The plan's assertion. Old behaviour: median of [200, 200, 200] = 200,
    // and twelve synthetic fills. New: median of [0,0,0,0,0,600] = 0.
    const p = resolve([
      fill('a', '2025-12-05', 200),
      fill('b', '2025-12-15', 200),
      fill('c', '2025-12-25', 200),
    ]);
    expect(p.fillSource).toBe('none');
    expect(p.monthlyFill).toBe(0);
    expect(p.events.some(e => e.tx.is_estimate === true)).toBe(false);
  });

  it('a single top-up is not a monthly pattern', () => {
    const p = resolve([fill('a', '2025-12-15', 800)]);
    expect(p.fillSource).toBe('none');
    expect(p.monthlyFill).toBe(0);
  });

  it('an envelope funded every month keeps its rate', () => {
    const p = resolve([
      fill('a', '2025-08-15', 500), fill('b', '2025-09-15', 500),
      fill('c', '2025-10-15', 500), fill('d', '2025-11-15', 500),
      fill('e', '2025-12-15', 500), fill('f', '2026-01-01', 500),
    ]);
    expect(p.fillSource).toBe('history');
    expect(p.monthlyFill).toBe(500);
  });

  it('two fills in one month sum into that month, not two samples', () => {
    // The unit `fillDelta` is stated in: an envelope funded twice a month
    // reports the combined figure, exactly as the scheduled branch does.
    const twice = ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12'].flatMap((m, i) => [
      fill(`x${i}`, `${m}-05`, 300),
      fill(`y${i}`, `${m}-20`, 200),
    ]);
    const p = resolve([...twice, fill('z', '2026-01-01', 500)]);
    expect(p.fillSource).toBe('history');
    expect(p.monthlyFill).toBe(500); // 300 + 200, not a median of 300 and 200
  });

  it('an unfunded month is a ZERO sample, not an absent one', () => {
    // The load-bearing half. Four funded months of 400 and two empty ones:
    // [0, 0, 400, 400, 400, 400] → median 400. Dropping the zeros entirely
    // would also give 400 here, so the case that separates them is the
    // majority-empty one: three funded, three empty → [0,0,0,400,400,400] is
    // a median of 200, where medianing only the funded months gives 400.
    const majorityEmpty = resolve([
      fill('a', '2025-11-15', 400),
      fill('b', '2025-12-15', 400),
      fill('c', '2026-01-01', 400),
    ]);
    expect(majorityEmpty.fillSource).toBe('history');
    expect(majorityEmpty.monthlyFill).toBe(200);
  });

  it('a negative monthly total still declines rather than inverting', () => {
    // The source envelope of a source-funded template is DRAINED monthly. A
    // non-positive median must not be extrapolated into refills.
    const p = resolve([
      fill('a', '2025-09-15', -400), fill('b', '2025-10-15', -400),
      fill('c', '2025-11-15', -400), fill('d', '2025-12-15', -400),
    ]);
    expect(p.fillSource).toBe('none');
    expect(p.monthlyFill).toBe(0);
  });
});
