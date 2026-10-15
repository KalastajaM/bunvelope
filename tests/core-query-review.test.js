import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { monthCountry, monthTombstones } from '../js/core/month-fields.js';
import { computeEnvelopeBalances, runMonthlyReview, computeEmergencyFundRequirement, rollForwardEnvelopeBalances } from '../js/engine.js';
import { buildEffectiveTxList } from '../js/core/effective-txs.js';
import { getTombstones } from '../js/state/scheduled-tombstones.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// The page's clock is appNow(): an instant with a time of day.
const NOW = new Date(2026, 9, 10, 14, 30, 0);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (input, d, now = NOW) => runQuery(registry, d, 'review.month', input, ctxAt(now));

// ── The page's composition, copied from js/pages/review.js before task 5 ───
// buildEffectiveTxs / buildEffectiveTxsThrough / renderReview's data steps,
// with `state` and `appNow()` made parameters. Kept verbatim otherwise.
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${y}-${pad2(m)}-01`;
  const endDate = new Date(y, m, 0);
  const end = ymd(endDate);
  return { y, m, start, end };
}
function localMonthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function buildEffectiveTxs(state, month, appNow) {
  const { start, end } = monthBounds(month);
  const today = appNow();
  const todayStr = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  if (todayStr > end) return state.transactions;
  return buildEffectiveTxList({
    transactions:      state.transactions,
    budgetItems:       state.budgetItems || [],
    envelopeTemplates: state.envelopeTemplates || [],
    accounts:          state.accounts || [],
    envelopes:         state.envelopes || [],
    today,
    endStr:  end,
    fromStr: start,
    country: state.meta?.country ?? 'FI',
    tombstones: getTombstones(state.meta),
  });
}
function buildEffectiveTxsThrough(state, throughMonth, appNow) {
  const { end } = monthBounds(throughMonth);
  const today = appNow();
  const todayStr = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  if (todayStr > end) return state.transactions;
  return buildEffectiveTxList({
    transactions:      state.transactions,
    budgetItems:       state.budgetItems || [],
    envelopeTemplates: state.envelopeTemplates || [],
    accounts:          state.accounts || [],
    envelopes:         state.envelopes || [],
    today,
    endStr:  end,
    country: state.meta?.country ?? 'FI',
    tombstones: getTombstones(state.meta),
  });
}
function oldReview(state, month, now) {
  const appNow = () => new Date(now.getTime());
  const today = appNow();
  const currentMonth = localMonthKey(today);
  const isFuture = month > currentMonth;
  const isCurrent = month === currentMonth;

  const effectiveTxs = buildEffectiveTxs(state, month, appNow);
  const todaysBalances = computeEnvelopeBalances(state.transactions, { asOf: today });
  const activeEnvelopes = state.envelopes.filter(e =>
    !e.archived && !(e.name || '').startsWith('(deleted:')
  );
  const activeIds = new Set(activeEnvelopes.map(e => e.id));

  let envelopeBalances = todaysBalances;
  if (isFuture) {
    const spanTxs = buildEffectiveTxsThrough(state, month, appNow);
    envelopeBalances = rollForwardEnvelopeBalances(
      activeEnvelopes, state.budgetItems, todaysBalances, spanTxs, month, today,
    );
  }

  const rows = runMonthlyReview(
    activeEnvelopes, state.budgetItems, envelopeBalances, effectiveTxs, month, today,
  ).filter(r => activeIds.has(r.envelope_id));

  const emergencyCalc = computeEmergencyFundRequirement({
    envelopes:    state.envelopes,
    budgetItems:  state.budgetItems,
    transactions: state.transactions,
    month,
    meta:         state.meta,
  });
  if (emergencyCalc) {
    const eRow = rows.find(r => r.envelope_id === emergencyCalc.emergencyId);
    if (eRow) {
      eRow.required    = emergencyCalc.required;
      eRow.surplus     = Math.round((eRow.projected - emergencyCalc.required) * 100) / 100;
      eRow.isEmergency = true;
    }
  }
  return { isCurrent, isFuture, rows };
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Today is 10 Oct 2026.
//   rent  an auto-post bill (25th), paid by hand on 5 Oct, linked to its item:
//         the #283 case, the forecast row must net against it.
//   net   an auto-post bill (20th) whose October occurrence was deleted: a
//         tombstone, so it must not come back as a forecast row.
//   groc  a planned (hand-recorded) item of 600, 150 spent so far, plus a
//         scheduled row dated before today (overdue) and a posted row dated
//         after today (future).
//   emerg the emergency envelope when `withEmergency`.
//   old   archived; dead a "(deleted:" envelope: both left out of the rows.
const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const fixture = ({ withEmergency = false } = {}) => deepFreeze({
  meta: {
    scheduledTombstones: ['netItem:2026-10'],
    ...(withEmergency ? { emergency_envelope_id: 'emerg', emergency_duration_months: 3 } : {}),
  },
  accounts: [{ id: 'chk', name: 'Checking', type: 'checking', initialBalance: 5000 }],
  envelopes: [
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'net', name: 'Internet', category: 'Housing' },
    { id: 'groc', name: 'Groceries', category: 'Food' },
    { id: 'emerg', name: 'Emergency', category: 'Savings' },
    { id: 'old', name: 'Old', category: 'Misc', archived: true },
    { id: 'dead', name: '(deleted: x)', category: 'Misc' },
  ],
  budgetItems: [
    {
      id: 'rentItem', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
      default_amount: -1000, payment_day: 25, schedule_day_type: 'exact', include: true,
      as_schedule: true, as_schedule_since: '2026-01-01', monthly_schedule: ALL_MONTHS,
      include_in_emergency_budget: true,
    },
    {
      id: 'netItem', kind: 'expense', description: 'Internet', envelope_id: 'net', account_id: 'chk',
      default_amount: -40, payment_day: 20, schedule_day_type: 'exact', include: true,
      as_schedule: true, as_schedule_since: '2026-01-01', monthly_schedule: ALL_MONTHS,
    },
    {
      id: 'grocItem', kind: 'expense', description: 'Groceries', envelope_id: 'groc', account_id: 'chk',
      default_amount: -600, include: true, monthly_schedule: ALL_MONTHS, include_in_emergency_budget: true,
    },
  ],
  envelopeTemplates: [],
  transactions: [
    { id: 'fill9', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 4750, status: 'posted',
      lines: [{ envelope_id: 'rent', amount: 2100 }, { envelope_id: 'net', amount: 100 }, { envelope_id: 'groc', amount: 1050 }, { envelope_id: 'emerg', amount: 1500 }] },
    { id: 'rent9', type: 'expense', date: '2026-09-25', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', status: 'posted', from_budget: 'rentItem:2026-09' },
    { id: 'net9', type: 'expense', date: '2026-09-20', payee: 'ISP', amount: 40, account: 'chk', envelope_id: 'net', status: 'posted', from_budget: 'netItem:2026-09' },
    { id: 'groc9', type: 'expense', date: '2026-09-15', payee: 'Shop', amount: 580, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'old9', type: 'expense', date: '2026-09-16', payee: 'Old', amount: 5, account: 'chk', envelope_id: 'old', status: 'posted' },
    // October
    { id: 'groc10a', type: 'expense', date: '2026-10-03', payee: 'Shop', amount: 150, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'rent10', type: 'expense', date: '2026-10-05', payee: 'Landlord', amount: 1000, account: 'chk', envelope_id: 'rent', budget_item_id: 'rentItem', status: 'posted' },
    { id: 'groc10s', type: 'expense', date: '2026-10-08', payee: 'Market', amount: 25, account: 'chk', envelope_id: 'groc', status: 'scheduled', __overdue: true },
    { id: 'groc10f', type: 'expense', date: '2026-10-20', payee: 'Shop ahead', amount: 60, account: 'chk', envelope_id: 'groc', status: 'posted' },
    { id: 'split10', type: 'expense', date: '2026-10-02', payee: 'Split', amount: 30, account: 'chk', status: 'posted',
      envelope_splits: [{ envelope_id: 'groc', amount: 20 }, { envelope_id: 'net', amount: 10 }] },
  ],
});

// The flag and the page sums the query adds to each row (pinned in
// tests/core-query-additive.test.js) are not part of the old composition.
const strip = (rows) => rows.map(({ isEmergency: _e, consolidateDelta: _c, need: _n, available: _a, archived: _ar, ...r }) => r);

// ── Equivalence ────────────────────────────────────────────────────────────

describe('review.month — equals the Review page composition', () => {
  // A past month is no longer the old composition (it read today's
  // balances): it is reviewed as it stood at its end, pinned below.
  const cases = [
    ['the current month (#283 paid early, a tombstone, a plan partly spent)', '2026-10', {}],
    ['a future month (roll-forward)', '2026-12', {}],
    ['the current month with an emergency envelope', '2026-10', { withEmergency: true }],
    ['a future month with an emergency envelope', '2026-11', { withEmergency: true }],
  ];
  for (const [label, month, opts] of cases) {
    it(label, () => {
      const d = fixture(opts);
      const old = oldReview(d, month, NOW);
      const r = ask({ month }, d);
      expect(r.ok).toBe(true);
      expect(r.value.month).toBe(month);
      expect(r.value.isCurrent).toBe(old.isCurrent);
      expect(r.value.isFuture).toBe(old.isFuture);
      expect(old.rows.length).toBeGreaterThan(0);
      expect(strip(r.value.rows)).toEqual(strip(old.rows));
      expect(r.value.rows.map(x => x.isEmergency)).toEqual(old.rows.map(x => x.isEmergency === true));
      expect(r.value.detail).toBeUndefined();
    });
  }

  it('leaves archived and "(deleted:" envelopes out and keeps the engine order', () => {
    const r = ask({ month: '2026-10' }, fixture()).value;
    expect(r.rows.map(x => x.envelope_id)).toEqual(['groc', 'net', 'rent', 'emerg']);
  });

  it('includeArchived adds the archived envelope, flagged, and never the "(deleted:" one', () => {
    const d = fixture();
    const base = ask({ month: '2026-10' }, d).value;
    const all = ask({ month: '2026-10', includeArchived: true }, d).value;
    expect(all.rows.map(x => x.envelope_id).sort()).toEqual(['emerg', 'groc', 'net', 'old', 'rent']);
    expect(all.rows.filter(x => x.archived).map(x => x.envelope_id)).toEqual(['old']);
    expect(base.rows.every(x => x.archived === false)).toBe(true);
    // The active rows are unchanged by the flag.
    const active = all.rows.filter(x => !x.archived);
    expect(active).toEqual(base.rows.filter(x => active.some(a => a.envelope_id === x.envelope_id)));
  });

  it('defaults month to today\'s month', () => {
    const d = fixture();
    const r = ask({}, d).value;
    expect(r.month).toBe('2026-10');
    expect(r.isCurrent).toBe(true);
    expect(r.isFuture).toBe(false);
    expect(r.rows).toEqual(ask({ month: '2026-10' }, d).value.rows);
  });

  it('the current month really exercises the netting and the tombstone', () => {
    const r = ask({ month: '2026-10' }, fixture()).value;
    const row = (id) => r.rows.find(x => x.envelope_id === id);
    // Rent paid by hand on the 5th: the 25 Oct auto-post row is netted away.
    expect(row('rent').actual).toBe(1000);
    expect(row('rent').scheduled).toBe(0);
    // Internet's October occurrence is tombstoned: nothing scheduled.
    expect(row('net').scheduled).toBe(0);
    // Groceries: 150 + 20 (split) actual; the scheduled 25 and the 60 dated ahead are scheduled.
    expect(row('groc').actual).toBe(170);
    expect(row('groc').scheduled).toBeGreaterThanOrEqual(85);
    expect(r.isCurrent).toBe(true);
  });

  it('a past month is past, not current and not future; a future month is future', () => {
    expect(ask({ month: '2026-09' }, fixture()).value).toMatchObject({ isCurrent: false, isFuture: false, isPast: true, asOf: '2026-09-30' });
    expect(ask({ month: '2026-10' }, fixture()).value).toMatchObject({ isCurrent: true, isFuture: false, isPast: false, asOf: '2026-10-10' });
    expect(ask({ month: '2026-12' }, fixture()).value).toMatchObject({ isCurrent: false, isFuture: true, isPast: false, asOf: '2026-10-10' });
  });

  it('reads tombstones and country the way the page did', () => {
    for (const meta of [undefined, {}, { scheduledTombstones: 'x' }, { scheduledTombstones: ['a'], country: 'NL' }]) {
      expect(monthTombstones({ meta })).toEqual(getTombstones(meta));
      expect(monthCountry({ meta })).toBe(meta?.country ?? 'FI');
    }
  });
});

// ── A past month, as it stood at its end ──────────────────────────────────

describe('review.month — a past month is reviewed as of its last day', () => {
  const SEP_END = new Date(2026, 8, 30, 23, 59, 59);
  const through = (d, end) => ({ ...d, transactions: d.transactions.filter(tx => tx.date <= end) });

  it('equals the review the page would have shown on the month\'s last day', () => {
    for (const opts of [{}, { withEmergency: true }]) {
      const d = fixture(opts);
      const r = ask({ month: '2026-09' }, d).value;
      // The ledger as of 30 Sep, reviewed on 30 Sep: September was then the
      // current month, and nothing was left of it to forecast.
      const then = ask({ month: '2026-09' }, through(d, '2026-09-30'), SEP_END).value;
      expect(then.isCurrent).toBe(true);
      expect(strip(r.rows)).toEqual(strip(then.rows));
      expect(r.rows.map(x => x.isEmergency)).toEqual(then.rows.map(x => x.isEmergency));
      expect(r.totals).toEqual(then.totals);
      expect(r.negativeCount).toBe(then.negativeCount);
    }
  });

  it('balances are the month-end balances; rows booked later change nothing', () => {
    const d = fixture();
    const r = ask({ month: '2026-09' }, d).value;
    const row = (id) => r.rows.find(x => x.envelope_id === id);
    // Filled 1 Sep, spent in September: 2100 − 1000, 100 − 40, 1050 − 580.
    expect(row('rent').balance).toBe(1100);
    expect(row('net').balance).toBe(60);
    expect(row('groc').balance).toBe(470);
    expect(row('groc').actual).toBe(580);
    // October's rows (and today's balances) are not part of it.
    const septemberOnly = through(d, '2026-09-30');
    // (`available` is the consolidate figure, booked over every row: not a month-end one.)
    expect(strip(ask({ month: '2026-09' }, septemberOnly).value.rows)).toEqual(strip(r.rows));
    const today = computeEnvelopeBalances(d.transactions, { asOf: NOW });
    expect(today.get('groc')).not.toBe(row('groc').balance);
  });

  it('the detail lists the month\'s rows as actuals, an unposted scheduled row as overdue', () => {
    const d = deepFreeze({
      ...fixture(),
      transactions: [...fixture().transactions,
        { id: 'groc9s', type: 'expense', date: '2026-09-28', payee: 'Never posted', amount: 9, account: 'chk', envelope_id: 'groc', status: 'scheduled' }],
    });
    const r = ask({ month: '2026-09', envelope: 'groc' }, d).value.detail;
    expect(r.actual.map(x => x.id)).toEqual(['groc9']);
    expect(r.overdue.map(x => x.id)).toEqual(['groc9s']);
    expect(r.coming).toEqual([]);
    expect(r.future).toEqual([]);
  });
});

// ── need: the gap Fill envelopes offers ───────────────────────────────────

describe('review.month — need', () => {
  it('is the gap to the required reserve, zero on a surplus, rounded', () => {
    for (const month of ['2026-09', '2026-10', '2026-12']) {
      const r = ask({ month }, fixture({ withEmergency: true })).value;
      for (const row of r.rows) {
        expect(row.need).toBe(row.surplus < -0.005 ? Math.round(-row.surplus * 100) / 100 : 0);
        expect(row.need).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is positive for an envelope projected short of its reserve', () => {
    // Groceries with nothing filled in October and 600 planned.
    const d = deepFreeze({ ...fixture(), transactions: fixture().transactions.filter(tx => tx.id !== 'fill9') });
    const g = ask({ month: '2026-10' }, d).value.rows.find(x => x.envelope_id === 'groc');
    expect(g.surplus).toBeLessThan(0);
    expect(g.need).toBe(Math.round(-g.surplus * 100) / 100);
  });
});

// ── Emergency ──────────────────────────────────────────────────────────────

describe('review.month — emergency envelope', () => {
  it('overrides required and surplus on a copy, and flags the row', () => {
    const d = fixture({ withEmergency: true });
    const r = ask({ month: '2026-10' }, d).value;
    const calc = computeEmergencyFundRequirement({
      envelopes: d.envelopes, budgetItems: d.budgetItems, transactions: d.transactions, month: '2026-10', meta: d.meta,
    });
    expect(calc).not.toBeNull();
    expect(r.emergencyEnvelopeId).toBe('emerg');
    const e = r.rows.find(x => x.envelope_id === 'emerg');
    expect(e.isEmergency).toBe(true);
    expect(e.required).toBe(calc.required);
    expect(e.surplus).toBe(Math.round((e.projected - calc.required) * 100) / 100);
    expect(r.rows.filter(x => x.isEmergency).length).toBe(1);
    // The plain fixture has no emergency envelope.
    const plain = ask({ month: '2026-10' }, fixture()).value;
    expect(plain.emergencyEnvelopeId).toBeNull();
    expect(plain.rows.every(x => x.isEmergency === false)).toBe(true);
  });

  it('does not change the engine rows a second run sees', () => {
    const d = fixture({ withEmergency: true });
    const first = ask({ month: '2026-10' }, d).value;
    const second = ask({ month: '2026-10' }, d).value;
    expect(second).toEqual(first);
  });
});

// ── Detail ─────────────────────────────────────────────────────────────────

describe('review.month — envelope detail', () => {
  it('classifies the envelope\'s rows in the month into actual, overdue, coming and future', () => {
    const d = fixture();
    const r = ask({ month: '2026-10', envelope: 'groc' }, d);
    expect(r.ok).toBe(true);
    const { detail } = r.value;
    expect(detail.envelope).toBe('groc');
    expect(detail.actual.map(t => t.id)).toEqual(['split10', 'groc10a']);
    expect(detail.overdue.map(t => t.id)).toEqual(['groc10s']);
    expect(detail.future.map(t => t.id)).toEqual(['groc10f']);
    // The planned grocery item's remaining plan, a forecast row after today.
    expect(detail.coming.length).toBeGreaterThan(0);
    for (const tx of detail.coming) {
      expect(tx.is_forecast || tx.status === 'scheduled').toBe(true);
      expect(tx.date >= '2026-10-10' && tx.date <= '2026-10-31').toBe(true);
      expect(tx.envelope_id).toBe('groc');
    }
    for (const list of [detail.actual, detail.overdue, detail.coming, detail.future]) {
      const dates = list.map(t => t.date);
      expect(dates).toEqual([...dates].sort());
    }
    // The rows are the envelope's rows only, all in October.
    const all = [...detail.actual, ...detail.overdue, ...detail.coming, ...detail.future];
    expect(all.every(t => t.date.startsWith('2026-10'))).toBe(true);
    expect(all.some(t => t.id === 'rent10')).toBe(false);
  });

  it('strips __-prefixed properties and writes nothing onto the data', () => {
    const d = fixture();
    const r = ask({ month: '2026-10', envelope: 'groc' }, d).value;
    const all = [...r.detail.actual, ...r.detail.overdue, ...r.detail.coming, ...r.detail.future];
    for (const tx of all) expect(Object.keys(tx).some(k => k.startsWith('__'))).toBe(false);
    // Frozen input: a write onto a row would have thrown.
    expect(Object.isFrozen(d.transactions[0])).toBe(true);
    expect(d.transactions.find(t => t.id === 'groc10s').__overdue).toBe(true);
    expect(d.transactions.find(t => t.id === 'groc10f').__overdue).toBeUndefined();
  });

  it('includes a split touching the envelope, and a past month has only actuals', () => {
    const r = ask({ month: '2026-09', envelope: 'net' }, fixture()).value;
    expect(r.detail.actual.map(t => t.id)).toEqual(['net9']);
    expect(r.detail.overdue).toEqual([]);
    expect(r.detail.coming).toEqual([]);
    expect(r.detail.future).toEqual([]);
    const oct = ask({ month: '2026-10', envelope: 'net' }, fixture()).value;
    expect(oct.detail.actual.map(t => t.id)).toEqual(['split10']);
    // Tombstoned: no October forecast row for Internet.
    expect(oct.detail.coming).toEqual([]);
  });

  it('gives empty lists for an envelope with nothing in the month', () => {
    const r = ask({ month: '2026-10', envelope: 'emerg' }, fixture()).value;
    expect(r.detail).toEqual({ envelope: 'emerg', actual: [], overdue: [], coming: [], future: [], totals: { actual: 0, overdue: 0, coming: 0, future: 0 } });
  });
});

// ── A loan paid by hand ────────────────────────────────────────────────────
// A loan_payment item due on the 25th, paid by hand on 6 Oct the way Add
// transaction writes it since #316: the principal as a debt_payment into the
// loan (linked by its loan account), the interest and the fee as expenses
// carrying budget_item_id. The three rows are one payment: the netting drops
// the 25 Oct forecast occurrence, every leg of it, and nothing is charged twice.
const loanFixture = ({ paid = true } = {}) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'checking', initialBalance: 5000 },
    { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -120000 },
  ],
  envelopes: [{ id: 'housing', name: 'Housing', category: 'Housing' }],
  budgetItems: [{
    id: 'mortgage', kind: 'loan_payment', description: 'Mortgage',
    envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg', loan_rate: 3, loan_fee: 15,
    default_amount: -1000, monthly_schedule: ALL_MONTHS, payment_day: 25,
    as_schedule: true, as_schedule_since: '2026-09-01', include: true, schedule_day_type: 'exact',
  }],
  envelopeTemplates: [],
  transactions: [
    { id: 'fillL', type: 'fill', date: '2026-09-01', payee: 'Fill', amount: 3000, status: 'posted',
      lines: [{ envelope_id: 'housing', amount: 3000 }] },
    ...(paid ? [
      { id: 'p10', type: 'debt_payment', date: '2026-10-06', payee: 'Bank', amount: 675, from_account: 'chk', to_account: 'mtg',
        envelope_id: 'housing', status: 'posted' },
      { id: 'i10', type: 'expense', date: '2026-10-06', payee: 'Bank', amount: 310, account: 'chk', envelope_id: 'housing',
        budget_item_id: 'mortgage', note: 'Loan interest', status: 'posted' },
      { id: 'fee10', type: 'expense', date: '2026-10-06', payee: 'Bank', amount: 15, account: 'chk', envelope_id: 'housing',
        budget_item_id: 'mortgage', note: 'Loan fee', status: 'posted' },
    ] : []),
  ],
});

describe('review.month — a loan payment recorded by hand', () => {
  it('equals the page composition', () => {
    const d = loanFixture();
    const old = oldReview(d, '2026-10', NOW);
    const r = ask({ month: '2026-10' }, d);
    expect(r.ok).toBe(true);
    expect(old.rows.length).toBeGreaterThan(0);
    expect(strip(r.value.rows)).toEqual(strip(old.rows));
  });

  it('counts the three rows once: the forecast occurrence is netted away', () => {
    const unpaid = ask({ month: '2026-10' }, loanFixture({ paid: false })).value.rows.find(x => x.envelope_id === 'housing');
    // Not paid: the 25 Oct instalment is still to come, so the netting is what removes it below.
    expect(unpaid.actual).toBe(0);
    expect(unpaid.scheduled).toBe(1000);

    const r = ask({ month: '2026-10', envelope: 'housing' }, loanFixture()).value;
    const row = r.rows.find(x => x.envelope_id === 'housing');
    expect(row.actual).toBe(1000);
    expect(row.scheduled).toBe(0);
    expect(r.detail.actual.map(t => t.id).sort()).toEqual(['fee10', 'i10', 'p10']);
    expect(r.detail.coming).toEqual([]);
    expect(r.detail.overdue).toEqual([]);
  });
});

// ── Errors ─────────────────────────────────────────────────────────────────

describe('review.month — refused input', () => {
  for (const month of ['2026-13', '2026-00', '2026-1', '26-10', '2026-10-01']) {
    it(`refuses month ${month}`, () => {
      const r = ask({ month }, fixture());
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors).toEqual([{ path: 'month', message: expect.any(String) }]);
    });
  }

  it('refuses an unknown envelope (the schema validator checks the ref)', () => {
    const r = ask({ month: '2026-10', envelope: 'nope' }, fixture());
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bad_input');
    expect(r.error.params.errors).toEqual([{ path: 'envelope', message: 'no envelope with id "nope"' }]);
  });
});
