// `dueUnpostedTotal` folds a bill that is due-but-unposted into the projection's
// opening balance, and its only evidence that an occurrence was already paid is
// the `from_budget` key `post-due` stamps on the transaction it materializes.
//
// That key is absent whenever the payment was recorded by hand — including
// after a user cleans up a double-booking and deletes the tagged copy rather
// than the hand-entered one. The bill was then charged twice: once as the real
// transaction inside the balance, once again as a phantom backlog, so `opening`
// started a whole payment below the balance the envelope card showed and every
// downstream figure inherited the gap.
//
// Shape below is the real report that surfaced it: a property tax of 183.60
// billed in August and October, funded by a 30.60/month fill (30.60 * 12 =
// 367.20 = two payments). Balance 122.40 on 2026-08-24, August already paid.
// Spare read -183.60 — minus one entire bill — for a fully funded envelope.

import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance, computeSpareByEnvelope } from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
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
  id: 'bi-tax', envelope_id: 'metsa', description: 'Property tax',
  default_amount: 183.6, include: true, payment_day: 6, as_schedule: true,
  account_id: 'a1',
  monthly_schedule: { ...NO_MONTHS, Aug: 183.6, Oct: 183.6 },
};

const FILL_TPL = {
  id: 'tpl-metsa',
  lines: [{ envelope_id: 'metsa', mode: 'add', amount: 30.6 }],
  schedule: { enabled: true, payment_day: 1, months: { ...ALL_MONTHS } },
};

const TODAY = new Date(2026, 7, 24); // 2026-08-24

// Leaves exactly 122.40 in the envelope as of TODAY.
const OPENING_FILL = {
  id: 'f0', type: 'fill', date: '2026-07-31', status: 'posted',
  lines: [{ envelope_id: 'metsa', mode: 'add', amount: 306.0 }],
};
const augustPayment = (extra = {}) => ({
  id: 'x-aug', type: 'expense', date: '2026-08-06', status: 'posted',
  amount: 183.6, envelope_id: 'metsa', account: 'a1', payee: 'Property tax',
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

describe('dueUnpostedTotal nets against hand-recorded spend', () => {
  it('does not re-charge an auto-post bill that was paid without a from_budget tag', () => {
    const txs = [OPENING_FILL, augustPayment()];
    const p = projectEnvelopeBalance(input(txs));

    // The payment is real and inside the balance; nothing is still owed.
    expect(p.dueUnposted).toBe(0);
    expect(p.opening).toBe(122.4);
  });

  it('matches the tagged case exactly — the tag stops being load-bearing', () => {
    const untagged = projectEnvelopeBalance(input([OPENING_FILL, augustPayment()]));
    const tagged = projectEnvelopeBalance(
      input([OPENING_FILL, augustPayment({ from_budget: 'bi-tax:2026-08' })]),
    );

    expect(untagged.opening).toBe(tagged.opening);
    expect(untagged.low.balance).toBe(tagged.low.balance);
    expect(untagged.low.date).toBe(tagged.low.date);
  });

  it('projects the October bill to land square instead of a bill in the hole', () => {
    const p = projectEnvelopeBalance(input([OPENING_FILL, augustPayment()]));

    // 122.40 + 30.60 (Sep 1) + 30.60 (Oct 1) - 183.60 (Oct 6) = 0.
    expect(p.low.date).toBe('2026-10-06');
    expect(p.low.balance).toBe(0);
  });

  it('reports spare of 0 rather than minus one whole payment', () => {
    const spare = computeSpareByEnvelope(input([OPENING_FILL, augustPayment()])).get('metsa');

    expect(spare.floor).toBe(0);
    expect(spare.spare).toBe(0); // regression: read -183.6
  });

  it('still charges a bill that genuinely has not been paid', () => {
    // Same schedule, but nothing was spent from the envelope in August.
    const p = projectEnvelopeBalance(input([OPENING_FILL]));

    expect(p.dueUnposted).toBe(183.6);
    expect(p.opening).toBe(306 - 183.6);
  });

  it('does not recognise a partial payment, and says so loudly here', () => {
    // 100 paid against a 183.60 bill is not evidence the bill was settled, so
    // the whole occurrence is still charged and the 100 is double-counted.
    // That is the OLD behaviour, kept on purpose: the alternative — treating
    // any outflow as part-payment — is what let ordinary spending erase an
    // unpaid bill. Overstating a shortfall beats hiding one.
    const partial = augustPayment({ id: 'x-aug-part', amount: 100 });
    const p = projectEnvelopeBalance(input([OPENING_FILL, partial]));

    expect(p.dueUnposted).toBe(183.6);
  });

  it('does not let unrelated spending settle a bill nobody paid', () => {
    // The regression that made the netting too loose: a Home envelope holding
    // both a scheduled bill and ad-hoc spending. Three unrelated purchases
    // summing past the bill must not cancel it.
    const shopping = [60, 70, 60].map((amount, i) => ({
      id: `shop-${i}`, type: 'expense', date: `2026-08-1${i}`, status: 'posted',
      amount, envelope_id: 'metsa', account: 'a1', payee: `Shop ${i}`,
    }));
    const p = projectEnvelopeBalance(input([OPENING_FILL, ...shopping]));

    expect(p.dueUnposted).toBe(183.6);
  });

  it('does not let one big unrelated purchase settle a bill either', () => {
    const hardware = augustPayment({ id: 'x-hw', amount: 200, date: '2026-08-12' });
    const p = projectEnvelopeBalance(input([OPENING_FILL, hardware]));

    expect(p.dueUnposted).toBe(183.6);
  });

  it('settles two occurrences of one bill from the payments beside each', () => {
    // Same item billed twice inside the lookback. Each occurrence must claim
    // the payment next to it, not whichever row sorts first.
    const twice = {
      ...TAX_ITEM, as_schedule_since: '2026-06-01',
      monthly_schedule: { ...NO_MONTHS, Jun: 183.6, Aug: 183.6 },
    };
    const june = augustPayment({ id: 'x-jun', date: '2026-06-06' });
    const p = projectEnvelopeBalance(
      input([OPENING_FILL, june, augustPayment()], { budgetItems: [twice] }),
    );

    expect(p.dueUnposted).toBe(0);
  });

  it('charges the occurrence that has no payment beside it', () => {
    const twice = {
      ...TAX_ITEM, as_schedule_since: '2026-06-01',
      monthly_schedule: { ...NO_MONTHS, Jun: 183.6, Aug: 183.6 },
    };
    // Only August was paid; June was not.
    const p = projectEnvelopeBalance(
      input([OPENING_FILL, augustPayment()], { budgetItems: [twice] }),
    );

    expect(p.dueUnposted).toBe(183.6);
  });

  it('does not let a fill or refund cancel a due bill', () => {
    // An inflow is not spending: the bill is still owed in full.
    const refund = {
      id: 'r1', type: 'fill', date: '2026-08-05', status: 'posted',
      lines: [{ envelope_id: 'metsa', mode: 'add', amount: 183.6 }],
    };
    const p = projectEnvelopeBalance(input([OPENING_FILL, refund]));

    expect(p.dueUnposted).toBe(183.6);
  });

  it('spends one hand-recorded payment once, not against a planned row too', () => {
    // Groceries is a PLANNED item (no as_schedule) on the same envelope, so
    // `netAgainstSpentThisMonth` reads the same untagged pool that the tax
    // occurrence just consumed. Netting it twice would silently erase the
    // groceries row and overstate the projection.
    const GROCERIES = {
      id: 'bi-food', envelope_id: 'metsa', description: 'Groceries',
      default_amount: 200, include: true, payment_day: 28,
      monthly_schedule: { ...NO_MONTHS, Aug: 200 },
    };
    const p = projectEnvelopeBalance(
      input([OPENING_FILL, augustPayment()], { budgetItems: [TAX_ITEM, GROCERIES] }),
    );

    expect(p.dueUnposted).toBe(0);
    const aug28 = p.events.filter(e => e.date === '2026-08-28');
    expect(aug28).toHaveLength(1);
    expect(aug28[0].effect.amount).toBe(-200);
  });
});
