import { describe, it, expect } from 'vitest';
import {
  computeAgeOfMoney,
  computeAgeOfMoneyDetailed,
  computeAgeOfMoneyHistory,
  attributeAgeOfMoneyDrop,
  computeMoneyCushion,
  AOM_HEALTH_GREEN,
  AOM_HEALTH_YELLOW,
} from '../../js/engine.js';

const isoDayOffset = (base, offset) => {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

describe('computeAgeOfMoneyDetailed', () => {
  it('returns same aom as computeAgeOfMoney for the same input', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = [
      { id: 'i1', type: 'income',  date: '2026-03-01', amount: 1000 },
      { id: 'e1', type: 'expense', date: '2026-04-15', amount:  100 },
      { id: 'e2', type: 'expense', date: '2026-04-25', amount:   50 },
    ];
    const lean     = computeAgeOfMoney(txs, ref, 30);
    const detailed = computeAgeOfMoneyDetailed(txs, ref, 30);
    expect(detailed.aom).toBe(lean);
  });

  it('perExpense weights sum to recentAgeWeight', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = [
      { id: 'i1', type: 'income',  date: '2026-03-01', amount: 1000 },
      { id: 'e1', type: 'expense', date: '2026-04-10', amount:  200 },
      { id: 'e2', type: 'expense', date: '2026-04-20', amount:  100 },
    ];
    const d = computeAgeOfMoneyDetailed(txs, ref, 30);
    const sum = d.perExpense.reduce((s, e) => s + e.ageWeight, 0);
    expect(sum).toBeCloseTo(d.recentAgeWeight, 5);
  });

  it('records incomes that fall inside the window', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = [
      { id: 'i_old', type: 'income',  date: '2025-12-01', amount: 500 },
      { id: 'i_in',  type: 'income',  date: '2026-04-15', amount: 800 },
      { id: 'e1',    type: 'expense', date: '2026-04-20', amount: 100 },
    ];
    const d = computeAgeOfMoneyDetailed(txs, ref, 30);
    expect(d.incomes.length).toBe(1);
    expect(d.incomes[0].amount).toBe(800);
  });

  it('excludes is_forecast and non-posted rows', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = [
      { id: 'i1',  type: 'income',  date: '2026-03-01', amount: 1000 },
      { id: 'sf',  type: 'expense', date: '2026-04-10', amount:  500, is_forecast: true },
      { id: 'sch', type: 'expense', date: '2026-04-12', amount:  500, status: 'scheduled' },
      { id: 'e1',  type: 'expense', date: '2026-04-15', amount:  100 },
    ];
    const d = computeAgeOfMoneyDetailed(txs, ref, 30);
    expect(d.perExpense.length).toBe(1);
    expect(d.perExpense[0].txId).toBe('e1');
  });
});

describe('computeAgeOfMoneyHistory', () => {
  // Three pay days a month (1st, 10th, 20th) and steady spending, read on
  // 6 October: the pay days after it are still scheduled. Sampled at 31 Oct,
  // October's point read six days of spending and counted 10-31 Oct as a gap
  // in income, so the trend reported an "income gap" drop that never happened.
  const midMonthTxs = () => {
    const txs = [];
    for (let m = 7; m <= 10; m++) {
      const mm = String(m).padStart(2, '0');
      for (const d of ['01', '10', '20']) {
        const date = `2026-${mm}-${d}`;
        txs.push({ id: `i${mm}${d}`, type: 'income', date, amount: 1500,
          status: date <= '2026-10-06' ? 'posted' : 'scheduled' });
      }
      txs.push({ id: `s${mm}`, type: 'expense', date: `2026-${mm}-02`, amount: 2500,
        status: `2026-${mm}-02` <= '2026-10-06' ? 'posted' : 'scheduled' });
      for (let d = 3; d <= 28; d += 3) {
        const date = `2026-${mm}-${String(d).padStart(2, '0')}`;
        if (date <= '2026-10-06') txs.push({ id: `e${mm}${d}`, type: 'expense', date, amount: 200 });
      }
    }
    return txs;
  };

  it("samples the reference date's own month at the reference date", () => {
    const ref = new Date(2026, 9, 6, 12);
    const txs = midMonthTxs();
    const h = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 3 });
    expect(h.map(s => s.monthKey)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(h[1].refDate.getDate()).toBe(30);
    expect(h[2].refDate.getDate()).toBe(6);
    expect(h[2].aom).toBe(computeAgeOfMoney(txs, ref, 30));
    expect(h[1].aom).toBe(computeAgeOfMoney(txs, new Date(2026, 8, 30, 12), 30));
  });

  it('a month still running reports no income gap past the reference date', () => {
    const ref = new Date(2026, 9, 6, 12);
    const txs = midMonthTxs();
    const h = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 2 });
    const r = attributeAgeOfMoneyDrop(
      computeAgeOfMoneyDetailed(txs, h[0].refDate, 30),
      computeAgeOfMoneyDetailed(txs, h[1].refDate, 30),
    );
    expect(r?.kind).not.toBe('income_gap');
    const curr = computeAgeOfMoneyDetailed(txs, h[1].refDate, 30);
    expect(curr.refDate.getDate()).toBe(6);
  });

  it('a reference date on the last day of its month samples that day', () => {
    const ref = new Date(2026, 8, 30, 12);
    const h = computeAgeOfMoneyHistory(midMonthTxs(), { refDate: ref, months: 2 });
    expect(h.map(s => [s.monthKey, s.refDate.getDate()])).toEqual([['2026-08', 31], ['2026-09', 30]]);
  });

  it('returns `months` samples, oldest first, with monthKey + refDate', () => {
    const ref = new Date('2026-04-30T00:00:00');
    const txs = [
      { id: 'i1', type: 'income',  date: '2025-01-01', amount: 5000 },
      { id: 'e1', type: 'expense', date: '2026-04-15', amount:   50 },
    ];
    const h = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 6 });
    expect(h.length).toBe(6);
    expect(h[0].monthKey < h[5].monthKey).toBe(true);
    expect(h[5].monthKey).toBe('2026-04');
  });

  it('preserves null samples (insufficient data) rather than zeroing them', () => {
    const ref = new Date('2026-04-30T00:00:00');
    // Only one expense, no income — every window is starved or empty.
    const txs = [
      { id: 'e1', type: 'expense', date: '2026-04-15', amount: 100 },
    ];
    const h = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 3 });
    expect(h.every(p => p.aom === null)).toBe(true);
  });

  it('shows a buffer building up over time as income lands before spending', () => {
    const ref = new Date('2026-04-30T00:00:00');
    // Income arrives on the 1st each month, spending on the 15th — the gap
    // between income and spend grows AoM-wise as income is consumed FIFO.
    const txs = [];
    for (let m = 0; m < 6; m++) {
      const month = String(m + 1).padStart(2, '0');
      txs.push({ id: 'i' + m, type: 'income',  date: `2026-${month}-01`, amount: 1000 });
      txs.push({ id: 'e' + m, type: 'expense', date: `2026-${month}-15`, amount:  500 });
    }
    const h = computeAgeOfMoneyHistory(txs, { refDate: ref, months: 6 });
    const last = h[h.length - 1].aom;
    const first = h.find(p => p.aom != null)?.aom;
    expect(last).not.toBeNull();
    expect(first).not.toBeNull();
    expect(last).toBeGreaterThanOrEqual(first);
  });
});

describe('attributeAgeOfMoneyDrop', () => {
  const baseRef = new Date('2026-04-30T00:00:00');

  it('returns null when the drop is below threshold', () => {
    const prev = { aom: 30, perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    const curr = { aom: 27, perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    expect(attributeAgeOfMoneyDrop(prev, curr)).toBeNull();
  });

  it('flags big_expense when one expense holds >=40% of weight', () => {
    const prev = { aom: 30, perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    const curr = {
      aom: 15,
      perExpense: [
        { txId: 'big', amount: 400, ageDays: 60, ageWeight: 24000 },
        { txId: 's1',  amount:  50, ageDays: 10, ageWeight:   500 },
        { txId: 's2',  amount:  50, ageDays: 10, ageWeight:   500 },
      ],
      incomes: [{ date: new Date('2026-04-10'), amount: 1000 }],
      refDate: baseRef,
      windowDays: 30,
    };
    const r = attributeAgeOfMoneyDrop(prev, curr);
    expect(r.kind).toBe('big_expense');
    expect(r.txId).toBe('big');
    expect(r.share).toBeGreaterThanOrEqual(0.4);
  });

  it('flags income_gap when no income for >=14d', () => {
    const prev = { aom: 30, perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    const curr = {
      aom: 12,
      perExpense: [
        { txId: 'a', amount: 100, ageDays: 10, ageWeight: 1000 },
        { txId: 'b', amount: 100, ageDays: 12, ageWeight: 1200 },
        { txId: 'c', amount: 100, ageDays: 14, ageWeight: 1400 },
      ],
      // No incomes inside the window at all -> max gap is the full 30 days.
      incomes: [],
      refDate: baseRef,
      windowDays: 30,
    };
    const r = attributeAgeOfMoneyDrop(prev, curr);
    expect(r.kind).toBe('income_gap');
    expect(r.gapDays).toBeGreaterThanOrEqual(14);
  });

  it('falls through to broad_shift when no clear cause', () => {
    const prev = { aom: 30, perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    // Many small expenses + frequent income -> no big-expense, no income gap.
    const incomes = [];
    for (let i = 0; i < 30; i += 3) {
      incomes.push({ date: new Date(baseRef.getTime() - (29 - i) * 86400000), amount: 100 });
    }
    const perExpense = [];
    for (let i = 0; i < 10; i++) {
      perExpense.push({ txId: 't' + i, amount: 50, ageDays: 5, ageWeight: 250 });
    }
    const curr = { aom: 18, perExpense, incomes, refDate: baseRef, windowDays: 30 };
    const r = attributeAgeOfMoneyDrop(prev, curr);
    expect(r.kind).toBe('broad_shift');
  });

  it('returns null when either side has null aom', () => {
    const prev = { aom: null, perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    const curr = { aom: 10,   perExpense: [], incomes: [], refDate: baseRef, windowDays: 30 };
    expect(attributeAgeOfMoneyDrop(prev, curr)).toBeNull();
  });
});

describe('computeMoneyCushion', () => {
  const refDate = new Date('2026-04-30T00:00:00');

  it('classifies health bands at 30 / 14 boundaries', () => {
    // Enough cash for a long runway (1000 / (100 / 30) = 300 days), so the
    // runway does not hold green back (see the next test).
    const accounts = [{ id: 'a1', initialBalance: 1000 }];
    const mk = (aomTarget) => {
      // Build a fixture that yields a specific AoM by spacing one income/expense.
      // Income on day -aomTarget, expense today, both posted.
      const incomeDate = isoDayOffset(refDate, -aomTarget);
      const expenseDate = isoDayOffset(refDate, 0);
      return [
        { id: 'i', type: 'income',  date: incomeDate,  amount: 100, account: 'a1' },
        { id: 'e', type: 'expense', date: expenseDate, amount: 100, account: 'a1' },
      ];
    };
    expect(computeMoneyCushion(accounts, mk(30), refDate, 30).health).toBe('green');
    expect(computeMoneyCushion(accounts, mk(14), refDate, 30).health).toBe('yellow');
    expect(computeMoneyCushion(accounts, mk(13), refDate, 30).health).toBe('red');
    expect(computeMoneyCushion(accounts, [],     refDate, 30).health).toBeNull();
  });

  // ux-review U2 (owner decision 2026-09-23): the runway is the spending
  // accounts, credit cards included (their debt is money already spent), and
  // never pension.
  it('counts the spending accounts, card debt included, and skips archived ones', () => {
    const accounts = [
      { id: 'cash', initialBalance: 1000 },
      { id: 'cc',   initialBalance: -500, type: 'credit_card' },
      { id: 'old',  initialBalance: 9999, archived: true },
    ];
    const txs = [
      { id: 'e1', type: 'expense', date: isoDayOffset(refDate, -5), amount: 100, account: 'cash' },
    ];
    const c = computeMoneyCushion(accounts, txs, refDate, 30);
    // 1000 - 100 on 'cash', -500 on the card.
    expect(c.liquidBalance).toBe(400);
  });

  it('leaves savings, investments, pension and opted-out accounts out of the runway', () => {
    const accounts = [
      { id: 'cash',    initialBalance: 1000, type: 'bank' },
      { id: 'sav',     initialBalance: 5000, type: 'savings' },
      { id: 'fund',    initialBalance: 7000, type: 'investment' },
      { id: 'pension', initialBalance: 9000, type: 'investment', pensionInsurance: true },
      { id: 'broker',  initialBalance: 250,  type: 'bank', spending: false },
      { id: 'wallet',  initialBalance: 40,   type: 'savings', spending: true },
    ];
    const c = computeMoneyCushion(accounts, [], refDate, 30);
    expect(c.liquidBalance).toBe(1040);
  });

  it('runwayDays is null when there is no recent spend', () => {
    const accounts = [{ id: 'a1', initialBalance: 1000 }];
    const c = computeMoneyCushion(accounts, [], refDate, 30);
    expect(c.runwayDays).toBeNull();
    expect(c.recentSpendPerDay).toBe(0);
  });

  it('runwayDays = floor(liquid / spendPerDay)', () => {
    const accounts = [{ id: 'a1', initialBalance: 1000 }];
    const txs = [
      // 30 euros spread over 30 days => 1 €/day.
      { id: 'e1', type: 'expense', date: isoDayOffset(refDate, -10), amount: 30, account: 'a1' },
    ];
    const c = computeMoneyCushion(accounts, txs, refDate, 30);
    expect(c.recentSpendPerDay).toBeCloseTo(1, 5);
    // liquid = 1000 - 30 = 970, runway = 970.
    expect(c.runwayDays).toBe(970);
  });

  it('exposes thresholds as exported constants', () => {
    expect(AOM_HEALTH_GREEN).toBe(30);
    expect(AOM_HEALTH_YELLOW).toBe(14);
  });
});
