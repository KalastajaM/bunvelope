// tests/core-template-commands.test.js — template.create, .update, .delete and
// the internal .convertIncomeLinked: the template editor's save rules through
// the command pipeline.
import { describe, it, expect } from 'vitest';
import templateCreate from '../js/core/commands/template-create.js';
import strictLedger from '../js/core/policies/strict-ledger.js';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import { convertIncomeLinkedTemplates } from '../js/core/migrate-income-templates.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const monthly = {
  id: 'monthly', name: 'Monthly', description: 'Old', kind: 'manual',
  lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }],
  schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: { Jan: true, Feb: true }, since: '2026-01-01', skipped: ['2026-02'] },
  note: 'kept', created_by: 'legacy',
};
const split = { id: 'split', name: 'Split', kind: 'dynamic', assignments: [{ envelope_id: 'rent', mode: 'add', percent: 50 }] };
// A stored template that already breaks a rule: no lines.
const empty = { id: 'empty', name: 'Empty', kind: 'manual', lines: [] };

const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 100 }],
  envelopes: [{ id: 'rent', name: 'Rent' }, { id: 'groc', name: 'Groceries' }, { id: 'buf', name: 'Buffer' }, { id: 'old', name: 'Old', archived: true }],
  budgetItems: [],
  envelopeTemplates: [monthly, split, empty],
  transactions: [],
  ...extra,
});

// Every successful run is checked twice over: the same input on the same
// frozen data gives the same diff, and that diff applied reproduces the changes.
function run(name, input, d = data()) {
  const r = runCommand(registry, d, name, input, ctx());
  if (r.ok) {
    const again = runCommand(registry, d, name, input, ctx());
    expect(again.value.diff).toEqual(r.value.diff);
    const applied = applyDiff(d, r.value.diff);
    expect(applied.ok).toBe(true);
    for (const [kind, rows] of Object.entries(applied.value)) expect(rows).toEqual(r.value.changes[kind]);
  }
  return r;
}
const tplOf = (r, id) => r.value.changes.envelopeTemplates.find(x => x.id === id);
const errPaths = (r) => r.error.params.errors.map(e => e.path);

describe('template.create', () => {
  it('stores a new manual template as the editor does, and returns the id', () => {
    const r = run('template.create', {
      name: '  Pay day ', kind: 'manual', description: ' ',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }, { envelope_id: 'groc', mode: 'set', amount: 50 }],
    });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'pay-day' });
    expect(r.value.changes.envelopeTemplates.slice(0, -1)).toEqual(data().envelopeTemplates);
    expect(r.value.changes.envelopeTemplates.at(-1)).toEqual({
      id: 'pay-day', name: 'Pay day', description: null, kind: 'manual',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }, { envelope_id: 'groc', mode: 'set', amount: 50 }],
    });
  });

  it('stores a dynamic template with a schedule, and avoids a taken id', () => {
    const r = run('template.create', {
      name: 'Monthly!', kind: 'dynamic', assignments: [{ envelope_id: 'rent', mode: 'add', percent: 25 }],
      schedule: { enabled: true, payment_day: 15, months: { Mar: true }, since: '2026-03-01', source_envelope_id: 'buf', source_since: '2026-03-01' },
    });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'monthly-2' });
    expect(r.value.changes.envelopeTemplates.at(-1)).toEqual({
      id: 'monthly-2', name: 'Monthly!', description: null, kind: 'dynamic',
      assignments: [{ envelope_id: 'rent', mode: 'add', percent: 25 }],
      schedule: { enabled: true, payment_day: 15, day_type: 'exact', months: { Mar: true }, since: '2026-03-01', source_envelope_id: 'buf', source_since: '2026-03-01' },
    });
  });

  it('refuses a taken name (case-insensitive, any template), a blank name, and no lines', () => {
    const lines = [{ envelope_id: 'rent', mode: 'add', amount: 5 }];
    const taken = run('template.create', { name: ' MONTHLY ', kind: 'manual', lines });
    expect(taken.error).toEqual({ code: 'name_taken', params: { kind: 'template', name: 'MONTHLY' } });
    const blank = run('template.create', { name: '  ', kind: 'manual', lines });
    expect(blank.error.code).toBe('bad_input');
    expect(errPaths(blank)).toEqual(['name']);
    const none = run('template.create', { name: 'Fresh', kind: 'manual' });
    expect(errPaths(none)).toEqual(['lines']);
    const dynNone = run('template.create', { name: 'Fresh', kind: 'dynamic', assignments: [] });
    expect(errPaths(dynNone)).toEqual(['assignments']);
  });

  it('refuses a list that does not belong to the kind', () => {
    const r = run('template.create', {
      name: 'Fresh', kind: 'manual',
      lines: [{ envelope_id: 'rent', mode: 'add', amount: 5 }],
      assignments: [{ envelope_id: 'rent', mode: 'add', percent: 5 }],
    });
    expect(r.error.code).toBe('bad_input');
    expect(errPaths(r)).toEqual(['assignments']);
  });

  it('refuses one line per envelope twice, and the schedule rules', () => {
    const base = { name: 'Fresh', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 5 }] };
    expect(errPaths(run('template.create', { ...base, lines: [...base.lines, { envelope_id: 'rent', mode: 'set', amount: 9 }] }))).toEqual(['lines[1].envelope_id']);
    const sched = { enabled: true, payment_day: 1, months: { Jan: true } };
    expect(errPaths(run('template.create', { ...base, schedule: { ...sched, months: {} } }))).toEqual(['schedule.months']);
    expect(errPaths(run('template.create', { ...base, schedule: { ...sched, since: '2026-05-01', until: '2026-04-30' } }))).toEqual(['schedule.until']);
    expect(errPaths(run('template.create', { ...base, schedule: { ...sched, source_envelope_id: 'rent' } }))).toEqual(['schedule.source_envelope_id']);
    expect(errPaths(run('template.create', { ...base, schedule: { ...sched, source_since: '2026-01-01' } }))).toEqual(['schedule.source_since']);
    expect(run('template.create', { ...base, schedule: { ...sched, source_envelope_id: 'buf' } }).ok).toBe(true);
  });
});

describe('template.update', () => {
  it('keeps the top-level fields the editor does not render, and the stored id', () => {
    const r = run('template.update', { id: 'monthly', fields: { description: ' New ', lines: [{ envelope_id: 'rent', mode: 'set', amount: 950 }] } });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'monthly' });
    expect(tplOf(r, 'monthly')).toEqual({ ...monthly, description: 'New', lines: [{ envelope_id: 'rent', mode: 'set', amount: 950 }] });
    expect(tplOf(r, 'monthly').note).toBe('kept');
    expect(r.value.changes.envelopeTemplates.map(x => x.id)).toEqual(['monthly', 'split', 'empty']);
  });

  it('a single-field update touches only that field', () => {
    const r = run('template.update', { id: 'monthly', fields: { description: null } });
    expect(tplOf(r, 'monthly')).toEqual({ ...monthly, description: null });
    expect(r.value.changes.envelopeTemplates[1]).toBe(data().envelopeTemplates[1]);
  });

  it('applies the name rule only when the name changes, case-insensitively', () => {
    const twinData = data({ envelopeTemplates: [monthly, { ...split, name: 'Twin' }, { ...split, id: 'twin2', name: 'twin' }] });
    expect(run('template.update', { id: 'monthly', fields: { name: 'TWIN' } }, twinData).error).toEqual({ code: 'name_taken', params: { kind: 'template', name: 'TWIN' } });
    expect(run('template.update', { id: 'monthly', fields: { name: ' MONTHLY ' } }, twinData).ok).toBe(true);
    // An unrelated edit of a template whose name duplicates another is not refused.
    expect(run('template.update', { id: 'twin2', fields: { description: 'x' } }, twinData).ok).toBe(true);
    const blank = run('template.update', { id: 'monthly', fields: { name: '  ' } });
    expect(blank.error.code).toBe('bad_input');
    expect(errPaths(blank)).toEqual(['fields.name']);
  });

  it('refuses only the errors the update adds', () => {
    // The stored template has no lines; editing its description still works.
    expect(run('template.update', { id: 'empty', fields: { description: 'x' } }).ok).toBe(true);
    // Adding a schedule with no month is an error the update introduces.
    const r = run('template.update', { id: 'empty', fields: { schedule: { enabled: true, payment_day: 1, months: {} } } });
    expect(r.error.code).toBe('bad_input');
    expect(errPaths(r)).toEqual(['fields.schedule.months']);
    // Emptying a template's lines is refused.
    expect(errPaths(run('template.update', { id: 'monthly', fields: { lines: [] } }))).toEqual(['fields.lines']);
  });

  it('enforces the schedule rules', () => {
    const sched = (over) => ({ ...monthly.schedule, ...over });
    expect(errPaths(run('template.update', { id: 'monthly', fields: { schedule: sched({ since: '2026-05-01', until: '2026-04-30' }) } }))).toEqual(['fields.schedule.until']);
    expect(errPaths(run('template.update', { id: 'monthly', fields: { schedule: sched({ source_envelope_id: 'rent' }) } }))).toEqual(['fields.schedule.source_envelope_id']);
    expect(errPaths(run('template.update', { id: 'monthly', fields: { schedule: sched({ source_envelope_id: 'old' }) } }))).toEqual(['fields.schedule.source_envelope_id']);
    expect(errPaths(run('template.update', { id: 'monthly', fields: { schedule: sched({ source_since: '2026-01-01' }) } }))).toEqual(['fields.schedule.source_since']);
    const off = run('template.update', { id: 'monthly', fields: { schedule: { ...monthly.schedule, enabled: false } } });
    expect(tplOf(off, 'monthly').schedule.enabled).toBe(false);
    const removed = run('template.update', { id: 'monthly', fields: { schedule: null } });
    expect(tplOf(removed, 'monthly')).not.toHaveProperty('schedule');
  });

  it('a kind change drops the other list; a list for the other kind is refused', () => {
    const r = run('template.update', { id: 'monthly', fields: { kind: 'dynamic', assignments: [{ envelope_id: 'rent', mode: 'add', percent: 40 }] } });
    expect(r.ok).toBe(true);
    expect(tplOf(r, 'monthly')).not.toHaveProperty('lines');
    expect(tplOf(r, 'monthly').assignments).toEqual([{ envelope_id: 'rent', mode: 'add', percent: 40 }]);
    expect(tplOf(r, 'monthly').note).toBe('kept');
    const stray = run('template.update', { id: 'split', fields: { lines: [{ envelope_id: 'rent', mode: 'add', amount: 5 }] } });
    expect(stray.error.code).toBe('bad_input');
    expect(errPaths(stray)).toEqual(['fields.lines']);
  });

  it('an update that changes nothing is ok, with no changes', () => {
    const r = run('template.update', { id: 'monthly', fields: { name: 'Monthly', description: 'Old' } });
    expect(r.ok).toBe(true);
    expect(r.value.changes).toEqual({});
  });

  it('refuses an unknown template', () => {
    expect(run('template.update', { id: 'nope', fields: { description: 'x' } }).ok).toBe(false);
  });
});

describe('template.delete', () => {
  it('removes the template without a reference check', () => {
    const d = data({ transactions: [{ id: 't1', type: 'fill', date: '2026-09-01', status: 'posted', template_id: 'monthly', lines: [] }], budgetItems: [{ id: 'i', kind: 'income', template_id: 'monthly' }] });
    const r = run('template.delete', { id: 'monthly' }, d);
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'monthly' });
    expect(r.value.changes).toEqual({ envelopeTemplates: [split, empty] });
    expect(r.value.diff.envelopeTemplates.removed.map(x => x.row.id)).toEqual(['monthly']);
  });

  it('refuses an unknown template', () => {
    expect(run('template.delete', { id: 'nope' }).ok).toBe(false);
  });
});

describe('template.convertIncomeLinked', () => {
  const income = (over = {}) => ({
    id: 'inc1', kind: 'income', as_schedule: true, template_id: 'tpl1', account_id: 'chk', payment_day: 25,
    default_amount: 2000, monthly_schedule: { ...everyMonth(), Jul: 0 }, as_schedule_since: '2025-01-01',
    skipped_occurrences: ['2026-07'], ...over,
  });
  const legacy = () => data({
    budgetItems: [income()],
    envelopeTemplates: [{ id: 'tpl1', name: 'Salary Split', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 100 }] }],
    transactions: [
      { id: 'i1', type: 'income', amount: 2000, date: '2026-08-25', status: 'posted', account: 'chk', from_budget: 'inc1:2026-08' },
      { id: 'f1', type: 'fill', date: '2026-08-25', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'rent', amount: 100, mode: 'add' }], from_budget: 'inc1:2026-08:fill' },
    ],
    meta: { schemaVersion: 8, scheduledTombstones: ['inc1:2026-07:fill', 'other:2026-07'] },
  });

  it('converts old occurrence keys under strict-ledger without bypassing financial edits', () => {
    const d = legacy();
    const r = runCommand(registry, d, 'template.convertIncomeLinked', {}, ctx(), { policies: [strictLedger] });
    expect(r.ok).toBe(true);
    expect(r.value.after.transactions.map(tx => tx.amount)).toEqual(d.transactions.map(tx => tx.amount));
    expect(r.value.after.transactions.map(tx => tx.from_budget)).not.toEqual(d.transactions.map(tx => tx.from_budget));
  });

  it('is internal, so it is listed only on request', () => {
    expect(registry.list().map(e => e.name)).not.toContain('template.convertIncomeLinked');
    expect(registry.list({ includeInternal: true }).map(e => e.name)).toContain('template.convertIncomeLinked');
  });

  it('gives the same collections as calling the function directly', () => {
    const d = legacy();
    const direct = convertIncomeLinkedTemplates({ budgetItems: d.budgetItems, envelopeTemplates: d.envelopeTemplates, transactions: d.transactions, meta: d.meta });
    expect(direct.changed).toBe(true);
    const r = run('template.convertIncomeLinked', {}, d);
    expect(r.ok).toBe(true);
    expect(r.value.changes).toEqual({
      budgetItems: direct.budgetItems, envelopeTemplates: direct.envelopeTemplates, transactions: direct.transactions, meta: direct.meta,
    });
    expect(r.value.value).toEqual({ changed: true, notes: direct.notes });
    expect(r.value.changes.meta.scheduledTombstones).toEqual(['tpl:tpl1:2026-07', 'other:2026-07']);
    expect(r.value.changes.budgetItems[0].template_id).toBeNull();
    expect(r.value.changes.envelopeTemplates[0].schedule.enabled).toBe(true);
  });

  it('leaves out a collection the conversion did not touch', () => {
    const d = data({
      budgetItems: [income()],
      envelopeTemplates: [{ id: 'tpl1', name: 'Salary Split', kind: 'manual', lines: [] }],
    });
    const r = run('template.convertIncomeLinked', {}, d);
    expect(Object.keys(r.value.changes).sort()).toEqual(['budgetItems', 'envelopeTemplates']);
  });

  it('a second run over the converted data is a no-op', () => {
    const first = run('template.convertIncomeLinked', {}, legacy());
    const converted = deepFreeze({ ...legacy(), ...first.value.changes });
    const second = run('template.convertIncomeLinked', {}, converted);
    expect(second.ok).toBe(true);
    expect(second.value.changes).toEqual({});
    expect(second.value.diff).toEqual({});
    expect(second.value.value).toEqual({ changed: false, notes: [] });
  });

  it('changes nothing when nothing is linked', () => {
    const r = run('template.convertIncomeLinked', {});
    expect(r.value.changes).toEqual({});
  });
});

it('does not let a stored blank name mask a newly invalid schedule', () => {
  const d = data({ envelopeTemplates: [{ ...monthly, name: '' }] });
  const r = run('template.update', { id: 'monthly', fields: { schedule: { enabled: true, payment_day: 1, months: {} } } }, d);
  expect(errPaths(r)).toContain('fields.schedule.months');
});
it('lets a stored both-list template edit its own list without dropping unrelated legacy data', () => {
  const d = data({ envelopeTemplates: [{ ...monthly, assignments: split.assignments }] });
  const r = run('template.update', { id: 'monthly', fields: { lines: [{ envelope_id: 'groc', mode: 'add', amount: 20 }] } }, d);
  expect(r.ok).toBe(true);
  expect(tplOf(r, 'monthly').assignments).toEqual(split.assignments);
});

it('reports duplicate envelopes at input indices, before zero lines were filtered', () => {
  const r = templateCreate.execute(data(), { name: 'Input positions', kind: 'manual', lines: [
    { envelope_id: 'groc', mode: 'add', amount: 0 },
    { envelope_id: 'rent', mode: 'add', amount: 10 },
    { envelope_id: 'rent', mode: 'add', amount: 20 },
  ] });
  expect(errPaths(r)).toEqual(['lines[2].envelope_id']);
});
it('tracks pre-existing duplicate errors by envelope and count despite shifted indices', () => {
  const line = { envelope_id: 'rent', mode: 'add', amount: 10 };
  const d = data({ envelopeTemplates: [{ ...monthly, lines: [line, line] }] });
  const lines = [{ envelope_id: 'groc', mode: 'add', amount: 20 }, line, line];
  expect(run('template.update', { id: 'monthly', fields: { lines } }, d).ok).toBe(true);
  expect(errPaths(run('template.update', { id: 'monthly', fields: { lines: [...lines, line] } }, d)))
    .toEqual(['fields.lines[3].envelope_id']);
});
