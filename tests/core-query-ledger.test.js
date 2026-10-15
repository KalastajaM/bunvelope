// tests/core-query-ledger.test.js — the Transactions page's running balances
// and the AI's envelope forecast and history as queries: `ledger.running`,
// `envelope.forecast`, `envelope.history`.
//
// `pageLedger` copies js/pages/transactions.js verbatim: buildEffectiveTxList
// (L1132-1146), the running balances and `envStepByTxId` (repaint L1195-1226)
// and buildDayMeta (L153-227), with `state` → the fixture, `appNow()` → the
// fixed clock and `ui` → a parameter; the visible rows are the page's own
// filterAndSort. `toolForecast` and `toolHistory` copy get_forecast and
// get_envelope_history from js/ai/tools/read.js with the wall clock replaced
// by the injected one, and get_forecast given the deleted occurrences
// (`tombstones`, as the Envelope health page passes them; ruling 8). Every
// query answer must equal the copy.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { transactionsPageTxList } from '../js/core/effective-txs.js';
import { getTombstones } from '../js/state/scheduled-tombstones.js';
import { filterAndSort } from '../js/core/transactions-filter.js';
import {
  computeEnvelopeRunningBalances, computeAccountRunningBalances, txNetAccountDelta,
  projectEnvelopeBalance, txEnvelopeEffect,
} from '../js/engine.js';
import { round2 } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const jsonSafe = (v) => expect(JSON.parse(JSON.stringify(v))).toEqual(v);
const at = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0, 0);
const NOW = at(2026, 4, 10);
const ctxAt = (now) => makeCtx({ now, newId: (() => { let n = 0; return () => `q${++n}`; })() });
const ask = (name, input, d, now = NOW) => runQuery(registry, d, name, input, ctxAt(now));
const answer = (name, input, d, now = NOW) => {
  const r = ask(name, input, d, now);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  return r.value;
};

// ── Fixture ────────────────────────────────────────────────────────────────
// Today is 10 Apr 2026. Rent is an auto-posted bill on the 20th; Fun gets a
// template fill of 50 on the 15th (April's deleted: a tombstone); Food is set
// to 250 on the 1st by a template. Stored rows: an income, a fill, a split
// on the card, an envelope transfer, a set-mode fill, two rows on one day in
// reverse array order, adjustments, an account transfer, a scheduled row and
// a future-dated one.
const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const data = () => deepFreeze({
  meta: { country: 'FI', scheduledTombstones: ['tpl:tplFun:2026-04'] },
  accounts: [
    { id: 'chk', name: 'Checking', type: 'checking', initialBalance: 1000 },
    { id: 'card', name: 'Card', type: 'credit_card' },
  ],
  envelopes: [
    { id: 'food', name: 'Food', category: 'Living' },
    { id: 'rent', name: 'Rent', category: 'Housing' },
    { id: 'fun', name: 'Fun', category: 'Living' },
    { id: 'old', name: 'Old', category: 'Misc', archived: true },
  ],
  budgetItems: [
    { id: 'bi-rent', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
      default_amount: -800, payment_day: 20, schedule_day_type: 'exact', include: true,
      as_schedule: true, as_schedule_since: '2026-01-01', monthly_schedule: ALL_MONTHS },
    { id: 'bi-food', kind: 'expense', description: 'Food', envelope_id: 'food', default_amount: -300, include: true, monthly_schedule: ALL_MONTHS },
  ],
  envelopeTemplates: [
    { id: 'tplFun', name: 'Mid-month', kind: 'manual', lines: [{ envelope_id: 'fun', mode: 'add', amount: 50 }],
      schedule: { enabled: true, payment_day: 15, day_type: 'exact', since: '2026-01-01', months: ALL_MONTHS } },
    { id: 'tplFood', name: 'Food reset', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'set', amount: 250 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-01-01', months: ALL_MONTHS } },
  ],
  transactions: [
    { id: 'inc1', type: 'income', date: '2026-03-01', payee: 'Pay', amount: 2000, account: 'chk', status: 'posted' },
    { id: 'fill1', type: 'fill', date: '2026-03-01', payee: 'Fill', status: 'posted',
      lines: [{ envelope_id: 'food', amount: 400 }, { envelope_id: 'rent', amount: 800 }, { envelope_id: 'fun', amount: 100 }] },
    { id: 'e1', type: 'expense', date: '2026-03-05', payee: 'Shop', amount: 45.5, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'split1', type: 'expense', date: '2026-03-05', payee: 'Mall', amount: 30, account: 'card', status: 'posted',
      envelope_splits: [{ envelope_id: 'food', amount: 20.1 }, { envelope_id: 'fun', amount: 9.9 }] },
    { id: 't1', type: 'envelope_transfer', date: '2026-03-10', amount: 15, from_envelope_id: 'fun', to_envelope_id: 'food', status: 'posted' },
    { id: 'rent3', type: 'expense', date: '2026-03-20', payee: 'Landlord', amount: 800, account: 'chk', envelope_id: 'rent', status: 'posted', from_budget: 'bi-rent:2026-03' },
    { id: 'set4', type: 'fill', date: '2026-04-01', payee: 'Reset', status: 'posted', lines: [{ envelope_id: 'food', mode: 'set', amount: 300 }] },
    { id: 'e3', type: 'expense', date: '2026-04-05', payee: 'Kiosk', amount: 7.66, account: 'card', envelope_id: 'food', status: 'posted' },
    { id: 'e2', type: 'expense', date: '2026-04-05', payee: 'Shop', amount: 12.34, account: 'chk', envelope_id: 'food', status: 'posted' },
    { id: 'adjA', type: 'adjustment', date: '2026-04-06', amount: -5, target: 'account', target_id: 'chk', status: 'posted' },
    { id: 'adjE', type: 'adjustment', date: '2026-04-06', amount: 3.5, target: 'envelope', target_id: 'fun', status: 'posted' },
    { id: 'x1', type: 'account_transfer', date: '2026-04-07', amount: 100, from_account: 'chk', to_account: 'card', status: 'posted' },
    { id: 'sched', type: 'expense', date: '2026-04-12', payee: 'Cinema', amount: 20, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
    { id: 'fut', type: 'expense', date: '2026-04-25', payee: 'Shop ahead', amount: 10, account: 'chk', envelope_id: 'food', status: 'posted' },
  ],
});

// ── The page's composition, copied from js/pages/transactions.js ───────────

function pageLedger(state, ui, nowDate) {
  const appNow = () => nowDate;
  let runningBal = null;
  let envStepByTxId = null;
  // ── copied: buildEffectiveTxList L1132-1146 ──
  function buildEffectiveTxList() {
    return transactionsPageTxList({
      transactions:      state.transactions,
      budgetItems:       state.budgetItems || [],
      envelopeTemplates: state.envelopeTemplates || [],
      accounts:          state.accounts || [],
      envelopes:         state.envelopes || [],
      today:             appNow(),
      showScheduled:     !!ui.showScheduled,
      dateFrom:          ui.dateFrom || null,
      dateTo:            ui.dateTo || null,
      country:           state.meta?.country ?? 'FI',
      tombstones:        getTombstones(state.meta),
    });
  }
  // ── copied: buildDayMeta L153-227 ──
  function buildDayMeta(rows, effective, runningBal) {
    const out = new Map();
    if (rows.length === 0) return out;

    if (runningBal) {
      const indexed = effective
        .map((tx, i) => ({ tx, i }))
        .filter(({ tx }) => runningBal.has(tx.id))
        .sort((a, b) => {
          const da = (a.tx.date || '').slice(0, 10);
          const db = (b.tx.date || '').slice(0, 10);
          if (da !== db) return da < db ? -1 : 1;
          return a.i - b.i;
        });
      const dayEnding = new Map(); // date → ending balance
      const orderedDays = [];
      for (const { tx } of indexed) {
        const d = (tx.date || '').slice(0, 10);
        if (!dayEnding.has(d)) orderedDays.push(d);
        dayEnding.set(d, runningBal.get(tx.id));
      }
      const prevDayOf = new Map();
      for (let k = 0; k < orderedDays.length; k++) {
        prevDayOf.set(orderedDays[k], k > 0 ? orderedDays[k - 1] : null);
      }
      let i = 0;
      while (i < rows.length) {
        const date = (rows[i].date || '').slice(0, 10);
        let j = i;
        while (j < rows.length && (rows[j].date || '').slice(0, 10) === date) j++;
        const ending = dayEnding.get(date);
        if (ending != null) {
          const prevDate = prevDayOf.get(date);
          const prevEnding = prevDate ? (dayEnding.get(prevDate) ?? 0) : 0;
          out.set(date, { total: ending - prevEnding, latestBalance: ending });
        }
        i = j;
      }
    } else {
      const accountIds = new Set((state.accounts || []).map(a => a && a.id).filter(Boolean));
      let i = 0;
      while (i < rows.length) {
        const date = (rows[i].date || '').slice(0, 10);
        let j = i;
        let total = 0;
        while (j < rows.length && (rows[j].date || '').slice(0, 10) === date) {
          total += txNetAccountDelta(rows[j], accountIds);
          j++;
        }
        out.set(date, { total: round2(total) });
        i = j;
      }
    }
    return out;
  }

  const effective = buildEffectiveTxList();
  const rows = filterAndSort(effective, ui);
  // ── copied: repaint L1195-1226 ──
  const oneEntity = (!!ui.envelope) !== (!!ui.account);
  const showRunning = oneEntity
    && ui.status === 'all'
    && ui.type === 'all'
    && !ui.search;
  if (showRunning && ui.envelope) {
    runningBal = computeEnvelopeRunningBalances(effective, ui.envelope);
  } else if (showRunning && ui.account) {
    runningBal = computeAccountRunningBalances(state.accounts || [], effective, ui.account);
  } else {
    runningBal = null;
  }
  envStepByTxId = null;
  if (ui.envelope) {
    const walk = runningBal || computeEnvelopeRunningBalances(effective, ui.envelope);
    envStepByTxId = new Map();
    let prevBal = 0;
    for (const [txId, afterBal] of walk) {
      envStepByTxId.set(txId, round2(afterBal - prevBal));
      prevBal = afterBal;
    }
  }
  const dayMeta = buildDayMeta(rows, effective, runningBal);
  return { effective, rows, runningBal, envStepByTxId, dayMeta };
}

const UI = { search: '', envelope: '', account: '', type: 'all', status: 'all', flagged: 'all', dateFrom: '', dateTo: '', showScheduled: false };

/** The query input for a page `ui`. */
function inputOf(ui) {
  return {
    ...(ui.envelope ? { envelope: ui.envelope } : { account: ui.account }),
    showScheduled: ui.showScheduled,
    ...(ui.dateFrom ? { dateFrom: ui.dateFrom } : {}),
    ...(ui.dateTo ? { dateTo: ui.dateTo } : {}),
  };
}

// ── ledger.running ─────────────────────────────────────────────────────────

describe('ledger.running — equals the Transactions page', () => {
  const entities = [
    ['envelope food (a set fill, a split, a transfer in)', { envelope: 'food' }],
    ['envelope fun (a split, a transfer out, an adjustment, template fills)', { envelope: 'fun' }],
    ['envelope rent (an auto-posted bill)', { envelope: 'rent' }],
    ['account chk (opening balance, an adjustment, a transfer out)', { account: 'chk' }],
    ['account card (a split, a transfer in)', { account: 'card' }],
  ];
  const ranges = [
    ['no date range', {}],
    ['a range ending past the 30 days', { dateFrom: '2026-03-15', dateTo: '2026-06-30' }],
    ['a range starting before today', { dateFrom: '2026-01-01' }],
  ];
  for (const [entityLabel, entity] of entities) {
    for (const showScheduled of [false, true]) {
      for (const [rangeLabel, range] of ranges) {
        it(`${entityLabel}, showScheduled ${showScheduled}, ${rangeLabel}`, () => {
          const d = data();
          const ui = { ...UI, ...entity, ...range, showScheduled };
          const page = pageLedger(d, ui, NOW);
          const a = answer('ledger.running', inputOf(ui), d);
          jsonSafe(a);

          // Running balances: every touching row, in the walk's order.
          expect(page.runningBal.size).toBeGreaterThan(0);
          expect(a.rows.map(r => [r.id, r.balance])).toEqual([...page.runningBal].map(([id, b]) => [id, round2(b)]));
          // The envelope's per-row step (the set-fill display amount).
          if (ui.envelope) expect(a.rows.map(r => [r.id, r.step])).toEqual([...page.envStepByTxId]);

          // Day headers: the page fills the visible days; the answer has
          // every day with a touching row.
          const visible = new Set(page.rows.map(r => (r.date || '').slice(0, 10)));
          const pageDays = Object.fromEntries([...page.dayMeta].map(([date, m]) => [date, { date, total: round2(m.total), balance: round2(m.latestBalance) }]));
          const answerDays = Object.fromEntries(a.days.filter(x => visible.has(x.date)).map(x => [x.date, x]));
          expect(answerDays).toEqual(pageDays);
          expect(a.days.map(x => x.date)).toEqual([...a.days.map(x => x.date)].sort());
        });
      }
    }
  }

  it('the preview is in the walk with showScheduled, not without', () => {
    const d = data();
    const off = answer('ledger.running', { envelope: 'rent' }, d);
    const on = answer('ledger.running', { envelope: 'rent', showScheduled: true }, d);
    expect(off.rows.map(r => r.id)).toEqual(['fill1', 'rent3']);
    expect(on.rows.map(r => r.id)).toEqual(['fill1', 'rent3', 'forecast:bi-rent:2026-04']);
    expect(on.rows.at(-1)).toMatchObject({ balance: -800, step: -800 });
    // The tombstoned April fill stays out; a range to June brings May's and June's in.
    const page = pageLedger(d, { ...UI, envelope: 'fun', showScheduled: true, dateTo: '2026-06-30' }, NOW);
    expect(page.effective.filter(t => t.is_forecast && t.type === 'fill' && (t.lines || []).some(l => l.envelope_id === 'fun')).map(t => t.date)).toEqual(['2026-05-15', '2026-06-15']);
    const fun = answer('ledger.running', { envelope: 'fun', showScheduled: true, dateTo: '2026-06-30' }, d);
    expect(fun.days.slice(-2).map(x => [x.date, x.total])).toEqual([['2026-05-15', 50], ['2026-06-15', 50]]);
  });

  it('a set fill steps by target less the prior balance; the day total sums its rows\' steps', () => {
    const a = answer('ledger.running', { envelope: 'food' }, data());
    const byId = Object.fromEntries(a.rows.map(r => [r.id, r]));
    // 400 + 15 − 45.5 − 20.1 = 349.4 before the reset to 300.
    expect(byId.t1.balance).toBe(349.4);
    expect(byId.set4).toEqual({ id: 'set4', balance: 300, step: -49.4 });
    expect(a.days.find(x => x.date === '2026-04-05')).toEqual({ date: '2026-04-05', total: -20, balance: 280 });
    // The two 5 April rows walk in list order: e3 is listed first.
    expect(a.rows.filter(r => ['e2', 'e3'].includes(r.id)).map(r => r.id)).toEqual(['e3', 'e2']);
  });

  it('an account walk starts from its opening balance', () => {
    const a = answer('ledger.running', { account: 'chk' }, data());
    expect(a.rows[0]).toEqual({ id: 'inc1', balance: 3000, step: 3000 });
    expect(a.days[0]).toEqual({ date: '2026-03-01', total: 3000, balance: 3000 });
  });

  it('date is today for the preview, as the clock is', () => {
    const d = data();
    const input = { account: 'chk', showScheduled: true };
    expect(answer('ledger.running', { ...input, date: '2026-04-10' }, d, at(2030, 1, 1))).toEqual(answer('ledger.running', input, d));
  });

  it('needs exactly one of account and envelope; refs must exist', () => {
    const d = data();
    expect(ask('ledger.running', {}, d).error.code).toBe('bad_input');
    expect(ask('ledger.running', { account: 'chk', envelope: 'food' }, d).error).toEqual({
      code: 'bad_input', params: { errors: [{ path: 'account', message: 'give exactly one of account or envelope' }] },
    });
    expect(ask('ledger.running', { envelope: 'nope' }, d).error.code).toBe('bad_input');
  });

  it('an entity no row touches has an empty walk', () => {
    expect(answer('ledger.running', { envelope: 'old' }, data())).toEqual({ rows: [], days: [] });
  });
});

// ── envelope.forecast ──────────────────────────────────────────────────────

// copied: get_forecast run (js/ai/tools/read.js L381-410), `new Date()` → the
// injected clock, tombstones added as the Envelope health page passes them.
// The tool read the country as `|| 'FI'`, the query (and the health page) as
// `?? 'FI'`; they differ only for an empty country, which `country` passes.
function toolForecast(state, input, clock, { country = state.meta?.country || 'FI' } = {}) {
  const envelopeName = (s, id) => (s.envelopes || []).find((e) => e.id === id)?.name || null;
  const months = Math.min(Math.max(Number(input.months) || 3, 1), 24);
  const projection = projectEnvelopeBalance({
    envelopeId: input.envelope_id,
    transactions: state.transactions || [],
    budgetItems: state.budgetItems || [],
    envelopeTemplates: state.envelopeTemplates || [],
    accounts: state.accounts || [],
    envelopes: state.envelopes || [],
    months,
    today: clock(),
    country,
    tombstones: state.meta?.scheduledTombstones || [],
  });
  return {
    envelope: envelopeName(state, input.envelope_id),
    months,
    opening: projection?.opening ?? null,
    closing: projection?.closing ?? null,
    low: projection?.low ?? null,
    high: projection?.high ?? null,
    firstNegative: projection?.firstNegative ?? null,
    monthlyFill: projection?.monthlyFill ?? null,
    fillSource: projection?.fillSource ?? null,
    months_detail: (projection?.months || []).map((m) => ({
      month: m.key, opening: m.opening, in: m.in, out: m.out, partial: m.partial,
    })),
  };
}

describe('envelope.forecast — equals get_forecast with the injected clock and tombstones', () => {
  for (const env of ['food', 'rent', 'fun', 'old']) {
    for (const months of [undefined, 1, 12, 24]) {
      it(`${env}, months ${months ?? 'default'}`, () => {
        const d = data();
        const a = answer('envelope.forecast', { envelope: env, ...(months ? { months } : {}) }, d);
        jsonSafe(a);
        expect(a).toEqual(toolForecast(d, { envelope_id: env, months }, () => NOW));
        // An archived envelope's projection is the unresolved one: no months.
        if (env !== 'old') expect(a.months_detail.length).toBeGreaterThan(0);
      });
    }
  }

  it('honours the deleted occurrences (an answer change from get_forecast)', () => {
    const d = data();
    const a = answer('envelope.forecast', { envelope: 'fun', months: 3 }, d);
    const untombed = toolForecast({ ...d, meta: { ...d.meta, scheduledTombstones: [] } }, { envelope_id: 'fun', months: 3 }, () => NOW);
    expect(a).not.toEqual(untombed);
    expect(round2(untombed.closing - a.closing)).toBe(50);
  });

  it('date moves the start, read from no wall clock', () => {
    const d = data();
    const later = answer('envelope.forecast', { envelope: 'food', date: '2026-06-03' }, d, at(2030, 1, 1));
    expect(later).toEqual(toolForecast(d, { envelope_id: 'food' }, () => at(2026, 6, 3, 12)));
    expect(later.months_detail[0].month).toBe('2026-06');
  });

  it('reads the country as the health page does: an empty one is passed as empty, a missing one as FI', () => {
    const d = data();
    const blank = deepFreeze({ ...d, meta: { ...d.meta, country: '' } });
    expect(answer('envelope.forecast', { envelope: 'rent', months: 3 }, blank))
      .toEqual(toolForecast(blank, { envelope_id: 'rent', months: 3 }, () => NOW, { country: '' }));
    const unset = deepFreeze({ ...d, meta: { scheduledTombstones: d.meta.scheduledTombstones } });
    expect(answer('envelope.forecast', { envelope: 'rent', months: 3 }, unset))
      .toEqual(toolForecast(unset, { envelope_id: 'rent', months: 3 }, () => NOW, { country: 'FI' }));
  });

  it('refuses an unknown envelope and a months out of range', () => {
    const d = data();
    expect(ask('envelope.forecast', { envelope: 'nope' }, d).error.code).toBe('bad_input');
    expect(ask('envelope.forecast', { envelope: 'food', months: 25 }, d).error.code).toBe('bad_input');
    expect(ask('envelope.forecast', {}, d).error.code).toBe('bad_input');
  });
});

// ── envelope.history ───────────────────────────────────────────────────────

// copied: get_envelope_history run (js/ai/tools/read.js L295-325),
// `new Date()` → the injected clock.
function toolHistory(state, input, clock) {
  const envelopeName = (s, id) => (s.envelopes || []).find((e) => e.id === id)?.name || null;
  const months = Math.min(Math.max(Number(input.months) || 12, 1), 36);
  const now = clock();
  const buckets = new Map();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, { month: key, in: 0, out: 0 });
  }

  for (const tx of (state.transactions || [])) {
    if (tx.is_forecast) continue;
    const key = String(tx.date || '').slice(0, 7);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const effect = txEnvelopeEffect(tx, input.envelope_id);
    if (!effect || effect.mode !== 'add') continue;
    const amount = effect.amount;
    if (!amount) continue;
    if (amount > 0) bucket.in = round2(bucket.in + amount);
    else bucket.out = round2(bucket.out - amount);
  }

  return {
    envelope: envelopeName(state, input.envelope_id),
    months: [...buckets.values()],
  };
}

describe('envelope.history — equals get_envelope_history with the injected clock', () => {
  const withForecastRow = () => {
    const d = data();
    return deepFreeze({ ...d, transactions: [...d.transactions, { id: 'fc', type: 'expense', date: '2026-04-02', amount: 99, envelope_id: 'food', is_forecast: true }] });
  };
  for (const env of ['food', 'rent', 'fun', 'old']) {
    for (const months of [undefined, 1, 2, 36]) {
      it(`${env}, months ${months ?? 'default'}`, () => {
        const d = withForecastRow();
        const a = answer('envelope.history', { envelope: env, ...(months ? { months } : {}) }, d);
        jsonSafe(a);
        expect(a).toEqual(toolHistory(d, { envelope_id: env, months }, () => NOW).months);
      });
    }
  }

  it('food: in, out, the set fill and the forecast row left out', () => {
    const a = answer('envelope.history', { envelope: 'food', months: 2 }, withForecastRow());
    expect(a).toEqual([
      { month: '2026-03', in: 415, out: 65.6 },
      { month: '2026-04', in: 0, out: 30 },
    ]);
  });

  it('date picks the last month, read from no wall clock', () => {
    const d = data();
    const a = answer('envelope.history', { envelope: 'food', months: 3, date: '2026-03-31' }, d, at(2030, 1, 1));
    expect(a).toEqual(toolHistory(d, { envelope_id: 'food', months: 3 }, () => at(2026, 3, 31, 12)).months);
    expect(a.map(m => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('refuses an unknown envelope and a months out of range', () => {
    const d = data();
    expect(ask('envelope.history', { envelope: 'nope' }, d).error.code).toBe('bad_input');
    expect(ask('envelope.history', { envelope: 'food', months: 37 }, d).error.code).toBe('bad_input');
  });
});
