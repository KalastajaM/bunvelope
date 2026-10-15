// tests/core-query-aom-upcoming.test.js — the Dashboard's Age of Money tile
// and sheet (`ageOfMoney`) and its Upcoming card (`upcoming`) as queries.
//
// Each equivalence helper below copies the Dashboard's current code from
// js/pages/dashboard.js verbatim (buildKpiRow's Age of Money tail,
// collectAomAnomalies and buildAnomalyItem's payee lookup; buildUpcomingCard's
// assembly), with `state` → the fixture, `now()` / `appNow()` → the fixed
// clock and the page's operational helpers → js/core/operational.js (the same
// rules, moved by Task 1). The query must equal it once its Dates are ISO
// strings and its money is round2'd.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx, isoDate } from '../js/core/context.js';
import { operationalAccounts, operationalTransactions } from '../js/core/operational.js';
import { takenOccurrenceKeys } from '../js/core/effective-txs.js';
import {
  computeAgeOfMoneyHistory, computeAgeOfMoneyDetailed, computeMoneyCushion, attributeAgeOfMoneyDrop,
} from '../js/engine/history.js';
import { forecastScheduledTransactions, forecastAllFills, forecastKey } from '../js/engine/scheduling.js';
import { txAccountDelta } from '../js/engine/tx-amounts.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
// Clocks are built from explicit components, so every test reads the same
// local calendar day under each zone test:tz runs.
const at = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now) => runQuery(registry, d, name, input, ctxAt(now));
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);

// ── Age of Money ───────────────────────────────────────────────────────────

const AOM_NOW = at(2026, 3, 31);
const inc = (id, date, amount, account = 'chk') => ({ id, type: 'income', date, amount, account, status: 'posted' });
const exp = (id, date, amount, payee, account = 'chk') => ({ id, type: 'expense', date, amount, account, envelope_id: 'food', payee, status: 'posted' });

// Every fixture has a savings account whose income must stay out of the
// operating money (operationalTransactions), and an archived checking account.
const aomData = (transactions) => deepFreeze({
  meta: {},
  accounts: [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 500 },
    { id: 'old', name: 'Old bank', type: 'bank', initialBalance: 50, archived: true },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 0 },
  ],
  envelopes: [{ id: 'food', name: 'Food' }],
  budgetItems: [],
  envelopeTemplates: [],
  transactions: [...transactions, inc('dividend', '2026-01-01', 5000, 'sav')],
});

// One expense per month, each fully funded by the income before it: the March
// expense is the only spend in March's window, so it is a big expense.
const BIG = [
  inc('i1', '2026-01-01', 123.456), exp('x1', '2026-02-10', 123.456, 'Shop'),
  inc('i2', '2026-03-01', 123.456), exp('x2', '2026-03-21', 123.456, 'Garage'),
];
// Three equal expenses a month (no single one dominates) and no income inside
// March's window: an income gap.
const GAP = [
  inc('i1', '2026-01-01', 300), exp('a1', '2026-02-08', 100), exp('a2', '2026-02-09', 100), exp('a3', '2026-02-10', 100),
  inc('i2', '2026-02-26', 300), exp('b1', '2026-03-15', 100), exp('b2', '2026-03-16', 100), exp('b3', '2026-03-17', 100),
];
// The same, with incomes spread through March's window: a broad shift.
const BROAD = [...GAP, inc('i3', '2026-03-10', 50), inc('i4', '2026-03-22', 50)];

// buildKpiRow's Age of Money tail, verbatim (aomNow = the clock).
function pageAom(state, appNow) {
  const aomTxs = operationalTransactions(state.accounts, state.transactions);
  const aomAccounts = operationalAccounts(state.accounts);
  const aomNow = appNow;
  const aomHistory = computeAgeOfMoneyHistory(aomTxs, { refDate: aomNow });
  const cushion = computeMoneyCushion(aomAccounts, aomTxs, aomNow, 30);
  return { aomHistory, cushion };
}
// collectAomAnomalies, verbatim.
function pageCollectAomAnomalies(state, history) {
  const out = [];
  const aomTxs = operationalTransactions(state.accounts, state.transactions);
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (a.aom == null || b.aom == null) continue;
    if (a.aom - b.aom < 7) continue; // bail before the expensive detail call
    const prev = computeAgeOfMoneyDetailed(aomTxs, a.refDate, 30);
    const curr = computeAgeOfMoneyDetailed(aomTxs, b.refDate, 30);
    const r = attributeAgeOfMoneyDrop(prev, curr);
    if (r) out.push({ ...r, monthRef: b.refDate, payeeId: r.txId });
  }
  return out;
}
// buildAnomalyItem's payee lookup, verbatim.
const pagePayee = (state, it) => {
  const tx = (state.transactions || []).find(t2 => t2.id === it.txId);
  return tx?.payee || '—';
};
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// The page's figures in the answer's shape.
function expectedAom(state, appNow) {
  const { aomHistory, cushion } = pageAom(state, appNow);
  const drops = pageCollectAomAnomalies(state, aomHistory).map(it => {
    const base = { month: ym(it.monthRef), kind: it.kind, drop: it.drop };
    if (it.kind === 'big_expense') {
      return { ...base, txId: it.txId, payee: pagePayee(state, it) === '—' ? null : pagePayee(state, it), amount: round2(it.amount), ageDays: it.ageDays, share: it.share };
    }
    if (it.kind === 'income_gap') return { ...base, gapStart: isoDate(it.gapStart), gapEnd: isoDate(it.gapEnd), gapDays: it.gapDays };
    return base;
  });
  return {
    days: cushion.aom,
    health: cushion.health,
    runwayLimited: cushion.runwayLimited,
    runwayDays: cushion.runwayDays,
    recentSpendPerDay: round2(cushion.recentSpendPerDay),
    liquidBalance: round2(cushion.liquidBalance),
    history: aomHistory.map(h => ({ month: h.monthKey, date: isoDate(h.refDate), days: h.aom })),
    drops,
    // These fixtures have too little income history for a one-off.
    oneOffs: [],
  };
}

describe('ageOfMoney', () => {
  it('equals the page for a big expense drop, and names its payee', () => {
    const d = aomData(BIG);
    const r = ask('ageOfMoney', {}, d, AOM_NOW);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(expectedAom(d, AOM_NOW));
    expect(r.value.drops).toEqual([
      { month: '2026-03', kind: 'big_expense', drop: 20, txId: 'x2', payee: 'Garage', amount: 123.46, ageDays: 20, share: 1 },
    ]);
    expect(r.value.history.slice(-2)).toEqual([
      { month: '2026-02', date: '2026-02-28', days: 40 },
      { month: '2026-03', date: '2026-03-31', days: 20 },
    ]);
    expect(r.value.history).toHaveLength(12);
    expect(r.value.history[0]).toEqual({ month: '2025-04', date: '2025-04-30', days: null });
    jsonSafe(r.value);
  });

  it('equals the page for an income gap drop, with the gap as ISO dates', () => {
    const d = aomData(GAP);
    const r = ask('ageOfMoney', {}, d, AOM_NOW);
    expect(r.value).toEqual(expectedAom(d, AOM_NOW));
    expect(r.value.drops).toEqual([
      { month: '2026-03', kind: 'income_gap', drop: 21, gapStart: '2026-03-01', gapEnd: '2026-03-31', gapDays: 30 },
    ]);
    jsonSafe(r.value);
  });

  it('equals the page for a broad shift', () => {
    const d = aomData(BROAD);
    const r = ask('ageOfMoney', {}, d, AOM_NOW);
    expect(r.value).toEqual(expectedAom(d, AOM_NOW));
    expect(r.value.drops).toEqual([{ month: '2026-03', kind: 'broad_shift', drop: 21 }]);
  });

  it('flags no drop under the 7-day threshold', () => {
    // February's one expense is 26 days old, March's 22: a fall of 4 days.
    const d = aomData([
      inc('i1', '2026-01-25', 100), exp('a1', '2026-02-20', 100),
      inc('i2', '2026-02-25', 100), exp('b1', '2026-03-19', 100),
    ]);
    const r = ask('ageOfMoney', {}, d, AOM_NOW);
    expect(r.value).toEqual(expectedAom(d, AOM_NOW));
    const [feb, mar] = r.value.history.slice(-2).map(h => h.days);
    expect(feb - mar).toBeGreaterThan(0);
    expect(feb - mar).toBeLessThan(7);
    expect(r.value.drops).toEqual([]);
  });

  it('the 7-day pre-check agrees with the engine\'s own threshold: a fall of 7 is a drop, 6 is not', () => {
    // February's one expense is 26 days old; March's is 19 (a fall of 7) or 20 (6).
    const fixture = (marchDay) => aomData([
      inc('i1', '2026-01-25', 100), exp('a1', '2026-02-20', 100),
      inc('i2', '2026-02-25', 100), exp('b1', `2026-03-${marchDay}`, 100, 'Shop'),
    ]);
    for (const [marchDay, fall] of [['16', 7], ['17', 6]]) {
      const d = fixture(marchDay);
      const v = ask('ageOfMoney', {}, d, AOM_NOW).value;
      const [feb, mar] = v.history.slice(-2).map(h => h.days);
      expect(feb - mar).toBe(fall);
      // The engine decides on every consecutive pair, without any pre-check.
      const txs = operationalTransactions(d.accounts, d.transactions);
      const history = computeAgeOfMoneyHistory(txs, { refDate: AOM_NOW });
      const engine = [];
      for (let i = 1; i < history.length; i++) {
        const r = attributeAgeOfMoneyDrop(computeAgeOfMoneyDetailed(txs, history[i - 1].refDate, 30), computeAgeOfMoneyDetailed(txs, history[i].refDate, 30));
        if (r) engine.push(`${history[i].monthKey} ${r.kind} ${r.drop}`);
      }
      expect(v.drops.map(x => `${x.month} ${x.kind} ${x.drop}`)).toEqual(engine);
      expect(v.drops).toHaveLength(fall >= 7 ? 1 : 0);
    }
  });

  it('the cushion: liquid balance over the non-archived spending accounts, runway and health', () => {
    const d = aomData(BIG);
    const v = ask('ageOfMoney', {}, d, AOM_NOW).value;
    // chk 500 + 123.456 − 123.456 + 123.456 − 123.456; the archived bank and savings are left out.
    expect(v.liquidBalance).toBe(500);
    expect(v.recentSpendPerDay).toBe(round2(123.456 / 30));
    expect(v.runwayDays).toBe(Math.floor(500 / (123.456 / 30)));
    expect(v).toMatchObject({ days: 20, health: 'yellow' });
  });

  it('without income there is no Age of Money: null days, null history, no drops', () => {
    const d = aomData([exp('x', '2026-03-10', 40)]);
    const v = ask('ageOfMoney', {}, { ...d, transactions: d.transactions.filter(t => t.id !== 'dividend') }, AOM_NOW).value;
    expect(v.days).toBeNull();
    expect(v.health).toBeNull();
    expect(v.history.every(h => h.days === null)).toBe(true);
    expect(v.drops).toEqual([]);
  });

  it('date picks the day it is about, whatever the clock', () => {
    const d = aomData(BIG);
    const viaDate = ask('ageOfMoney', { date: '2026-03-31' }, d, at(2026, 7, 4));
    expect(viaDate.value).toEqual(ask('ageOfMoney', {}, d, AOM_NOW).value);
    // A day in February: the history ends with February, sampled on that
    // day (the rest of the month has not happened), so it is the headline.
    const feb = ask('ageOfMoney', { date: '2026-02-20' }, d, AOM_NOW).value;
    expect(feb.history.at(-1)).toEqual({ month: '2026-02', date: '2026-02-20', days: 40 });
    expect(feb.history.at(-1).days).toBe(feb.days);
    expect(feb.history.at(-2).date).toBe('2026-01-31');
  });

  it('months and windowDays shape the history and the cushion', () => {
    const d = aomData(GAP);
    const opsTxs = operationalTransactions(d.accounts, d.transactions);
    const v = ask('ageOfMoney', { months: 3, windowDays: 45 }, d, AOM_NOW).value;
    expect(v.history).toEqual(computeAgeOfMoneyHistory(opsTxs, { refDate: AOM_NOW, months: 3, windowDays: 45 })
      .map(h => ({ month: h.monthKey, date: isoDate(h.refDate), days: h.aom })));
    expect(v.days).toBe(computeMoneyCushion(operationalAccounts(d.accounts), opsTxs, AOM_NOW, 45).aom);
  });

  it('refuses months and windowDays out of range', () => {
    const d = aomData(BIG);
    expect(ask('ageOfMoney', { months: 0 }, d, AOM_NOW).error.code).toBe('bad_input');
    expect(ask('ageOfMoney', { months: 37 }, d, AOM_NOW).error.code).toBe('bad_input');
    expect(ask('ageOfMoney', { windowDays: 366 }, d, AOM_NOW).error.code).toBe('bad_input');
  });
});

// ── Upcoming ───────────────────────────────────────────────────────────────

// The Dashboard page test's budget (now = 15 Sep 2026), plus: an overdue
// scheduled bill (Gym, the 3rd), a posted September Internet bill's tombstoned
// October twin (tombstones), a template fill on the 1st (a fill forecast,
// overdue in September), a posted row dated in the past (never listed) and a
// row dated past the window.
const UP_NOW = at(2026, 9, 15);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const sched = (id, description, amount, day, envelope_id = 'fun') => ({
  id, kind: 'expense', envelope_id, description, default_amount: -amount, extra_buffer: 0, include: true, monthly_schedule: every(),
  as_schedule: true, account_id: 'chk', payment_day: day, schedule_day_type: 'exact', as_schedule_since: '2026-01-01',
});
const upData = (extra = {}) => deepFreeze({
  meta: { country: 'FI', scheduledTombstones: ['ins:2026-10'] },
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 }],
  envelopes: [{ id: 'food', name: 'Food' }, { id: 'fun', name: 'Fun' }, { id: 'rent', name: 'Rent' }],
  budgetItems: [
    { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every(), as_schedule: false },
    sched('net', 'Internet', 25, 20),
    sched('gym', 'Gym', 15, 3),
    sched('ins', 'Insurance', 60, 10),
    // Ended in August: the walker leaves it out though the items are undated.
    { ...sched('old', 'Old phone', 9, 25), end_month: '2026-08' },
  ],
  envelopeTemplates: [{
    id: 'tpl', name: 'Monthly', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'add', amount: 100 }],
    schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every(), source_envelope_id: 'rent' },
  }],
  transactions: [
    { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Supermarket', amount: 80, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'ins9', type: 'expense', date: '2026-09-10', payee: 'Insurance', amount: 60, account: 'chk', envelope_id: 'fun', status: 'posted', from_budget: 'ins:2026-09' },
    { id: 'e3', type: 'expense', date: '2026-10-02', payee: 'Dentist', amount: 40, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
    { id: 'e4', type: 'expense', date: '2026-10-02', payee: 'Pharmacy', amount: 12, account: 'chk', envelope_id: 'fun', status: 'posted' },
    { id: 'far', type: 'expense', date: '2026-11-20', payee: 'Far away', amount: 5, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
  ],
  ...extra,
});

// buildUpcomingCard's assembly, verbatim (getTombstones(meta) = the same
// Array.isArray check as monthTombstones).
function pageUpcoming(state, appNow, horizonDays = 30) {
  const now = appNow;
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = ymd(now);
  const monthStart = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  const windowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + horizonDays);
  const windowEndStr = ymd(windowEnd);
  const realItems = state.transactions
    .filter(tx => {
      const d = tx.date && tx.date.slice(0, 10);
      return d && d > todayStr && d <= windowEndStr;
    })
    .map(tx => ({ ...tx, next: new Date(tx.date.slice(0, 10) + 'T00:00:00').getTime() }));
  const rawForecasts = forecastScheduledTransactions(
    state.budgetItems || [], state.accounts || [], state.envelopes || [], now, windowEndStr, monthStart,
    state.meta?.country ?? 'FI', { transactions: state.transactions },
  ).concat(forecastAllFills(
    state.budgetItems || [], state.envelopeTemplates || [], state.accounts || [], state.envelopes || [], now, windowEndStr,
    { fromDateStr: monthStart, country: state.meta?.country ?? 'FI' },
  ));
  const getTombstones = (meta) => (Array.isArray(meta?.scheduledTombstones) ? meta.scheduledTombstones : []);
  const takenKeys = takenOccurrenceKeys(state.transactions, getTombstones(state.meta));
  const forecastItems = rawForecasts
    .filter(f => !takenKeys.has(forecastKey(f)))
    .map(f => ({ ...f, next: new Date(f.date.slice(0, 10) + 'T00:00:00').getTime(), is_overdue: f.date < todayStr }));
  const overdue = forecastItems.filter(f => f.is_overdue).sort((a, b) => a.next - b.next);
  const upcoming = realItems.concat(forecastItems.filter(f => !f.is_overdue)).sort((a, b) => a.next - b.next);
  return { overdue, upcoming };
}
// The page's rows in the answer's shape: the row's own fields, `next` and
// `is_overdue` replaced by `origin` and `overdue`.
const asAnswerRow = ({ next: _next, is_overdue, ...row }) => ({ ...row, origin: row.is_forecast ? 'forecast' : 'ledger', overdue: !!is_overdue });
function expectedUpcoming(state, appNow, days) {
  const { overdue, upcoming } = pageUpcoming(state, appNow, days);
  return { overdue: overdue.map(asAnswerRow), coming: upcoming.map(asAnswerRow) };
}

// Owner decision 2026-10-05: one-off inflows are left out and listed; the
// health is green only when the runway agrees.
describe('ageOfMoney — one-offs and the runway', () => {
  // Pay 1000 on the 1st, Sep 2025 – Mar 2026, 900 spent each 20th; a 40 000
  // share sale on 5 Feb 2026, and a 20 000 dividend on savings (not operating
  // money, so neither counted nor listed).
  const rows = [];
  for (const [y, m] of [[2025, 9], [2025, 10], [2025, 11], [2025, 12], [2026, 1], [2026, 2], [2026, 3]]) {
    const mm = String(m).padStart(2, '0');
    rows.push(inc(`p${y}${mm}`, `${y}-${mm}-01`, 1000), exp(`e${y}${mm}`, `${y}-${mm}-20`, 900, 'Shop'));
  }
  const withSale = [...rows, { ...inc('sale', '2026-02-05', 40000), payee: 'Shares' }, inc('div', '2026-02-06', 20000, 'sav')];

  it('lists the one-offs of the history\'s months with their payee, and the figure ignores them', () => {
    const v = ask('ageOfMoney', {}, aomData(withSale), AOM_NOW).value;
    expect(v.oneOffs).toEqual([{ txId: 'sale', date: '2026-02-05', payee: 'Shares', amount: 40000 }]);
    expect(v.days).toBe(ask('ageOfMoney', {}, aomData(rows), AOM_NOW).value.days);
    // A history that ends before the sale lists none.
    expect(ask('ageOfMoney', { date: '2026-01-31' }, aomData(withSale), AOM_NOW).value.oneOffs).toEqual([]);
  });

  it('holds green at yellow on a short runway, with runwayLimited', () => {
    // Paid 900 on the 1st from August, 900 spent each 20th from September:
    // August's pay is a month's buffer, so the money spent is about 47 days
    // old, while the current account holds 1400 at 30 a day.
    const buffered = [inc('p202508', '2025-08-01', 900)];
    for (const [y, m] of [[2025, 9], [2025, 10], [2025, 11], [2025, 12], [2026, 1], [2026, 2], [2026, 3]]) {
      const mm = String(m).padStart(2, '0');
      buffered.push(inc(`p${y}${mm}`, `${y}-${mm}-01`, 900), exp(`e${y}${mm}`, `${y}-${mm}-20`, 900, 'Shop'));
    }
    const v = ask('ageOfMoney', {}, aomData(buffered), AOM_NOW).value;
    expect(v.days).toBeGreaterThanOrEqual(30);
    expect(v.runwayDays).toBe(46); // 1400 / (900 / 30)
    expect(v).toMatchObject({ health: 'yellow', runwayLimited: true });
  });
});

// Owner decision 2026-10-06 (BACKLOG 2026-10-05 [check]): the usual definition.
// Money moved out of the spending accounts consumes the oldest money; a
// transfer between two spending accounts is neutral; money moved in is new.
describe('ageOfMoney — transfers across the spending accounts\' edge', () => {
  const MONTHS = [[2025, 9], [2025, 10], [2025, 11], [2025, 12], [2026, 1], [2026, 2], [2026, 3]];
  // Paid 2000 on the 1st, 1100 moved on the 2nd, 900 spent on the 20th.
  const saver = (to, extra = {}) => MONTHS.flatMap(([y, m]) => {
    const mm = String(m).padStart(2, '0');
    return [inc(`p${y}${mm}`, `${y}-${mm}-01`, 2000), exp(`e${y}${mm}`, `${y}-${mm}-20`, 900, 'Shop'),
      { id: `t${y}${mm}`, type: 'account_transfer', date: `${y}-${mm}-02`, amount: 1100, from_account: 'chk', to_account: to, status: 'posted', ...extra }];
  });
  const noTransfers = () => saver('sav').filter(t => t.type !== 'account_transfer');

  it('a salary moved on to savings no longer stays queued as old money', () => {
    const v = ask('ageOfMoney', {}, aomData(saver('sav')), AOM_NOW).value;
    // Each transfer takes the oldest 1100, so March's 900 is March's pay, 19 days old.
    expect(v.days).toBe(19);
    expect(v.history.slice(-3).map(h => h.days)).toEqual([19, 19, 19]);
    // Before the fix the surplus stayed queued: the same rows without the transfers.
    expect(ask('ageOfMoney', {}, aomData(noTransfers()), AOM_NOW).value.days).toBeGreaterThan(100);
  });

  it('a transfer between two spending accounts is neutral', () => {
    // 'old' is an (archived) bank account: spending money, so the surplus stays queued.
    const v = ask('ageOfMoney', {}, aomData(saver('old')), AOM_NOW).value;
    expect(v.days).toBe(ask('ageOfMoney', {}, aomData(noTransfers()), AOM_NOW).value.days);
  });

  it('a scheduled (unposted) transfer changes nothing', () => {
    const v = ask('ageOfMoney', {}, aomData(saver('sav', { status: 'scheduled' })), AOM_NOW).value;
    expect(v.days).toBe(ask('ageOfMoney', {}, aomData(noTransfers()), AOM_NOW).value.days);
  });

  it('money moved in from savings is new money, as income is', () => {
    // January's pay went to savings; March's spend is paid from what came back on 15 March.
    const rows = [
      inc('p1', '2026-01-01', 900),
      { id: 'out', type: 'account_transfer', date: '2026-01-02', amount: 900, from_account: 'chk', to_account: 'sav', status: 'posted' },
      { id: 'in', type: 'account_transfer', date: '2026-03-15', amount: 900, from_account: 'sav', to_account: 'chk', status: 'posted' },
      exp('x', '2026-03-20', 900, 'Shop'),
    ];
    expect(ask('ageOfMoney', {}, aomData(rows), AOM_NOW).value.days).toBe(5);
  });
});

describe('upcoming', () => {
  it('equals the page: overdue forecasts first, then real and forecast rows by date', () => {
    const d = upData();
    const r = ask('upcoming', {}, d, UP_NOW);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.value).toEqual(expectedUpcoming(d, UP_NOW, 30));
    const label = (row) => `${row.date} ${row.payee} ${row.origin}`;
    expect(r.value.overdue.map(label)).toEqual(['2026-09-01 Monthly forecast', '2026-09-03 Gym forecast']);
    expect(r.value.coming.map(label)).toEqual([
      '2026-09-20 Internet forecast',
      '2026-10-01 Monthly forecast',
      '2026-10-02 Dentist ledger',
      '2026-10-02 Pharmacy ledger',
      '2026-10-03 Gym forecast',
    ]);
    expect(r.value.overdue.every(row => row.overdue && row.is_forecast)).toBe(true);
    expect(r.value.coming.every(row => row.overdue === false)).toBe(true);
    jsonSafe(r.value);
  });

  it('a fill forecast carries its lines and dedup key', () => {
    const fill = ask('upcoming', {}, upData(), UP_NOW).value.coming.find(row => row.type === 'fill');
    expect(fill).toMatchObject({ forecast_dedup_key: 'tpl:tpl:2026-10', template_id: 'tpl', origin: 'forecast', source: 'allocation' });
    expect(fill.lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: 100 }, { envelope_id: 'rent', mode: 'add', amount: -100 }]);
  });

  it('nets out a posted occurrence and a tombstoned one', () => {
    const v = ask('upcoming', {}, upData(), UP_NOW).value;
    expect([...v.overdue, ...v.coming].filter(row => row.payee === 'Insurance')).toEqual([]);
    // Without the tombstone, October's Insurance is listed again.
    const d = upData({ meta: { country: 'FI' } });
    const r = ask('upcoming', {}, d, UP_NOW).value;
    expect(r).toEqual(expectedUpcoming(d, UP_NOW, 30));
    expect(r.coming.filter(row => row.payee === 'Insurance').map(row => row.date)).toEqual(['2026-10-10']);
  });

  it('days sets the window: today + days, inclusive', () => {
    const d = upData();
    const r = ask('upcoming', { days: 66 }, d, UP_NOW).value;
    expect(r).toEqual(expectedUpcoming(d, UP_NOW, 66));
    expect(r.coming.find(row => row.id === 'far')).toMatchObject({ date: '2026-11-20', origin: 'ledger' });
    expect(ask('upcoming', { days: 65 }, d, UP_NOW).value.coming.some(row => row.id === 'far')).toBe(false);
  });

  it('date picks today, whatever the clock', () => {
    const d = upData();
    expect(ask('upcoming', { date: '2026-09-15' }, d, at(2027, 2, 1)).value).toEqual(ask('upcoming', {}, d, UP_NOW).value);
    // On the 25th, Internet (the 20th) is overdue too.
    const later = ask('upcoming', { date: '2026-09-25' }, d, UP_NOW).value;
    expect(later).toEqual(expectedUpcoming(d, at(2026, 9, 25), 30));
    expect(later.overdue.map(row => row.payee)).toEqual(['Monthly', 'Gym', 'Internet']);
  });

  it('a row\'s own source survives the origin marker: a stored new_income fill still debits its account', () => {
    const stored = {
      id: 'ni', type: 'fill', date: '2026-09-25', status: 'scheduled', source: 'new_income', source_account: 'chk', payee: 'Bonus',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 250 }],
    };
    const d = upData({ transactions: [...upData().transactions, stored] });
    const v = ask('upcoming', {}, d, UP_NOW).value;
    expect(v).toEqual(expectedUpcoming(d, UP_NOW, 30));
    const row = v.coming.find(r => r.id === 'ni');
    expect(row).toMatchObject({ source: 'new_income', origin: 'ledger', overdue: false });
    expect(txAccountDelta(row, 'chk')).toBe(txAccountDelta(stored, 'chk'));
    expect(txAccountDelta(row, 'chk')).toBe(-250);
    // A forecast fill keeps its own source and account effect too.
    const fill = v.coming.find(r => r.type === 'fill' && r.origin === 'forecast');
    const raw = forecastAllFills(d.budgetItems, d.envelopeTemplates, d.accounts, d.envelopes, UP_NOW, '2026-10-15', { fromDateStr: '2026-09-01', country: 'FI' })
      .find(f => f.id === fill.id);
    expect(fill.source).toBe(raw.source);
    expect(fill.source).toBe('allocation');
    expect(txAccountDelta(fill, 'chk')).toBe(txAccountDelta(raw, 'chk'));
  });

  it('a loan payment\'s forecast legs are listed as the page lists them, and are JSON-safe', () => {
    const base = upData();
    const d = upData({
      accounts: [...base.accounts, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -120000, interestDayCount: '30/360' }],
      envelopes: [...base.envelopes, { id: 'housing', name: 'Housing' }],
      budgetItems: [...base.budgetItems, {
        id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'housing', account_id: 'chk', to_account_id: 'mtg',
        loan_rate: 3, default_amount: -1000, monthly_schedule: every(), payment_day: 25, as_schedule: true,
        as_schedule_since: '2026-09-01', include: true, schedule_day_type: 'exact',
      }],
    });
    const v = ask('upcoming', {}, d, UP_NOW).value;
    expect(v).toEqual(expectedUpcoming(d, UP_NOW, 30));
    const legs = v.coming.filter(r => r.forecast_loan_leg);
    expect(legs.map(r => [r.date, r.forecast_loan_leg, r.type])).toEqual([
      ['2026-09-25', 'principal', 'debt_payment'],
      ['2026-09-25', 'interest', 'expense'],
    ]);
    jsonSafe(v);
  });

  it('refuses days out of range, and runs against frozen data without mutating it', () => {
    const d = upData();
    expect(ask('upcoming', { days: 0 }, d, UP_NOW).error.code).toBe('bad_input');
    expect(ask('upcoming', { days: 367 }, d, UP_NOW).error.code).toBe('bad_input');
    const before = JSON.stringify(d);
    ask('upcoming', {}, d, UP_NOW);
    expect(JSON.stringify(d)).toBe(before);
  });
});
