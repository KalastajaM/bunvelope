// The forward half of the `dueUnpostedTotal` netting.
//
// `dueUnpostedTotal` stops a bill that is due-or-past being charged twice when
// the payment was recorded by hand. Nothing did the same for a bill still
// ahead on the calendar: the projection deduped forecast occurrences against
// real transactions purely by the `from_budget` key, and a row the user typed
// carries none. So a bill entered by hand for a future date was charged once
// as that real row and once again as the budget item's forecast occurrence.
//
// Shape below is the report that surfaced it, and it is the same envelope as
// due-unposted-netting.test.js one bill later: property tax of 183.60 billed
// in August and October, funded by a 30.60/month fill, August paid, balance
// 122.40 — and the October installment already entered by hand for Oct 6.
// October projected an outflow of 367.20 and spare read -183.60, minus one
// entire bill, for an envelope that lands exactly square.

import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance, computeSpareByEnvelope } from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a1', name: 'Income & Expenses', type: 'bank' }];
const ENVELOPES = [{ id: 'metsa', name: 'Metsareuna', rollover: 'carry' }];

const NO_MONTHS = {
  Jan: false, Feb: false, Mar: false, Apr: false, May: false, Jun: false,
  Jul: false, Aug: false, Sep: false, Oct: false, Nov: false, Dec: false,
};
const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const TAX_ITEM = {
  id: 'bi-tax', envelope_id: 'metsa', description: 'Property Taxes',
  default_amount: 183.6, include: true, payment_day: 6, as_schedule: true,
  account_id: 'a1',
  monthly_schedule: { ...NO_MONTHS, Aug: 183.6, Oct: 183.6 },
};

const FILL_TPL = {
  id: 'tpl-metsa',
  lines: [{ envelope_id: 'metsa', mode: 'add', amount: 30.6 }],
  schedule: { enabled: true, payment_day: 1, months: { ...ALL_MONTHS } },
};

const TODAY = new Date(2026, 7, 25); // 2026-08-25

// Leaves exactly 122.40 in the envelope as of TODAY.
const OPENING_FILL = {
  id: 'f0', type: 'fill', date: '2026-07-31', status: 'posted',
  lines: [{ envelope_id: 'metsa', mode: 'add', amount: 306.0 }],
};
const augustPayment = {
  id: 'x-aug', type: 'expense', date: '2026-08-06', status: 'posted',
  amount: 183.6, envelope_id: 'metsa', account: 'a1',
  payee: 'Kiinteistovero Metsareuna',
};
// The October installment, entered by hand ahead of time. No `from_budget`:
// nothing links it back to the budget item that also predicts it.
const octoberPayment = (extra = {}) => ({
  id: 'x-oct', type: 'expense', date: '2026-10-06', status: 'scheduled',
  amount: 183.6, envelope_id: 'metsa', account: 'a1', payee: 'Property Taxes',
  ...extra,
});

function input(transactions, extra = {}) {
  return {
    envelopeId: 'metsa',
    transactions,
    budgetItems: [TAX_ITEM],
    envelopeTemplates: [FILL_TPL],
    accounts: ACCOUNTS,
    envelopes: ENVELOPES,
    today: TODAY,
    months: 12,
    country: 'FI',
    tombstones: [],
    ...extra,
  };
}

const octoberEvents = p => p.events
  .filter(e => e.date === '2026-10-06')
  .map(e => ({ forecast: !!e.tx.is_forecast, amount: e.effect.amount }));

const monthRow = (p, key) => p.months.find(m => m.key === key);

describe('a real future payment settles the occurrence that predicted it', () => {
  it('charges a hand-entered future bill once, not twice', () => {
    const p = projectEnvelopeBalance(input([OPENING_FILL, augustPayment, octoberPayment()]));

    expect(octoberEvents(p)).toEqual([{ forecast: false, amount: -183.6 }]);
    expect(monthRow(p, '2026-10').out).toBe(-183.6); // regression: read -367.20
  });

  it('projects the October bill to land square', () => {
    const p = projectEnvelopeBalance(input([OPENING_FILL, augustPayment, octoberPayment()]));

    // 122.40 + 30.60 (Sep 1) + 30.60 (Oct 1) - 183.60 (Oct 6) = 0.
    expect(p.low.date).toBe('2026-10-06');
    expect(p.low.balance).toBe(0);
  });

  it('reports spare of 0 rather than minus one whole payment', () => {
    const spare = computeSpareByEnvelope(input([OPENING_FILL, augustPayment, octoberPayment()]))
      .get('metsa');

    expect(spare.floor).toBe(0);
    expect(spare.spare).toBe(0); // regression: read -183.6
  });

  it('matches the tagged case exactly — the tag stops being load-bearing', () => {
    const untagged = projectEnvelopeBalance(input([OPENING_FILL, augustPayment, octoberPayment()]));
    const tagged = projectEnvelopeBalance(input([
      OPENING_FILL, augustPayment, octoberPayment({ from_budget: 'bi-tax:2026-10' }),
    ]));

    expect(untagged.low.balance).toBe(tagged.low.balance);
    expect(untagged.low.date).toBe(tagged.low.date);
    expect(monthRow(untagged, '2026-10').out).toBe(monthRow(tagged, '2026-10').out);
  });

  it('recognises a payment made a few days off the due date', () => {
    const early = projectEnvelopeBalance(
      input([OPENING_FILL, augustPayment, octoberPayment({ date: '2026-09-30' })]),
    );

    expect(monthRow(early, '2026-10').out).toBe(0);
    expect(monthRow(early, '2026-09').out).toBe(-183.6);
    // Paying a day before the fill that funds it really does dip the envelope
    // under, and only a daily walk sees the one day it lasts: 153.00 on Sep 30
    // less the bill, back to zero when Oct 1 lands. -30.60, not a whole bill.
    expect(early.low.date).toBe('2026-09-30');
    expect(early.low.balance).toBe(-30.6);
  });

  it('still forecasts the bill when nothing was entered for it', () => {
    const p = projectEnvelopeBalance(input([OPENING_FILL, augustPayment]));

    expect(octoberEvents(p)).toEqual([{ forecast: true, amount: -183.6 }]);
    expect(monthRow(p, '2026-10').out).toBe(-183.6);
  });

  it('does not let a payment far from the due date settle it', () => {
    // Two weeks out is outside LINK_DAY_WINDOW: this is some other spend of a
    // coincidentally identical size, and the bill is still owed on top of it.
    const p = projectEnvelopeBalance(
      input([OPENING_FILL, augustPayment, octoberPayment({ date: '2026-10-22' })]),
    );

    expect(monthRow(p, '2026-10').out).toBe(-367.2);
  });

  it('does not let a differently-sized payment settle it', () => {
    const p = projectEnvelopeBalance(
      input([OPENING_FILL, augustPayment, octoberPayment({ amount: 90 })]),
    );

    expect(octoberEvents(p)).toEqual([
      { forecast: false, amount: -90 },
      { forecast: true, amount: -183.6 },
    ]);
  });

  it('does not let an inflow settle a bill', () => {
    const refund = {
      id: 'r1', type: 'fill', date: '2026-10-05', status: 'scheduled',
      lines: [{ envelope_id: 'metsa', mode: 'add', amount: 183.6 }],
    };
    const p = projectEnvelopeBalance(input([OPENING_FILL, augustPayment, refund]));

    expect(monthRow(p, '2026-10').out).toBe(-183.6);
  });

  it('settles each of two occurrences from the payment beside it', () => {
    // Both installments still ahead, both entered by hand. Each occurrence
    // must claim the payment next to it rather than one payment cancelling
    // both, and neither may be charged twice.
    const bothAhead = {
      ...TAX_ITEM, monthly_schedule: { ...NO_MONTHS, Oct: 183.6, Dec: 183.6 },
    };
    const december = octoberPayment({ id: 'x-dec', date: '2026-12-06' });
    const p = projectEnvelopeBalance(input(
      [OPENING_FILL, augustPayment, octoberPayment(), december],
      { budgetItems: [bothAhead] },
    ));

    expect(monthRow(p, '2026-10').out).toBe(-183.6);
    expect(monthRow(p, '2026-12').out).toBe(-183.6);
  });

  it('charges the occurrence that has no payment beside it', () => {
    const bothAhead = {
      ...TAX_ITEM, monthly_schedule: { ...NO_MONTHS, Oct: 183.6, Dec: 183.6 },
    };
    // Only October was entered; December was not.
    const p = projectEnvelopeBalance(input(
      [OPENING_FILL, augustPayment, octoberPayment()],
      { budgetItems: [bothAhead] },
    ));

    expect(monthRow(p, '2026-10').out).toBe(-183.6);
    expect(monthRow(p, '2026-12').out).toBe(-183.6);
  });

  it('does not net against a payment the walk never applies', () => {
    // A payment beyond the window end cannot cancel an occurrence inside it:
    // dropping the forecast row there would lose the outflow altogether
    // rather than count it once. Three-month window ends 2026-11-24, bill due
    // 2026-11-20, payment entered for 2026-11-26 — inside the ten-day match
    // window, outside the walk.
    const novemberItem = {
      ...TAX_ITEM, payment_day: 20, monthly_schedule: { ...NO_MONTHS, Nov: 183.6 },
    };
    const beyondEnd = octoberPayment({ id: 'x-nov', date: '2026-11-26' });
    const p = projectEnvelopeBalance(input(
      [OPENING_FILL, augustPayment, beyondEnd],
      { budgetItems: [novemberItem], months: 3 },
    ));

    expect(monthRow(p, '2026-11').out).toBe(-183.6);
  });

  it('recognises a bill paid before it was owed', () => {
    // Occurrence still ahead (Aug 28), payment already made (Aug 24) and so
    // already inside `opening`. `dueUnpostedTotal` only covers occurrences
    // dated today or earlier, so nothing paired these before.
    const soon = {
      ...TAX_ITEM, payment_day: 28, monthly_schedule: { ...NO_MONTHS, Aug: 183.6 },
    };
    const paidEarly = { ...augustPayment, date: '2026-08-24' };
    const p = projectEnvelopeBalance(input(
      [OPENING_FILL, paidEarly], { budgetItems: [soon] },
    ));

    expect(p.dueUnposted).toBe(0);
    expect(p.opening).toBe(122.4);
    expect(monthRow(p, '2026-08').out).toBe(0); // regression: read -183.60
    expect(p.low.balance).toBe(122.4);
  });

  it('does not let one payment settle both a past and a coming occurrence', () => {
    // Two occurrences ten days apart, one payment between them. Whichever
    // pass runs first, the other must still charge its bill: both draw on the
    // same transaction and one payment is one payment.
    const twice = {
      ...TAX_ITEM, as_schedule_since: '2026-08-01',
      payment_day: 20, monthly_schedule: { ...NO_MONTHS, Aug: 183.6 },
    };
    const alsoLater = {
      ...twice, id: 'bi-tax-2', payment_day: 28,
    };
    const onePayment = { ...augustPayment, date: '2026-08-24' };
    const p = projectEnvelopeBalance(input(
      [OPENING_FILL, onePayment], { budgetItems: [twice, alsoLater] },
    ));

    // Aug 20 was due and unpaid as far as the key goes, so the payment
    // settles it — leaving the Aug 28 bill genuinely still to come.
    expect(p.dueUnposted).toBe(0);
    expect(monthRow(p, '2026-08').out).toBe(-183.6);
  });

  it('leaves another envelope\'s identical bill alone', () => {
    // Same amount, same day, different envelope. The payment sits in Metsa,
    // so only Metsa's occurrence may be settled by it.
    const envelopes = [...ENVELOPES, { id: 'other', name: 'Other', rollover: 'carry' }];
    const otherItem = { ...TAX_ITEM, id: 'bi-other', envelope_id: 'other' };
    const p = projectEnvelopeBalance(input(
      [OPENING_FILL, augustPayment, octoberPayment()],
      { budgetItems: [TAX_ITEM, otherItem], envelopes, envelopeId: 'other' },
    ));

    expect(monthRow(p, '2026-10').out).toBe(-183.6);
    expect(octoberEvents(p)).toEqual([{ forecast: true, amount: -183.6 }]);
  });
});
