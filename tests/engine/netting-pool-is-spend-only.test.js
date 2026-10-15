// §2.9 — netAgainstSpentThisMonth nets a projected planned expense against
// spending that has already happened this month, so a bill already paid by
// hand is not charged twice. The pool it drew from admitted ANY transaction
// whose effect on the envelope was negative.
//
// txEnvelopeEffect is the BALANCE question; balances.js:285 documents at
// length why that is deliberately not the SPEND question. A fill relocating
// money out of an envelope, an outbound envelope transfer and a negative
// adjustment all move the balance down, and none of them is a bill being
// paid. Netting a planned bill against one cancels a projected hole with
// money that was moved rather than spent — the false-negative direction that
// hides a shortfall.
import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance } from '../../js/engine.js';

const ENVELOPES = [{ id: 'home', name: 'Home' }, { id: 'other', name: 'Other' }];
const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const HOME_ITEM = {
  id: 'bi-home', envelope_id: 'home', kind: 'expense', include: true,
  as_schedule: false, payment_day: 0, default_amount: -200,
  monthly_schedule: { ...ALL_MONTHS },
};
const TODAY = new Date(2026, 0, 15);

const project = transactions => projectEnvelopeBalance({
  envelopeId: 'home', transactions, budgetItems: [HOME_ITEM],
  envelopeTemplates: [], accounts: [], envelopes: ENVELOPES,
  today: TODAY, months: 1,
});
const janOut = transactions => project(transactions).months.find(m => m.key === '2026-01').out;

describe('the month-to-date netting pool is spend, not balance movement', () => {
  it('a real expense still nets against the plan line', () => {
    // The behaviour the pool exists for, unchanged.
    expect(janOut([
      { id: 'e1', type: 'expense', date: '2026-01-10', status: 'posted', envelope_id: 'home', amount: 80 },
    ])).toBeCloseTo(-120, 2); // 200 planned − 80 already spent
  });

  it('a negative fill line does NOT net the planned bill away', () => {
    // Money moved OUT of the envelope by a fill is not a bill being paid.
    // This is the row the plan measured on the owner's budget.
    expect(janOut([
      { id: 'f1', type: 'fill', date: '2026-01-10', status: 'posted',
        lines: [{ envelope_id: 'home', amount: -161, mode: 'add' }] },
    ])).toBeCloseTo(-200, 2); // full plan still projected
  });

  it('a negative adjustment does NOT net the planned bill away', () => {
    expect(janOut([
      { id: 'a1', type: 'adjustment', date: '2026-01-10', status: 'posted',
        target: 'envelope', target_id: 'home', amount: -160 },
    ])).toBeCloseTo(-200, 2);
  });

  it('an outbound envelope transfer does NOT net the planned bill away', () => {
    expect(janOut([
      { id: 'x1', type: 'envelope_transfer', date: '2026-01-10', status: 'posted',
        from_envelope_id: 'home', to_envelope_id: 'other', amount: 150 },
    ])).toBeCloseTo(-200, 2);
  });

  it('the buy leg of an investment transfer is spend, and does net', () => {
    // txEnvelopeSpend's set is narrow but not empty beyond plain expenses —
    // this arm must survive the tightening.
    expect(janOut([
      { id: 'i1', type: 'investment_transfer', direction: 'buy', date: '2026-01-10',
        status: 'posted', envelope_id: 'home', from_account: 'chk', to_account: 'inv',
        amount: 50, units: 1, pricePerUnit: 50 },
    ])).toBeCloseTo(-150, 2);
  });
});
