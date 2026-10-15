// tests/core-envelope-commands.test.js — envelope.create, .update, .archive,
// .delete, .reorder and the internal envelope.archiveDeleted, run through the
// pipeline as every surface runs them.
import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import { slugify, uniqueId } from '../js/utils.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const NOW = new Date(2026, 9, 2, 10, 0, 0);
const TODAY = '2026-10-02';
const ctx = () => makeCtx({ now: NOW, newId: (() => { let n = 0; return () => `n${++n}`; })() });

const groc = { id: 'food-groceries', name: 'Groceries', category: 'Food', description: 'Weekly shop', archived: false };
const rent = { id: 'home-rent', name: 'Rent', category: 'Home', description: '', archived: false, spend_flag_exempt: true };
const goal = { id: 'goal-trip', name: 'Trip', category: 'Goals', description: '', archived: false, goal_amount: 1000, goal_date: '2027-01-01', goal_start: '2026-03-01', rollover: 'zero-monthly' };
const old = { id: 'old', name: 'Old', category: '', description: '', archived: true };
const dup1 = { id: 'dup1', name: 'Spare', category: 'A', description: '' };
const dup2 = { id: 'dup2', name: 'Spare', category: 'B', description: '' };
// One envelope per reference kind, so each delete refusal is its own case.
const ref = (id) => ({ id, name: `Ref ${id}`, category: 'Refs', description: '', archived: false });

const data = (extra = {}) => deepFreeze({
  meta: {},
  accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 100 }],
  envelopes: [groc, rent, goal, old, dup1, dup2, ref('free'), ref('inplan'), ref('intpl'), ref('insched'), ref('insplit'), ref('intx')],
  budgetItems: [{ id: 'bi1', name: 'Plan', envelope_id: 'inplan', amount: 10, account: 'chk', frequency: 'monthly' }],
  envelopeTemplates: [
    { id: 'tpl1', name: 'Manual', lines: [{ envelope_id: 'intpl', amount: 5 }] },
    { id: 'tpl2', name: 'Dynamic', schedule: { source_envelope_id: 'insched' }, assignments: [] },
  ],
  transactions: [
    { id: 't1', type: 'expense', date: '2026-09-01', payee: 'Shop', amount: 30, account: 'chk', envelope_id: 'intx', status: 'posted' },
    { id: 't2', type: 'expense', date: '2026-09-02', payee: 'Mixed', amount: 40, account: 'chk', status: 'posted', envelope_splits: [{ envelope_id: 'insplit', amount: 25 }, { envelope_id: 'intx', amount: 15 }] },
  ],
  ...extra,
});

// Every successful run is checked twice over: the same input on the same
// frozen data gives the same diff (the dry run is the commit), and that diff
// applied to the data reproduces the committed collections.
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
const envOf = (r, id) => r.value.changes.envelopes.find(e => e.id === id);

describe('envelope.create', () => {
  it('makes the id from category and name, and always writes spend_flag_exempt', () => {
    const r = run('envelope.create', { name: 'Gym' });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'gym' });
    expect(r.value.changes.envelopes.at(-1)).toEqual({ id: 'gym', code: 'GY01', name: 'Gym', category: '', description: '', archived: false, spend_flag_exempt: false });
    expect(r.value.changes.envelopes.slice(0, -1)).toEqual(data().envelopes);
  });

  it('trims the text, derives the id from category and name, and suffixes a collision', () => {
    const r = run('envelope.create', { name: ' Groceries ', category: ' Food ', description: ' more ', spend_flag_exempt: true });
    // The name is taken (case-insensitive); a different one in the same category collides on id only.
    expect(r.error.code).toBe('name_taken');
    const ok1 = run('envelope.create', { name: 'Groceries 2', category: ' Food ', description: ' more ', spend_flag_exempt: true });
    expect(ok1.value.value).toEqual({ id: 'food-groceries-2' });
    expect(ok1.value.changes.envelopes.at(-1)).toEqual({ id: 'food-groceries-2', code: 'FO01', name: 'Groceries 2', category: 'Food', description: 'more', archived: false, spend_flag_exempt: true });
    const clash = run('envelope.create', { name: 'Groceries!', category: 'Food' });
    expect(clash.value.value).toEqual({ id: 'food-groceries-2' });
    expect(run('envelope.create', { name: '!!!' }).value.value).toEqual({ id: 'envelope' });
  });

  it('refuses a name already taken, case-insensitively and among archived envelopes', () => {
    expect(run('envelope.create', { name: ' groceries ' }).error).toEqual({ code: 'name_taken', params: { kind: 'envelope', name: 'groceries' } });
    expect(run('envelope.create', { name: 'OLD' }).error.code).toBe('name_taken');
    const empty = run('envelope.create', { name: '   ' });
    expect(empty.error.code).toBe('bad_input');
    expect(empty.error.params.errors[0].path).toBe('name');
  });

  it('stamps goal_start with today beside a goal amount and date, and stores carry as no key', () => {
    const r = run('envelope.create', { name: 'Bike', goal_amount: '500.5', goal_date: '2027-05-01', rollover: 'carry' });
    expect(r.value.changes.envelopes.at(-1)).toEqual({
      id: 'bike', code: 'BI01', name: 'Bike', category: '', description: '', archived: false, spend_flag_exempt: false,
      goal_amount: 500.5, goal_date: '2027-05-01', goal_start: TODAY,
    });
    const half = run('envelope.create', { name: 'Half', goal_amount: 100, rollover: 'zero-monthly' });
    expect(half.value.changes.envelopes.at(-1)).toEqual({
      id: 'half', code: 'HA01', name: 'Half', category: '', description: '', archived: false, spend_flag_exempt: false, goal_amount: 100, rollover: 'zero-monthly',
    });
  });

  it('refuses a goal amount that is not positive', () => {
    expect(run('envelope.create', { name: 'Bad', goal_amount: 0 }).error.code).toBe('bad_input');
  });
});

describe('envelope.update', () => {
  it('sets the given fields and keeps the rest', () => {
    const r = run('envelope.update', { id: 'food-groceries', fields: { name: ' Food shop ', description: ' x ', favorite: true, spend_flag_exempt: true } });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'food-groceries' });
    expect(envOf(r, 'food-groceries')).toEqual({ ...groc, name: 'Food shop', description: 'x', favorite: true, spend_flag_exempt: true });
    expect(r.value.changes).not.toHaveProperty('transactions');
    // The id never changes with a rename, and the order is kept.
    expect(r.value.changes.envelopes.map(e => e.id)).toEqual(data().envelopes.map(e => e.id));
  });

  it('null clears a nullable field, and carry removes the rollover key', () => {
    const r = run('envelope.update', { id: 'goal-trip', fields: { rollover: 'carry', goal_amount: null } });
    expect(envOf(r, 'goal-trip')).toEqual({ id: 'goal-trip', name: 'Trip', category: 'Goals', description: '', archived: false, goal_date: '2027-01-01' });
  });

  it('allows an existing duplicate name to stay, but refuses a changed name that clashes', () => {
    expect(run('envelope.update', { id: 'dup1', fields: { description: 'still a duplicate' } }).ok).toBe(true);
    expect(run('envelope.update', { id: 'dup1', fields: { name: 'Spare', description: 'same name sent' } }).ok).toBe(true);
    expect(run('envelope.update', { id: 'food-groceries', fields: { name: 'GROCERIES' } }).ok).toBe(true);
    expect(run('envelope.update', { id: 'food-groceries', fields: { name: 'rent' } }).error)
      .toEqual({ code: 'name_taken', params: { kind: 'envelope', name: 'rent' } });
    expect(run('envelope.update', { id: 'dup1', fields: { name: 'old' } }).error.code).toBe('name_taken');
    const empty = run('envelope.update', { id: 'food-groceries', fields: { name: ' ' } });
    expect(empty.error.code).toBe('bad_input');
    expect(empty.error.params.errors[0].path).toBe('fields.name');
  });

  describe('goal stamping', () => {
    it('stamps today when a goal becomes complete', () => {
      const r = run('envelope.update', { id: 'food-groceries', fields: { goal_amount: 200, goal_date: '2027-02-01' } });
      expect(envOf(r, 'food-groceries')).toEqual({ ...groc, goal_amount: 200, goal_date: '2027-02-01', goal_start: TODAY });
    });

    it('keeps an existing goal_start when the goal is edited', () => {
      const r = run('envelope.update', { id: 'goal-trip', fields: { goal_amount: 1500, name: 'Big trip' } });
      expect(envOf(r, 'goal-trip').goal_start).toBe('2026-03-01');
      const redate = run('envelope.update', { id: 'goal-trip', fields: { goal_date: '2028-01-01' } });
      expect(envOf(redate, 'goal-trip').goal_start).toBe('2026-03-01');
    });

    it('drops goal_start when the goal is no longer complete, and restamps if it completes again', () => {
      const cleared = run('envelope.update', { id: 'goal-trip', fields: { goal_date: null } });
      expect(envOf(cleared, 'goal-trip')).not.toHaveProperty('goal_start');
      const again = run('envelope.update', { id: 'goal-trip', fields: { goal_date: '2028-01-01' } }, data({
        envelopes: [envOf(cleared, 'goal-trip')],
      }));
      expect(envOf(again, 'goal-trip').goal_start).toBe(TODAY);
    });

    it('replaces an invalid stored goal_start with today when the goal is edited', () => {
      const bad = { ...goal, goal_start: 'soon' };
      const r = run('envelope.update', { id: 'goal-trip', fields: { goal_amount: 1200 } }, data({ envelopes: [bad] }));
      expect(envOf(r, 'goal-trip').goal_start).toBe(TODAY);
    });
  });

  describe('a single-field update touches only its own fields', () => {
    // A goal set before goal_start existed (the pace verdict falls back to one
    // year), an unrounded goal and a stored default rollover: none of them is
    // re-derived unless the update names the goal or the rollover.
    const legacy = { id: 'legacy', name: 'Car', category: 'Goals', description: '', goal_amount: 999.999, goal_date: '2027-06-01', rollover: 'carry' };
    const bad = { ...goal, goal_start: 'soon' };
    for (const env of [legacy, bad, goal, groc]) {
      for (const fields of [{ favorite: true }, { favorite: false }, { description: 'note' }, { spend_flag_exempt: true }]) {
        it(`${env.id}, ${JSON.stringify(fields)}: every other key is identical`, () => {
          const r = run('envelope.update', { id: env.id, fields }, data({ envelopes: [env] }));
          expect(r.ok).toBe(true);
          expect(envOf(r, env.id)).toEqual({ ...env, ...fields });
        });
      }
    }

    it('a favourite on a goal envelope without goal_start leaves it absent', () => {
      const r = run('envelope.update', { id: 'legacy', fields: { favorite: true } }, data({ envelopes: [legacy] }));
      expect(envOf(r, 'legacy')).not.toHaveProperty('goal_start');
    });

    it('the goal fields and the rollover still normalise when given', () => {
      const r = run('envelope.update', { id: 'legacy', fields: { goal_amount: 999.999, rollover: 'carry' } }, data({ envelopes: [legacy] }));
      expect(envOf(r, 'legacy')).toEqual({ id: 'legacy', name: 'Car', category: 'Goals', description: '', goal_amount: 1000, goal_date: '2027-06-01', goal_start: TODAY });
    });
  });
});

describe('envelope.archive', () => {
  it('archives and unarchives, changing only archived', () => {
    const a = run('envelope.archive', { id: 'food-groceries', archived: true });
    expect(a.value.changes.envelopes).toEqual(data().envelopes.map(x => (x.id === 'food-groceries' ? { ...groc, archived: true } : x)));
    expect(a.value.value).toEqual({ id: 'food-groceries', archived: true });
    const u = run('envelope.archive', { id: 'old', archived: false });
    expect(envOf(u, 'old')).toEqual({ ...old, archived: false });
  });

  it('refuses a no-op, so Undo always has a diff', () => {
    for (const input of [{ id: 'food-groceries', archived: false }, { id: 'old', archived: true }, { id: 'dup1', archived: false }]) {
      const r = run('envelope.archive', input);
      expect(r.error.code).toBe('bad_input');
      expect(r.error.params.errors[0].path).toBe('archived');
    }
  });
});

describe('envelope.delete', () => {
  it('refuses an envelope still referenced, with the counts, for each referencing collection', () => {
    const cases = [
      ['inplan', { budgetItems: 1, transactions: 0, envelopeTemplates: 0 }],
      ['intpl', { budgetItems: 0, transactions: 0, envelopeTemplates: 1 }],
      ['insched', { budgetItems: 0, transactions: 0, envelopeTemplates: 1 }],
      ['insplit', { budgetItems: 0, transactions: 1, envelopeTemplates: 0 }],
      ['intx', { budgetItems: 0, transactions: 2, envelopeTemplates: 0 }],
    ];
    for (const [id, refs] of cases) {
      expect(run('envelope.delete', { id }).error, id).toEqual({ code: 'in_use', params: { kind: 'envelope', id, refs } });
    }
  });

  it('removes an unreferenced envelope', () => {
    const r = run('envelope.delete', { id: 'free' });
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ id: 'free' });
    expect(r.value.changes.envelopes).toEqual(data().envelopes.filter(e => e.id !== 'free'));
    expect(r.value.diff.envelopes.removed).toEqual([{ row: ref('free'), index: 6 }]);
  });

  it('refuses an unknown id', () => {
    expect(run('envelope.delete', { id: 'nope' }).error.code).toBe('bad_input');
  });
});

describe('envelope.reorder', () => {
  const ids = data().envelopes.map(e => e.id);

  it('rebuilds the array in the given order, keeping every object', () => {
    const d = data();
    const next = [...ids].reverse();
    const r = run('envelope.reorder', { ids: next }, d);
    expect(r.ok).toBe(true);
    expect(r.value.changes.envelopes.map(e => e.id)).toEqual(next);
    r.value.changes.envelopes.forEach(e => expect(e).toBe(d.envelopes.find(x => x.id === e.id)));
    expect(r.value.diff).toEqual({ envelopes: { added: [], removed: [], changed: [], order: { before: ids, after: next } } });
  });

  it('refuses anything but a permutation of the current ids', () => {
    const notPerm = { code: 'not_permutation', params: { kind: 'envelope' } };
    expect(run('envelope.reorder', { ids: ids.slice(1) }).error).toEqual(notPerm);
    expect(run('envelope.reorder', { ids: [...ids, 'extra'] }).error).toEqual(notPerm);
    expect(run('envelope.reorder', { ids: [...ids.slice(1), 'extra'] }).error).toEqual(notPerm);
    expect(run('envelope.reorder', { ids: [...ids.slice(1), ids[1]] }).error).toEqual(notPerm);
  });
});

describe('envelope.archiveDeleted', () => {
  const legacy = { id: 'l1', name: '(deleted: Gym)', category: 'X', description: '' };
  const legacyDone = { id: 'l2', name: '(deleted: Books)', category: 'X', description: '', archived: true };
  const lookalike = { id: 'l3', name: 'Not (deleted: really)', category: 'X', description: '' };
  const legacy2 = { id: 'l4', name: '(deleted:Pets)', category: 'X', description: '', archived: false };
  const d = () => data({ envelopes: [groc, legacy, legacyDone, lookalike, legacy2] });

  it('is internal: dispatchable by name, left out of the listing', () => {
    expect(registry.get('envelope.archiveDeleted').internal).toBe(true);
    expect(registry.list().map(e => e.name)).not.toContain('envelope.archiveDeleted');
    expect(registry.list({ includeInternal: true }).map(e => e.name)).toContain('envelope.archiveDeleted');
  });

  it('archives only the matching unarchived envelopes', () => {
    const r = run('envelope.archiveDeleted', {}, d());
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ archived: 2 });
    expect(r.value.changes.envelopes).toEqual([groc, { ...legacy, archived: true }, legacyDone, lookalike, { ...legacy2, archived: true }]);
  });

  it('a second run is a no-op: ok, no changes, no diff', () => {
    const first = run('envelope.archiveDeleted', {}, d());
    const r = run('envelope.archiveDeleted', {}, deepFreeze({ ...d(), ...first.value.changes }));
    expect(r.ok).toBe(true);
    expect(r.value.value).toEqual({ archived: 0 });
    expect(r.value.changes).toEqual({});
    expect(r.value.diff).toEqual({});
  });

  it('rejects any input', () => {
    expect(run('envelope.archiveDeleted', { x: 1 }, d()).error.code).toBe('bad_input');
  });
});

// The envelope form's Save handler (js/pages/envelope-edit.js), the create and
// update branches, copied with the DOM reads replaced by `f` (the form's state
// after the user's edits) and `todayIso`. It returns the stored list.
function oldFormSave(envelopes, env, f, todayIso) {
  const isNew = !env;
  const name = f.name.trim();
  const category = f.category.trim();
  const description = f.description.trim();
  const goalAmtRaw = f.goalAmount === '' ? NaN : Number(f.goalAmount);
  const goalAmount = Number.isFinite(goalAmtRaw) && goalAmtRaw > 0 ? Math.round(goalAmtRaw * 100) / 100 : null;
  const goalDate = f.goalDate && /^\d{4}-\d{2}-\d{2}$/.test(f.goalDate) ? f.goalDate : null;
  const existingStart = !isNew && typeof env.goal_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(env.goal_start) ? env.goal_start : null;
  const goalStart = (goalAmount !== null && goalDate !== null) ? (existingStart || todayIso) : null;
  const goalPatch = {};
  if (goalAmount !== null) goalPatch.goal_amount = goalAmount;
  if (goalDate !== null) goalPatch.goal_date = goalDate;
  if (goalStart !== null) goalPatch.goal_start = goalStart;
  const rollover = ['carry', 'cover-from-unallocated', 'zero-monthly'].includes(f.rollover) ? f.rollover : 'carry';
  const spendFlagExempt = f.exempt;
  if (isNew) {
    const taken = new Set(envelopes.map(x => x.id));
    const id = uniqueId(slugify(`${category}-${name}`) || 'envelope', taken);
    const newEnv = { id, name, category, description, archived: false, ...goalPatch };
    if (rollover !== 'carry') newEnv.rollover = rollover;
    newEnv.spend_flag_exempt = spendFlagExempt;
    return [...envelopes, newEnv];
  }
  return envelopes.map(x => {
    if (x.id !== env.id) return x;
    const updated = { ...x, name, category, description, spend_flag_exempt: spendFlagExempt };
    if (goalAmount !== null) updated.goal_amount = goalAmount; else delete updated.goal_amount;
    if (goalDate !== null) updated.goal_date = goalDate; else delete updated.goal_date;
    if (goalStart !== null) updated.goal_start = goalStart; else delete updated.goal_start;
    if (rollover !== 'carry') updated.rollover = rollover; else delete updated.rollover;
    return updated;
  });
}

// What the form sends as a command: every field, empty goal inputs as null.
const formFields = (f) => ({
  name: f.name, category: f.category, description: f.description, rollover: f.rollover, spend_flag_exempt: f.exempt,
  goal_amount: f.goalAmount === '' ? null : f.goalAmount, goal_date: f.goalDate || null,
});

describe('equivalence with the envelope form', () => {
  const blank = { name: 'Fun', category: 'Life', description: '', goalAmount: '', goalDate: '', rollover: 'carry', exempt: false };
  const CASES = [
    ['plain', blank],
    ['padded text', { ...blank, name: '  Fun  ', category: ' Life ', description: ' time ' }],
    ['exempt, cover-from-unallocated', { ...blank, rollover: 'cover-from-unallocated', exempt: true }],
    ['complete goal', { ...blank, goalAmount: '1200.456', goalDate: '2027-06-30', rollover: 'zero-monthly' }],
    ['amount without date', { ...blank, goalAmount: '300' }],
    ['date without amount', { ...blank, goalDate: '2027-06-30' }],
    ['no category', { ...blank, category: '' }],
  ];
  const others = [dup1, dup2];

  for (const [label, f] of CASES) {
    it(`create, ${label}: stores what the form stores`, () => {
      const d = data({ envelopes: [...others, { id: 'life-fun', name: 'Other fun', category: 'Life' }] });
      const r = run('envelope.create', formFields(f), d);
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      const expected = oldFormSave(d.envelopes, null, f, TODAY);
      expected.at(-1).code = f.category.trim() ? 'LI01' : 'FU01';
      expect(r.value.changes.envelopes).toEqual(expected);
    });

    for (const [from, existing] of [['a plain envelope', groc], ['an envelope with a goal', goal], ['an envelope with a rollover', { ...rent, rollover: 'cover-from-unallocated', goal_start: 'x' }]]) {
      it(`update, ${label}, over ${from}: stores what the form stores`, () => {
        const d = data({ envelopes: [...others, existing] });
        const r = run('envelope.update', { id: existing.id, fields: formFields(f) }, d);
        expect(r.ok, JSON.stringify(r.error)).toBe(true);
        expect(r.value.changes.envelopes).toEqual(oldFormSave(d.envelopes, existing, f, TODAY));
      });
    }
  }
});
