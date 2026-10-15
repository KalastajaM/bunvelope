// projectEnvelopeBalance walks one envelope day by day for 12 months. The
// intra-month case is the point of the whole feature: rent leaves on the 3rd,
// the fill lands on the 25th, so the envelope is deeply negative mid-month and
// square again by the 31st. A month-end view calls that healthy.

import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance } from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
const ENVELOPES = [{ id: 'rent', name: 'Rent' }];
const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const TODAY = new Date(2026, 0, 1); // 2026-01-01

const RENT_ITEM = {
  id: 'bi-rent', envelope_id: 'rent', description: 'Rent',
  default_amount: 800, include: true, payment_day: 3,
  monthly_schedule: { ...ALL_MONTHS }, as_schedule: true, account_id: 'a1',
};
const SALARY_ITEM = {
  id: 'income-salary', kind: 'income', description: 'Salary',
  default_amount: 3000, include: true, payment_day: 25,
  monthly_schedule: { ...ALL_MONTHS }, as_schedule: true, account_id: 'a1',
};
const TPL = {
  id: 'tpl',
  lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }],
  // The template carries its own calendar now. Day 25 is the same date the
  // salary used to drive when the fill was a leg of the income occurrence,
  // so the intra-month shape these tests are about is unchanged.
  schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } },
};

// Cadence used to come from the funding income item's schedule, through
// `template_id`. It lives on the template now, so a fixture that wants a fill
// on a particular day says so here rather than moving the salary.
const tplOn = (day, over = {}) => ({
  id: `tpl-${day}`,
  lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }],
  schedule: { enabled: true, payment_day: day, months: { ...ALL_MONTHS } },
  ...over,
});

function baseInput(extra = {}) {
  return {
    envelopeId: 'rent',
    transactions: [],
    budgetItems: [RENT_ITEM, SALARY_ITEM],
    envelopeTemplates: [TPL],
    accounts: ACCOUNTS,
    envelopes: ENVELOPES,
    today: TODAY,
    months: 12,
    ...extra,
  };
}

describe('projectEnvelopeBalance', () => {
  it('opens at the balance as of today, ignoring future-dated rows', () => {
    const txs = [
      { id: 'f1', type: 'fill', date: '2025-12-20', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }] },
      { id: 'x1', type: 'expense', date: '2026-06-01', status: 'posted',
        amount: 100, envelope_id: 'rent', account: 'a1' },
    ];
    const p = projectEnvelopeBalance(baseInput({ transactions: txs }));
    expect(p.opening).toBe(900);
    expect(p.daily[0]).toEqual({ date: '2026-01-01', balance: 900 });
  });

  it('finds an intra-month trough a month-end view would miss', () => {
    // Opens at 800. Rent (-800) on the 3rd, fill (+800) on the 25th.
    // Month-end closing is 800 every month; the low is 0 on the 3rd.
    const txs = [
      { id: 'f1', type: 'fill', date: '2025-12-28', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }] },
    ];
    const p = projectEnvelopeBalance(baseInput({ transactions: txs }));

    expect(p.low.date).toBe('2026-01-03');
    expect(p.low.balance).toBe(0);
    expect(p.months[0].closing).toBe(800);
    expect(p.months[0].low).toBe(0);
    expect(p.closing).toBe(800);
  });

  it('reports the first below-zero day when the envelope is underfunded', () => {
    // Opens at 500. Rent -800 on 2026-01-03 → -300.
    const txs = [
      { id: 'f1', type: 'fill', date: '2025-12-28', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 500 }] },
    ];
    const p = projectEnvelopeBalance(baseInput({ transactions: txs }));

    expect(p.firstNegative.date).toBe('2026-01-03');
    expect(p.low.balance).toBeLessThan(0);
  });

  it('suppresses a forecast whose occurrence is already posted', () => {
    const txs = [
      { id: 'r1', type: 'expense', date: '2026-01-03', status: 'posted',
        amount: 800, envelope_id: 'rent', account: 'a1',
        from_budget: 'bi-rent:2026-01' },
      { id: 'r2', type: 'fill', date: '2026-01-25', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }],
        from_budget: 'tpl:tpl:2026-01' },
    ];
    // Both January events are real, so January must show exactly one -800 and
    // one +800, not two of each.
    const p = projectEnvelopeBalance(baseInput({ transactions: txs, today: new Date(2026, 0, 1) }));

    expect(p.months[0].out).toBe(-800);
    expect(p.months[0].in).toBe(800);
  });

  it('honours a set-mode fill by overwriting the balance', () => {
    const setTpl = { id: 'tpl', lines: [{ envelope_id: 'rent', mode: 'set', amount: 1000 }], schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } }, };
    const txs = [
      { id: 'f1', type: 'fill', date: '2025-12-28', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 5000 }] },
    ];
    const p = projectEnvelopeBalance(baseInput({ transactions: txs, envelopeTemplates: [setTpl] }));

    // 5000 opening, -800 rent on the 3rd, then the set fill clamps to 1000.
    const jan25 = p.daily.find(d => d.date === '2026-01-25');
    expect(jan25.balance).toBe(1000);
  });

  it('orders same-day events real → expense → fill → injection', () => {
    // The concat order in gatherEvents is the same-day tiebreaker, and it is
    // load-bearing: a set-mode fill overwrites the balance, so if it landed
    // before the expense the expense would vanish, and if an injection landed
    // before it the injected top-up would be erased.
    const setTpl = { id: 'tpl', lines: [{ envelope_id: 'rent', mode: 'set', amount: 1000 }], schedule: { enabled: true, payment_day: 3, months: { ...ALL_MONTHS } } };
    const p = projectEnvelopeBalance(baseInput({
      budgetItems: [RENT_ITEM, { ...SALARY_ITEM, payment_day: 3 }],
      envelopeTemplates: [setTpl],
      injections: [{
        id: 'inj', type: 'fill', date: '2026-01-03', status: 'scheduled',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 50 }],
      }],
    }));

    // 0 → rent -800 → set to 1000 → injected +50.
    expect(p.daily.find(d => d.date === '2026-01-03').balance).toBe(1050);
  });

  it('records each bucket opening and high', () => {
    // Fill on the 5th, rent on the 20th, so the month peaks above both its
    // opening and its closing — otherwise `high` is indistinguishable from
    // `opening` and a mutation that never sets it survives.
    const txs = [
      { id: 'f1', type: 'fill', date: '2025-12-28', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 500 }] },
    ];
    const p = projectEnvelopeBalance(baseInput({
      transactions: txs,
      budgetItems: [{ ...RENT_ITEM, payment_day: 20 }, { ...SALARY_ITEM, payment_day: 5 }],
      envelopeTemplates: [tplOn(5)],
    }));

    expect(p.months[0].opening).toBe(500);
    expect(p.months[0].high).toBe(1300);
    expect(p.months[0].low).toBe(500);
    expect(p.months[0].closing).toBe(500);
    expect(p.months[1].opening).toBe(500);
  });

  it('produces one month bucket per projected month', () => {
    const p = projectEnvelopeBalance(baseInput());
    expect(p.months).toHaveLength(12);
    expect(p.months[0].key).toBe('2026-01');
    expect(p.months[11].key).toBe('2026-12');
    // Starting on the 1st is the only case where every bucket is a whole month.
    expect(p.months.every(m => m.partial === false)).toBe(true);
  });

  it('spans 13 buckets from a mid-month start, flagging the two partial ones', () => {
    const p = projectEnvelopeBalance(baseInput({ today: new Date(2026, 0, 15) }));

    expect(p.months).toHaveLength(13);
    expect(p.months[0].key).toBe('2026-01');
    expect(p.months[12].key).toBe('2027-01');
    // Jan starts on the 15th and the following Jan stops on the 14th; averaging
    // outflow across those as though they were whole months understates it.
    expect(p.months[0].partial).toBe(true);
    expect(p.months[12].partial).toBe(true);
    expect(p.months.slice(1, 12).every(m => m.partial === false)).toBe(true);
  });

  it('clamps the window end to the target month length', () => {
    // A one-month window from the 31st ends on 2026-02-27 — the day before the
    // clamped anniversary. Relying on Date overflow instead would push the
    // anniversary to 2026-03-03 and open a spurious third month bucket.
    const p = projectEnvelopeBalance(baseInput({ today: new Date(2026, 0, 31), months: 1 }));

    expect(p.months.map(m => m.key)).toEqual(['2026-01', '2026-02']);
    expect(p.daily[p.daily.length - 1].date).toBe('2026-02-27');
    expect(p.months.every(m => m.partial === true)).toBe(true);
  });
});

describe('projectEnvelopeBalance — unresolved envelope', () => {
  // A flat-zero projection is indistinguishable from a well-funded envelope to
  // every downstream rule, so an envelope that cannot be resolved has to say
  // so rather than quietly reading as healthy. Throwing is not an option: the
  // caller is a UI sheet.
  it('flags an envelope that is not in the list', () => {
    const p = projectEnvelopeBalance(baseInput({ envelopes: [] }));

    expect(p.unresolved).toBe(true);
    expect(p.fillSource).toBe('none');
    expect(p.months).toEqual([]);
  });

  it('flags an archived envelope', () => {
    const p = projectEnvelopeBalance(baseInput({
      envelopes: [{ id: 'rent', name: 'Rent', archived: true }],
    }));

    expect(p.unresolved).toBe(true);
    expect(p.fillSource).toBe('none');
  });

  it('flags a missing envelope id', () => {
    expect(projectEnvelopeBalance(baseInput({ envelopeId: '' })).unresolved).toBe(true);
  });

  it('leaves unresolved falsy on the normal path', () => {
    expect(projectEnvelopeBalance(baseInput()).unresolved).toBeFalsy();
  });
});

describe('projectEnvelopeBalance — fillDelta', () => {
  // A second income item on the same template: bi-weekly or twice-monthly pay,
  // which is common and is exactly the case that used to double the delta.
  const SALARY_EARLY = { ...SALARY_ITEM, id: 'income-salary-2', payment_day: 10 };
  const twoFills = extra => baseInput({
    budgetItems: [RENT_ITEM, SALARY_EARLY, SALARY_ITEM],
    envelopeTemplates: [tplOn(10), tplOn(25)],
    ...extra,
  });

  it('is a per-month amount split across that month\'s fills, not applied to each', () => {
    // Two 800 fills land in January. `fillDelta: 100` must lift the month by
    // 100 in total — 50 per fill — or the label ("raise the monthly fill by
    // 100") lies about the arithmetic that fixed the curve.
    const base = projectEnvelopeBalance(twoFills());
    const lifted = projectEnvelopeBalance(twoFills({ fillDelta: 100 }));

    expect(base.months[0].in).toBe(1600);
    expect(lifted.months[0].in).toBe(1700);
    expect(lifted.daily.find(d => d.date === '2026-01-10').balance)
      .toBe(base.daily.find(d => d.date === '2026-01-10').balance + 50);
  });

  it('floors a fill at zero instead of inverting it into a withdrawal', () => {
    // The trim rule bisects a negative delta upward. Without a floor the fill
    // becomes a huge withdrawal and the search converges on a trim larger than
    // the fill that exists.
    const p = projectEnvelopeBalance(baseInput({ fillDelta: -100000 }));

    expect(p.months[0].in).toBe(0);
    expect(p.months[0].out).toBe(-800); // rent only — the fill contributes nothing
    expect(p.low.balance).toBeGreaterThan(-100000);
  });

  it('floors a set-mode fill at zero as well', () => {
    const setTpl = { id: 'tpl', lines: [{ envelope_id: 'rent', mode: 'set', amount: 1000 }], schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } }, };
    const p = projectEnvelopeBalance(baseInput({
      envelopeTemplates: [setTpl], fillDelta: -100000,
    }));

    // The fill sets the balance outright, so an unclamped trim would set it to
    // -99000 rather than merely removing the fill.
    expect(p.daily.find(d => d.date === '2026-01-25').balance).toBe(0);
  });

  it('treats a non-finite delta as zero', () => {
    const base = projectEnvelopeBalance(baseInput());
    for (const bad of [NaN, Infinity, -Infinity]) {
      const p = projectEnvelopeBalance(baseInput({ fillDelta: bad }));
      expect(p.months[0].in).toBe(base.months[0].in);
      expect(p.closing).toBe(base.closing);
    }
  });

  it('never moves a fill the user has already posted', () => {
    const txs = [
      { id: 'r1', type: 'fill', date: '2026-01-20', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 500 }] },
    ];
    const p = projectEnvelopeBalance(baseInput({ transactions: txs, fillDelta: 100 }));

    // Rent -800 on the 3rd, then the untouched real fill: -800 + 500.
    expect(p.daily.find(d => d.date === '2026-01-20').balance).toBe(-300);
    // The forecast fill on the 25th absorbs the whole 100: -300 + 900.
    expect(p.daily.find(d => d.date === '2026-01-25').balance).toBe(600);
  });
});

// `monthlyFill` is read off the first WHOLE month, never the start month. The
// window opens mid-month, so the start month holds only the fills still ahead
// of today — which is why these two cases exist: both used to report a
// scheduled fill of 0 or of half the real rate, and that figure is what the
// recommendations are phrased against.
describe('projectEnvelopeBalance — monthly fill is read off a whole month', () => {
  it('does not report zero when this month\'s pay day has already passed', () => {
    // Salary lands on the 25th; project from the 26th. January therefore has
    // no fill row left, but February onward does.
    const p = projectEnvelopeBalance(baseInput({ today: new Date(2026, 0, 26) }));
    expect(p.fillSource).toBe('scheduled');
    expect(p.monthlyFill).toBe(800);
  });

  it('sums both fills for a twice-monthly schedule, even mid-month', () => {
    const second = { ...SALARY_ITEM, id: 'income-salary-2', payment_day: 10 };
    // Start on the 15th: January has only the 25th fill left, February has both.
    const p = projectEnvelopeBalance(baseInput({
      today: new Date(2026, 0, 15),
      budgetItems: [RENT_ITEM, SALARY_ITEM, second],
      envelopeTemplates: [tplOn(10), tplOn(25)],
    }));
    expect(p.fillSource).toBe('scheduled');
    expect(p.monthlyFill).toBe(1600);
  });
});

// `monthlyFill` is only a per-CALENDAR-MONTH rate when every whole month in the
// window is actually funded and every contributing line adds rather than sets.
// When it is not, the figure is still the best one available for display, but
// it is not a rate anyone can be advised to adjust — so the source says so and
// the rules decline to phrase per-month advice against it.
describe('projectEnvelopeBalance — irregular fill cadence', () => {
  const QUARTERLY = { Jan: true, Apr: true, Jul: true, Oct: true };

  it('flags a quarterly schedule as irregular rather than a monthly rate', () => {
    // 2400 every three months is a true rate of 800/month, but the old code
    // keyed only on months that CONTAIN a fill and reported 2400 — 3x over.
    // Meanwhile `fillDelta: 100` moves only 400/year, 3x under. The two errors
    // point in opposite directions, so no self-consistency check catches it.
    const p = projectEnvelopeBalance(baseInput({
      budgetItems: [RENT_ITEM, { ...SALARY_ITEM, monthly_schedule: { ...QUARTERLY } }],
      envelopeTemplates: [{
        id: 'tpl', lines: [{ envelope_id: 'rent', mode: 'add', amount: 2400 }],
        schedule: { enabled: true, payment_day: 25, months: { ...QUARTERLY } },
      }],
    }));
    expect(p.fillSource).toBe('scheduled-irregular');
    // No assertion on `monthlyFill` here on purpose: once the source says the
    // cadence is irregular, the figure is display-only and nothing may phrase
    // per-month advice against it.
  });

  it('flags a set-mode fill as scheduled-set, since its per-month effect is not its amount', () => {
    // A `set` line of 500 against an envelope already holding 500 moves nothing
    // at all, so summing it as if it were an add is meaningless. Since
    // 2026-09-24 it has its own source rather than `scheduled-irregular`:
    // `monthlyFill` is the top-up TARGET, and the rules phrase advice as a
    // change to it (tests/engine/set-mode-forecast.test.js).
    const p = projectEnvelopeBalance(baseInput({
      envelopeTemplates: [{ id: 'tpl', lines: [{ envelope_id: 'rent', mode: 'set', amount: 500 }], schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } }, }],
    }));
    expect(p.fillSource).toBe('scheduled-set');
    expect(p.monthlyFill).toBe(500);   // the target, not a rate
  });

  it('keeps a fully funded add-mode schedule on the plain `scheduled` source', () => {
    const p = projectEnvelopeBalance(baseInput());
    expect(p.fillSource).toBe('scheduled');
  });

  it('does not read the monthly fill off the TRAILING partial month', () => {
    // Window 2026-01-16 .. 2027-01-15. An annual bonus paying on 2027-01-05
    // lands in the trailing partial bucket and nowhere else. Excluding only the
    // START month — as `k > startMonth` did — selects it, and the envelope is
    // told its monthly fill is 5000.
    const p = projectEnvelopeBalance(baseInput({
      today: new Date(2026, 0, 16),
      budgetItems: [
        RENT_ITEM,
        { ...SALARY_ITEM, payment_day: 5, monthly_schedule: { Jan: true } },
      ],
      envelopeTemplates: [{
        id: 'tpl', lines: [{ envelope_id: 'rent', mode: 'add', amount: 5000 }],
        schedule: { enabled: true, payment_day: 5, months: { Jan: true } },
      }],
    }));
    expect(p.months.filter(m => m.partial).map(m => m.key)).toEqual(['2026-01', '2027-01']);
    expect(p.fillSource).toBe('scheduled-irregular');
    // No WHOLE month in the window is funded, so there is no monthly rate to
    // report at all. Reporting the bonus as if it arrived every month is the
    // defect; reporting 0 alongside an `irregular` source is the honest answer.
    expect(p.monthlyFill).toBe(0);
  });
});

describe('projectEnvelopeBalance — fill source', () => {
  it('reports a scheduled fill and its monthly amount', () => {
    const p = projectEnvelopeBalance(baseInput());
    expect(p.fillSource).toBe('scheduled');
    expect(p.monthlyFill).toBe(800);
  });

  // §2.8 — the median is over the trailing six MONTHS, so every one of the
  // six contributes a sample and an unfunded month contributes a zero. These
  // three tests are about median-not-mean, per-envelope scoping and
  // `is_estimate` tagging respectively, none of which is about sparseness, so
  // they fund all six months. The sparse case has its own test below.
  //
  // 100, 100, 300, 300, 900, 900 → median 300, mean 433.33.
  const SIX_FUNDED_MONTHS = [
    { id: 'h1', type: 'fill', date: '2025-08-15', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 100 }] },
    { id: 'h2', type: 'fill', date: '2025-09-15', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 100 }] },
    { id: 'h3', type: 'fill', date: '2025-10-15', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 300 }] },
    { id: 'h4', type: 'fill', date: '2025-11-15', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 300 }] },
    { id: 'h5', type: 'fill', date: '2025-12-15', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }] },
    { id: 'h6', type: 'fill', date: '2026-01-01', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }] },
  ];

  it('falls back to the median of the trailing six months of real fills', () => {
    // Six funded months of 100/100/300/300/900/900 → median 300, not the
    // 433.33 mean. A single catch-up top-up must not set the forward
    // expectation.
    const txs = SIX_FUNDED_MONTHS;
    const p = projectEnvelopeBalance(baseInput({
      transactions: txs,
      budgetItems: [RENT_ITEM],       // rent still scheduled, no income template
      envelopeTemplates: [],
    }));

    expect(p.fillSource).toBe('history');
    expect(p.monthlyFill).toBe(300);
    // The estimate is injected, so the envelope receives money each month.
    // February, not January: h6 already funded January today, and the
    // fallback no longer funds a month twice (QA 2026-09-23 #5).
    expect(p.months[0].in).toBe(0);
    expect(p.months[1].in).toBe(300);
  });

  it('reports no fill at all when there is neither a schedule nor history', () => {
    const p = projectEnvelopeBalance(baseInput({
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
    }));
    expect(p.fillSource).toBe('none');
    expect(p.monthlyFill).toBe(0);
    expect(p.months[0].in).toBe(0);
  });

  it('ignores fills older than the six-month window', () => {
    const txs = [
      { id: 'old', type: 'fill', date: '2024-01-15', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 999 }] },
    ];
    const p = projectEnvelopeBalance(baseInput({
      transactions: txs, budgetItems: [RENT_ITEM], envelopeTemplates: [],
    }));
    expect(p.fillSource).toBe('none');
  });

  it('does not claim a scheduled fill when the template funds a different envelope', () => {
    // A scheduled fill exists in the window, but none of its lines touch this
    // envelope. "A fill is scheduled somewhere" is not the question — "is THIS
    // envelope scheduled to be filled" is.
    const otherTpl = { id: 'tpl', lines: [{ envelope_id: 'food', mode: 'add', amount: 500 }], schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } }, };
    const txs = SIX_FUNDED_MONTHS;
    const p = projectEnvelopeBalance(baseInput({
      transactions: txs,
      envelopes: [...ENVELOPES, { id: 'food', name: 'Food' }],
      envelopeTemplates: [otherTpl],
    }));

    expect(p.fillSource).toBe('history');
    expect(p.monthlyFill).toBe(300);
  });

  it('tags synthetic fills as estimates so the fillDelta knob can move them', () => {
    // `is_estimate` is what makes a synthetic row adjustable. Without it the
    // recommendation bisection cannot move the only money the envelope gets,
    // and every history-funded envelope would look unfixable.
    const txs = SIX_FUNDED_MONTHS;
    const withHistory = extra => baseInput({
      transactions: txs, budgetItems: [RENT_ITEM], envelopeTemplates: [], ...extra,
    });

    const base = projectEnvelopeBalance(withHistory());
    const lifted = projectEnvelopeBalance(withHistory({ fillDelta: 100 }));

    expect(base.events.some(e => e.tx.is_estimate === true)).toBe(true);
    // months[1]: January is already funded by h6 (see above).
    expect(base.months[1].in).toBe(300);
    expect(lifted.months[1].in).toBe(400);
  });
});

describe('projectEnvelopeBalance — rollover policies', () => {
  const txs = [
    { id: 'f1', type: 'fill', date: '2025-12-28', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 2000 }] },
  ];

  it('carries the balance across month ends by default', () => {
    const p = projectEnvelopeBalance(baseInput({ transactions: txs }));
    // 2000 opening, rent -800 and fill +800 each month → flat 2000 at month end.
    expect(p.months[0].closing).toBe(2000);
    expect(p.months[1].closing).toBe(2000);
  });

  it('sweeps a positive balance to zero for a zero-monthly envelope', () => {
    const p = projectEnvelopeBalance(baseInput({
      transactions: txs,
      envelopes: [{ id: 'rent', name: 'Rent', rollover: 'zero-monthly' }],
    }));
    expect(p.months[0].closing).toBe(0);
    // The sweep leaves the envelope, so it must be booked as outflow: rent
    // -800 plus the 2000 swept at month end.
    expect(p.months[0].out).toBe(-2800);
    // February then opens empty, so rent on the 3rd takes it negative.
    expect(p.daily.find(d => d.date === '2026-02-03').balance).toBe(-800);
  });

  it('lifts a negative balance to zero for a cover-from-unallocated envelope', () => {
    // No income item, so nothing ever fills the envelope and January genuinely
    // ends at -800. With a fill on the 25th the month squares itself and the
    // assertion holds whether or not the cover branch exists at all.
    const p = projectEnvelopeBalance(baseInput({
      transactions: [],
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
      envelopes: [{ id: 'rent', name: 'Rent', rollover: 'cover-from-unallocated' }],
    }));

    expect(p.daily.find(d => d.date === '2026-01-03').balance).toBe(-800);
    expect(p.daily.find(d => d.date === '2026-01-31').balance).toBe(0);
    expect(p.months[0].closing).toBe(0);
    // The cover is money arriving from unallocated, so it must be booked as
    // inflow — not conjured by resetting the running balance.
    expect(p.months[0].in).toBe(800);
  });

  it('never lets a zero-monthly envelope accumulate across the window', () => {
    const p = projectEnvelopeBalance(baseInput({
      transactions: txs,
      envelopes: [{ id: 'rent', name: 'Rent', rollover: 'zero-monthly' }],
    }));
    expect(p.months.every(m => m.closing <= 0)).toBe(true);
  });
});

// Most budget items are NOT `as_schedule` — they are planned spend the user
// records by hand. The projection originally forecast only auto-posting items,
// so an envelope funded for quarterly spending showed the funding and none of
// the spending, and read as permanently over-funded.
describe('projectEnvelopeBalance — planned (non-scheduled) spend', () => {
  const NO_MONTHS = {
    Jan: false, Feb: false, Mar: false, Apr: false, May: false, Jun: false,
    Jul: false, Aug: false, Sep: false, Oct: false, Nov: false, Dec: false,
  };
  // The reported case: 70 every three months, not a scheduled transaction.
  const HAIR_ITEM = {
    id: 'bi-hair', envelope_id: 'hair', description: 'Hairdresser',
    default_amount: 70, include: true, payment_day: 20,
    monthly_schedule: { ...NO_MONTHS, Jan: true, Apr: true, Jul: true, Oct: true },
  };
  const HAIR_ENVELOPES = [{ id: 'hair', name: 'Hairdresser' }];
  const HAIR_TPL = { id: 'tpl', lines: [{ envelope_id: 'hair', mode: 'add', amount: 25 }], schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } }, };

  function hairInput(extra = {}) {
    return {
      envelopeId: 'hair',
      transactions: [],
      budgetItems: [HAIR_ITEM, { ...SALARY_ITEM }],
      envelopeTemplates: [HAIR_TPL],
      accounts: ACCOUNTS,
      envelopes: HAIR_ENVELOPES,
      today: TODAY,
      months: 12,
      ...extra,
    };
  }

  it('charges a quarterly planned item on its payment day', () => {
    const p = projectEnvelopeBalance(hairInput());

    const out = p.months.filter(m => m.out < -0.005).map(m => m.key);
    expect(out).toEqual(['2026-01', '2026-04', '2026-07', '2026-10']);
    expect(p.months[0].out).toBe(-70);
  });

  it('no longer reads as endlessly accumulating once the spend is counted', () => {
    // 25/month in, 70 every three months out — net positive, but the closing
    // balance must reflect the outflow rather than 12 months of pure fills.
    const p = projectEnvelopeBalance(hairInput());
    const fillsOnly = 25 * 12;          // 300 if the spend were ignored

    expect(p.closing).toBeLessThan(fillsOnly);
    expect(p.closing).toBe(fillsOnly - 70 * 4);   // 300 − 280 = 20
  });

  it('nets this month\'s plan against spending already recorded by hand', () => {
    // Paid the hairdresser early, on the 5th, before the 20th it is planned for.
    const txs = [
      { id: 'paid', type: 'expense', date: '2026-01-05', status: 'posted',
        amount: 70, envelope_id: 'hair', account: 'a1' },
    ];
    const p = projectEnvelopeBalance(hairInput({ today: new Date(2026, 0, 10), transactions: txs }));

    // January's plan is already met — charging it again would double-count.
    expect(p.months[0].out).toBe(0);
    // April is untouched: netting applies to the current month only.
    const april = p.months.find(m => m.key === '2026-04');
    expect(april.out).toBe(-70);
  });

  it('nets only partially when the hand-recorded spend is smaller than the plan', () => {
    const txs = [
      { id: 'part', type: 'expense', date: '2026-01-05', status: 'posted',
        amount: 30, envelope_id: 'hair', account: 'a1' },
    ];
    const p = projectEnvelopeBalance(hairInput({ today: new Date(2026, 0, 10), transactions: txs }));

    expect(p.months[0].out).toBe(-40);
  });

  it('does not net against spending that a scheduled item already dedups', () => {
    // Carries from_budget, so key dedup handles it; netting too would remove
    // the plan twice over.
    const txs = [
      { id: 'sched', type: 'expense', date: '2026-01-05', status: 'posted',
        amount: 70, envelope_id: 'hair', account: 'a1', from_budget: 'other-item:2026-01' },
    ];
    const p = projectEnvelopeBalance(hairInput({ today: new Date(2026, 0, 10), transactions: txs }));

    expect(p.months[0].out).toBe(-70);
  });

  it('does not let an incoming fill count as spending when netting', () => {
    const txs = [
      { id: 'f', type: 'fill', date: '2026-01-05', status: 'posted',
        lines: [{ envelope_id: 'hair', mode: 'add', amount: 500 }] },
    ];
    const p = projectEnvelopeBalance(hairInput({ today: new Date(2026, 0, 10), transactions: txs }));

    expect(p.months[0].out).toBe(-70);
  });

  it('still reports a shortfall date for an underfunded planned envelope', () => {
    // 5/month in against 70 a quarter out — it must eventually go negative.
    const thinTpl = { id: 'tpl', lines: [{ envelope_id: 'hair', mode: 'add', amount: 5 }], schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } }, };
    const p = projectEnvelopeBalance(hairInput({ envelopeTemplates: [thinTpl] }));

    expect(p.firstNegative).not.toBeNull();
    expect(p.low.balance).toBeLessThan(0);
  });
});
