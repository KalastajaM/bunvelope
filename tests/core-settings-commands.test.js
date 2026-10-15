// tests/core-settings-commands.test.js — settings.update and the month
// commands (month.close, .reopen, .clearReopen): each field stored as the
// Settings page stores it, validation, the clock from ctx, and every one of
// them meta-primary through a browser session.
import { describe, it, expect, vi } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyDiff } from '../js/core/diff.js';
import { CURRENCIES, COUNTRIES } from '../js/core/settings-fields.js';
import { closeMonthPatch, reopenMonthPatch, dropReopenPatch } from '../js/core/closed-periods.js';
import { createBrowserSession } from '../js/session/browser-session.js';
import { createMetaQueue } from '../js/state/meta-queue.js';
import settingsUpdate from '../js/core/commands/settings-update.js';

function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const OCT_2 = new Date(2026, 9, 2, 10, 0, 0);
const ctx = (now = OCT_2) => makeCtx({ now, newId: (() => { let n = 0; return () => `n${++n}`; })() });
const data = (meta = {}) => deepFreeze({
  meta, accounts: [], envelopes: [{ id: 'efund', name: 'Emergency' }, { id: 'rent', name: 'Rent' }],
  budgetItems: [], envelopeTemplates: [], transactions: [],
});

// Every success is checked twice: the diff is stable, and applying it to the
// frozen data reproduces the changed meta.
function run(name, input, d = data(), now) {
  const r = runCommand(registry, d, name, input, ctx(now));
  if (r.ok) {
    const again = runCommand(registry, d, name, input, ctx(now));
    expect(again.value.diff).toEqual(r.value.diff);
    const applied = applyDiff(d, r.value.diff);
    expect(applied.ok).toBe(true);
    for (const [kind, v] of Object.entries(applied.value)) expect(v).toEqual(r.value.changes[kind]);
  }
  return r;
}
const metaOf = (r) => r.value.changes.meta;
const errPaths = (r) => r.error.params.errors.map(e => e.path);

describe('settings.update', () => {
  const base = { schemaVersion: 8, name: 'Home', currency: 'EUR', locale: 'fi-FI', country: 'SE', auto_close_after_months: 3 };

  it('sets currency as Settings does ({...m, currency})', () => {
    const r = run('settings.update', { fields: { currency: 'USD' } }, data(base));
    expect(metaOf(r)).toEqual({ ...base, currency: 'USD' });
    expect(r.value.value).toEqual({ changed: ['currency'] });
  });

  it('does not throw when meta is absent (execute called directly)', () => {
    const r = settingsUpdate.execute({}, { fields: { currency: 'USD' } });
    expect(r.ok).toBe(true);
    expect(r.value.changes.meta).toEqual({ currency: 'USD' });
    expect(r.value.value).toEqual({ changed: ['currency'] });
  });

  it('lists the page options in core: ten currencies and ten countries', () => {
    expect(CURRENCIES).toHaveLength(10);
    expect(COUNTRIES).toHaveLength(10);
    expect(CURRENCIES[0]).toEqual(['EUR', 'Euro']);
    expect(COUNTRIES[0]).toEqual(['FI', 'Finland']);
  });

  it('sets locale, and a null or empty locale deletes the key', () => {
    expect(metaOf(run('settings.update', { fields: { locale: 'en-GB' } }, data(base)))).toEqual({ ...base, locale: 'en-GB' });
    for (const locale of [null, '']) {
      const next = metaOf(run('settings.update', { fields: { locale } }, data(base)));
      expect(Object.hasOwn(next, 'locale')).toBe(false);
      expect(next.currency).toBe('EUR');
    }
  });

  it('sets country; null resets to FI', () => {
    expect(metaOf(run('settings.update', { fields: { country: 'DE' } }, data(base))).country).toBe('DE');
    expect(metaOf(run('settings.update', { fields: { country: null } }, data(base))).country).toBe('FI');
  });

  it('sets the emergency envelope, and null stores null (not a deleted key)', () => {
    const set = metaOf(run('settings.update', { fields: { emergency_envelope_id: 'efund' } }, data(base)));
    expect(set.emergency_envelope_id).toBe('efund');
    const cleared = metaOf(run('settings.update', { fields: { emergency_envelope_id: null } }, data({ ...base, emergency_envelope_id: 'efund' })));
    expect(Object.hasOwn(cleared, 'emergency_envelope_id')).toBe(true);
    expect(cleared.emergency_envelope_id).toBeNull();
  });

  it('sets the emergency duration and credit source', () => {
    const r = run('settings.update', { fields: { emergency_duration_months: 9, emergency_credit_source: 'all' } }, data(base));
    expect(metaOf(r)).toMatchObject({ emergency_duration_months: 9, emergency_credit_source: 'all' });
    expect(metaOf(run('settings.update', { fields: { emergency_duration_months: 120 } }, data(base))).emergency_duration_months).toBe(120);
    expect(metaOf(run('settings.update', { fields: { emergency_duration_months: 1 } }, data(base))).emergency_duration_months).toBe(1);
  });

  it('sets auto_close_after_months; null deletes the key', () => {
    expect(metaOf(run('settings.update', { fields: { auto_close_after_months: 6 } }, data(base))).auto_close_after_months).toBe(6);
    const off = metaOf(run('settings.update', { fields: { auto_close_after_months: null } }, data(base)));
    expect(Object.hasOwn(off, 'auto_close_after_months')).toBe(false);
  });

  it('leaves fields not given as they are, and sets several at once', () => {
    const r = run('settings.update', { fields: { currency: 'GBP', country: 'GB' } }, data(base));
    expect(metaOf(r)).toEqual({ ...base, currency: 'GBP', country: 'GB' });
  });

  it('an update that changes nothing is ok with no changes', () => {
    const r = run('settings.update', { fields: { currency: 'EUR', locale: 'fi-FI' } }, data(base));
    expect(r.ok).toBe(true);
    expect(r.value.changes).toEqual({});
    expect(r.value.value).toEqual({ changed: [] });
  });

  describe('validation (bad_input in the validator\'s shape)', () => {
    const refused = (fields) => {
      const r = runCommand(registry, data(base), 'settings.update', { fields }, ctx());
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('bad_input');
      return r;
    };
    it('refuses a duration of 0 or 121, or a fraction', () => {
      expect(errPaths(refused({ emergency_duration_months: 0 }))).toEqual(['fields.emergency_duration_months']);
      expect(errPaths(refused({ emergency_duration_months: 121 }))).toEqual(['fields.emergency_duration_months']);
      expect(errPaths(refused({ emergency_duration_months: 1.5 }))).toEqual(['fields.emergency_duration_months']);
    });
    it('refuses an unknown currency and an unknown country', () => {
      expect(errPaths(refused({ currency: 'XXX' }))).toEqual(['fields.currency']);
      expect(errPaths(refused({ country: 'ZZ' }))).toEqual(['fields.country']);
    });
    it('refuses an unknown envelope', () => {
      expect(errPaths(refused({ emergency_envelope_id: 'nope' }))).toEqual(['fields.emergency_envelope_id']);
    });
    it('refuses a bad credit source, a non-positive auto-close and an unknown field', () => {
      expect(errPaths(refused({ emergency_credit_source: 'some' }))).toEqual(['fields.emergency_credit_source']);
      expect(errPaths(refused({ auto_close_after_months: 0 }))).toEqual(['fields.auto_close_after_months']);
      expect(errPaths(refused({ name: 'x' }))).toEqual(['fields.name']);
    });
    it('a null currency is not a way to clear it: nothing changes', () => {
      const r = runCommand(registry, data(base), 'settings.update', { fields: { currency: null } }, ctx());
      expect(r.ok).toBe(true);
      expect(r.value.changes).toEqual({});
    });
  });
});

describe('month.close', () => {
  it('closes by hand, as closeMonthPatch does', () => {
    const d = data({ closed_months: ['2026-06'], reopened_months: ['2026-08'] });
    const r = run('month.close', { month: '2026-08' }, d);
    expect(metaOf(r)).toEqual(closeMonthPatch(d.meta, '2026-08'));
    expect(metaOf(r).closed_months).toEqual(['2026-06', '2026-08']);
    expect(metaOf(r).reopened_months).toEqual([]);
  });

  it('refuses a month that is already closed by hand', () => {
    const r = run('month.close', { month: '2026-06' }, data({ closed_months: ['2026-06'] }));
    expect(r.error.code).toBe('bad_input');
    expect(errPaths(r)).toEqual(['month']);
  });

  it('refuses an auto-closed month, but closes it once it is reopened (ctx.today decides)', () => {
    const d = data({ auto_close_after_months: 1 });
    // On 2 Oct with N = 1 August is auto-closed, September is not.
    expect(run('month.close', { month: '2026-08' }, d).error.code).toBe('bad_input');
    expect(run('month.close', { month: '2026-09' }, d).ok).toBe(true);
    // A month later September is auto-closed.
    expect(run('month.close', { month: '2026-09' }, d, new Date(2026, 10, 2, 10)).error.code).toBe('bad_input');
    const reopened = data({ auto_close_after_months: 1, reopened_months: ['2026-08'] });
    const r = run('month.close', { month: '2026-08' }, reopened);
    expect(metaOf(r).closed_months).toEqual(['2026-08']);
    expect(metaOf(r).reopened_months).toEqual([]);
  });

  it('refuses a month that has not ended: the current one and later ones (ctx.today decides)', () => {
    for (const month of ['2026-10', '2026-11', '2027-01']) {
      const r = runCommand(registry, data(), 'month.close', { month }, ctx());
      expect(r.ok).toBe(false);
      expect(r.error).toEqual({ code: 'month_not_ended', params: { month } });
    }
    // The last day of October is still October; on 1 Nov it has ended.
    expect(runCommand(registry, data(), 'month.close', { month: '2026-10' }, ctx(new Date(2026, 9, 31, 23, 59))).error.code).toBe('month_not_ended');
    expect(run('month.close', { month: '2026-10' }, data(), new Date(2026, 10, 1, 0, 5)).ok).toBe(true);
  });

  it('refuses a month that is not YYYY-MM', () => {
    for (const month of ['2026-13', '2026-8', 'August', '']) {
      const r = runCommand(registry, data(), 'month.close', { month }, ctx());
      expect(r.error.code).toBe('bad_input');
      expect(errPaths(r)).toEqual(['month']);
    }
  });
});

describe('month.reopen', () => {
  it('drops a manual close', () => {
    const d = data({ closed_months: ['2026-06', '2026-07'] });
    const r = run('month.reopen', { month: '2026-06' }, d);
    expect(metaOf(r)).toEqual(reopenMonthPatch(d.meta, '2026-06', OCT_2));
    expect(metaOf(r).closed_months).toEqual(['2026-07']);
    expect(Object.hasOwn(metaOf(r), 'reopened_months')).toBe(false);
  });

  it('reopens an auto-closed month with an exception, sorted, using ctx.today', () => {
    const d = data({ auto_close_after_months: 1, reopened_months: ['2026-08'] });
    const r = run('month.reopen', { month: '2026-07' }, d);
    expect(metaOf(r).reopened_months).toEqual(['2026-07', '2026-08']);
    expect(metaOf(r)).toEqual(reopenMonthPatch(d.meta, '2026-07', OCT_2));
    // The same month is open on 2 Aug (cutoff 2026-07), so the command refuses it.
    const early = run('month.reopen', { month: '2026-07' }, data({ auto_close_after_months: 1 }), new Date(2026, 7, 2, 10));
    expect(early.error.code).toBe('bad_input');
  });

  it('a manual close of an auto-closed month: the close goes and the exception comes', () => {
    const d = data({ auto_close_after_months: 1, closed_months: ['2026-07'] });
    const r = run('month.reopen', { month: '2026-07' }, d);
    expect(metaOf(r).closed_months).toEqual([]);
    expect(metaOf(r).reopened_months).toEqual(['2026-07']);
  });

  it('refuses a month that is not closed', () => {
    const r = run('month.reopen', { month: '2026-09' }, data({ auto_close_after_months: 1 }));
    expect(r.error.code).toBe('bad_input');
    expect(errPaths(r)).toEqual(['month']);
    expect(run('month.reopen', { month: '2026-06' }, data()).error.code).toBe('bad_input');
    expect(run('month.reopen', { month: '2026-08' }, data({ auto_close_after_months: 1, reopened_months: ['2026-08'] })).error.code).toBe('bad_input');
  });
});

describe('month.clearReopen', () => {
  it('removes the exception without closing the month, as dropReopenPatch does', () => {
    const d = data({ auto_close_after_months: 1, reopened_months: ['2026-07', '2026-08'] });
    const r = run('month.clearReopen', { month: '2026-07' }, d);
    expect(metaOf(r)).toEqual(dropReopenPatch(d.meta, '2026-07'));
    expect(metaOf(r).reopened_months).toEqual(['2026-08']);
    expect(Object.hasOwn(metaOf(r), 'closed_months')).toBe(false);
  });

  it('deletes the key when the last exception goes', () => {
    const r = run('month.clearReopen', { month: '2026-07' }, data({ auto_close_after_months: 1, reopened_months: ['2026-07'] }));
    expect(Object.hasOwn(metaOf(r), 'reopened_months')).toBe(false);
  });

  it('refuses a month with no exception', () => {
    const r = run('month.clearReopen', { month: '2026-07' }, data({ reopened_months: ['2026-08'] }));
    expect(r.error.code).toBe('bad_input');
    expect(errPaths(r)).toEqual(['month']);
    expect(run('month.clearReopen', { month: '2026-07' }, data()).error.code).toBe('bad_input');
  });
});

describe('through a browser session: meta-primary', () => {
  function setup(meta) {
    const state = { budgetFolder: { name: 'A' }, meta, accounts: [], envelopes: [{ id: 'efund', name: 'Emergency' }], budgetItems: [], envelopeTemplates: [], transactions: [] };
    const writes = [];
    const saveMeta = vi.fn(async () => {});
    const queue = createMetaQueue((folder, m) => saveMeta(folder, m));
    const runMetaExclusive = vi.fn(queue.runExclusive);
    const updateMeta = vi.fn(queue.update);
    let n = 0;
    const session = createBrowserSession({
      state, registry, updateMeta, runMetaExclusive,
      writeBatch: async (ref, items) => { writes.push(items); },
      currentGeneration: () => 1,
      notify: vi.fn(),
      clock: () => OCT_2,
      newId: () => `id${++n}`,
      isVersionConflict: () => false,
    });
    return { state, session, writes, saveMeta, runMetaExclusive, updateMeta };
  }
  const metaWritten = (writes) => writes[0].find(i => i.filename === 'budget-meta.json').data;

  it.each([
    ['settings.update', { fields: { emergency_envelope_id: 'efund', emergency_duration_months: 9 } }, {}],
    ['month.close', { month: '2026-08' }, {}],
    ['month.reopen', { month: '2026-07' }, { auto_close_after_months: 1 }],
    ['month.clearReopen', { month: '2026-07' }, { auto_close_after_months: 1, reopened_months: ['2026-07'] }],
  ])('%s commits meta in one writeBatch, inside the meta queue', async (name, input, meta) => {
    const ctl = setup({ schemaVersion: 8, country: 'FI', ...meta });
    const r = await ctl.session.dispatch(name, input);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ committed: true, published: true });
    expect(ctl.runMetaExclusive).toHaveBeenCalledTimes(1);
    expect(ctl.updateMeta).not.toHaveBeenCalled();
    expect(ctl.saveMeta).not.toHaveBeenCalled();
    expect(ctl.writes).toHaveLength(1);
    expect(ctl.state.meta).toEqual(metaWritten(ctl.writes));
    expect(ctl.state.meta.change_log).toBeUndefined();
  });

  it('close then Undo restores the meta', async () => {
    const ctl = setup({ schemaVersion: 8, country: 'FI' });
    const r = await ctl.session.dispatch('month.close', { month: '2026-08' });
    expect(ctl.state.meta.closed_months).toEqual(['2026-08']);
    const undone = await ctl.session.undo(r.value.undo);
    expect(undone.ok).toBe(true);
    // Nothing moved, so the inverse is stored exactly: there was no closed_months key.
    expect('closed_months' in ctl.state.meta).toBe(false);
  });

  it('a refused command writes nothing', async () => {
    const ctl = setup({ schemaVersion: 8, country: 'FI' });
    const r = await ctl.session.dispatch('settings.update', { fields: { emergency_duration_months: 0 } });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('bad_input');
    expect(ctl.writes).toHaveLength(0);
    expect(ctl.runMetaExclusive).not.toHaveBeenCalled();
  });
});
