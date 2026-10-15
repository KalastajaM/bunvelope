// §2.4 — the Monthly Review's spend flag had two independent problems in five
// lines, and between them they accounted for all 62 findings D47/D62 measured:
//
//   1. The dead band was a flat ±0.01, so the flag fired on rounding. On a
//      real budget that is nearly every envelope, all the time.
//   2. The comparison was `actual + scheduled` against plan, so the flag
//      claimed to answer "have I overspent?" while answering "will I?" — an
//      envelope that had plainly underspent read `normal` because the bills
//      still to come topped it back up.
import { describe, it, expect } from 'vitest';
import { runMonthlyReview } from '../../js/engine/monthly-review.js';

const ENVELOPES = [{ id: 'food', name: 'Food', category: 'Needs' }];
const item = amount => ([{
  envelope_id: 'food', kind: 'expense', default_amount: amount,
  monthly_schedule: { Apr: true }, extra_buffer: 0, include: true,
}]);

const flagFor = (planned, txs, refDate = new Date(2026, 3, 15)) => {
  const rows = runMonthlyReview(
    ENVELOPES, item(planned), new Map([['food', 10000]]), txs, '2026-04', refDate,
  );
  return rows.find(r => r.envelope_id === 'food');
};

const spent = (id, amount, date = '2026-04-10') => ({
  id, type: 'expense', envelope_id: 'food', date, status: 'posted', amount,
});
const scheduled = (id, amount, date = '2026-04-25') => ({
  id, type: 'expense', envelope_id: 'food', date, status: 'scheduled', amount,
});

describe('spend flag — the dead band', () => {
  it('an envelope 0.50 off plan is normal', () => {
    // The plan's pinned assertion. Under the old flat ±0.01 this was `over`.
    expect(flagFor(40, [spent('t1', 40.5)]).spendFlag).toBe('normal');
    expect(flagFor(40, [spent('t1', 39.5)]).spendFlag).toBe('normal');
  });

  it('the band is proportional above 20, and a flat unit below it', () => {
    // 5% of 40 is 2, so the proportional term already beats the floor.
    expect(flagFor(40, [spent('t1', 41.5)]).spendFlag).toBe('normal');
    expect(flagFor(40, [spent('t1', 43)]).spendFlag).toBe('over');
    // Below 20 the floor binds: 5% of 10 is 0.50, which would put us back at
    // flagging rounding, so the band stays at one whole unit.
    expect(flagFor(10, [spent('t1', 10.8)]).spendFlag).toBe('normal');
    expect(flagFor(10, [spent('t1', 11.5)]).spendFlag).toBe('over');
    // €800 envelope → €40 band, so 2% over plan is not a signal.
    expect(flagFor(800, [spent('t1', 816.63)]).spendFlag).toBe('normal');
    expect(flagFor(800, [spent('t1', 900)]).spendFlag).toBe('over');
  });

  it('a genuinely large overspend is still flagged', () => {
    expect(flagFor(400, [spent('t1', 638.37)]).spendFlag).toBe('over');
  });
});

describe('spend flag — what has been spent, not what will be', () => {
  it('an envelope with actual = 0 and scheduled = planned reads under', () => {
    // The plan's second pinned assertion, and the direction that matters:
    // this used to read `normal` because the scheduled bill topped it back up.
    const row = flagFor(100, [scheduled('s1', 100)], new Date(2026, 3, 5));
    expect(row.actual).toBe(0);
    expect(row.scheduled).toBe(100);
    expect(row.spendFlag).toBe('under');
  });

  it('a scheduled bill does not mask a partial underspend', () => {
    const row = flagFor(100, [spent('t1', 20, '2026-04-02'), scheduled('s1', 80)],
      new Date(2026, 3, 5));
    expect(row.spendFlag).toBe('under');
  });

  it('an overspend is still over even with more scheduled to come', () => {
    // Both terms must move together. `planned` on the row has bookedExtras
    // folded in — the future-dated row — so comparing `actual` against THAT
    // would bias every envelope with a booked bill toward `under` and
    // replace one wrong answer with another. The flag compares against the
    // recurring plan instead.
    const row = flagFor(100, [spent('t1', 150), scheduled('s1', 60)]);
    expect(row.actual).toBe(150);
    expect(row.scheduled).toBe(60);
    expect(row.planned).toBe(160);   // recurring 100 + the booked 60
    expect(row.spendFlag).toBe('over');
  });

  it('the forward-looking figure keeps its own column and its own projection', () => {
    // Nothing is lost by taking `scheduled` out of the flag.
    const row = flagFor(100, [spent('t1', 150), scheduled('s1', 60)]);
    expect(row.scheduled).toBe(60);
    expect(row.projected).toBe(10000 - 60);
  });
});
