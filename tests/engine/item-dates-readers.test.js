import { describe, it, expect } from 'vitest';
import {
  runMonthlyReview, computeEmergencyFundRequirement, computeDashboardSummary, computeItemFunding,
} from '../../js/engine.js';
import { liveTemplateLines } from '../../js/engine/scheduling.js';

const ALL = Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => [m, true]));
const envelopes = [{ id: 'allow', name: 'Allowance', category: 'Finance' }];
// Tomas's allowance: €100 a month, last paid in December 2026.
const tomas = { id: 'tomas', kind: 'expense', include: true, envelope_id: 'allow', default_amount: -100,
  monthly_schedule: { ...ALL }, payment_day: 1, include_in_emergency_budget: true, end_month: '2026-12' };
const balances = new Map([['allow', 0]]);
const plannedIn = (month, refDate) =>
  runMonthlyReview(envelopes, [tomas], balances, [], month, refDate).find(r => r.envelope_id === 'allow')?.planned ?? 0;

describe('Review reads the plan as of the reviewed month', () => {
  it('counts December 2026 when reviewed in January 2027', () => {
    expect(plannedIn('2026-12', new Date(2027, 0, 10))).toBe(100);
  });
  it('counts nothing for January 2027', () => {
    expect(plannedIn('2027-01', new Date(2027, 0, 10))).toBe(0);
  });
});

describe('the emergency fund drops an item that has ended', () => {
  const meta = { emergency_envelope_id: 'allow', emergency_duration_months: 6 };
  const calc = (month) => computeEmergencyFundRequirement({
    envelopes, budgetItems: [tomas], transactions: [], month, meta,
  });
  it('counts it while it runs', () => {
    expect(calc('2026-10').monthlyEssentials).toBeCloseTo(300 / 12, 2);
  });
  it('drops it once it has ended', () => {
    expect(calc('2027-01')?.monthlyEssentials ?? 0).toBe(0);
  });
});

describe('planned this month on the dashboard summary', () => {
  it('leaves out an item that starts next month', () => {
    const later = { ...tomas, end_month: null, start_month: '2026-11' };
    expect(computeDashboardSummary([], [], [later], '2026-10').plannedThisMonth).toBe(0);
    expect(computeDashboardSummary([], [], [later], '2026-11').plannedThisMonth).toBe(100);
  });
});

describe('fill % plans an ended item at nothing', () => {
  it('has no row for an item that ended last month', () => {
    const ended = { ...tomas, end_month: '2026-09' };
    const f = computeItemFunding({ envelopeId: 'allow', budgetItems: [ended], transactions: [], balance: 0, today: new Date(2026, 9, 2) });
    expect(f.items.length).toBe(0);
  });
});

describe('dynamic template lines read the dated plan', () => {
  const tpl = { id: 't', kind: 'dynamic', name: 'Start', assignments: [{ envelope_id: 'allow', mode: 'add', percent: 100 }] };
  const envById = new Map(envelopes.map(e => [e.id, e]));
  const total = (items, at) => liveTemplateLines(tpl, items, envById, at).reduce((s, l) => s + l.amount, 0);

  // Owner decision 2026-10-04: a running item is funded at its full monthly
  // average until its end month. The coming-12-months view alone funded
  // October at 300/12 = 25 for an allowance of 100 a month ending in December.
  it('funds a running item in full every month up to its end, then nothing', () => {
    expect(total([tomas], new Date(2026, 9, 2))).toBe(100);
    expect(total([tomas], new Date(2026, 11, 2))).toBe(100);
    expect(total([tomas], new Date(2027, 0, 2))).toBe(0);
  });

  // Budget's 1e check (2026-10-04) reported "Allowance Boys 200.00 → 33.33".
  // 33.33 is 200 × 2 / 12: the old view of an allowance of 200 a month with
  // two months left (a reconstruction, not Budget's own data).
  it('reproduces Budget\'s case: 200 a month ending next month fills 200, not 33.33', () => {
    const boys = { ...tomas, id: 'boys', default_amount: -200, end_month: '2026-11' };
    expect(total([boys], new Date(2026, 9, 30))).toBe(200);
  });

  it('reads an item that has not started as the coming 12 months do', () => {
    const later = { ...tomas, id: 'later', start_month: '2027-04', end_month: '2027-06' };
    // April to June of the window: 300 / 12.
    expect(total([later], new Date(2026, 9, 2))).toBeCloseTo(300 / 12, 2);
  });
});
