import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNodeSession } from '../server/session/node-session.js';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import strictLedger from '../js/core/policies/strict-ledger.js';
import { postDueRows } from '../js/core/commands/month-post-due.js';
import { withSkippedMonth } from '../js/core/entity-fields.js';
import { runInvariantCheck } from '../js/engine/insights.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 15, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const tpl = (over = {}) => ({
  id: 'tpl', name: 'Monthly', kind: 'manual',
  lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }, { envelope_id: 'fun', mode: 'add', amount: 20.5 }],
  ...over,
});
const scheduled = (over = {}) => tpl({
  schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS },
  ...over,
});
const data = (over = {}) => deepFreeze({
  meta: {}, budgetItems: [],
  envelopeTemplates: [tpl()],
  accounts: [{ id: 'chk', name: 'Checking' }],
  envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'fun', name: 'Fun' }, { id: 'buf', name: 'Buffer' }],
  transactions: [],
  ...over,
});
const fill = (d, input, opts) => runCommand(registry, d, 'allocation.fill', input, ctx(), opts);
const row = (r) => r.value.value;
const existingFill = (over = {}) => ({
  id: 'old', type: 'fill', date: '2026-10-03', status: 'posted', source: 'allocation',
  lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }], payee: 'Monthly', template_id: 'tpl', ...over,
});

describe('allocation.fill, manual lines', () => {
  it('stores a posted fill row with add-mode lines', () => {
    const r = fill(data(), { lines: [{ envelope: 'groc', amount: '12.345' }, { envelope: 'fun', amount: -2 }], note: ' hello ' });
    expect(r.ok).toBe(true);
    expect(row(r)).toEqual({
      id: 'n1', type: 'fill', date: '2026-10-15', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 12.35 }, { envelope_id: 'fun', mode: 'add', amount: -2 }],
      payee: '', note: 'hello', created_at: NOW.toISOString(), modified_at: NOW.toISOString(),
    });
    expect(r.value.changes.transactions).toHaveLength(1);
  });

  it('refuses a set-mode line', () => {
    const r = fill(data(), { lines: [{ envelope: 'groc', amount: 50, mode: 'set' }] });
    expect(r.error).toEqual({ code: 'field_not_allowed', params: { field: 'mode', type: 'fill' } });
  });

  it('refuses a zero line', () => {
    expect(fill(data(), { lines: [{ envelope: 'groc', amount: 0 }] }).error.code).toBe('bad_input');
    expect(fill(data(), { lines: [{ envelope: 'groc', amount: 0.001 }] }).error.code).toBe('bad_input');
  });

  it('needs exactly one of lines and template', () => {
    expect(fill(data(), {}).error.code).toBe('fill_needs_lines_or_template');
    expect(fill(data(), { lines: [] }).error.code).toBe('fill_needs_lines_or_template');
    expect(fill(data(), { lines: [{ envelope: 'groc', amount: 1 }], template: 'tpl' }).error.code).toBe('fill_needs_lines_or_template');
  });

  it('requires an account for a new_income fill and stores it as source_account', () => {
    const lines = [{ envelope: 'groc', amount: 10 }];
    expect(fill(data(), { lines, source: 'new_income' }).error).toEqual({ code: 'field_required', params: { field: 'account' } });
    const r = fill(data(), { lines, source: 'new_income', account: 'chk', payee: 'Salary' });
    expect(row(r)).toMatchObject({ source: 'new_income', source_account: 'chk', payee: 'Salary' });
  });

  it('stores source_account for pool_distribute with an account, and refuses one on a plain allocation', () => {
    const lines = [{ envelope: 'groc', amount: 10 }];
    expect(row(fill(data(), { lines, source: 'pool_distribute', account: 'chk' }))).toMatchObject({ source_account: 'chk' });
    expect(row(fill(data(), { lines, source: 'pool_distribute' }))).not.toHaveProperty('source_account');
    expect(fill(data(), { lines, account: 'chk' }).error.code).toBe('field_not_allowed');
  });

  it('funds a manual fill from an envelope with an offsetting line', () => {
    const r = fill(data(), { lines: [{ envelope: 'groc', amount: 10 }, { envelope: 'fun', amount: 5.5 }], fromEnvelope: 'buf' });
    expect(row(r).lines).toEqual([
      { envelope_id: 'groc', mode: 'add', amount: 10 },
      { envelope_id: 'fun', mode: 'add', amount: 5.5 },
      { envelope_id: 'buf', mode: 'add', amount: -15.5 },
    ]);
    expect(row(r).source_envelope_id).toBe('buf');
  });

  it('refuses a source that is also a target, a source with new_income, and a zero total to fund', () => {
    const lines = [{ envelope: 'groc', amount: 10 }];
    expect(fill(data(), { lines, fromEnvelope: 'groc' }).error.code).toBe('fill_source_conflict');
    expect(fill(data(), { lines, fromEnvelope: 'buf', source: 'new_income', account: 'chk' }).error.code).toBe('fill_source_conflict');
    const zero = [{ envelope: 'groc', amount: 10 }, { envelope: 'fun', amount: -10 }];
    expect(fill(data(), { lines: zero, fromEnvelope: 'buf' }).error.code).toBe('fill_nothing_to_fund');
  });

  it('trims a caller-supplied payee', () => {
    const r = fill(data(), { lines: [{ envelope: 'groc', amount: 10 }], payee: '  Bonus  ' });
    expect(row(r).payee).toBe('Bonus');
  });

  it('honours an explicit date', () => {
    expect(row(fill(data(), { lines: [{ envelope: 'groc', amount: 10 }], date: '2026-10-01' })).date).toBe('2026-10-01');
  });

  it('is not refused by the strict-ledger policy', () => {
    const r = fill(data(), { lines: [{ envelope: 'groc', amount: 10 }] }, { policies: [strictLedger] });
    expect(r.ok).toBe(true);
  });
});

describe('allocation.fill, template', () => {
  it('fills a non-scheduled template: payee from the template, no from_budget', () => {
    const r = fill(data(), { template: 'tpl' });
    expect(r.ok).toBe(true);
    expect(row(r)).toEqual({
      id: 'n1', type: 'fill', date: '2026-10-15', status: 'posted', source: 'allocation',
      lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }, { envelope_id: 'fun', mode: 'add', amount: 20.5 }],
      payee: 'Monthly', note: null, template_id: 'tpl', created_at: NOW.toISOString(), modified_at: NOW.toISOString(),
    });
  });

  it('lets an explicit payee override the template name, and drops zero-amount lines', () => {
    const d = data({ envelopeTemplates: [tpl({ lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }, { envelope_id: 'fun', mode: 'add', amount: 0 }] })] });
    const r = fill(d, { template: 'tpl', payee: 'Custom' });
    expect(row(r).payee).toBe('Custom');
    expect(row(r).lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: 30 }]);
  });

  it('stamps a scheduled template with its occurrence key', () => {
    const r = fill(data({ envelopeTemplates: [scheduled()] }), { template: 'tpl' });
    expect(row(r)).toMatchObject({ template_id: 'tpl', from_budget: 'tpl:tpl:2026-10', date: '2026-10-15' });
  });

  it('keys a fill dated before a working-day-shifted pay day on the schedule month', () => {
    // Nov 1 2026 is a Sunday: the prev_work_day pay date is Fri Oct 30.
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'prev_work_day', since: '2026-10-01', months: ALL_MONTHS } });
    const r = fill(data({ envelopeTemplates: [t] }), { template: 'tpl', date: '2026-10-30' });
    expect(row(r).from_budget).toBe('tpl:tpl:2026-11');
    const later = fill(data({ envelopeTemplates: [t] }), { template: 'tpl', date: '2026-10-10' });
    expect(row(later).from_budget).toBe('tpl:tpl:2026-10');
  });

  // post-due's materialiser takes its lines through liveTemplateLines: a line on
  // an archived or missing envelope is dropped, and an amount is its magnitude.
  it('drops a line on an archived or missing envelope, as the scheduler does', () => {
    const t = tpl({ lines: [{ envelope_id: 'groc', mode: 'add', amount: 30 }, { envelope_id: 'old', mode: 'add', amount: 9 }, { envelope_id: 'gone', mode: 'add', amount: 8 }] });
    const d = data({ envelopeTemplates: [t], envelopes: [{ id: 'groc', name: 'Groceries' }, { id: 'old', name: 'Old', archived: true }] });
    expect(row(fill(d, { template: 'tpl' })).lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: 30 }]);
  });

  it('stores a negative template line as its magnitude, as the scheduler does', () => {
    const t = scheduled({ lines: [{ envelope_id: 'groc', mode: 'add', amount: -30 }] });
    const d = data({ envelopeTemplates: [t] });
    const r = fill(d, { template: 'tpl', date: '2026-10-01' });
    expect(row(r).lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: 30 }]);
    const posted = postDueRows(d, { date: '2026-10-01' }, ctx());
    expect(posted[0].lines).toEqual(row(r).lines);
  });

  it('draws the source for an early fill of a shifted occurrence, judging source_since on the raw schedule date', () => {
    // The Nov 1 occurrence (a Sunday) is paid Fri Oct 30; source_since is the
    // raw date, so the fill dated Oct 30 draws the source, as post-due does.
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'prev_work_day', since: '2026-10-01', months: ALL_MONTHS, source_envelope_id: 'buf', source_since: '2026-11-01' } });
    const d = data({ envelopeTemplates: [t] });
    const r = fill(d, { template: 'tpl', date: '2026-10-30' });
    expect(row(r)).toMatchObject({ from_budget: 'tpl:tpl:2026-11', source_envelope_id: 'buf' });
    expect(row(r).lines.at(-1)).toEqual({ envelope_id: 'buf', mode: 'add', amount: -50.5 });
    const posted = postDueRows(d, { date: '2026-11-02' }, ctx()).find(x => x.from_budget === 'tpl:tpl:2026-11');
    expect(posted).toMatchObject({ date: '2026-10-30', source_envelope_id: 'buf', lines: row(r).lines });
  });

  it('finds a twin on the occurrence month alone', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'prev_work_day', since: '2026-10-01', months: ALL_MONTHS } });
    // No from_budget, and dated in neither the fill's month (Oct) nor by key:
    // only the occurrence month (Nov) can match it.
    const d = data({ envelopeTemplates: [t], transactions: [existingFill({ date: '2026-11-03' })] });
    expect(fill(d, { template: 'tpl', date: '2026-10-30' }).error).toEqual({ code: 'fill_already_this_month', params: { template: 'tpl', id: 'old', date: '2026-11-03' } });
  });

  it('refuses a second fill the same month unless forced', () => {
    const d = data({ transactions: [existingFill()] });
    const r = fill(d, { template: 'tpl' });
    expect(r.error).toEqual({ code: 'fill_already_this_month', params: { template: 'tpl', id: 'old', date: '2026-10-03' } });
    expect(fill(d, { template: 'tpl', force: true }).ok).toBe(true);
  });

  it('finds the twin by its from_budget key, ignores reversed and scheduled fills', () => {
    const t = scheduled();
    const byKey = data({ envelopeTemplates: [t], transactions: [existingFill({ date: '2026-09-28', from_budget: 'tpl:tpl:2026-10' })] });
    expect(fill(byKey, { template: 'tpl' }).error.code).toBe('fill_already_this_month');
    const reversed = data({ transactions: [existingFill({ reversed_by: 'x' })] });
    expect(fill(reversed, { template: 'tpl' }).ok).toBe(true);
    const sched = data({ transactions: [existingFill({ status: 'scheduled' })] });
    expect(fill(sched, { template: 'tpl' }).ok).toBe(true);
    const otherMonth = data({ transactions: [existingFill({ date: '2026-09-03' })] });
    expect(fill(otherMonth, { template: 'tpl' }).ok).toBe(true);
    const otherTemplate = data({ transactions: [existingFill({ template_id: 'else' })] });
    expect(fill(otherTemplate, { template: 'tpl' }).ok).toBe(true);
  });

  it('refuses a tombstoned occurrence unless forced (scheduled templates only)', () => {
    const d = data({ meta: { scheduledTombstones: ['tpl:tpl:2026-10'] }, envelopeTemplates: [scheduled()] });
    expect(fill(d, { template: 'tpl' }).error).toEqual({ code: 'occurrence_tombstoned', params: { key: 'tpl:tpl:2026-10' } });
    expect(fill(d, { template: 'tpl', force: true }).ok).toBe(true);
    const plain = data({ meta: { scheduledTombstones: ['tpl:tpl:2026-10'] } });
    expect(fill(plain, { template: 'tpl' }).ok).toBe(true);
  });

  it('draws the schedule source envelope with an offsetting line', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, source_envelope_id: 'buf' } });
    const r = fill(data({ envelopeTemplates: [t] }), { template: 'tpl' });
    expect(row(r).source_envelope_id).toBe('buf');
    expect(row(r).lines).toEqual([
      { envelope_id: 'groc', mode: 'add', amount: 30 },
      { envelope_id: 'fun', mode: 'add', amount: 20.5 },
      { envelope_id: 'buf', mode: 'add', amount: -50.5 },
    ]);
    // Confirming the schedule's own source is fine.
    expect(fill(data({ envelopeTemplates: [t] }), { template: 'tpl', fromEnvelope: 'buf' }).ok).toBe(true);
  });

  it('refuses a fromEnvelope that conflicts with the schedule source, and new_income over it', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, source_envelope_id: 'buf' } });
    const d = data({ envelopeTemplates: [t] });
    expect(fill(d, { template: 'tpl', fromEnvelope: 'fun' }).error.code).toBe('fill_source_conflict');
    expect(fill(d, { template: 'tpl', source: 'new_income', account: 'chk' }).error.code).toBe('fill_source_conflict');
  });

  it('funds a non-scheduled template from fromEnvelope', () => {
    const r = fill(data(), { template: 'tpl', fromEnvelope: 'buf' });
    expect(row(r).lines.at(-1)).toEqual({ envelope_id: 'buf', mode: 'add', amount: -50.5 });
    expect(row(r).source_envelope_id).toBe('buf');
  });

  it('resolves a set line to an add delta against the balance as of the fill date', () => {
    const earlier = { id: 'e1', type: 'fill', date: '2026-10-01', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'groc', mode: 'add', amount: 12 }] };
    const future = { id: 'e2', type: 'fill', date: '2026-10-20', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'groc', mode: 'add', amount: 500 }] };
    const t = tpl({ lines: [{ envelope_id: 'groc', mode: 'set', amount: 100 }, { envelope_id: 'fun', mode: 'add', amount: 5 }] });
    const r = fill(data({ envelopeTemplates: [t], transactions: [earlier, future] }), { template: 'tpl', date: '2026-10-10' });
    // The target rides along for the month-end sweep's replay (txRolloverReplayEffect).
    expect(row(r).lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: 88, set_target: 100 }, { envelope_id: 'fun', mode: 'add', amount: 5 }]);
    expect(row(r).lines.every(l => l.mode === 'add')).toBe(true);
  });

  it('keeps a met set line as a zero line with its target, and refuses a fill that moves nothing', () => {
    const exact = { id: 'e1', type: 'fill', date: '2026-10-01', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'groc', mode: 'add', amount: 100 }] };
    const t = tpl({ lines: [{ envelope_id: 'groc', mode: 'set', amount: 100 }, { envelope_id: 'fun', mode: 'add', amount: 5 }] });
    const r = fill(data({ envelopeTemplates: [t], transactions: [exact] }), { template: 'tpl' });
    expect(row(r).lines).toEqual([{ envelope_id: 'groc', mode: 'add', amount: 0, set_target: 100 }, { envelope_id: 'fun', mode: 'add', amount: 5 }]);
    const only = tpl({ lines: [{ envelope_id: 'groc', mode: 'set', amount: 100 }] });
    expect(fill(data({ envelopeTemplates: [only], transactions: [exact] }), { template: 'tpl' }).error.code).toBe('fill_nothing_to_fund');
  });

  it('is not refused by the strict-ledger policy', () => {
    const t = tpl({ lines: [{ envelope_id: 'groc', mode: 'set', amount: 100 }] });
    const r = fill(data({ envelopeTemplates: [t] }), { template: 'tpl' }, { policies: [strictLedger] });
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown template (the data is frozen, so a fill that mutated it would throw)', () => {
    expect(fill(data(), { template: 'nope' }).error.code).toBe('bad_input');
  });
});

describe('allocation.fill, skipTemplateMonth', () => {
  const tplChanges = (r) => r.value.changes.envelopeTemplates;

  it('adds the occurrence month to schedule.skipped in the same commit as the fill', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, skipped: ['2026-12', '2026-03'] } });
    const other = { id: 'other', name: 'Other', kind: 'manual', lines: [] };
    const d = data({ envelopeTemplates: [t, other] });
    const r = fill(d, { template: 'tpl', skipTemplateMonth: true });
    expect(r.ok).toBe(true);
    expect(row(r)).toMatchObject({ template_id: 'tpl', from_budget: 'tpl:tpl:2026-10' });
    expect(tplChanges(r)[0]).toEqual(withSkippedMonth(t, '2026-10'));
    expect(tplChanges(r)[0].schedule.skipped).toEqual(['2026-03', '2026-10', '2026-12']);
    expect(tplChanges(r)[1]).toBe(other);
    // One diff carries both: the fill row and the template's skipped month.
    expect(Object.keys(r.value.diff).sort()).toEqual(['envelopeTemplates', 'transactions']);
    expect(r.value.diff.transactions.added).toHaveLength(1);
    expect(r.value.diff.envelopeTemplates.changed).toEqual([{ id: 'tpl', before: t, after: tplChanges(r)[0] }]);
  });

  it('skips the month the fill is keyed to, not the date\'s own month', () => {
    // Nov 1 2026 is a Sunday: the prev_work_day pay date is Fri Oct 30.
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'prev_work_day', since: '2026-10-01', months: ALL_MONTHS } });
    const r = fill(data({ envelopeTemplates: [t] }), { template: 'tpl', date: '2026-10-30', skipTemplateMonth: true });
    expect(row(r).from_budget).toBe('tpl:tpl:2026-11');
    expect(tplChanges(r)[0].schedule.skipped).toEqual(['2026-11']);
  });

  it('is bad_input without a template, or on a template with no enabled schedule', () => {
    const lines = fill(data(), { lines: [{ envelope: 'groc', amount: 10 }], skipTemplateMonth: true });
    expect(lines.error).toEqual({ code: 'bad_input', params: { errors: [{ path: 'skipTemplateMonth', message: 'needs a template with an enabled schedule' }] } });
    expect(fill(data(), { template: 'tpl', skipTemplateMonth: true }).error).toEqual(lines.error);
    const off = scheduled({ schedule: { enabled: false, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS } });
    expect(fill(data({ envelopeTemplates: [off] }), { template: 'tpl', skipTemplateMonth: true }).error).toEqual(lines.error);
  });

  it('leaves the templates alone when false or not given', () => {
    const d = data({ envelopeTemplates: [scheduled()] });
    expect(fill(d, { template: 'tpl', skipTemplateMonth: false }).value.changes).not.toHaveProperty('envelopeTemplates');
    expect(fill(d, { template: 'tpl' }).value.changes).not.toHaveProperty('envelopeTemplates');
  });

  it('leaves the templates alone when the month is already skipped', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, skipped: ['2026-10'] } });
    const r = fill(data({ envelopeTemplates: [t] }), { template: 'tpl', skipTemplateMonth: true });
    expect(row(r).from_budget).toBe('tpl:tpl:2026-10');
    expect(r.value.changes).not.toHaveProperty('envelopeTemplates');
  });

  it('still refuses a twin in the month; with force the extra fill and the skip both land', () => {
    const d = data({ envelopeTemplates: [scheduled()], transactions: [existingFill()] });
    expect(fill(d, { template: 'tpl', skipTemplateMonth: true }).error.code).toBe('fill_already_this_month');
    const r = fill(d, { template: 'tpl', skipTemplateMonth: true, force: true });
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions).toHaveLength(2);
    expect(tplChanges(r)[0].schedule.skipped).toEqual(['2026-10']);
  });
});

describe('allocation.fill, month (an early run of a named occurrence)', () => {
  const badMonth = (message) => ({ code: 'bad_input', params: { errors: [{ path: 'month', message }] } });

  it('is unkeyed and skips that occurrence; post-due then posts nothing for the template', () => {
    // October's occurrence already posted (dated in the fill's own month): the
    // twin check runs on November, so it does not refuse the early run.
    const oct = existingFill({ from_budget: 'tpl:tpl:2026-10' });
    const d = data({ envelopeTemplates: [scheduled()], transactions: [oct] });
    const r = fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: true });
    expect(r.ok).toBe(true);
    expect(row(r)).toMatchObject({ date: '2026-10-15', template_id: 'tpl' });
    // The skipped month records the occurrence, not a from_budget key: a key
    // weeks before its month would be a stale link to the invariant check.
    expect(row(r)).not.toHaveProperty('from_budget');
    expect(r.value.changes.envelopeTemplates[0].schedule.skipped).toEqual(['2026-11']);
    const posted = postDueRows(r.value.after, { date: '2026-11-02' }, ctx());
    expect(posted.filter(x => x.template_id === 'tpl')).toEqual([]);
  });

  it('leaves the invariant check clean, however far ahead the occurrence is', () => {
    const d = data({ envelopeTemplates: [scheduled()] });
    const r = fill(d, { template: 'tpl', date: '2026-10-02', month: '2026-11', skipTemplateMonth: true });
    expect(r.ok).toBe(true);
    expect(runInvariantCheck(r.value.after).totalProblems).toBe(0);
  });

  it('needs skipTemplateMonth: an early run is recorded by the skip', () => {
    const d = data({ envelopeTemplates: [scheduled()] });
    const needsSkip = { code: 'bad_input', params: { errors: [{ path: 'skipTemplateMonth', message: 'must be true with month (an early run)' }] } };
    expect(fill(d, { template: 'tpl', month: '2026-11' }).error).toEqual(needsSkip);
    expect(fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: false }).error).toEqual(needsSkip);
  });

  it('runs the twin check on that month', () => {
    const nov = existingFill({ id: 'nov', date: '2026-10-05', from_budget: 'tpl:tpl:2026-11' });
    const d = data({ envelopeTemplates: [scheduled()], transactions: [nov] });
    expect(fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: true }).error).toEqual({ code: 'fill_already_this_month', params: { template: 'tpl', id: 'nov', date: '2026-10-05' } });
    expect(fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: true, force: true }).ok).toBe(true);
  });

  it('is not blocked by an extra (adhoc) fill dated in that month: only the scheduler\'s keyed fill is a twin', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS } });
    const d0 = data({ envelopeTemplates: [t] });
    const extra = fill(d0, { template: 'tpl', date: '2026-10-05', adhoc: true });
    expect(extra.ok).toBe(true);
    const r = fill(extra.value.after, { template: 'tpl', date: '2026-10-15', month: '2026-10', skipTemplateMonth: true });
    expect(r.ok).toBe(true);
    expect(r.value.changes.transactions.filter(x => x.template_id === 'tpl')).toHaveLength(2);
    expect(r.value.changes.envelopeTemplates[0].schedule.skipped).toEqual(['2026-10']);
  });

  it('refuses a second early run of the same month: the skipped month is no occurrence', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS } });
    const first = fill(data({ envelopeTemplates: [t] }), { template: 'tpl', month: '2026-10', skipTemplateMonth: true });
    expect(first.ok).toBe(true);
    const again = fill(first.value.after, { template: 'tpl', month: '2026-10', skipTemplateMonth: true });
    expect(again.error).toEqual(badMonth('is not an occurrence of the template\'s schedule'));
  });

  it('refuses a tombstoned occurrence unless forced', () => {
    const d = data({ meta: { scheduledTombstones: ['tpl:tpl:2026-11'] }, envelopeTemplates: [scheduled()] });
    expect(fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: true }).error).toEqual({ code: 'occurrence_tombstoned', params: { key: 'tpl:tpl:2026-11' } });
    const r = fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: true, force: true });
    expect(r.ok).toBe(true);
    expect(row(r)).not.toHaveProperty('from_budget');
  });

  it('draws the source as that occurrence would, judging source_since on its raw date', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, source_envelope_id: 'buf', source_since: '2026-11-01' } });
    const d = data({ envelopeTemplates: [t] });
    expect(row(fill(d, { template: 'tpl' }))).not.toHaveProperty('source_envelope_id');
    const r = fill(d, { template: 'tpl', month: '2026-11', skipTemplateMonth: true });
    expect(row(r)).toMatchObject({ source_envelope_id: 'buf' });
    expect(row(r)).not.toHaveProperty('from_budget');
    expect(row(r).lines.at(-1)).toEqual({ envelope_id: 'buf', mode: 'add', amount: -50.5 });
  });

  it('refuses a month that is not an occurrence of the schedule', () => {
    const t = scheduled({ schedule: { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: { ...ALL_MONTHS, Dec: false }, skipped: ['2027-01'] } });
    const d = data({ envelopeTemplates: [t] });
    const notOne = badMonth('is not an occurrence of the template\'s schedule');
    const early = (month) => fill(d, { template: 'tpl', month, skipTemplateMonth: true });
    expect(early('2026-12').error).toEqual(notOne);
    expect(early('2026-09').error).toEqual(notOne);
    expect(early('2027-01').error).toEqual(notOne);
    expect(early('2026-13').error).toEqual(badMonth('must be a month, YYYY-MM'));
  });

  it('refuses a month without a template with an enabled schedule', () => {
    const needs = badMonth('needs a template with an enabled schedule');
    expect(fill(data(), { template: 'tpl', month: '2026-11' }).error).toEqual(needs);
    expect(fill(data(), { lines: [{ envelope: 'groc', amount: 1 }], month: '2026-11' }).error).toEqual(needs);
    const off = scheduled({ schedule: { enabled: false, payment_day: 1, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS } });
    expect(fill(data({ envelopeTemplates: [off] }), { template: 'tpl', month: '2026-11' }).error).toEqual(needs);
  });
});

describe('allocation.fill, adhoc (a fill outside the template\'s schedule)', () => {
  const bad = (path, message) => ({ code: 'bad_input', params: { errors: [{ path, message }] } });
  const on25 = (over = {}) => scheduled({ schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-10-01', months: ALL_MONTHS, ...over } });

  it('is unkeyed, so post-due still posts the month\'s occurrence', () => {
    // Oct 25 has not posted yet on Oct 15: an extra fill must not stand in for it.
    const d = data({ envelopeTemplates: [on25()] });
    const r = fill(d, { template: 'tpl', adhoc: true });
    expect(r.ok).toBe(true);
    expect(row(r)).toMatchObject({ template_id: 'tpl', date: '2026-10-15' });
    expect(row(r)).not.toHaveProperty('from_budget');
    expect(r.value.changes).not.toHaveProperty('envelopeTemplates');
    const posted = postDueRows(r.value.after, { date: '2026-10-26' }, ctx());
    expect(posted.filter(x => x.from_budget === 'tpl:tpl:2026-10')).toHaveLength(1);
  });

  it('draws no source leg, even when the schedule has a source', () => {
    const r = fill(data({ envelopeTemplates: [on25({ source_envelope_id: 'buf' })] }), { template: 'tpl', adhoc: true });
    expect(row(r)).not.toHaveProperty('source_envelope_id');
    expect(row(r).lines).toEqual([
      { envelope_id: 'groc', mode: 'add', amount: 30 },
      { envelope_id: 'fun', mode: 'add', amount: 20.5 },
    ]);
  });

  it('runs no twin check: a repeat in the month is allowed, scheduled or not', () => {
    const plain = data({ transactions: [existingFill()] });
    expect(fill(plain, { template: 'tpl' }).error.code).toBe('fill_already_this_month');
    expect(fill(plain, { template: 'tpl', adhoc: true }).value.changes.transactions).toHaveLength(2);
    const sched = data({ envelopeTemplates: [scheduled()], transactions: [existingFill({ from_budget: 'tpl:tpl:2026-10' })] });
    expect(fill(sched, { template: 'tpl', adhoc: true }).ok).toBe(true);
  });

  it('is not refused by a deleted occurrence, which it does not stand in for', () => {
    const d = data({ meta: { scheduledTombstones: ['tpl:tpl:2026-10'] }, envelopeTemplates: [scheduled()] });
    expect(fill(d, { template: 'tpl', adhoc: true }).ok).toBe(true);
  });

  it('is bad_input with month or skipTemplateMonth, or without a template', () => {
    const d = data({ envelopeTemplates: [scheduled()] });
    expect(fill(d, { template: 'tpl', adhoc: true, month: '2026-11', skipTemplateMonth: true }).error)
      .toEqual({ code: 'bad_input', params: { errors: [{ path: 'adhoc', message: 'cannot be combined with month' }, { path: 'adhoc', message: 'cannot be combined with skipTemplateMonth' }] } });
    expect(fill(d, { template: 'tpl', adhoc: true, skipTemplateMonth: true }).error).toEqual(bad('adhoc', 'cannot be combined with skipTemplateMonth'));
    expect(fill(d, { lines: [{ envelope: 'groc', amount: 1 }], adhoc: true }).error).toEqual(bad('adhoc', 'needs a template'));
    expect(fill(d, { template: 'tpl', adhoc: false }).ok).toBe(true);
  });
});

describe('allocation.fill, account null', () => {
  it('stores source_account null on a pool_distribute fill (no account picked)', () => {
    const r = fill(data(), { template: 'tpl', source: 'pool_distribute', account: null });
    expect(r.ok).toBe(true);
    expect(row(r)).toHaveProperty('source_account', null);
  });

  it('is still required for new_income and refused for allocation', () => {
    expect(fill(data(), { template: 'tpl', source: 'new_income', account: null }).error).toEqual({ code: 'field_required', params: { field: 'account' } });
    expect(fill(data(), { template: 'tpl', account: null }).error).toEqual({ code: 'field_not_allowed', params: { field: 'account', type: 'fill' } });
  });
});

describe('allocation.fill, skipTemplateMonth through the Node session', () => {
  it('writes the fill and the skipped month in one commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bv-fill-skip-'));
    try {
      const path = join(dir, 'bundle.json');
      writeFileSync(path, JSON.stringify({
        ...data({ envelopeTemplates: [scheduled()] }),
        meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
      }));
      const s = createNodeSession({ registry, clock: () => NOW, newId: () => 'n1', source: { kind: 'file', path } });
      const r = await s.dispatch('allocation.fill', { template: 'tpl', skipTemplateMonth: true });
      expect(r.ok).toBe(true);
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(saved.transactions).toEqual([expect.objectContaining({ id: 'n1', template_id: 'tpl', from_budget: 'tpl:tpl:2026-10' })]);
      expect(saved.envelopeTemplates[0].schedule.skipped).toEqual(['2026-10']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
