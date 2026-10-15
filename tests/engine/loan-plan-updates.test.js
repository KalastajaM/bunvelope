// A loan's plan item follows the loan (owner decision 2026-10-02, applied on
// opening the budget): disabled once repaid, the months after a payoff in the
// coming year switched off (and back on if the payoff moves later), and a
// calculated payment kept current. Also: the projection's due backlog no
// longer charges a repaid loan, or the plan amount of a calculated one.
import { describe, it, expect } from 'vitest';
import { loanPlanUpdates, projectEnvelopeBalance } from '../../js/engine.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = Object.fromEntries(MONTHS.map(m => [m, true]));
const chk = { id: 'chk', type: 'bank', initialBalance: 0 };
const loan = (owed, over = {}) => ({ id: 'mtg', type: 'loan', initialBalance: -owed, interestRates: [{ from: '2020-01-01', rate: 3 }], interestDayCount: '30/360', ...over });
const envelopes = [{ id: 'housing', name: 'Housing' }];
const item = (over = {}) => ({
  id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg',
  default_amount: -1000, monthly_schedule: everyMonth, payment_day: 5, as_schedule: true, as_schedule_since: '2026-09-01',
  include: true, schedule_day_type: 'exact', ...over,
});
const paid = (date, amount) => ({ id: `p-${date}`, type: 'debt_payment', date, amount, from_account: 'chk', to_account: 'mtg', envelope_id: 'housing', status: 'posted' });
const TODAY = new Date(2026, 8, 20); // 20 Sep 2026
const updates = (items, owed, txs = [], today = TODAY) => loanPlanUpdates({
  budgetItems: items, accounts: [chk, loan(owed)], transactions: txs, today,
});

describe('loanPlanUpdates', () => {
  it('disables the item of a repaid loan, noting when it was paid off', () => {
    const out = updates([item()], 5000, [paid('2026-08-05', 4000), paid('2026-09-05', 1000)]);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('repaid');
    expect(out[0].item).toMatchObject({ include: false, loan_paid_off: '2026-09-05' });
  });

  it('leaves a loan with nothing ever paid into it alone (not drawn yet)', () => {
    expect(updates([item()], 0)).toEqual([]);
  });

  it('respects an item re-enabled by hand after the payoff', () => {
    const reEnabled = item({ include: true, loan_paid_off: '2026-09-05' });
    expect(updates([reEnabled], 5000, [paid('2026-09-05', 5000)])).toEqual([]);
  });

  it('switches off the months after a payoff within the year, and keeps what they were', () => {
    // 3,000 left at 1,000 a month and 3 %: Oct, Nov and Dec leave about 22,
    // which Jan 2027 pays off (Sep is already posted).
    const posted = { ...paid('2026-09-05', 1000), from_budget: 'mortgage:2026-09' };
    const out = updates([item()], 4000, [posted]);
    expect(out).toHaveLength(1);
    const next = out[0].item;
    // Feb to Aug 2027 are after the payoff and inside the coming year.
    expect(MONTHS.filter(m => next.monthly_schedule[m] === false)).toEqual(['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']);
    expect(next.monthly_schedule.Jan).toBe(true);
    expect(Object.keys(next.loan_months_off)).toEqual(['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']);
    // Run again on the result: nothing more to change.
    expect(loanPlanUpdates({ budgetItems: [next], accounts: [chk, loan(4000)], transactions: [posted], today: TODAY })).toEqual([]);
  });

  it('turns months back on when the payoff moves later', () => {
    const posted = { ...paid('2026-09-05', 1000), from_budget: 'mortgage:2026-09' };
    const [{ item: trimmed }] = updates([item()], 4000, [posted]);
    // A new 20,000 drawn on the loan: no payoff within the year any more.
    const drawn = { id: 'd', type: 'account_transfer', date: '2026-09-10', amount: 20000, from_account: 'mtg', to_account: 'chk' };
    const out = loanPlanUpdates({ budgetItems: [trimmed], accounts: [chk, loan(4000)], transactions: [posted, drawn], today: TODAY });
    expect(out).toHaveLength(1);
    expect(out[0].item.monthly_schedule).toEqual(everyMonth);
    expect(out[0].item).not.toHaveProperty('loan_months_off');
  });

  it('keeps a calculated payment current', () => {
    const eq = item({ loan_method: 'equal_principal', loan_end: '2051-09', default_amount: -900 });
    const out = updates([eq], 100000);
    // 100,000 over Sep 2026 – Sep 2051 (301 payments): 332.23 + 250 interest.
    expect(out[0].item.default_amount).toBe(-582.23);
    expect(updates([out[0].item], 100000)).toEqual([]);
  });

  it('leaves a fixed payment’s amount, and other kinds, alone', () => {
    expect(updates([item({ default_amount: -1000 }), { id: 'x', kind: 'expense', as_schedule: true }], 100000)).toEqual([]);
  });
});

describe('the projection does not charge a repaid loan as overdue', () => {
  const fill = { id: 'f', type: 'fill', date: '2026-09-01', status: 'posted', lines: [{ envelope_id: 'housing', mode: 'add', amount: 3000 }] };

  it('a payment due today on a repaid loan is no backlog', () => {
    const p = projectEnvelopeBalance({
      envelopeId: 'housing', transactions: [fill, paid('2026-08-05', 5000)], budgetItems: [item()],
      accounts: [chk, loan(5000)], envelopes, today: TODAY, months: 1,
    });
    expect(p.daily[0].balance).toBe(3000 - 5000);
  });

  it('an overdue calculated payment is charged at its real amount, not the plan’s', () => {
    const eq = item({ loan_method: 'equal_principal', loan_end: '2051-09', default_amount: -900 });
    const p = projectEnvelopeBalance({
      envelopeId: 'housing', transactions: [fill], budgetItems: [eq],
      accounts: [chk, loan(100000)], envelopes, today: TODAY, months: 1,
    });
    // Sep 5 is due and not posted: 582.23, not the 900 on the item.
    expect(p.daily[0].balance).toBe(round2(3000 - 582.23));
  });
});

function round2(n) { return Math.round(n * 100) / 100; }

describe('months switched off and then saved in the editor', () => {
  it('a month saved without a key (the editor’s off) still counts as switched off', () => {
    const posted = { ...paid('2026-09-05', 1000), from_budget: 'mortgage:2026-09' };
    const [{ item: trimmed }] = updates([item()], 4000, [posted]);
    // The editor writes only the active months.
    const resaved = { ...trimmed, monthly_schedule: Object.fromEntries(Object.entries(trimmed.monthly_schedule).filter(([, v]) => v)) };
    const drawn = { id: 'd', type: 'account_transfer', date: '2026-09-10', amount: 20000, from_account: 'mtg', to_account: 'chk' };
    const out = loanPlanUpdates({ budgetItems: [resaved], accounts: [chk, loan(4000)], transactions: [posted, drawn], today: TODAY });
    expect(out[0].item.monthly_schedule).toEqual(everyMonth);
  });
});
