// tests/cli-query-smoke.test.js — the real `bin/bunvelope.mjs` process running
// the read-only queries over a bundle file: the single-segment verbs
// `balances`, `upcoming` and `age-of-money`, and the dotted verbs `net-worth
// current` / `history` / `projection`, `cash position`, `cards due`,
// `spending month` / `history`, `plan annual`, `envelopes month` / `history`,
// `reports spending` / `cashflow`, `flow plan` / `actual`, `investments
// holdings` / `tax`, `ledger running`, `envelope forecast` / `history` /
// `health`, `emergency requirement`, `fill preview`,
// `stress runway`, `forecast balances` /
// `simulation` and `review month`, plus the name → id resolution of a
// top-level ref flag. The process reads the wall
// clock, so every date the answers depend on is either in the distant past or
// derived from the current month here. No Postgres.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';

const pad2 = (n) => String(n).padStart(2, '0');
const monthOf = (offset) => {
  const d = new Date(); const m = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return `${m.getFullYear()}-${pad2(m.getMonth() + 1)}`;
};
const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad2(new Date(y, m, 0).getDate())}`;
};

describe('CLI queries over a bundle file', () => {
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bv-cli-query-'));
    file = join(dir, 'bundle.json');
    writeFileSync(file, JSON.stringify({
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
      accounts: [
        { id: 'chk', name: 'Checking', type: 'checking' },
        { id: 'amex', name: 'Amex', type: 'credit_card' },
      ],
      envelopes: [{ id: 'groceries', name: 'Groceries' }, { id: 'rent', name: 'Rent' }],
      budgetItems: [],
      envelopeTemplates: [],
      transactions: [
        { id: 'i1', type: 'income', date: '2020-03-01', status: 'posted', amount: 1000, account: 'chk', envelope_id: 'groceries' },
        { id: 'e1', type: 'expense', date: '2020-03-10', status: 'posted', amount: 40, account: 'amex', envelope_id: 'groceries' },
      ],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args) => {
    const r = spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args, '--file', file], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
    });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr) : null };
  };
  const byId = (rows) => Object.fromEntries(rows.map(r => [r.id, r.balance]));

  it('searches by resolved names, totals before pagination, and leaves the bundle unchanged', () => {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    d.transactions = Array.from({ length: 75 }, (_, i) => ({
      id: `search-${i}`, type: 'expense', date: '2026-09-10', payee: 'Search shop',
      amount: 10, account: 'chk', envelope_id: 'groceries', status: 'posted',
    }));
    writeFileSync(file, JSON.stringify(d));
    const before = readFileSync(file, 'utf8');
    const r = cli('transactions', 'search', '--account', 'Checking', '--envelope', 'Groceries', '--search', 'search shop');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toMatchObject({ matched: 75, totalMagnitude: 750, hasMore: true, limit: 60 });
    expect(r.out.value.rows).toHaveLength(60);
    const next = cli('transactions', 'search', '--offset', '60', '--limit', '20');
    expect(next.out.value.rows).toHaveLength(15);
    expect(next.out.value.rows[0].id).toBe('search-14');
    expect(next.out.value.hasMore).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('templates summary returns pending occurrences and resolved lines without writing', () => {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    d.envelopeTemplates = [{
      id: 'payday', name: 'Payday', kind: 'manual',
      lines: [{ envelope_id: 'groceries', mode: 'set', amount: 300 }],
      schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-01-01', months: { Sep: true, Oct: true } },
    }];
    d.meta.scheduledTombstones = ['tpl:payday:2026-09'];
    writeFileSync(file, JSON.stringify(d));
    const before = readFileSync(file, 'utf8');
    const r = cli('templates', 'summary', '--date', '2026-09-15', '--templates', '["payday"]');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value.templates).toEqual([{
      id: 'payday', lineCount: 1, total: 300,
      resolvedLines: [{ envelope_id: 'groceries', mode: 'set', amount: 300 }],
      nextPending: { date: '2026-10-25', monthKey: '2026-10' },
    }]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(cli('templates', 'summary', '--templates', '[]').out.value.templates).toEqual([]);
    expect(cli('templates', 'summary', '--templates', '["missing"]').err.error.code).toBe('ref_not_found');
  });

  it('accounts detail exposes portfolio values, with zero and null kept distinct', () => {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    d.accounts.push({ id: 'broker', name: 'Broker', type: 'investment' }, { id: 'empty', name: 'Empty', type: 'investment' });
    d.meta.investments = { holdingOverrides: { broker: { FUND: { units: 2, costBasis: 100 } } }, prices: { FUND: { price: 75 } } };
    writeFileSync(file, JSON.stringify(d));
    const r = cli('accounts', 'detail', '--repayment', 'false');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value.accounts.map(a => [a.id, a.portfolioValue])).toEqual([
      ['chk', null], ['amex', null], ['broker', 150], ['empty', 0],
    ]);
  });

  it('balances: the booked lens, then the forecast lens through a horizon', () => {
    const booked = cli('balances', '--lens', 'booked');
    expect(booked.status, JSON.stringify(booked.err)).toBe(0);
    expect(booked.out.value).toMatchObject({ lens: 'booked', horizon: null, unallocated: 0 });
    expect(byId(booked.out.value.accounts)).toEqual({ chk: 1000, amex: -40 });
    expect(byId(booked.out.value.envelopes)).toEqual({ groceries: 960, rent: 0 });

    const eom = cli('balances', '--lens', 'forecast', '--horizon', 'eom');
    expect(eom.status, JSON.stringify(eom.err)).toBe(0);
    expect(eom.out.value.lens).toBe('forecast');
    expect(eom.out.value.horizon).toBe(lastDay(monthOf(0)));
    expect(byId(eom.out.value.accounts)).toEqual({ chk: 1000, amex: -40 });
  });

  it('balances: the answer carries the hero totals', () => {
    const booked = cli('balances', '--lens', 'booked');
    expect(booked.status, JSON.stringify(booked.err)).toBe(0);
    expect(booked.out.value.totals).toEqual({ envelopes: 960, accounts: 960, assignedPct: 100 });
  });

  it('net worth current: the parts and the lens default', () => {
    const r = cli('net-worth', 'current');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toMatchObject({ lens: 'booked', horizon: null, total: 960, notYetCleared: 0, hasActiveAccounts: true });
    // 'checking' is not a spending type by default; the card is.
    expect(r.out.value.parts).toMatchObject({ spending: -40, other: 1000 });
    expect(r.out.value.unrealized).toEqual({ pl: 0, pct: 0, hasData: false });
  });

  it('net worth history: the month-ends before today, then today; an excluded account leaves the totals', () => {
    const d = new Date();
    const today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const r = cli('net-worth', 'history', '--months', '3');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value.points.map(p => p.date)).toEqual([...[-3, -2, -1].map(o => lastDay(monthOf(o))), today]);
    expect(r.out.value.points.map(p => p.total)).toEqual([960, 960, 960, 960]);
    const ex = cli('net-worth', 'history', '--months', '1', '--exclude-accounts', '["amex"]');
    expect(ex.status, JSON.stringify(ex.err)).toBe(0);
    expect(ex.out.value.points.map(p => p.total)).toEqual([1000, 1000]);
  });

  it('forecast simulation: a 12-month walk; an unknown what-if is not found', () => {
    const r = cli('forecast', 'simulation', '--months', '12');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    expect(v.points).toHaveLength(13);
    expect(v.points.at(-1)).toMatchObject({ date: lastDay(monthOf(12)), total: 960, spending: -40, other: 1000 });
    expect(v.end).toBe(lastDay(monthOf(12)));
    expect(v).toMatchObject({ alerts: [], whatIf: null, alertsDiff: null });

    const bad = cli('forecast', 'simulation', '--what-if', 'nope');
    expect(bad.status).toBe(1);
    expect(bad.err.error).toMatchObject({ code: 'not_found', params: { kind: 'whatIf', id: 'nope' } });
  });

  it('net worth projection: ten flat years with no rates or contributions; years is required', () => {
    const r = cli('net-worth', 'projection', '--years', '10');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    const flat = Array.from({ length: 11 }, (_, year) => ({ year, total: 960 }));
    expect(v).toMatchObject({ years: 10, base: flat, low: flat, high: flat, whatIf: null,
      table: { used: 0, plan: 0, actual: 0, gap: false } });
    expect(v.accounts.map(a => [a.id, a.balance, a.atHorizon, a.shown])).toEqual([['chk', 1000, 1000, true], ['amex', -40, -40, true]]);

    const bad = cli('net-worth', 'projection');
    expect(bad.status).toBe(1);
    expect(bad.err.error.code).toBe('bad_input');
  });

  it('cash position: the spending accounts over the last months', () => {
    const r = cli('cash', 'position', '--months', '3');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    expect(v).toMatchObject({ lens: 'booked', balance: -40, notYetCleared: 0, accountCount: 1, delta: 0 });
    expect(v.series).toEqual([-2, -1, 0].map(o => ({ date: lastDay(monthOf(o)), balance: -40 })));
  });

  it('cards due: what each credit card owes', () => {
    const r = cli('cards', 'due');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toEqual({ lens: 'booked', horizon: null, cards: [{ account: 'amex', name: 'Amex', paymentDue: 40, postedDue: 40 }], total: 40 });
  });

  it('spending month and history: the consumption of the rows dated in a month', () => {
    const month = cli('spending', 'month', '--month', '2020-03');
    expect(month.status, JSON.stringify(month.err)).toBe(0);
    expect(month.out.value).toEqual({ month: '2020-03', spent: 40, planned: 0, averageMonthlyFunding: 0, calendarPlanned: 0, calendarSpentPct: 0, spentPct: 0, daysLeft: null, byCategory: [{ category: 'other', amount: 40 }] });

    const history = cli('spending', 'history', '--months', '3', '--date', '2020-03-20');
    expect(history.status, JSON.stringify(history.err)).toBe(0);
    expect(history.out.value.months).toEqual([
      { month: '2020-01', spent: 0 }, { month: '2020-02', spent: 0 }, { month: '2020-03', spent: 40 },
    ]);

    const own = cli('spending', 'month', '--date', '2020-03-20');
    expect(own.out.value).toMatchObject({ month: '2020-03', spent: 40, daysLeft: 11 });
  });

  it('plan annual: the year of a plan against its income', () => {
    const none = cli('plan', 'annual', '--date', '2020-03-01');
    expect(none.status, JSON.stringify(none.err)).toBe(0);
    expect(none.out.value).toMatchObject({ hasIncluded: false, status: 'balanced' });

    const months = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    bundle.budgetItems = [
      { id: 'pay', kind: 'income', description: 'Pay', default_amount: 1000, include: true, monthly_schedule: months },
      { id: 'groc', kind: 'expense', description: 'Food', envelope_id: 'groceries', default_amount: -250, include: true, monthly_schedule: months },
    ];
    writeFileSync(file, JSON.stringify(bundle));
    const r = cli('plan', 'annual', '--date', '2020-03-01');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toEqual({ hasIncluded: true, income: 12000, budget: 3000, diff: 9000, status: 'surplus', coveragePct: 25, fillPct: 25 });
  });

  it('stress runway: the scenario table, then with --detail', () => {
    const none = cli('stress', 'runway', '--date', '2020-03-01');
    expect(none.status, JSON.stringify(none.err)).toBe(0);
    // Only the card is crisis cash ('checking' is neither spending nor savings); no plan, no burn.
    expect(none.out.value).toMatchObject({ lens: 'booked', horizon: null, liquid: -40, bufferFloor: 0, usableCash: 0 });
    expect(none.out.value.scenarios.map(s => [s.scenario, s.runway])).toEqual(
      ['Baseline', 'A', 'B', 'C', 'D', 'E'].map(s => [s, 'unlimited']),
    );
    expect(none.out.value.items).toBeUndefined();

    const months = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    bundle.accounts.push({ id: 'sav', name: 'Savings', type: 'savings', initialBalance: 1200 });
    bundle.budgetItems = [
      { id: 'groc', kind: 'expense', description: 'Food', envelope_id: 'groceries', default_amount: -250, include: true, monthly_schedule: months,
        extra_buffer: 100, stress_category: 'B', stress_cut_pcts: { A: 0.5, B: 0.5 } },
    ];
    writeFileSync(file, JSON.stringify(bundle));
    const r = cli('stress', 'runway', '--date', '2020-03-01', '--detail');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    expect(v).toMatchObject({ liquid: 1160, bufferFloor: 100, usableCash: 1060 });
    expect(v.scenarios[0]).toEqual({
      scenario: 'Baseline', extraExpense: 0, income: 0, expense: 3000, net: -3000, netNegative: true, delta: 0, deltaSign: 0, runway: 'months', months: 1060 / 250,
    });
    expect(v.scenarios[1]).toMatchObject({ scenario: 'A', expense: 1500, delta: 1500, deltaSign: 1, runway: 'months', months: 1060 / 125 });
    expect(v.items).toEqual([{
      id: 'groc', annual: 3000,
      adjusted: { A: 1500, B: 1500, C: 3000, D: 3000, E: 3000 },
      impact: { A: -1500, B: -1500, C: 0, D: 0, E: 0 },
      impactSign: { A: -1, B: -1, C: 0, D: 0, E: 0 },
    }]);
    expect(v.flatLadder).toEqual(['groc']);
  });

  it('age of money: the trend ends with date\'s month; no operating income, no figure', () => {
    // 'checking' is not a spending type by default, so its income is not
    // operating money: only the card's spend is left.
    const r = cli('age-of-money', '--date', '2020-03-31', '--months', '3');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toEqual({
      days: null, health: null, runwayLimited: false, runwayDays: 0, recentSpendPerDay: 1.33, liquidBalance: -40,
      history: [
        { month: '2020-01', date: '2020-01-31', days: null },
        { month: '2020-02', date: '2020-02-29', days: null },
        { month: '2020-03', date: '2020-03-31', days: null },
      ],
      drops: [],
      oneOffs: [],
    });
  });

  it('upcoming: the stored rows dated after date, within the window', () => {
    const r = cli('upcoming', '--days', '30', '--date', '2020-03-05');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toEqual({
      overdue: [],
      coming: [{ id: 'e1', type: 'expense', date: '2020-03-10', status: 'posted', amount: 40, account: 'amex', envelope_id: 'groceries', origin: 'ledger', overdue: false }],
    });
    // The window ends at date + days: five days on, e1 is past it.
    expect(cli('upcoming', '--days', '4', '--date', '2020-03-05').out.value.coming).toEqual([]);
  });

  it('envelopes month: one envelope\'s card figures', () => {
    const r = cli('envelopes', 'month', '--date', '2020-03-15', '--envelopes', '["groceries"]');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toMatchObject({ lens: 'booked', horizon: null });
    expect(r.out.value.envelopes).toHaveLength(1);
    expect(r.out.value.envelopes[0]).toMatchObject({
      id: 'groceries', name: 'Groceries', balance: 960, todayBalance: 960, planned: 0, spent: 40, fundsTemplates: null,
    });
    expect(typeof r.out.value.envelopes[0].spare.spare).toBe('number');
  });

  it('forecast balances: a card flag given by name settles from the named account', () => {
    const date = lastDay(monthOf(1));
    const r = cli('forecast', 'balances', '--date', date, '--cards', 'settle-15th', '--card-funding-account', 'Checking');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    expect(v.date).toBe(date);
    expect(v.assumptions).toEqual({ charge: 'plan', cards: 'settle-15th', cardFundingAccount: 'chk' });
    expect(byId(v.accounts)).toEqual({ chk: 960, amex: 0 });
    expect(v.settlements.length).toBeGreaterThan(0);
    expect(v.settlements.every(s => s.account === 'amex')).toBe(true);
    expect(v.settlements.reduce((sum, s) => sum + s.amount, 0)).toBe(40);

    const bad = cli('forecast', 'balances', '--date', date, '--cards', 'settle-15th');
    expect(bad.status).toBe(1);
    expect(bad.err.error.code).toBe('bad_input');
  });

  it('review month: a past month, then one envelope\'s rows in it', () => {
    const month = cli('review', 'month', '--month', '2020-03');
    expect(month.status, JSON.stringify(month.err)).toBe(0);
    expect(month.out.value.month).toBe('2020-03');
    const rows = month.out.value.rows;
    expect(rows.map(r => r.envelope_id)).toEqual(['groceries', 'rent']);
    expect(month.out.value.detail).toBeUndefined();

    const one = cli('review', 'month', '--month', '2020-03', '--envelope', 'Groceries');
    expect(one.status, JSON.stringify(one.err)).toBe(0);
    expect(one.out.value.detail.envelope).toBe('groceries');
    expect(one.out.value.detail.actual.map(t => t.id)).toEqual(['i1', 'e1']);
  });
  it('reports spending: by payee over all time; by envelope with an exclusion', () => {
    const r = cli('reports', 'spending', '--group-by', 'payee');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toEqual({ groupBy: 'payee', rows: [{ key: '(no payee)', label: '(no payee)', value: 40 }], other: null });
    const ex = cli('reports', 'spending', '--group-by', 'envelope', '--exclude-envelopes', '["groceries"]');
    expect(ex.status, JSON.stringify(ex.err)).toBe(0);
    expect(ex.out.value.rows).toEqual([]);
    const bad = cli('reports', 'spending');
    expect(bad.status).toBe(1);
    expect(bad.err.error.code).toBe('bad_input');
  });

  it('reports cashflow: the months of a range, their totals and the average window', () => {
    const r = cli('reports', 'cashflow', '--from', '2020-01-01', '--to', '2020-12-31');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    expect(v.months).toEqual(['2020-03']);
    expect(v.totals).toEqual({ income: 1000, spending: 40, saving: 0, net: 960 });
    expect(v.averages).toEqual({ window: { from: '2020-01-01', to: '2020-12-31' }, income: 100, spending: 4, saving: null, spendingByMonth: 4 });
  });

  it('envelopes history: the month-ends through today\'s month, with a picked envelope', () => {
    const r = cli('envelopes', 'history', '--months', '3', '--envelopes', '["groceries"]');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    const v = r.out.value;
    expect(v.months).toEqual([monthOf(-2), monthOf(-1), monthOf(0)]);
    expect(v.totals.map(p => p.value)).toEqual([960, 960, 960]);
    expect(v.byEnvelope).toEqual([{ id: 'groceries', points: v.months.map(month => ({ month, value: 960 })) }]);
  });
  it('flow plan and actual: the plan\'s year, a range of posted rows; period is required', () => {
    const plan = cli('flow', 'plan', '--period', 'year');
    expect(plan.status, JSON.stringify(plan.err)).toBe(0);
    expect(plan.out.value).toEqual({ nodes: [], links: [], totals: { in: 0, out: 0 } });
    const actual = cli('flow', 'actual', '--from', '2020-01-01', '--to', '2020-12-31', '--top-sources', '0');
    expect(actual.status, JSON.stringify(actual.err)).toBe(0);
    expect(actual.out.value.totals).toEqual({ in: 1000, out: 1000 });
    expect(actual.out.value.nodes.find(n => n.kind === 'envelope')).toMatchObject({ key: 'groceries', value: 40 });
    const bad = cli('flow', 'plan');
    expect(bad.status).toBe(1);
    expect(bad.err.error.code).toBe('bad_input');
  });

  it('investments holdings and tax: a broker account with a buy and a sell', () => {
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    bundle.meta.investments = { prices: { VWCE: { price: 120 } } };
    bundle.accounts.push({ id: 'brk', name: 'Broker', type: 'investment' });
    bundle.transactions.push(
      { id: 'b1', type: 'investment_transfer', direction: 'buy', date: '2020-04-01', status: 'posted', amount: 500, units: 5, symbol: 'VWCE', from_account: 'chk', to_account: 'brk' },
      { id: 's1', type: 'investment_transfer', direction: 'sell', date: '2021-04-01', status: 'posted', amount: 300, units: 2, symbol: 'VWCE', from_account: 'brk', to_account: 'chk' },
    );
    writeFileSync(file, JSON.stringify(bundle));
    const h = cli('investments', 'holdings');
    expect(h.status, JSON.stringify(h.err)).toBe(0);
    expect(h.out.value.holdings).toEqual([{ accountId: 'brk', symbol: 'VWCE', name: null, units: 3, costBasis: 300, realized: 100,
      distributions: 0, oversoldUnits: 0, overridden: false, price: 120, markPrice: 120, zero: false }]);
    expect(h.out.value.accounts).toEqual([{ id: 'brk', balance: 200, value: 360, gap: -160 }]);
    expect(h.out.value.invested[0]).toEqual({ month: '2020-04', value: 500 });
    expect(h.out.value.invested.at(-1)).toEqual({ month: monthOf(0), value: 200 });
    const tax = cli('investments', 'tax', '--year', '2019');
    expect(tax.status, JSON.stringify(tax.err)).toBe(0);
    expect(tax.out.value).toMatchObject({ years: [2021], year: 2021, totals: { grossProceeds: 300, purchaseCost: 200, gains: 100, losses: 0, net: 100 } });
    expect(tax.out.value.sales.map(s => s.id)).toEqual(['s1']);
  });

  it('ledger running: an account by name, its balance after each row and per day', () => {
    const r = cli('ledger', 'running', '--account', 'Checking');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toEqual({ rows: [{ id: 'i1', balance: 1000, step: 1000 }], days: [{ date: '2020-03-01', total: 1000, balance: 1000 }] });
    const env = cli('ledger', 'running', '--envelope', 'Groceries');
    expect(env.status, JSON.stringify(env.err)).toBe(0);
    expect(env.out.value.rows).toEqual([{ id: 'i1', balance: 1000, step: 1000 }, { id: 'e1', balance: 960, step: -40 }]);
    const bad = cli('ledger', 'running');
    expect(bad.status).toBe(1);
    expect(bad.err.error.code).toBe('bad_input');
  });

  it('envelope forecast and history: one envelope by name, from a date', () => {
    const f = cli('envelope', 'forecast', '--envelope', 'Groceries', '--months', '2', '--date', '2020-03-15');
    expect(f.status, JSON.stringify(f.err)).toBe(0);
    expect(f.out.value).toMatchObject({ envelope: 'Groceries', months: 2, opening: 960, closing: 960, firstNegative: null });
    expect(f.out.value.months_detail.map(m => m.month)).toEqual(['2020-03', '2020-04', '2020-05']);
    const h = cli('envelope', 'history', '--envelope', 'Groceries', '--months', '2', '--date', '2020-03-15');
    expect(h.status, JSON.stringify(h.err)).toBe(0);
    expect(h.out.value).toEqual([{ month: '2020-02', in: 0, out: 0 }, { month: '2020-03', in: 1000, out: 40 }]);
  });

  it('envelope health, emergency requirement and fill preview', () => {
    const h = cli('envelope', 'health', '--envelope', 'Groceries', '--months', '1', '--date', '2020-03-15');
    expect(h.status, JSON.stringify(h.err)).toBe(0);
    expect(h.out.value).toMatchObject({ envelope: 'groceries', lensBalance: 960, asOfBalance: 960, recommendations: expect.any(Array) });
    expect(h.out.value.projection).toMatchObject({ opening: 960, closing: 960, unresolved: false });
    expect(h.out.value.projection.months.map(m => m.key)).toEqual(['2020-03', '2020-04']);
    // No emergency envelope in this budget.
    const e = cli('emergency', 'requirement', '--month', '2020-03');
    expect(e.status, JSON.stringify(e.err)).toBe(0);
    expect(e.out.value).toBeNull();
    const f = cli('fill', 'preview', '--lines', '[{"envelope":"rent","amount":25}]', '--envelopes', '["rent","groceries"]', '--date', '2020-03-15');
    expect(f.status, JSON.stringify(f.err)).toBe(0);
    expect(f.out.value).toEqual({ envelopes: [{ id: 'rent', spare: 25, lowDate: '2020-03-15' }, { id: 'groceries', spare: 960, lowDate: '2020-03-15' }] });
  });

  it('balances as of a day, and envelopes month without the projection', () => {
    const r = cli('balances', '--lens', 'booked', '--as-of', '2020-03-05');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(byId(r.out.value.accounts)).toEqual({ chk: 1000, amex: 0 });
    expect(byId(r.out.value.envelopes)).toEqual({ groceries: 1000, rent: 0 });
    const m = cli('envelopes', 'month', '--date', '2020-03-15', '--spare', 'false');
    expect(m.status, JSON.stringify(m.err)).toBe(0);
    expect(m.out.value.envelopes.map(e => [e.id, e.spare, e.buffer])).toEqual([['groceries', null, 0], ['rent', null, 0]]);
  });

  it('--now fixes the clock: review month then defaults to that month', () => {
    const r = cli('review', 'month', '--now', '2020-03-15');
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.value).toMatchObject({ month: '2020-03', isCurrent: true, isFuture: false });
    const bad = cli('review', 'month', '--now', 'yesterday');
    expect(bad.status).toBe(2);
    expect(bad.err.error.code).toBe('bad_arguments');
  });
});
