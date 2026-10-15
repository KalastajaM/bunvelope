// Owner decision 2026-09-24: `fill { mode: 'set' }` stays a real, scheduled
// operation on templates ("top this envelope up to 500"), and the forecast
// honours it. A forecast row cannot know the balance it will overwrite when
// it is generated, so the projection walk resolves it against the balance it
// has walked to on that day: the effective delta is target − walked balance,
// and the funding-source leg (when the template draws a source envelope)
// draws exactly that delta. Recommendations phrase their advice as a change
// to the top-up TARGET instead of standing down.

import { describe, it, expect } from 'vitest';
import {
  projectEnvelopeBalance, recommendEnvelopeActions, materializeDueTemplateFills,
  forecastTemplateFills, computeEnvelopeBalances, templateFillSourceId,
  computeTemplateSourceDraws, lensTransactions,
} from '../../js/engine.js';
import { _resetLensCache } from '../../js/engine/lens.js';

const ALL = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};
const TODAY = new Date(2026, 0, 1);
const ACCOUNTS = [{ id: 'a1', name: 'Checking', type: 'bank' }];
const ENVELOPES = [
  { id: 'groc', name: 'Groceries' },
  { id: 'other', name: 'Other' },
  { id: 'buf', name: 'Buffer' },
];

// 200 leaves Groceries on the 28th of every month, three days after the fill.
const SPEND = {
  id: 'bi-groc', envelope_id: 'groc', description: 'Groceries', default_amount: 200,
  include: true, payment_day: 28, monthly_schedule: { ...ALL }, as_schedule: true, account_id: 'a1',
};

const setTpl = (target = 500, over = {}) => ({
  id: 'tpl', name: 'Top up',
  lines: [{ envelope_id: 'groc', mode: 'set', amount: target }],
  schedule: { enabled: true, payment_day: 25, months: { ...ALL } },
  ...over,
});

function input(extra = {}) {
  return {
    envelopeId: 'groc',
    transactions: [],
    budgetItems: [SPEND],
    envelopeTemplates: [setTpl()],
    accounts: ACCOUNTS,
    envelopes: ENVELOPES,
    today: TODAY,
    months: 12,
    ...extra,
  };
}

const on = (p, date) => p.daily.find(d => d.date === date)?.balance;
const byKind = (recs, kind) => recs.find(r => r.kind === kind);

describe('projection resolves a scheduled set line against the walked balance', () => {
  it('tops a monthly set template up by what was spent: 500 first, then 200 a month', () => {
    const p = projectEnvelopeBalance(input());
    expect(p.months).toHaveLength(12);
    expect(p.months.map(m => m.in)).toEqual([500, ...Array(11).fill(200)]);
    expect(p.months.every(m => m.out === -200)).toBe(true);
    expect(on(p, '2026-01-25')).toBe(500);
    expect(on(p, '2026-01-28')).toBe(300);
    expect(on(p, '2026-02-25')).toBe(500);
    expect(p.closing).toBe(300);
  });

  it('lets a set line after a big hand fill pull the balance DOWN to the target', () => {
    const handFill = {
      id: 'hand', type: 'fill', date: '2026-01-20', status: 'posted',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 2000 }],
    };
    const p = projectEnvelopeBalance(input({ transactions: [handFill] }));
    expect(on(p, '2026-01-24')).toBe(2000);
    expect(on(p, '2026-01-25')).toBe(500);
    // The set line's resolved delta is −1500, which lands in the month's outflow.
    expect(p.months[0].in).toBe(2000);
    expect(p.months[0].out).toBe(-1700);
  });

  it('reads fillDelta on a set line as a raised target', () => {
    const p = projectEnvelopeBalance(input({ fillDelta: 100 }));
    expect(on(p, '2026-01-25')).toBe(600);
    expect(on(p, '2026-02-25')).toBe(600);
    // The first top-up from zero is 100 larger; after that it still replaces
    // exactly what was spent, just against a higher target.
    expect(p.months[0].in).toBe(600);
    expect(p.months[1].in).toBe(200);
    expect(p.closing).toBe(400);
  });

  it('classifies a set-only envelope as scheduled-set, reporting the target', () => {
    const p = projectEnvelopeBalance(input());
    expect(p.fillSource).toBe('scheduled-set');
    expect(p.monthlyFill).toBe(500);
  });

  it('classifies set on a gapped cadence as scheduled-set too: a target has no per-month rate', () => {
    const p = projectEnvelopeBalance(input({
      envelopeTemplates: [setTpl(500, { schedule: { enabled: true, payment_day: 25, months: { Mar: true, Sep: true } } })],
    }));
    expect(p.fillSource).toBe('scheduled-set');
    expect(p.monthlyFill).toBe(500);
  });

  it('keeps an envelope funded by BOTH add and set lines on scheduled-irregular', () => {
    const p = projectEnvelopeBalance(input({
      envelopeTemplates: [
        setTpl(),
        { id: 'add', lines: [{ envelope_id: 'groc', mode: 'add', amount: 50 }],
          schedule: { enabled: true, payment_day: 10, months: { ...ALL } } },
      ],
    }));
    expect(p.fillSource).toBe('scheduled-irregular');
  });

  it('honours a dynamic template\'s set assignment (target = monthly plan) the same way', () => {
    const planned = { ...SPEND, as_schedule: false, account_id: null };
    const dyn = {
      id: 'dyn', name: 'Dynamic', kind: 'dynamic',
      assignments: [{ envelope_id: 'groc', mode: 'set', percent: 100 }],
      schedule: { enabled: true, payment_day: 25, months: { ...ALL } },
    };
    const p = projectEnvelopeBalance(input({ budgetItems: [planned], envelopeTemplates: [dyn] }));
    expect(p.fillSource).toBe('scheduled-set');
    expect(p.monthlyFill).toBe(200);
    expect(on(p, '2026-01-25')).toBe(200);
    expect(on(p, '2026-01-28')).toBe(0);
    expect(on(p, '2026-02-25')).toBe(200);
  });
});

describe('a set line funded from a source envelope draws the resolved delta', () => {
  const sourced = (target = 500) => ({
    id: 'tpl', name: 'Top up from buffer',
    lines: [
      { envelope_id: 'groc', mode: 'set', amount: target },
      { envelope_id: 'other', mode: 'add', amount: 100 },
    ],
    schedule: { enabled: true, payment_day: 25, months: { ...ALL }, since: '2026-01-01', source_envelope_id: 'buf' },
  });
  const funding = {
    id: 'seed', type: 'adjustment', target: 'envelope', target_id: 'buf', amount: 5000,
    date: '2025-12-01', status: 'posted',
  };

  it('no longer declines a source for a template carrying a set line', () => {
    const t = sourced();
    const envById = new Map(ENVELOPES.map(e => [e.id, e]));
    expect(templateFillSourceId(t, '2026-02-25', t.lines, envById)).toBe('buf');
    expect(computeTemplateSourceDraws([t]).get('buf')).toHaveLength(1);
  });

  it('marks the forecast twin\'s source leg as pending, carrying only the add part', () => {
    const rows = forecastTemplateFills([sourced()], [], ENVELOPES, TODAY, '2026-02-28', {});
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source_envelope_id).toBe('buf');
      expect(r.source_set_pending).toBe(true);
      expect(r.lines.at(-1)).toEqual({ envelope_id: 'buf', mode: 'add', amount: -100 });
    }
  });

  it('the source projection draws exactly what the target projection receives', () => {
    const base = input({ transactions: [funding], envelopeTemplates: [sourced()] });
    const groc = projectEnvelopeBalance(base);
    const buf = projectEnvelopeBalance({ ...base, envelopeId: 'buf' });
    const other = projectEnvelopeBalance({ ...base, envelopeId: 'other' });
    expect(groc.months.map(m => m.in)).toEqual([500, ...Array(11).fill(200)]);
    for (let i = 0; i < 12; i++) {
      expect(buf.months[i].out).toBe(-(groc.months[i].in + other.months[i].in));
    }
    expect(buf.closing).toBe(5000 - 500 - 11 * 200 - 12 * 100);
    // The draw is a real per-month drain, not a fallback to "no fill".
    // Read off the first whole month, like any scheduled fill: January's draw
    // includes the initial top-up from zero.
    expect(buf.fillSource).toBe('scheduled');
    expect(buf.monthlyFill).toBe(-600);
  });

  it('credits the source when the set line lowers the target envelope', () => {
    const handFill = {
      id: 'hand', type: 'fill', date: '2026-01-20', status: 'posted',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 2000 }],
    };
    const base = input({ transactions: [funding, handFill], envelopeTemplates: [sourced()] });
    const buf = projectEnvelopeBalance({ ...base, envelopeId: 'buf' });
    // 2000 in groc on the 25th → set to 500 is −1500, plus 100 to `other`:
    // the fill nets to zero, so 1400 flows back to the buffer.
    expect(on(buf, '2026-01-25')).toBe(6400);
  });

  it('keeps the draw when the source projection bisects (recommendations reuse it)', () => {
    const base = { ...input({ transactions: [funding], envelopeTemplates: [sourced()] }), envelopeId: 'buf' };
    const p = projectEnvelopeBalance(base);
    expect(p.setDraws && p.setDraws.size).toBeGreaterThan(0);
    const reused = projectEnvelopeBalance({ ...base, setDraws: p.setDraws });
    expect(reused.daily).toEqual(p.daily);
  });

  it('the materialiser resolves the source line against the balance at posting', () => {
    const spent = {
      id: 'x1', type: 'expense', date: '2026-01-28', status: 'posted', amount: 200,
      envelope_id: 'groc', account: 'a1',
    };
    const { newTxs } = materializeDueTemplateFills(
      [sourced()], [], ENVELOPES, [funding, spent], new Date(2026, 1, 26), () => `t${Math.random()}`,
    );
    expect(newTxs.map(t => t.date)).toEqual(['2026-01-25', '2026-02-25']);
    // Jan: groc 0 → 500 (+500) and 100 to other. Feb: groc 300 → 500 (+200).
    expect(newTxs[0].lines.at(-1)).toEqual({ envelope_id: 'buf', mode: 'add', amount: -600 });
    expect(newTxs[1].lines.at(-1)).toEqual({ envelope_id: 'buf', mode: 'add', amount: -300 });
    // The set line is stored as its delta (owner decision 2026-10-04: stored
    // fills are add-only), with the target kept for the month-end sweep.
    expect(newTxs[0].lines[0]).toEqual({ envelope_id: 'groc', mode: 'add', amount: 500, set_target: 500 });
    expect(newTxs[1].lines[0]).toEqual({ envelope_id: 'groc', mode: 'add', amount: 200, set_target: 500 });
    const eb = computeEnvelopeBalances([funding, spent, ...newTxs]);
    expect(eb.get('groc')).toBe(500);
    expect(eb.get('buf')).toBe(4100);
    expect(newTxs.some(t => t.source_set_pending)).toBe(false);
  });

  it('the Forecast lens resolves the pending source leg the same way', () => {
    _resetLensCache();
    const state = {
      transactions: [funding], budgetItems: [SPEND], envelopeTemplates: [sourced()],
      accounts: ACCOUNTS, envelopes: ENVELOPES, meta: { country: 'FI' },
    };
    const txs = lensTransactions(state, { lens: 'forecast', horizon: '2026-12-31', today: TODAY });
    const eb = computeEnvelopeBalances(txs);
    const base = input({ transactions: [funding], envelopeTemplates: [sourced()] });
    expect(eb.get('buf')).toBe(projectEnvelopeBalance({ ...base, envelopeId: 'buf' }).closing);
    expect(eb.get('groc')).toBe(projectEnvelopeBalance(base).closing);
    expect(txs.some(t => t.source_set_pending)).toBe(false);
  });
});

describe('recommendations for a set-funded envelope', () => {
  it('raises the top-up target when the envelope runs short, instead of standing down', () => {
    const inp = input({ envelopeTemplates: [setTpl(150)] });
    const recs = recommendEnvelopeActions(inp);
    const monthly = byKind(recs, 'shortfall-monthly');
    expect(monthly).toBeTruthy();
    expect(monthly.meta.fillMode).toBe('set');
    expect(monthly.meta.currentFill).toBe(150);
    expect(monthly.amount).toBe(50);
    // A one-time top-up is erased by the next set, and says so visibly.
    const topup = byKind(recs, 'shortfall-topup');
    expect(topup.amount).toBeNull();
    expect(topup.meta.unsolvable).toBe(true);
    expect(byKind(recs, 'warn-irregular-fill')).toBeUndefined();
  });

  it('suggests lowering the target of an overfunded set envelope', () => {
    const opening = {
      id: 'o', type: 'fill', date: '2025-12-20', status: 'posted',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 3000 }],
    };
    const recs = recommendEnvelopeActions(input({ transactions: [opening], envelopeTemplates: [setTpl(3000)] }));
    const trim = byKind(recs, 'overfunded-trim');
    expect(trim).toBeTruthy();
    expect(trim.meta.fillMode).toBe('set');
    expect(trim.amount).toBe(2600);
  });

  it('bounds the target trim by the target, not by a day-zero low it cannot move', () => {
    // Opens at 500, topped up to 3000 on the 25th, 200 spent a month. The low
    // is the opening balance; lowering the target by 2600 still leaves 200
    // after every month's spend, one month of cover.
    const opening = {
      id: 'o', type: 'fill', date: '2025-12-20', status: 'posted',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 500 }],
    };
    const recs = recommendEnvelopeActions(input({ transactions: [opening], envelopeTemplates: [setTpl(3000)] }));
    expect(byKind(recs, 'overfunded-trim').amount).toBe(2600);
  });

  it('phrases a goal shortfall as a target raise', () => {
    const envelopes = ENVELOPES.map(e => (e.id === 'groc' ? { ...e, goal_amount: 1000, goal_date: '2026-06-30' } : e));
    const recs = recommendEnvelopeActions(input({ envelopes }));
    const goal = byKind(recs, 'goal-shortfall');
    expect(goal.meta.fillMode).toBe('set');
    expect(goal.amount).toBe(700);
  });

  it('says visibly when raising the target cannot help (the low comes before the first top-up)', () => {
    // 300 leaves on the 10th, the first top-up lands on the 25th.
    const early = { ...SPEND, payment_day: 10, default_amount: 300 };
    const recs = recommendEnvelopeActions(input({ budgetItems: [early], envelopeTemplates: [setTpl(100)] }));
    const monthly = byKind(recs, 'shortfall-monthly');
    expect(monthly).toBeTruthy();
    expect(monthly.meta.fillMode).toBe('set');
    expect(monthly.amount).toBeNull();
    expect(monthly.meta.unsolvable).toBe(true);
  });
});
