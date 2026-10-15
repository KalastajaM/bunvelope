// @vitest-environment jsdom
// Envelope editor: what create / edit / archive / delete hand to the envelope
// commands (through the real browser session; the storage boundary, writeBatch,
// is the fake that records what would be written), including the goal fields,
// the archive warning for future rows (a confirm that must be accepted before
// anything is written) and the delete rules. Drives the real
// js/pages/envelope-edit.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openEnvelopeEdit } from '../js/pages/envelope-edit.js';
import { t, setLang, loadLocale } from '../js/ui/i18n.js';
import { setFormatDefaults, getLocale } from '../js/utils.js';
import {
  state, navigate, updateStatusBar, writeBatch, session, resetState, mountHosts, flush, setValue,
  sheetIsOpen, topOverlay, dialogOk, dialogButton, toastTexts,
} from './_fakes/pageApp.js';

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const nameIn = () => sheet().querySelector('input[name="name"]');
const catIn = () => sheet().querySelector('input[name="category"]');
const descIn = () => sheet().querySelector('textarea[name="description"]');
const goalAmtIn = () => sheet().querySelector('input[inputmode="decimal"]');
const goalDateIn = () => sheet().querySelector('input[type="date"]');
const rolloverSel = () => [...sheet().querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'zero-monthly'));
const exemptIn = () => sheet().querySelector('input[type="checkbox"]');
const sheetBtn = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const submit = async () => { sheet().querySelector('form').requestSubmit(); await flush(); };
const saved = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'envelopes.json')?.data;
const savedEnv = (id) => saved().find(e => e.id === id);
const toastButton = () => document.querySelector('#toast-host .toast-action');

let spare;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState({
    transactions: [
      { id: 'x1', type: 'expense', date: '2026-09-02', payee: 'Grocer', amount: 50, envelope_id: 'food', account: 'chk', status: 'posted' },
    ],
  });
  // An envelope nothing refers to, so it can be deleted.
  spare = { id: 'spare', name: 'Spare', category: 'misc', description: '' };
  state.envelopes = [...state.envelopes, spare];
  mountHosts();
});

describe('create an envelope', () => {
  beforeEach(() => openEnvelopeEdit(null));

  it('marks Name required and keeps an empty or whitespace submission in the editor', async () => {
    expect(nameIn().getAttribute('aria-required')).toBe('true');
    expect(nameIn().closest('.field').querySelector('.required-marker')).not.toBeNull();
    setValue(nameIn(), '   ');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nameIn());
    expect(nameIn().getAttribute('aria-invalid')).toBe('true');
    expect(nameIn().closest('.field').querySelector('.field-hint').textContent).toBe(t('common.fieldRequired'));
    setValue(nameIn(), 'A new name');
    expect(nameIn().getAttribute('aria-invalid')).toBe('false');
    await submit();
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it('writes a category-prefixed slug id and the explicit spend-flag, with no goal or rollover', async () => {
    setValue(nameIn(), 'Holiday Fund');
    setValue(catIn(), 'Savings');
    setValue(descIn(), 'Summer trip');
    await submit();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(saved().map(e => e.id)).toEqual(['food', 'fun', 'rent', 'spare', 'savings-holiday-fund']);
    expect(savedEnv('savings-holiday-fund')).toEqual({
      id: 'savings-holiday-fund', code: 'SA01', name: 'Holiday Fund', category: 'Savings', description: 'Summer trip',
      archived: false, spend_flag_exempt: false,
    });
    expect(state.envelopes).toBe(saved());
    expect(navigate).toHaveBeenCalledWith('envelopes');
    expect(sheetIsOpen()).toBe(false);
  });

  it('an empty name writes nothing', async () => {
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('a name whose slug collides with another envelope\'s id gets a distinct id', async () => {
    setValue(nameIn(), 'Food!');
    await submit();
    const ids = saved().map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });

  it('stores a goal amount, its date, and stamps goal_start with today', async () => {
    setValue(nameIn(), 'Bike');
    setValue(goalAmtIn(), '600.456');
    setValue(goalDateIn(), '2027-03-01');
    await submit();
    expect(savedEnv('bike')).toMatchObject({ goal_amount: 600.46, goal_date: '2027-03-01', goal_start: '2026-09-15' });
  });

  it('a goal amount without a date has no goal_start', async () => {
    setValue(nameIn(), 'Bike');
    setValue(goalAmtIn(), '600');
    await submit();
    expect(savedEnv('bike').goal_amount).toBe(600);
    expect(savedEnv('bike')).not.toHaveProperty('goal_date');
    expect(savedEnv('bike')).not.toHaveProperty('goal_start');
  });

  it('a typed but unreadable goal is refused, not silently dropped', async () => {
    setValue(nameIn(), 'Bike');
    setValue(goalAmtIn(), 'lots');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('a non-default rollover is stored; carry is left implicit', async () => {
    setValue(nameIn(), 'Coffee');
    setValue(rolloverSel(), 'zero-monthly', ['change']);
    await submit();
    expect(savedEnv('coffee').rollover).toBe('zero-monthly');

    writeBatch.mockClear();
    mountHosts();
    openEnvelopeEdit(null);
    setValue(nameIn(), 'Tea');
    await submit();
    expect(savedEnv('tea')).not.toHaveProperty('rollover');
  });

  it('the spend-flag exemption checkbox is written as chosen', async () => {
    setValue(nameIn(), 'Refunds');
    exemptIn().checked = true;
    await submit();
    expect(savedEnv('refunds').spend_flag_exempt).toBe(true);
  });

  it('a failed write reports it, leaves the list alone and keeps the sheet open', async () => {
    const before = state.envelopes;
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    setValue(nameIn(), 'Doomed');
    await submit();
    expect(state.envelopes).toBe(before);
    expect(navigate).not.toHaveBeenCalled();
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(sheetIsOpen()).toBe(true);
  });
});

describe('edit an envelope', () => {
  it('a save whose meta write failed still closes, and says the change log was not saved', async () => {
    const real = session.dispatch;
    const spy = vi.spyOn(session, 'dispatch').mockImplementationOnce(async (...args) => {
      const r = await real(...args);
      return { ...r, value: { ...r.value, metaFailed: { message: 'meta down' } } };
    });
    openEnvelopeEdit(state.envelopes.find(e => e.id === 'spare'));
    setValue(nameIn(), 'Extra');
    await submit();
    expect(savedEnv('spare').name).toBe('Extra');
    expect(toastTexts()).toContain(t('common.metaSaveFailed')('meta down'));
    expect(sheetIsOpen()).toBe(false);
    spy.mockRestore();
  });

  it('rewrites the envelope in place; other envelopes are the same objects', async () => {
    openEnvelopeEdit(spare);
    setValue(nameIn(), 'Spare change');
    setValue(catIn(), 'fun');
    await submit();
    expect(saved().map(e => e.id)).toEqual(['food', 'fun', 'rent', 'spare']);
    expect(savedEnv('spare')).toMatchObject({ name: 'Spare change', category: 'fun' });
    expect(saved()[0]).toBe(state.envelopes[0]);
  });

  it('keeps the original goal_start when the goal is edited later', async () => {
    const goal = { id: 'goal', name: 'Goal', category: 'x', goal_amount: 100, goal_date: '2027-01-01', goal_start: '2026-01-10' };
    state.envelopes = [...state.envelopes, goal];
    openEnvelopeEdit(goal);
    setValue(goalAmtIn(), '200');
    await submit();
    expect(savedEnv('goal')).toMatchObject({ goal_amount: 200, goal_date: '2027-01-01', goal_start: '2026-01-10' });
  });

  it('clearing the amount drops the goal and its start, keeping the date typed', async () => {
    const goal = { id: 'goal', name: 'Goal', category: 'x', goal_amount: 100, goal_date: '2027-01-01', goal_start: '2026-01-10' };
    state.envelopes = [...state.envelopes, goal];
    openEnvelopeEdit(goal);
    setValue(goalAmtIn(), '');
    await submit();
    const out = savedEnv('goal');
    expect(out).not.toHaveProperty('goal_amount');
    // goal_start only exists alongside an amount and a date.
    expect(out).not.toHaveProperty('goal_start');
    expect(out.goal_date).toBe('2027-01-01');
  });

  it('back to carry drops a stored rollover', async () => {
    const r = { id: 'r', name: 'R', category: 'x', rollover: 'zero-monthly' };
    state.envelopes = [...state.envelopes, r];
    openEnvelopeEdit(r);
    setValue(rolloverSel(), 'carry', ['change']);
    await submit();
    expect(savedEnv('r')).not.toHaveProperty('rollover');
  });
});

describe('archive an envelope', () => {
  const archiveBtn = () => sheetBtn(t('envelopes.archive'));

  it('with no future rows: archives straight away and Undo reverses it', async () => {
    const before = state.envelopes;
    openEnvelopeEdit(spare);
    archiveBtn().click();
    await flush();
    expect(savedEnv('spare').archived).toBe(true);
    expect(state.envelopes).toBe(saved());
    expect(navigate).toHaveBeenCalledWith('envelopes');
    expect(toastTexts()).toContain(t('common.archivedToast')('Spare'));

    toastButton().click();
    await flush();
    expect(saved()).toStrictEqual(before);
    expect(state.envelopes).toStrictEqual(before);
  });

  it('future-dated rows into it: confirm first; cancel writes nothing', async () => {
    state.transactions = [
      ...state.transactions,
      { id: 'f1', type: 'expense', date: '2026-10-05', payee: 'Later', amount: 9, envelope_id: 'spare', account: 'chk', status: 'posted' },
    ];
    openEnvelopeEdit(spare);
    archiveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('common.futureRowsArchiveWarning')(1));
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(state.envelopes.find(e => e.id === 'spare').archived).toBeUndefined();
  });

  it('future-dated rows into it: accepting archives', async () => {
    state.transactions = [
      ...state.transactions,
      { id: 'f1', type: 'expense', date: '2026-10-05', payee: 'Later', amount: 9, envelope_id: 'spare', account: 'chk', status: 'posted' },
    ];
    openEnvelopeEdit(spare);
    archiveBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(savedEnv('spare').archived).toBe(true);
  });

  it('a scheduled row (any date) counts as a future row', async () => {
    state.transactions = [
      ...state.transactions,
      { id: 's1', type: 'expense', date: '2026-09-01', payee: 'Sched', amount: 9, envelope_id: 'spare', account: 'chk', status: 'scheduled' },
    ];
    openEnvelopeEdit(spare);
    archiveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('common.futureRowsArchiveWarning')(1));
  });

  it('rows dated today or earlier do not warn', async () => {
    state.transactions = [
      ...state.transactions,
      { id: 'p1', type: 'expense', date: '2026-09-15', payee: 'Today', amount: 9, envelope_id: 'spare', account: 'chk', status: 'posted' },
    ];
    openEnvelopeEdit(spare);
    archiveBtn().click();
    await flush();
    expect(savedEnv('spare').archived).toBe(true);
  });

  it('unarchiving never asks', async () => {
    const archived = { ...spare, archived: true };
    state.envelopes = state.envelopes.map(e => (e.id === 'spare' ? archived : e));
    state.transactions = [
      ...state.transactions,
      { id: 'f1', type: 'expense', date: '2026-10-05', payee: 'Later', amount: 9, envelope_id: 'spare', account: 'chk', status: 'posted' },
    ];
    openEnvelopeEdit(archived);
    sheetBtn(t('envelopes.unarchive')).click();
    await flush();
    expect(savedEnv('spare').archived).toBe(false);
    expect(toastTexts()).toContain(t('common.unarchivedToast')('Spare'));
  });

  it('a failed archive write leaves the list as it was', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    const before = state.envelopes;
    openEnvelopeEdit(spare);
    archiveBtn().click();
    await flush();
    expect(state.envelopes).toBe(before);
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
  });
});

describe('delete an envelope', () => {
  const deleteBtn = () => sheetBtn(t('envelopes.delete'));
  const note = () => sheet().querySelector('[id^="env-delete-note-"]');
  // Shown but disabled, described by a note saying what uses it.
  const blocked = (what) => {
    expect(deleteBtn().disabled, what).toBe(true);
    expect(deleteBtn().getAttribute('aria-describedby')).toBe(note().id);
    expect(note().textContent).toContain(t('envelopes.deleteBlocked')('').slice(0, 20));
  };

  it('is disabled, with why, while transactions refer to it', () => {
    openEnvelopeEdit(state.envelopes.find(e => e.id === 'food'));
    blocked();
  });

  it('is disabled, with why, while a plan item refers to it', () => {
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'spare', default_amount: -10 }];
    openEnvelopeEdit(spare);
    blocked();
    expect(sheetBtn(t('envelopes.viewInBudgetPlan'))).toBeTruthy();
  });

  it('is disabled, with why, while a fill line refers to it', () => {
    state.transactions = [
      ...state.transactions,
      { id: 'fl', type: 'fill', date: '2026-09-03', status: 'posted', source: 'allocation', lines: [{ envelope_id: 'spare', amount: 10, mode: 'add' }] },
    ];
    openEnvelopeEdit(spare);
    blocked();
  });

  it('is disabled, with why, while an expense split refers to it', () => {
    state.transactions = [
      ...state.transactions,
      {
        id: 'sp', type: 'expense', date: '2026-09-03', payee: 'Shop', amount: 30, account: 'chk', status: 'posted',
        envelope_splits: [{ envelope_id: 'food', amount: 10 }, { envelope_id: 'spare', amount: 20 }],
      },
    ];
    openEnvelopeEdit(spare);
    blocked();
  });

  it('is disabled, with why, while a template names it (line, dynamic assignment or fill source)', () => {
    for (const tpl of [
      { id: 't1', name: 'Manual', kind: 'fixed', lines: [{ envelope_id: 'spare', amount: 10 }] },
      { id: 't2', name: 'Dynamic', kind: 'dynamic', assignments: [{ envelope_id: 'spare', weight: 1 }] },
      { id: 't3', name: 'Sourced', kind: 'fixed', lines: [{ envelope_id: 'food', amount: 5 }],
        schedule: { enabled: true, source_envelope_id: 'spare' } },
    ]) {
      state.envelopeTemplates = [tpl];
      openEnvelopeEdit(spare);
      blocked(tpl.name);
      document.querySelectorAll('.sheet-overlay').forEach(o => o.remove());
    }
    state.envelopeTemplates = [{ id: 't4', name: 'Other', kind: 'fixed', lines: [{ envelope_id: 'food', amount: 5 }] }];
    openEnvelopeEdit(spare);
    expect(deleteBtn().disabled).toBe(false);
    expect(note()).toBeNull();
  });

  it('the note names what uses it: transactions, plan items and template lines', async () => {
    state.budgetItems = [{ id: 'b1', kind: 'expense', envelope_id: 'food', default_amount: -10 }];
    state.envelopeTemplates = [{ id: 't1', name: 'M', kind: 'fixed', lines: [{ envelope_id: 'food', amount: 5 }] }];
    openEnvelopeEdit(state.envelopes.find(e => e.id === 'food'));
    expect(note().textContent).toBe(t('envelopes.deleteBlocked')([
      t('envelopes.refsTransactions')(1), t('envelopes.refsPlanItems')(1), t('envelopes.refsTemplateLines')(1),
    ].join(', ')));
    deleteBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('the note groups large counts with the locale\'s thousands separator (en, fi, nl)', async () => {
    const prevLocale = getLocale();
    state.transactions = Array.from({ length: 2472 }, (_, i) => (
      { id: `m${i}`, type: 'expense', date: '2026-09-02', payee: 'Grocer', amount: 1, envelope_id: 'food', account: 'chk', status: 'posted' }
    ));
    const cases = [
      ['en', 'en-US', '2,472 transactions'],
      ['fi', 'fi-FI', '2 472 tapahtumaa'],
      ['nl', 'nl-NL', '2.472 transacties'],
    ];
    try {
      for (const [lang, locale, want] of cases) {
        await loadLocale(lang);
        setLang(lang);
        setFormatDefaults({ locale });
        openEnvelopeEdit(state.envelopes.find(e => e.id === 'food'));
        expect(note().textContent, lang).toContain(want);
        document.querySelectorAll('.sheet-overlay').forEach(o => o.remove());
      }
    } finally {
      setLang('en');
      setFormatDefaults({ locale: prevLocale });
    }
  });

  it('asks first; cancelling writes nothing', async () => {
    openEnvelopeEdit(spare);
    deleteBtn().click();
    await flush();
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.envelopes).toHaveLength(4);
  });

  it('confirming writes the list without it, and Undo restores the same list', async () => {
    const before = state.envelopes;
    openEnvelopeEdit(spare);
    deleteBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(saved().map(e => e.id)).toEqual(['food', 'fun', 'rent']);
    expect(state.envelopes).toBe(saved());
    expect(navigate).toHaveBeenCalledWith('envelopes');
    expect(toastTexts()).toContain(t('envelopes.deleted'));

    toastButton().click();
    await flush();
    expect(saved()).toStrictEqual(before);
    expect(state.envelopes).toStrictEqual(before);
  });

  it('a failed delete write keeps the envelope', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('offline'); });
    openEnvelopeEdit(spare);
    deleteBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.envelopes).toHaveLength(4);
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the page hands to the commands, and the Undo contract (ruling 6).
// ---------------------------------------------------------------------------
describe('the commands the page dispatches', () => {
  const dispatched = () => vi.spyOn(session, 'dispatch').mockClear();

  it('create sends one envelope.create with the form\'s fields and no goal_start', async () => {
    const spy = dispatched();
    openEnvelopeEdit(null);
    setValue(nameIn(), 'Bike');
    setValue(goalAmtIn(), '600.456');
    setValue(goalDateIn(), '2027-03-01');
    await submit();
    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe('envelope.create');
    expect(input).toMatchObject({ name: 'Bike', goal_amount: 600.46, goal_date: '2027-03-01', rollover: 'carry', spend_flag_exempt: false });
    expect(Object.hasOwn(input, 'goal_start')).toBe(false);
    // The command stamps it, from the session's clock.
    expect(savedEnv('bike').goal_start).toBe('2026-09-15');
    expect(updateStatusBar).toHaveBeenCalled();
  });

  it('an edit sends one envelope.update by id; a cleared goal goes as null', async () => {
    const goal = { id: 'goal', name: 'Goal', category: 'x', goal_amount: 100, goal_date: '2027-01-01', goal_start: '2026-01-10' };
    state.envelopes = [...state.envelopes, goal];
    const spy = dispatched();
    openEnvelopeEdit(goal);
    setValue(goalAmtIn(), '');
    setValue(goalDateIn(), '');
    await submit();
    expect(spy).toHaveBeenCalledTimes(1);
    const [name, input] = spy.mock.calls[0];
    expect(name).toBe('envelope.update');
    expect(input.id).toBe('goal');
    expect(input.fields).toMatchObject({ name: 'Goal', goal_amount: null, goal_date: null });
    expect(Object.hasOwn(input.fields, 'goal_start')).toBe(false);
    expect(savedEnv('goal')).not.toHaveProperty('goal_start');
  });

  it('a name another envelope already has shows a hint on the name field and writes nothing', async () => {
    openEnvelopeEdit(null);
    setValue(nameIn(), 'food');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
    const field = nameIn().closest('.field');
    expect(field.querySelector('.field-hint').textContent).toBe(t('envelopes.nameTaken')('food'));
    expect(field.classList.contains('has-error')).toBe(true);
    expect(toastTexts()).toEqual([]);
  });

  it('the same clash on rename is refused; keeping the name is not', async () => {
    openEnvelopeEdit(spare);
    setValue(nameIn(), 'Fun');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(nameIn().closest('.field').classList.contains('has-error')).toBe(true);
    setValue(nameIn(), 'Spare');
    setValue(descIn(), 'changed');
    await submit();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(savedEnv('spare').description).toBe('changed');
  });

  it('a budget that already holds duplicate names can still edit another field', async () => {
    state.envelopes = [...state.envelopes, { id: 'dup', name: 'Food', category: 'x' }];
    openEnvelopeEdit(state.envelopes.find(e => e.id === 'dup'));
    setValue(descIn(), 'ok');
    await submit();
    expect(savedEnv('dup').description).toBe('ok');
  });
});

describe('Undo of archive and delete goes through the session', () => {
  it('archive Undo restores, and keeps an edit made in between', async () => {
    openEnvelopeEdit(spare);
    sheetBtn(t('envelopes.archive')).click();
    await flush();
    expect(state.envelopes.find(e => e.id === 'spare').archived).toBe(true);
    state.envelopes = [...state.envelopes, { id: 'late', name: 'Added later', category: 'x' }];

    toastButton().click();
    await flush();
    expect(saved().map(e => e.id)).toEqual(['food', 'fun', 'rent', 'spare', 'late']);
    expect(saved().find(e => e.id === 'spare')).not.toHaveProperty('archived');
    expect(toastTexts()).toContain(t('common.restored'));
  });

  it('delete Undo puts the envelope back in its place', async () => {
    openEnvelopeEdit(spare);
    sheetBtn(t('envelopes.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.envelopes.map(e => e.id)).toEqual(['food', 'fun', 'rent']);
    toastButton().click();
    await flush();
    expect(saved().map(e => e.id)).toEqual(['food', 'fun', 'rent', 'spare']);
  });

  it('Undo after a budget switch writes nothing and says so', async () => {
    openEnvelopeEdit(spare);
    sheetBtn(t('envelopes.archive')).click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);

    state.budgetFolder = { name: 'budget-B' };
    const envelopesB = [{ id: 'b-only', name: 'B envelope', category: 'x' }];
    state.envelopes = envelopesB;

    toastButton().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.envelopes).toBe(envelopesB);
    expect(toastTexts()).toContain(t('coreError.undoBudgetChanged'));
  });
});
