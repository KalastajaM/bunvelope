import { describe, it, expect } from 'vitest';
import { computeSpareByEnvelope } from '../../js/engine.js';

// The owner's Heinola, 25 Sep 2026: September's spending took the envelope
// 476.43 below zero, and a 10 000 transfer dated 1 Oct refills it. The card
// read "−476.43 short" next to a Booked balance of 9 523.57 with nothing
// saying the hole closes in six days. `coveredDate` is that date.

const E = 'heinola';
const TODAY = new Date(2026, 8, 25);

const fill = (id, date, amount) => ({
  id, type: 'fill', date, status: 'posted', lines: [{ envelope_id: E, amount, mode: 'add' }],
});
const expense = (id, date, amount) => ({ id, type: 'expense', date, envelope_id: E, amount });

const spareFor = (transactions) => computeSpareByEnvelope({
  transactions,
  budgetItems: [],
  envelopeTemplates: [],
  accounts: [{ id: 'bank', type: 'bank' }],
  envelopes: [{ id: E, name: 'Heinola' }],
  today: TODAY,
  months: 12,
  country: 'FI',
  tombstones: [],
}).get(E);

describe('computeSpareByEnvelope coveredDate', () => {
  it('is the day a future refill lifts a short envelope back to its floor', () => {
    const s = spareFor([
      expense('e1', '2026-09-20', 476.43),
      fill('f1', '2026-10-01', 10000),
    ]);
    expect(s.spare).toBe(-476.43);
    expect(s.lowDate).toBe('2026-09-25');
    expect(s.coveredDate).toBe('2026-10-01');
  });

  it('is null when the envelope is not short', () => {
    const s = spareFor([fill('f0', '2026-09-01', 500)]);
    expect(s.spare).toBe(500);
    expect(s.coveredDate).toBeNull();
  });

  it('is null when nothing in the window covers the hole', () => {
    const s = spareFor([expense('e1', '2026-09-20', 100)]);
    expect(s.spare).toBe(-100);
    expect(s.coveredDate).toBeNull();
  });

  it('balanceCoveredDate is null when Booked is not below zero', () => {
    const s = spareFor([
      expense('e1', '2026-09-20', 476.43),
      fill('f1', '2026-10-01', 10000),
    ]);
    expect(s.balanceCoveredDate).toBeNull();
  });

  it('waits for the last hole, not the first recovery', () => {
    // Short today, refilled 1 Oct, short again from 1 Nov until 1 Dec.
    const s = spareFor([
      expense('e1', '2026-09-20', 100),
      fill('f1', '2026-10-01', 200),
      expense('e2', '2026-11-01', 150),
      fill('f2', '2026-12-01', 100),
    ]);
    expect(s.spare).toBe(-100);
    expect(s.coveredDate).toBe('2026-12-01');
  });
});

// The owner's Metsäreuna, 25 Sep 2026: 153.00 held, a property-tax bill of
// 183.60 already entered for 6 Oct, and a 30.60 Start of Month template fill
// on the 1st that exists only as a schedule. Booked reads −30.60 "over" while
// the forecast lands on exactly 0.
describe('computeSpareByEnvelope balanceCoveredDate', () => {
  const ALL_MONTHS = Object.fromEntries(
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      .map(m => [m, true]),
  );
  const startOfMonth = {
    id: 'som',
    name: 'Start of Month',
    lines: [{ envelope_id: E, amount: 30.6, mode: 'add' }],
    schedule: { enabled: true, day_type: 'exact', payment_day: 1, months: ALL_MONTHS },
  };
  const run = (transactions, envelopeTemplates) => computeSpareByEnvelope({
    transactions,
    budgetItems: [],
    envelopeTemplates,
    accounts: [{ id: 'bank', type: 'bank' }],
    envelopes: [{ id: E, name: 'Metsäreuna' }],
    today: TODAY,
    months: 12,
    country: 'FI',
    tombstones: [],
  }).get(E);
  const held = fill('f0', '2026-09-01', 153);
  const tax = expense('tax', '2026-10-06', 183.6);

  it('is the day the scheduled fill lifts Booked back to zero', () => {
    const s = run([held, tax], [startOfMonth]);
    expect(s.spare).toBe(0);
    expect(s.balanceCoveredDate).toBe('2026-10-01');
  });

  it('is null when no scheduled row ever covers it', () => {
    const s = run([held, tax], []);
    expect(s.spare).toBe(-30.6);
    expect(s.balanceCoveredDate).toBeNull();
  });

  it('is null when a future-dated Set row makes Booked non-additive', () => {
    const set = { id: 's1', type: 'fill', date: '2026-10-20', status: 'posted',
      lines: [{ envelope_id: E, amount: 0, mode: 'set' }] };
    expect(run([held, tax, set], [startOfMonth]).balanceCoveredDate).toBeNull();
  });
});
