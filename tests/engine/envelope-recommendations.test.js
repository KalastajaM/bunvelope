// Recommendation amounts are verified by re-projection, not derived. The
// set-mode case is why: adding money to an envelope whose fill overwrites the
// balance changes nothing at all, and an arithmetic shortcut would happily
// recommend a number that does not work.

import { describe, it, expect } from 'vitest';
import { projectEnvelopeBalance, recommendEnvelopeActions } from '../../js/engine.js';

const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
const ENVELOPES = [{ id: 'rent', name: 'Rent' }];
const ALL_MONTHS = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const TODAY = new Date(2026, 0, 1);

// A start on the 1st is the ONE date that yields 12 whole month buckets, and
// every partial-bucket defect lives in the 30 days it never exercises. The core
// rules are asserted under both a 1st-of-month and a mid-month window; anything
// whose expected NUMBER depends on which bills fall inside the window stays
// pinned to a single start date and says so.
const START_DATES = [
  ['on the 1st', new Date(2026, 0, 1)],
  ['mid-month', new Date(2026, 0, 16)],
];

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

// One month of rent already sitting in the envelope. Without it the fixture is
// degenerate: rent leaves on the 3rd and the fill lands on the 25th, so the
// FIRST bill is paid out of an empty envelope and the projection is -800 on
// 2026-01-03 no matter how generous the fill is. Every scenario would read as
// `critical`, and no monthly-fill increase could ever repair January — the
// money arrives three weeks too late. The opening balance is what makes the
// steady state the thing under test.
const OPENING_DEFAULT = 800;

function inputWith({
  fillAmount = 800, transactions = null, envelopes = ENVELOPES, mode = 'add',
  opening = OPENING_DEFAULT, today = TODAY,
} = {}) {
  const openingTxs = opening > 0
    ? [{
      id: 'opening', type: 'fill', date: '2025-12-28', status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: opening }],
    }]
    : [];
  return {
    envelopeId: 'rent',
    transactions: transactions || openingTxs,
    budgetItems: [RENT_ITEM, SALARY_ITEM],
    // Self-scheduled on day 25 — the date the salary used to drive when the
    // fill was a leg of the income occurrence, so the fixture's intra-month
    // shape (rent out on the 3rd, funding three weeks later) is unchanged.
    envelopeTemplates: [{
      id: 'tpl',
      lines: [{ envelope_id: 'rent', mode, amount: fillAmount }],
      schedule: { enabled: true, payment_day: 25, months: { ...ALL_MONTHS } },
    }],
    accounts: ACCOUNTS,
    envelopes,
    today,
    months: 12,
  };
}

const byKind = (recs, kind) => recs.find(r => r.kind === kind);

describe.each(START_DATES)('recommendEnvelopeActions — core rules (window starting %s)', (_label, today) => {
  const mk = (opts = {}) => inputWith({ ...opts, today });

  it('emits both a top-up and a monthly-increase when the envelope goes negative', () => {
    // Fill 700 against rent 800 → loses 100/month, negative within the year.
    const input = mk({ fillAmount: 700 });
    const recs = recommendEnvelopeActions(input);

    expect(byKind(recs, 'shortfall-topup')).toBeTruthy();
    expect(byKind(recs, 'shortfall-monthly')).toBeTruthy();
    expect(byKind(recs, 'shortfall-topup').severity).toBe('critical');
  });

  it('recommends a top-up that actually clears the dip when applied', () => {
    const input = mk({ fillAmount: 700 });
    const rec = byKind(recommendEnvelopeActions(input), 'shortfall-topup');

    const fixed = projectEnvelopeBalance({
      ...input,
      injections: [{
        id: 'test-topup', type: 'fill', date: rec.date, status: 'scheduled',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: rec.amount }],
      }],
    });

    expect(fixed.low.balance).toBeGreaterThanOrEqual(-0.005);
  });

  it('recommends a monthly increase that actually clears the dip when applied', () => {
    const input = mk({ fillAmount: 700 });
    const rec = byKind(recommendEnvelopeActions(input), 'shortfall-monthly');

    const fixed = projectEnvelopeBalance({ ...input, fillDelta: rec.amount });
    expect(fixed.low.balance).toBeGreaterThanOrEqual(-0.005);
    // The exact figure depends on how many bills the window contains, so only
    // the pinned-date test below asserts it.
    expect(rec.amount).toBeGreaterThan(0);
  });

  it('rounds every recommended amount to a whole currency unit', () => {
    // The bisection converges on something like 1100.0244140625. That value
    // does work, so a "does it fix it?" assertion passes straight over it —
    // but it is not an amount anyone can act on. The rounding step is what
    // turns a solver output into advice, and it must round UP, never down.
    const recs = recommendEnvelopeActions(mk({ fillAmount: 700 }));
    for (const kind of ['shortfall-topup', 'shortfall-monthly']) {
      const rec = byKind(recs, kind);
      expect(Number.isInteger(rec.amount)).toBe(true);
    }
  });

  it('dates the top-up before the first day the balance falls below the floor', () => {
    const input = mk({ fillAmount: 700 });
    const base = projectEnvelopeBalance(input);
    const rec = byKind(recommendEnvelopeActions(input, base), 'shortfall-topup');

    expect(rec.date < base.firstNegative.date).toBe(true);
  });

  it('never dates a top-up before the window opens', () => {
    // `walkDays` only applies events on days strictly AFTER the window start,
    // so a top-up dated on or before day zero is silently dropped — the
    // recommendation would be verified against a projection it never touched.
    for (const opts of [{ fillAmount: 700 }, { fillAmount: 700, opening: 0 }]) {
      const input = mk(opts);
      const base = projectEnvelopeBalance(input);
      const rec = byKind(recommendEnvelopeActions(input, base), 'shortfall-topup');
      expect(rec.date > base.daily[0].date).toBe(true);
    }
  });

  it('reports null rather than a fabricated amount when no increase can work', () => {
    // Nothing funds this envelope — no template, no fill history — so there is
    // no projected fill for `fillDelta` to move and NO monthly increase fixes
    // it. A solver that hands back its own search bound instead of admitting
    // defeat produces a confident, precise, useless number.
    const input = {
      ...mk({ opening: 0 }),
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
    };
    // Since 2026-09-25 the rule does not run at all when no projected fill
    // puts money in: probing could only come back unsolvable, and the sheet
    // gave that a wrong reason ("uses a set-mode fill"). `warn-no-fill` says
    // why, and the one-time top-up still offers a number that works.
    const recs = recommendEnvelopeActions(input);

    expect(byKind(recs, 'shortfall-monthly')).toBeUndefined();
    expect(byKind(recs, 'warn-no-fill')).toBeTruthy();
    expect(byKind(recs, 'shortfall-topup').amount).toBeGreaterThan(0);
  });

  it('emits no shortfall recommendation for a healthy envelope', () => {
    const recs = recommendEnvelopeActions(mk({ fillAmount: 900 }));
    expect(byKind(recs, 'shortfall-topup')).toBeUndefined();
    expect(byKind(recs, 'shortfall-monthly')).toBeUndefined();
  });

  it('reports an unresolved envelope instead of reading its flat zero as healthy', () => {
    // An archived or missing envelope projects a flat zero. Every numeric rule
    // would call that a perfectly funded envelope with nothing to say.
    for (const envelopes of [[], [{ id: 'rent', name: 'Rent', archived: true }]]) {
      const recs = recommendEnvelopeActions(mk({ fillAmount: 700, envelopes }));
      expect(recs.map(r => r.kind)).toEqual(['warn-unresolved-envelope']);
    }
  });

  // ── C1: an envelope already below its reserve floor today ────────────────
  //
  // This is the NORMAL state of any envelope carrying an `extra_buffer` that
  // is not yet fully funded, so it is not an edge case.
  describe('when the opening balance is already below the floor', () => {
    // Opening 900 against a floor of 2000. Fill 800 matches rent 800, so the
    // envelope never climbs back to the floor on its own.
    const underFloor = () => ({
      ...mk({ fillAmount: 800, opening: 900 }),
      budgetItems: [{ ...RENT_ITEM, extra_buffer: 2000 }, SALARY_ITEM],
    });

    it('still emits a shortfall', () => {
      expect(byKind(recommendEnvelopeActions(underFloor()), 'shortfall-topup')).toBeTruthy();
    });

    it('solves a real top-up instead of declaring the shortfall unfixable', () => {
      // Day zero carries the opening balance and no future top-up can move it,
      // so a predicate that minimises over the FULL series is unsatisfiable for
      // every candidate — the solver returns null and the UI says "nothing
      // fixes this" next to a date in the past. The rules must reason over the
      // future, which is the only thing a recommendation can act on.
      const rec = byKind(recommendEnvelopeActions(underFloor()), 'shortfall-topup');

      expect(rec.meta.unsolvable).toBe(false);
      expect(rec.amount).toBeGreaterThan(0);
    });

    it('dates the top-up inside the window, and that top-up verifiably works', () => {
      const input = underFloor();
      const base = projectEnvelopeBalance(input);
      const rec = byKind(recommendEnvelopeActions(input, base), 'shortfall-topup');

      expect(rec.date > base.daily[0].date).toBe(true);

      const fixed = projectEnvelopeBalance({
        ...input,
        injections: [{
          id: 'test-topup', type: 'fill', date: rec.date, status: 'scheduled',
          lines: [{ envelope_id: 'rent', mode: 'add', amount: rec.amount }],
        }],
      });
      // Everything from the day after the window opens must clear the floor.
      const after = fixed.daily.slice(1);
      expect(Math.min(...after.map(d => d.balance))).toBeGreaterThanOrEqual(2000 - 0.005);
    });

    it('leaves projection.low reporting the true low, today included', () => {
      // The rules exclude day zero; the projection must not. "You are below
      // your floor today" is a fact the tile still has to be able to show.
      const base = projectEnvelopeBalance(underFloor());
      expect(base.low.balance).toBeLessThan(2000);
    });
  });

  // ── C2: the trim search must run in fill units, not balance units ────────
  describe('trim sizing', () => {
    it('never recommends trimming more than the fill that actually exists', () => {
      // Opening 50,000 with fill 800 == rent 800. The old bound was
      // `low - floor` — a BALANCE — while the answer is a per-month FILL
      // delta. Because oversized deltas clamp the fills at zero the predicate
      // saturates, so the search handed back its whole bound: a trim of 49,200
      // against a fill of 800, rendered as a new monthly fill of −48,400.
      const input = mk({ fillAmount: 800, opening: 50000 });
      const base = projectEnvelopeBalance(input);
      const trim = byKind(recommendEnvelopeActions(input, base), 'overfunded-trim');

      expect(trim).toBeTruthy();
      expect(trim.amount).toBeLessThanOrEqual(base.monthlyFill);
      // And the figure the UI subtracts it from must stay non-negative.
      expect(base.monthlyFill - trim.amount).toBeGreaterThanOrEqual(0);
    });

    it('recommends trimming an overfunded envelope', () => {
      // Fill 1200 against rent 800 → +400/month with no goal to justify it.
      const recs = recommendEnvelopeActions(mk({ fillAmount: 1200, opening: 2000 }));
      const trim = byKind(recs, 'overfunded-trim');

      expect(trim).toBeTruthy();
      expect(trim.severity).toBe('info');
      expect(trim.amount).toBeGreaterThan(0);
    });

    it('leaves a one-month cushion when trimming', () => {
      const input = mk({ fillAmount: 1200, opening: 2000 });
      const trim = byKind(recommendEnvelopeActions(input), 'overfunded-trim');
      const trimmed = projectEnvelopeBalance({ ...input, fillDelta: -trim.amount });

      expect(trimmed.low.balance).toBeGreaterThanOrEqual(-0.005);
    });
  });
});

describe('recommendEnvelopeActions — shortfall, pinned to a 1st-of-month window', () => {
  it('solves the exact minimum monthly increase, never one unit over', () => {
    // Fill 700 vs rent 800 from an opening of 800: the window holds 12 rents
    // and 11 fills before the low, so exactly 100/month closes it and 99 does
    // not. `Math.ceil` on a bisection that landed at 100.0000001 would say 101
    // — a precise, verified, wrong number.
    const input = inputWith({ fillAmount: 700 });
    const rec = byKind(recommendEnvelopeActions(input), 'shortfall-monthly');

    expect(rec.amount).toBe(100);
    expect(projectEnvelopeBalance({ ...input, fillDelta: 99 }).low.balance).toBeLessThan(-0.005);
  });

  it('treats the summed extra_buffer of the envelope items as the floor', () => {
    // Fill matches rent exactly, so the envelope hovers at zero — healthy at a
    // floor of 0, a shortfall at a floor of 500. Pinned: from a mid-month start
    // the first rent falls outside the window and the envelope genuinely holds
    // 800 throughout, so there is no shortfall to find.
    const withBuffer = {
      ...inputWith({ fillAmount: 800 }),
      budgetItems: [{ ...RENT_ITEM, extra_buffer: 500 }, SALARY_ITEM],
    };
    const recs = recommendEnvelopeActions(withBuffer);
    const rec = byKind(recs, 'shortfall-topup');

    expect(rec).toBeTruthy();
    expect(rec.severity).toBe('warn');   // below floor, but never below zero
  });
});

// ── I1 + I3: monthlyFill is not a rate for every cadence ───────────────────
describe('recommendEnvelopeActions — irregular fill cadence', () => {
  const QUARTERLY = { Jan: true, Apr: true, Jul: true, Oct: true };

  const quarterly = (opts = {}) => {
    const input = inputWith({ fillAmount: 2400, ...opts });
    return {
      ...input,
      budgetItems: [RENT_ITEM, { ...SALARY_ITEM, monthly_schedule: { ...QUARTERLY } }],
      // Cadence is the template's own now, not the funding income item's.
      envelopeTemplates: input.envelopeTemplates.map(tpl => ({
        ...tpl,
        schedule: { ...tpl.schedule, months: { ...QUARTERLY } },
      })),
    };
  };

  it('declines to phrase monthly advice against a quarterly fill', () => {
    // 2400 a quarter is 800/month, but `monthlyFill` reports 2400 while
    // `fillDelta: 100` moves only 400 a year. Both numbers are wrong, in
    // opposite directions — so neither may be shown as advice.
    const input = quarterly({ opening: 0 });
    const recs = recommendEnvelopeActions(input);

    expect(projectEnvelopeBalance(input).fillSource).toBe('scheduled-irregular');
    expect(byKind(recs, 'shortfall-monthly')).toBeUndefined();
    expect(byKind(recs, 'overfunded-trim')).toBeUndefined();
    expect(byKind(recs, 'warn-irregular-fill')).toBeTruthy();
    expect(byKind(recs, 'warn-irregular-fill').severity).toBe('info');
  });

  it('still offers a one-time top-up, which is meaningful at any cadence', () => {
    const recs = recommendEnvelopeActions(quarterly({ opening: 0 }));
    expect(byKind(recs, 'shortfall-topup')).toBeTruthy();
  });

  it('phrases set-mode advice as a TARGET change rather than standing down', () => {
    // A `set` line of 700 leaves an envelope already holding 700 completely
    // unmoved, so raising "the monthly fill" is not the change that helps —
    // raising the top-up target is, and `fillDelta` on a set line is exactly
    // that. Owner decision 2026-09-24: run the rule, say `fillMode: 'set'`.
    const input = inputWith({ fillAmount: 700, mode: 'set' });
    const recs = recommendEnvelopeActions(input);

    expect(projectEnvelopeBalance(input).fillSource).toBe('scheduled-set');
    const monthly = byKind(recs, 'shortfall-monthly');
    expect(monthly).toBeTruthy();
    expect(monthly.meta.fillMode).toBe('set');
    expect(byKind(recs, 'warn-irregular-fill')).toBeUndefined();
    expect(byKind(recs, 'shortfall-topup')).toBeTruthy();
  });

  it('does not warn when every whole month is funded add-mode', () => {
    const recs = recommendEnvelopeActions(inputWith({ fillAmount: 700 }));
    expect(byKind(recs, 'warn-irregular-fill')).toBeUndefined();
    expect(byKind(recs, 'shortfall-monthly')).toBeTruthy();
  });

  it('does not trim an overfunded envelope whose cadence is irregular', () => {
    // Overfunded on paper — 2400 a quarter against 800/month of rent — but
    // "trim N per month" is not a change the user can make here.
    const recs = recommendEnvelopeActions(quarterly({ opening: 5000 }));
    expect(byKind(recs, 'overfunded-trim')).toBeUndefined();
    expect(byKind(recs, 'warn-irregular-fill')).toBeTruthy();
  });
});

describe('recommendEnvelopeActions — trim, goals and warnings', () => {
  // The trim rule only fires once the projected LOW clears one month's outflow,
  // so a surplus alone is not enough — the envelope has to be carrying real
  // slack at its worst point. 2000 opening against an 800 bill is that.
  const OVERFUNDED = { fillAmount: 1200, opening: 2000 };

  // The emit-and-verify cases for the trim rule live in the start-date-
  // parameterised block above; what is left here is start-date-specific.

  it('sizes the trim cushion from whole months only', () => {
    // A window opening mid-month spans 13 buckets, and the first and last are
    // partial: January holds no rent (the 3rd is behind us) and the trailing
    // January holds only the days up to the 14th. Averaging outflow across all
    // 13 reports 9600/13 = 738.46 as "one month of spending" when the real
    // figure is 800 — so the trim rule would shave the cushion it exists to
    // protect. Only whole months count.
    const input = inputWith({ ...OVERFUNDED, today: new Date(2026, 0, 15) });
    const base = projectEnvelopeBalance(input);
    const trim = byKind(recommendEnvelopeActions(input, base), 'overfunded-trim');

    expect(base.months.filter(m => m.partial).length).toBe(2);
    expect(trim).toBeTruthy();
    expect(trim.meta.cushion).toBe(800);
  });

  it('does not recommend a trim when the envelope has a goal', () => {
    const recs = recommendEnvelopeActions(inputWith({
      ...OVERFUNDED,
      envelopes: [{ id: 'rent', name: 'Rent', goal_amount: 20000 }],
    }));
    expect(byKind(recs, 'overfunded-trim')).toBeUndefined();
  });

  it('reports a goal as on track when the projection reaches it in time', () => {
    const recs = recommendEnvelopeActions(inputWith({
      fillAmount: 1200,
      envelopes: [{ id: 'rent', name: 'Rent', goal_amount: 2000, goal_date: '2026-12-31' }],
    }));
    expect(byKind(recs, 'goal-on-track')).toBeTruthy();
    expect(byKind(recs, 'goal-shortfall')).toBeUndefined();
  });

  it('reports the monthly fill needed when a goal is missed', () => {
    const input = inputWith({
      fillAmount: 850,
      envelopes: [{ id: 'rent', name: 'Rent', goal_amount: 5000, goal_date: '2026-12-31' }],
    });
    const rec = byKind(recommendEnvelopeActions(input), 'goal-shortfall');

    expect(rec).toBeTruthy();
    expect(rec.amount).toBeGreaterThan(0);

    const fixed = projectEnvelopeBalance({ ...input, fillDelta: rec.amount });
    const atGoal = fixed.daily.filter(d => d.date <= '2026-12-31').pop();
    expect(atGoal.balance).toBeGreaterThanOrEqual(5000 - 0.005);
  });

  it('judges a goal at its goal_date, not at the end of the window', () => {
    // +400/month from an opening 800: 3200 by the end of June, 5600 by the end
    // of the window. A 4000 goal due 2026-06-30 is therefore MISSED on time and
    // met months late. Reading the balance at the window end calls that on
    // track — the one answer a deadline cannot give.
    const input = inputWith({
      fillAmount: 1200,
      envelopes: [{ id: 'rent', name: 'Rent', goal_amount: 4000, goal_date: '2026-06-30' }],
    });
    const recs = recommendEnvelopeActions(input);
    const rec = byKind(recs, 'goal-shortfall');

    expect(byKind(recs, 'goal-on-track')).toBeUndefined();
    expect(rec).toBeTruthy();
    expect(rec.meta.projected).toBeLessThan(4000);

    // And the increase it asks for has to land the goal BY the date.
    const fixed = projectEnvelopeBalance({ ...input, fillDelta: rec.amount });
    const atGoal = fixed.daily.filter(d => d.date <= '2026-06-30').pop();
    expect(atGoal.balance).toBeGreaterThanOrEqual(4000 - 0.005);
  });

  it('warns when the fill is estimated from history', () => {
    // §2.8 — the history median is over the trailing six MONTHS, so a
    // regularly hand-filled envelope needs most of those months funded to
    // produce a positive median. One fill in six months no longer counts as a
    // pattern; that case is pinned separately below.
    const txs = ['2025-10-15', '2025-11-15', '2025-12-15', '2026-01-01'].map((date, i) => ({
      id: `h${i}`, type: 'fill', date, status: 'posted',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }],
    }));
    const recs = recommendEnvelopeActions({
      ...inputWith({ transactions: txs }),
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
    });
    expect(byKind(recs, 'warn-fill-from-history')).toBeTruthy();
  });

  it('does not invent a fill pattern from a single top-up in six months', () => {
    // §2.8 — one fill used to be a "pattern": v1 medianed the fill ROWS, saw
    // 800, and synthesised twelve monthly fills the owner never intended. Five
    // unfunded months are five zero samples, so the median is 0 and the
    // envelope correctly reports no funding.
    const txs = [
      { id: 'h1', type: 'fill', date: '2025-12-15', status: 'posted',
        lines: [{ envelope_id: 'rent', mode: 'add', amount: 800 }] },
    ];
    const recs = recommendEnvelopeActions({
      ...inputWith({ transactions: txs }),
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
    });
    expect(byKind(recs, 'warn-fill-from-history')).toBeFalsy();
    expect(byKind(recs, 'warn-no-fill')).toBeTruthy();
  });

  it('warns when nothing funds the envelope at all', () => {
    const recs = recommendEnvelopeActions({
      ...inputWith({ opening: 0 }),
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
    });
    expect(byKind(recs, 'warn-no-fill')).toBeTruthy();
  });

  it('warns when no scheduled expense targets the envelope', () => {
    const recs = recommendEnvelopeActions({
      ...inputWith(),
      budgetItems: [SALARY_ITEM],
    });
    expect(byKind(recs, 'warn-no-scheduled-expenses')).toBeTruthy();
  });

  it('orders critical recommendations before informational ones', () => {
    const recs = recommendEnvelopeActions({
      ...inputWith({ fillAmount: 700, opening: 0 }),
      budgetItems: [RENT_ITEM],
      envelopeTemplates: [],
    });
    const severities = recs.map(r => r.severity);
    const rank = { critical: 0, warn: 1, info: 2 };
    const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
    expect(severities).toEqual(sorted);
    // A run that emitted only one severity would satisfy the sort trivially.
    expect(new Set(severities).size).toBeGreaterThan(1);
    expect(severities[0]).toBe('critical');
  });

  it('never emits a severity out of rank order, across every rule combination', () => {
    // NOTE: with today's rule set the sort is a no-op — the only non-`info`
    // rule emitted after the shortfall pair is `goal-shortfall`, and it is
    // mutually exclusive with the only earlier `info` emitter (`overfunded-trim`
    // requires no goal). So deleting the sort breaks nothing YET. This matrix
    // is what turns that from luck into a checked invariant: append a rule out
    // of order and one of these combinations fails.
    const rank = { critical: 0, warn: 1, info: 2 };
    const GOALS = [
      null,
      { goal_amount: 2000 },
      { goal_amount: 20000, goal_date: '2026-06-30' },
      { goal_amount: 500, goal_date: '2026-03-31' },
    ];
    let sawMultiSeverity = 0;

    for (const fillAmount of [0, 700, 800, 1200]) {
      for (const opening of [0, 800, 2000]) {
        for (const extraBuffer of [0, 500]) {
          for (const goal of GOALS) {
            for (const templated of [true, false]) {
              const input = {
                ...inputWith({
                  fillAmount,
                  opening,
                  envelopes: [{ id: 'rent', name: 'Rent', ...(goal || {}) }],
                }),
                budgetItems: [{ ...RENT_ITEM, extra_buffer: extraBuffer }, SALARY_ITEM],
                ...(templated ? {} : { envelopeTemplates: [] }),
              };
              const severities = recommendEnvelopeActions(input).map(r => r.severity);
              const sorted = [...severities].sort((a, b) => rank[a] - rank[b]);
              expect(severities).toEqual(sorted);
              if (new Set(severities).size > 1) sawMultiSeverity++;
            }
          }
        }
      }
    }

    // Guard against the matrix silently degenerating into single-severity runs,
    // which would satisfy the sort assertion without testing anything.
    expect(sawMultiSeverity).toBeGreaterThan(20);
  }, 20_000); // exhaustive over rule combinations; 5 s default times out on a loaded machine
});
