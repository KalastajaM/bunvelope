// Age of Money, owner decision 2026-10-05: one-off inflows are left out of
// the FIFO queue (engine AOM_ONE_OFF_FACTOR), and "healthy" needs the runway
// to agree (AOM_HEALTHY_RUNWAY_DAYS). Dates are ISO strings and clocks local
// calendar days, so every zone test:tz runs reads the same.
import { describe, it, expect } from 'vitest';
import {
  computeAgeOfMoney,
  computeAgeOfMoneyDetailed,
  computeAgeOfMoneyHistory,
  computeMoneyCushion,
  aomOneOffIncomes,
  AOM_ONE_OFF_FACTOR,
  AOM_HEALTHY_RUNWAY_DAYS,
} from '../../js/engine.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const REF = at(2026, 10, 31);
const inc = (id, date, amount) => ({ id, type: 'income', date, amount, account: 'chk' });
const exp = (id, date, amount) => ({ id, type: 'expense', date, amount, account: 'chk' });
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

/** Pay 3000 on the 25th, Oct 2025 – Sep 2026; spend 2900 on the 10th, Nov 2025 – Oct 2026. */
function regular() {
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const y = 2025 + Math.floor((9 + i) / 12);
    const m = ((9 + i) % 12) + 1;
    rows.push(inc(`pay${i}`, `${ym(y, m)}-25`, 3000));
    const y2 = 2025 + Math.floor((10 + i) / 12);
    const m2 = ((10 + i) % 12) + 1;
    rows.push(exp(`spend${i}`, `${ym(y2, m2)}-10`, 2900));
  }
  return rows;
}

describe('one-off inflows', () => {
  it('a sale far above the usual monthly income does not make the money look old', () => {
    const base = regular();
    const withSale = [...base, inc('sale', '2026-03-01', 50000)];
    expect(computeAgeOfMoney(withSale, REF, 30)).toBe(computeAgeOfMoney(base, REF, 30));
    expect(computeAgeOfMoney(base, REF, 30)).not.toBeNull();
    expect(aomOneOffIncomes(withSale)).toEqual([{ txId: 'sale', date: '2026-03-01', amount: 50000 }]);
  });

  it(`the line is ${AOM_ONE_OFF_FACTOR}x the median monthly income of the 12 months before: a bonus stays in`, () => {
    // March's own income does not count towards its median (Oct–Feb: 3000 each).
    const at3x = [...regular(), inc('bonus', '2026-03-01', 9000)];
    expect(aomOneOffIncomes(at3x)).toEqual([]);
    const above = [...regular(), inc('bonus', '2026-03-01', 9000.01)];
    expect(aomOneOffIncomes(above).map(o => o.txId)).toEqual(['bonus']);
  });

  it('leaves nothing out with under three months of income history', () => {
    const early = [inc('p1', '2025-10-25', 3000), inc('p2', '2025-11-25', 3000), inc('big', '2025-12-05', 50000)];
    expect(aomOneOffIncomes(early)).toEqual([]);
    expect(aomOneOffIncomes([...early, inc('p3', '2025-12-25', 3000), inc('big2', '2026-01-05', 50000)]).map(o => o.txId))
      .toEqual(['big2']);
  });

  it('spending beyond the regular income draws on the one-off money instead of reading no data', () => {
    const rows = [
      inc('p1', '2025-10-25', 3000), inc('p2', '2025-11-25', 3000), inc('p3', '2025-12-25', 3000),
      inc('sale', '2026-01-05', 50000),
      exp('x1', '2025-11-10', 2900), exp('x2', '2025-12-10', 2900), exp('x3', '2026-01-10', 2900),
      exp('late', '2026-10-10', 1000),
    ];
    expect(aomOneOffIncomes(rows).map(o => o.txId)).toEqual(['sale']);
    // The regular queue holds 300 by October; the other 700 comes from the sale.
    const d = computeAgeOfMoneyDetailed(rows, REF, 30);
    expect(d.starvedInWindow).toBe(false);
    expect(d.aom).not.toBeNull();
    // The sale is not an income of the window either (no income-gap cover).
    expect(d.incomes).toEqual([]);
  });

  it('the month-end history equals the headline at each month-end, one-offs and all', () => {
    const rows = [...regular(), inc('sale', '2026-03-01', 50000), exp('splurge', '2026-07-15', 12000)];
    const history = computeAgeOfMoneyHistory(rows, { refDate: REF, months: 12, windowDays: 30 });
    for (const h of history) expect(h.aom).toBe(computeAgeOfMoney(rows, h.refDate, 30));
  });
});

describe('healthy only with the runway', () => {
  // AoM 30 (green on its own): income 30 days before an expense of 100.
  const rows = [inc('i', '2026-10-01', 100), exp('e', '2026-10-31', 100)];

  it(`holds green at yellow below ${AOM_HEALTHY_RUNWAY_DAYS} days of runway, and says so`, () => {
    // Nothing left: a runway of 0 days.
    const short = computeMoneyCushion([{ id: 'chk', type: 'bank', initialBalance: 0 }], rows, REF, 30);
    expect(short.aom).toBe(30);
    expect(short).toMatchObject({ health: 'yellow', runwayLimited: true, runwayDays: 0 });
    // 300 / (100 / 30) = 90 days: exactly enough.
    const enough = computeMoneyCushion([{ id: 'chk', type: 'bank', initialBalance: 300 }], rows, REF, 30);
    expect(enough).toMatchObject({ health: 'green', runwayLimited: false, runwayDays: 90 });
  });

  it('never moves yellow or red, and leaves green alone without spending to measure', () => {
    const young = [inc('i', '2026-10-25', 100), exp('e', '2026-10-31', 100)];
    expect(computeMoneyCushion([{ id: 'chk', type: 'bank', initialBalance: 0 }], young, REF, 30))
      .toMatchObject({ health: 'red', runwayLimited: false });
    // No expense in the window: no runway, no AoM, no rating.
    expect(computeMoneyCushion([{ id: 'chk', type: 'bank', initialBalance: 0 }], [inc('i', '2026-10-01', 100)], REF, 30))
      .toMatchObject({ health: null, runwayLimited: false, runwayDays: null });
  });
});
