// QA batch 2026-09-23 — forecast and scheduling findings, each reproduced
// against the real modules before it was fixed. One describe block per
// finding; the numbers in each are the ones the QA script printed.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  projectEnvelopeBalance,
  recommendEnvelopeActions,
  materializeDueBudgetItems,
  materializeDueTemplateFills,
  computeEnvelopeUpcomingDeltas,
  computeEnvelopeBalances,
  lensTransactions,
  LENS_FORECAST,
} from '../../js/engine.js';
import { _resetLensCache } from '../../js/engine/lens.js';
import { getBankingHolidays, workingDayAdjust } from '../../js/engine/scheduling.js';

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

const accounts = [{ id: 'a1', name: 'Checking', type: 'bank', initialBalance: 0 }];

beforeEach(() => _resetLensCache());

// ── 1. One hand payment netted twice ───────────────────────────────────────

describe('a hand-recorded payment settles one forecast row, not two', () => {
  const envelopes = [{ id: 'env', name: 'Home' }];
  const budgetItems = [
    {
      id: 'bi-bill', envelope_id: 'env', kind: 'expense', include: true,
      as_schedule: true, account_id: 'a1', payment_day: 15,
      default_amount: -200, monthly_schedule: { ...allMonths },
    },
    {
      id: 'bi-food', envelope_id: 'env', kind: 'expense', include: true,
      as_schedule: false, payment_day: 0, default_amount: -400,
      monthly_schedule: { ...allMonths },
    },
  ];
  const transactions = [
    { id: 'f1', type: 'fill', date: '2026-10-01', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'env', mode: 'add', amount: 1000 }] },
    // The 200 bill, paid by hand a week early — no from_budget.
    { id: 'pay', type: 'expense', date: '2026-10-08', status: 'posted',
      envelope_id: 'env', account: 'a1', amount: 200 },
  ];
  const today = new Date(2026, 9, 10);

  it('projection: the payment cancels the bill and does not also net the groceries', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'env', transactions, budgetItems, envelopeTemplates: [],
      accounts, envelopes, today, months: 1,
    });
    expect(p.opening).toBe(800);
    // 800 − 400 groceries. The bug read 600: groceries netted to 200 by the
    // same 200 that had already cancelled the bill.
    expect(p.daily.find(d => d.date === '2026-10-31').balance).toBe(400);
    // The window also includes November 1–9: 9/30 of its 400 daily plan.
    expect(p.closing).toBe(280);
  });

  it('forecast lens: same rule', () => {
    const txs = lensTransactions(
      { transactions, budgetItems, envelopeTemplates: [], accounts, envelopes, meta: {} },
      { lens: LENS_FORECAST, horizon: 'eom', today },
    );
    expect(computeEnvelopeBalances(txs).get('env')).toBe(400);
  });
});

// ── 2. Working-day shift into the next month is never posted ───────────────

describe('an occurrence shifted into the next month still posts', () => {
  const envelopes = [{ id: 'env', name: 'Rent' }];
  const item = {
    id: 'bi', envelope_id: 'env', kind: 'expense', as_schedule: true,
    account_id: 'a1', payment_day: 31, schedule_day_type: 'next_work_day',
    default_amount: -300, monthly_schedule: { ...allMonths },
  };

  it('Oct 31 2026 (Sat) → Mon Nov 2: not on Oct 31, posted on Nov 2 under 2026-10', () => {
    const early = materializeDueBudgetItems([item], accounts, envelopes, [], new Date(2026, 9, 31), () => 'x', [], 'FI');
    expect(early.newTxs.filter(t => t.from_budget === 'bi:2026-10')).toHaveLength(0);

    const { newTxs } = materializeDueBudgetItems([item], accounts, envelopes, [], new Date(2026, 10, 2), () => 'x', [], 'FI');
    const oct = newTxs.filter(t => t.from_budget === 'bi:2026-10');
    expect(oct).toHaveLength(1);
    expect(oct[0].date).toBe('2026-11-02');

    // Idempotent: once posted it is not posted again.
    const again = materializeDueBudgetItems([item], accounts, envelopes, newTxs, new Date(2026, 10, 3), () => 'y', [], 'FI');
    expect(again.newTxs).toHaveLength(0);
  });

  it('does not backfill an unshifted occurrence from last month', () => {
    const plain = { ...item, payment_day: 28, schedule_day_type: 'exact' };
    const { newTxs } = materializeDueBudgetItems([plain], accounts, envelopes, [], new Date(2026, 10, 2), () => 'x', [], 'FI');
    expect(newTxs).toHaveLength(0);
  });

  it('template fills get the same guarantee', () => {
    const tpl = {
      id: 'tpl', name: 'Month end', kind: 'manual',
      lines: [{ envelope_id: 'env', mode: 'add', amount: 100 }],
      schedule: { enabled: true, payment_day: 31, day_type: 'next_work_day', months: allMonths },
    };
    const { newTxs } = materializeDueTemplateFills([tpl], [], envelopes, [], new Date(2026, 10, 2), () => 'x', 'FI');
    const oct = newTxs.filter(t => t.from_budget === 'tpl:tpl:2026-10');
    expect(oct).toHaveLength(1);
    expect(oct[0].date).toBe('2026-11-02');
  });

  it('the projection counts it as due on Nov 2, exactly as post-due would', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'env',
      transactions: [{ id: 'f', type: 'fill', date: '2026-10-01', status: 'posted', source: 'allocation',
        lines: [{ envelope_id: 'env', mode: 'add', amount: 1000 }] }],
      budgetItems: [item], envelopeTemplates: [], accounts, envelopes,
      today: new Date(2026, 10, 2), months: 1,
    });
    expect(p.dueUnposted).toBe(300);
  });

  it('the projection sees it on Oct 31, while its payment date is still ahead', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'env',
      transactions: [{ id: 'f', type: 'fill', date: '2026-10-01', status: 'posted', source: 'allocation',
        lines: [{ envelope_id: 'env', mode: 'add', amount: 1000 }] }],
      budgetItems: [item], envelopeTemplates: [], accounts, envelopes,
      today: new Date(2026, 9, 31), months: 1,
    });
    expect(p.dueUnposted).toBe(0);
    expect(p.daily.find(d => d.date === '2026-11-02').balance).toBe(700);
  });
});

// ── 3 + 4. Day zero: shifted-back rows and today's month-end rollover ──────

describe('the window start applies what lands on it', () => {
  it('a bill prev_work_day moves onto today is charged (Sat 10-31 → Fri 10-30)', () => {
    const envelopes = [{ id: 'env', name: 'Rent' }];
    const item = {
      id: 'bi', envelope_id: 'env', kind: 'expense', as_schedule: true,
      account_id: 'a1', payment_day: 31, schedule_day_type: 'prev_work_day',
      default_amount: -300, monthly_schedule: { ...allMonths },
    };
    const fill = { id: 'f', type: 'fill', date: '2026-10-01', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'env', mode: 'add', amount: 1000 }] };
    const input = {
      envelopeId: 'env', transactions: [fill], budgetItems: [item], envelopeTemplates: [],
      accounts, envelopes, today: new Date(2026, 9, 30), months: 1,
    };
    const p = projectEnvelopeBalance(input);
    expect(p.low.balance).toBe(700);
    expect(p.daily[0].balance).toBe(700);

    // Next day post-due writes it (dated 10-30, keyed 2026-10): counted once.
    const posted = materializeDueBudgetItems([item], accounts, envelopes, [fill], new Date(2026, 9, 31), () => 'p', [], 'FI').newTxs;
    expect(posted).toHaveLength(1);
    const after = projectEnvelopeBalance({ ...input, transactions: [fill, ...posted], today: new Date(2026, 9, 31) });
    expect(after.low.balance).toBe(700);
  });

  it("today's month-end rollover applies when today is the last day", () => {
    const envelopes = [{ id: 'env', name: 'Fun', rollover: 'cover-from-unallocated' }];
    const input = {
      envelopeId: 'env',
      transactions: [{ id: 'x', type: 'expense', date: '2026-09-15', status: 'posted',
        envelope_id: 'env', account: 'a1', amount: 300 }],
      budgetItems: [], envelopeTemplates: [], accounts, envelopes,
      today: new Date(2026, 8, 30), months: 1,
    };
    const p = projectEnvelopeBalance(input);
    expect(p.daily[0].balance).toBe(0);
    expect(p.daily[1].balance).toBe(0);
    expect(p.low.balance).toBe(0);
    const recs = recommendEnvelopeActions(input, p);
    expect(recs.some(r => r.severity === 'critical')).toBe(false);
  });
});

// ── 5. History fallback funds the current month twice ──────────────────────

describe('history fill fallback respects a fill already made this month', () => {
  const fill = (id, date, amount) => ({
    id, type: 'fill', date, status: 'posted',
    lines: [{ envelope_id: 'env', mode: 'add', amount }],
  });

  it('no synthetic September fill when September is already funded', () => {
    const transactions = [
      fill('a', '2026-04-25', 500), fill('b', '2026-05-25', 500), fill('c', '2026-06-25', 500),
      fill('d', '2026-07-25', 500), fill('e', '2026-08-25', 500),
      fill('now', '2026-09-02', 500),
    ];
    const p = projectEnvelopeBalance({
      envelopeId: 'env', transactions, budgetItems: [], envelopeTemplates: [],
      accounts: [], envelopes: [{ id: 'env', name: 'Env' }], today: new Date(2026, 8, 10), months: 3,
    });
    expect(p.fillSource).toBe('history');
    const estimates = p.events.filter(e => e.tx.is_estimate).map(e => e.date);
    expect(estimates.some(d => d.startsWith('2026-09'))).toBe(false);
    expect(estimates).toContain('2026-10-25');
  });
});

// ── 6. Upcoming deltas lose the sign of a source-envelope line ─────────────

describe('computeEnvelopeUpcomingDeltas keeps line signs', () => {
  it("a source-funded fill drains the source envelope rather than filling it", () => {
    const envelopes = [{ id: 'target', name: 'T' }, { id: 'buf', name: 'Buffer' }];
    const tpl = {
      id: 'tpl', name: 'Draw', kind: 'manual',
      lines: [{ envelope_id: 'target', mode: 'add', amount: 50 }],
      schedule: { enabled: true, payment_day: 20, day_type: 'exact', months: allMonths, source_envelope_id: 'buf' },
    };
    const deltas = computeEnvelopeUpcomingDeltas([], [], accounts, envelopes, new Date(2026, 9, 10), 'FI', [tpl]);
    expect(deltas.get('target')).toBe(50);
    expect(deltas.get('buf')).toBe(-50);
  });
});

// ── 8. Bank-holiday tables ─────────────────────────────────────────────────
// Easter 2026 = Apr 5, 2027 = Mar 28. Dates are calendar facts, not derived
// from the implementation.

describe('getBankingHolidays — per-country tables', () => {
  it('US: no Easter days; Columbus and Veterans Day; Sunday holidays observed Monday', () => {
    const h = getBankingHolidays(2026, 'US');
    expect(h.has('2026-04-03')).toBe(false);  // Good Friday — Fed open
    expect(h.has('2026-04-06')).toBe(false);  // Easter Monday — Fed open
    expect(h.has('2026-10-12')).toBe(true);   // Columbus Day
    expect(h.has('2026-11-11')).toBe(true);   // Veterans Day
    // 2027-07-04 is a Sunday → observed Mon Jul 5.
    expect(getBankingHolidays(2027, 'US').has('2027-07-05')).toBe(true);
  });

  it('GB: Early May bank holiday, and Christmas substitute days', () => {
    const h = getBankingHolidays(2026, 'GB');
    expect(h.has('2026-05-04')).toBe(true);   // first Monday of May
    expect(h.has('2026-04-03')).toBe(true);   // Good Friday
    expect(h.has('2026-04-06')).toBe(true);   // Easter Monday
    // Dec 26 2026 is a Saturday → substitute Mon Dec 28.
    expect(h.has('2026-12-28')).toBe(true);
    // 2022: Dec 25 Sun, Dec 26 Mon → Christmas substitute Tue Dec 27.
    const h22 = getBankingHolidays(2022, 'GB');
    expect(h22.has('2022-12-26')).toBe(true);
    expect(h22.has('2022-12-27')).toBe(true);
    expect(workingDayAdjust('2026-12-26', 'next_work_day', 'GB')).toBe('2026-12-29');
  });

  it('EE: Good Friday, and Easter Monday as a TARGET2 closing day', () => {
    const h = getBankingHolidays(2026, 'EE');
    expect(h.has('2026-04-03')).toBe(true);
    expect(h.has('2026-04-06')).toBe(true);
  });

  it('LV: Restoration of Independence Day, with weekend transfer', () => {
    expect(getBankingHolidays(2026, 'LV').has('2026-05-04')).toBe(true);  // Monday
    // 2025-05-04 is a Sunday → Mon May 5; 2023-11-18 is a Saturday → Mon Nov 20.
    expect(getBankingHolidays(2025, 'LV').has('2025-05-05')).toBe(true);
    expect(getBankingHolidays(2023, 'LV').has('2023-11-20')).toBe(true);
    expect(getBankingHolidays(2026, 'LV').has('2026-04-06')).toBe(true);  // Easter Monday
  });

  it('LT: Easter Monday, All Souls, and Good Friday as a TARGET2 closing day', () => {
    const h = getBankingHolidays(2026, 'LT');
    expect(h.has('2026-04-03')).toBe(true);
    expect(h.has('2026-04-06')).toBe(true);
    expect(h.has('2026-11-02')).toBe(true);
  });

  it('SE and DE: no Maundy Thursday; SE National Day', () => {
    expect(getBankingHolidays(2026, 'SE').has('2026-04-02')).toBe(false);
    expect(getBankingHolidays(2026, 'DE').has('2026-04-02')).toBe(false);
    expect(getBankingHolidays(2026, 'SE').has('2026-06-06')).toBe(true);  // Saturday, harmless
    expect(getBankingHolidays(2029, 'SE').has('2029-06-06')).toBe(true);  // Wednesday
  });

  it('DK: the bank holiday after Ascension; Great Prayer Day only before 2024', () => {
    expect(getBankingHolidays(2026, 'DK').has('2026-05-15')).toBe(true);  // Ascension May 14 + 1
    expect(getBankingHolidays(2026, 'DK').has('2026-05-01')).toBe(false);
    expect(getBankingHolidays(2023, 'DK').has('2023-05-05')).toBe(true);  // Store Bededag 2023
    expect(getBankingHolidays(2024, 'DK').has('2024-04-26')).toBe(false);
  });

  it('NO: Christmas Eve and New Year\'s Eve are bank holidays', () => {
    const h = getBankingHolidays(2026, 'NO');
    expect(h.has('2026-12-24')).toBe(true);
    expect(h.has('2026-12-31')).toBe(true);
    expect(h.has('2026-04-02')).toBe(true);  // Maundy Thursday
  });

  it('FI is unchanged', () => {
    const h = getBankingHolidays(2026, 'FI');
    for (const d of ['2026-01-01', '2026-01-06', '2026-04-03', '2026-04-06', '2026-05-01',
      '2026-05-14', '2026-06-19', '2026-12-06', '2026-12-24', '2026-12-25', '2026-12-26']) {
      expect(h.has(d), d).toBe(true);
    }
  });
});

// ── 7. Forecast lens resurrects a tombstoned occurrence ────────────────────

describe('forecast lens honours scheduledTombstones', () => {
  it('a deleted occurrence does not come back as a forecast row', () => {
    const envelopes = [{ id: 'env', name: 'Fees' }];
    const budgetItems = [{
      id: 'bi-fee', envelope_id: 'env', kind: 'expense', include: true,
      as_schedule: true, account_id: 'a1', payment_day: 15,
      default_amount: -25, monthly_schedule: { ...allMonths },
    }];
    const txs = lensTransactions(
      { transactions: [], budgetItems, envelopeTemplates: [], accounts, envelopes,
        meta: { scheduledTombstones: ['bi-fee:2026-10'] } },
      { lens: LENS_FORECAST, horizon: 'eom', today: new Date(2026, 9, 10) },
    );
    expect(txs.some(t => t.forecast_budget_item_id === 'bi-fee')).toBe(false);
  });
});
