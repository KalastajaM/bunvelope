// @vitest-environment jsdom
// Templates page, editors: the dynamic-template editor (percent-of-plan
// assignments, group bulk-add, live preview, refusals) and the schedule
// section both editors share (enable, months, payment day, since / until,
// funding source, and its refusals). Drives the real js/pages/templates.js
// through the real browser session (tests/_fakes/pageApp.js); what is asserted
// is the envelope-templates.json the session writes, never a snapshot.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

// jsdom has no scrollIntoView; the envelope combobox scrolls its active option.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

import { render } from '../js/pages/templates.js';
import { fmt } from '../js/utils.js';
import { t } from '../js/ui/i18n.js';
import {
  state, writeBatch, runDueScheduled, updateStatusBar, resetState, mountHosts, flush, setValue,
  sheetIsOpen, topOverlay, toastTexts,
} from './_fakes/pageApp.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const hostText = () => document.querySelector('#sheet-host').textContent;
const savedTemplates = () => writeBatch.mock.calls.at(-1)?.[1].find(i => i.filename === 'envelope-templates.json')?.data;
const rows = () => [...sheet().querySelectorAll('.split-row')];
// A schedule-section control, found by its field label.
const ctl = (label) => [...sheet().querySelectorAll('.field')]
  .find(f => f.querySelector(':scope > label')?.textContent === label)
  ?.querySelector('input, select');
const enableBox = () => sheet().querySelector('input[type="checkbox"]');
const monthCell = (mon) => sheet().querySelector(`.bp-mcell[data-mon="${mon}"]`);
const submit = async () => { sheet().querySelector('form').requestSubmit(); await flush(); };
const addAssignmentBtn = () => [...sheet().querySelectorAll('button')].find(b => b.textContent === t('templatesPage.addAssignment'));
const pick = (row, envId, pct) => {
  setValue(row.querySelector('.split-env'), envId, ['change']);
  if (pct != null) setValue(row.querySelector('.split-pct'), String(pct));
};
const enable = () => {
  enableBox().checked = true;
  enableBox().dispatchEvent(new Event('change', { bubbles: true }));
};

async function openPage() {
  mountHosts();
  await render(document.getElementById('app-root'));
}

async function newTemplate(kind) {
  document.querySelector('.page-head .btn-accent').click();
  await flush();
  const cards = [...sheet().querySelectorAll('.tpl-kind-card')];
  cards[kind === 'dynamic' ? 1 : 0].click();
  await flush();
}

const editCard = async (name) => {
  const card = [...document.querySelectorAll('.tpl-card')].find(c => c.querySelector('.tpl-name').textContent === name);
  card.querySelectorAll('.tpl-actions button')[0].click();
  await flush();
};

let dyn;

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState();
  // Monthly plan: Food 100, Rent 800, Fun 20 (each every month).
  const item = (id, envelope_id, amt) => ({
    id, kind: 'expense', envelope_id, description: id, default_amount: -amt, extra_buffer: 0,
    include: true, monthly_schedule: every(), as_schedule: false,
  });
  state.budgetItems = [item('groc', 'food', 100), item('rent', 'rent', 800), item('fun', 'fun', 20)];
  dyn = {
    id: 'plan-share', name: 'Plan share', description: 'Half of plan', kind: 'dynamic',
    assignments: [
      { envelope_id: 'food', mode: 'add', percent: 50 },
      { envelope_id: 'rent', mode: 'set', percent: 100 },
    ],
  };
  state.envelopeTemplates = [dyn];
  runDueScheduled.mockReset();
  runDueScheduled.mockImplementation(async () => {});
  updateStatusBar.mockClear();
  await openPage();
});

describe('dynamic template editor: creating', () => {
  it('a new dynamic template is saved with a slug id and its percent assignments', async () => {
    await newTemplate('dynamic');
    expect(sheet().textContent).toContain(t('templatesPage.newDynamicTitle'));
    setValue(sheet().querySelector('input[type="text"]'), 'Half Plan');
    pick(rows()[0], 'food', 50);
    await submit();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(savedTemplates().map(x => x.id)).toEqual(['plan-share', 'half-plan']);
    expect(savedTemplates()[1]).toEqual({
      id: 'half-plan', name: 'Half Plan', description: null, kind: 'dynamic',
      assignments: [{ envelope_id: 'food', mode: 'add', percent: 50 }],
    });
    // No schedule was asked for, so the template is not self-scheduled.
    expect(savedTemplates()[1].schedule).toBeUndefined();
    expect(runDueScheduled).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toContain(t('templatesPage.saved'));
  });

  it('a second row takes its own mode, and a name whose slug is taken gets a different id', async () => {
    await newTemplate('dynamic');
    // Names are unique, but "Plan share!" slugs to the existing "plan-share".
    setValue(sheet().querySelector('input[type="text"]'), 'Plan share!');
    pick(rows()[0], 'food', 25);
    addAssignmentBtn().click();
    expect(rows()).toHaveLength(2);
    pick(rows()[1], 'fun', 200);
    setValue(rows()[1].querySelector('.line-mode'), 'set', ['change']);
    await submit();

    expect(savedTemplates()).toHaveLength(2);
    const saved = savedTemplates().at(-1);
    expect(saved.id).toBe('plan-share-2');
    expect(saved.assignments).toEqual([
      { envelope_id: 'food', mode: 'add', percent: 25 },
      { envelope_id: 'fun', mode: 'set', percent: 200 },
    ]);
  });

  it('the preview shows each row and the total as a share of the monthly plan', async () => {
    await newTemplate('dynamic');
    pick(rows()[0], 'food', 50);
    expect(rows()[0].querySelector('.split-preview').textContent).toBe(`= ${fmt(50)} / mo`);
    addAssignmentBtn().click();
    pick(rows()[1], 'rent', 25);
    expect(rows()[1].querySelector('.split-preview').textContent).toBe(`= ${fmt(200)} / mo`);
    expect(sheet().textContent).toContain(t('templatesPage.monthlyTotal')(fmt(250)));
  });

  it('a group bulk-add adds each envelope of that category once, replacing the blank row', async () => {
    await newTemplate('dynamic');
    const bulk = sheet().querySelector('.bulk-add-group');
    setValue(bulk, 'cat:living', ['change']);
    expect(rows().map(r => r.querySelector('.split-env').value)).toEqual(['food', 'fun']);
    expect(rows().every(r => r.querySelector('.split-pct').value === '100')).toBe(true);
    // "All envelopes" then only adds what is not already on the list.
    setValue(bulk, '__all__', ['change']);
    expect(rows().map(r => r.querySelector('.split-env').value)).toEqual(['food', 'fun', 'rent']);
    setValue(sheet().querySelector('input[type="text"]'), 'Everything');
    await submit();
    expect(savedTemplates().at(-1).assignments.map(a => a.envelope_id)).toEqual(['food', 'fun', 'rent']);
  });

  it('a picked envelope is disabled in the other rows so it cannot be chosen twice', async () => {
    await newTemplate('dynamic');
    pick(rows()[0], 'food');
    addAssignmentBtn().click();
    const opt = (row, id) => [...row.querySelector('.split-env').options].find(o => o.value === id);
    expect(opt(rows()[1], 'food').disabled).toBe(true);
    expect(opt(rows()[0], 'food').disabled).toBe(false);
    expect(opt(rows()[1], 'fun').disabled).toBe(false);
  });

  it('each row\'s envelope picker is the searchable combobox, without the envelopes other rows took', async () => {
    await newTemplate('dynamic');
    pick(rows()[0], 'food');
    addAssignmentBtn().click();
    const combo = (row) => row.querySelector('.combo input[role="combobox"]');
    expect(combo(rows()[0])).not.toBeNull();
    expect(combo(rows()[0]).value).toBe('Food');
    const input = combo(rows()[1]);
    input.dispatchEvent(new Event('focus'));
    const listed = () => [...rows()[1].querySelectorAll('.combo-opt')].map(li => li.textContent);
    expect(listed()).not.toContain('Food');
    expect(listed()).toContain('Fun');
    input.value = 'ren';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(listed()).toEqual(['Rent']);
    rows()[1].querySelector('.combo-opt').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(rows()[1].querySelector('.split-env').value).toBe('rent');
  });

  it('removing a row drops it from what is saved; a lone row cannot be removed', async () => {
    await newTemplate('dynamic');
    expect(rows()[0].querySelector('.line-rm').style.visibility).toBe('hidden');
    pick(rows()[0], 'food', 10);
    addAssignmentBtn().click();
    pick(rows()[1], 'fun', 20);
    expect(rows()[0].querySelector('.line-rm').style.visibility).toBe('visible');
    rows()[0].querySelector('.line-rm').click();
    setValue(sheet().querySelector('input[type="text"]'), 'Just fun');
    await submit();
    expect(savedTemplates().at(-1).assignments).toEqual([{ envelope_id: 'fun', mode: 'add', percent: 20 }]);
  });
});

describe('dynamic template editor: editing and refusals', () => {
  it('editing keeps the id and saves the changed percent and name', async () => {
    await editCard('Plan share');
    expect(sheet().textContent).toContain(t('templatesPage.editDynamicTitle'));
    expect(rows().map(r => r.querySelector('.split-env').value)).toEqual(['food', 'rent']);
    expect(rows()[1].querySelector('.line-mode').value).toBe('set');
    setValue(rows()[0].querySelector('.split-pct'), '75');
    setValue(sheet().querySelector('input[type="text"]'), ' Plan share v2 ');
    await submit();

    expect(savedTemplates()).toHaveLength(1);
    expect(savedTemplates()[0]).toEqual({
      id: 'plan-share', name: 'Plan share v2', description: 'Half of plan', kind: 'dynamic',
      assignments: [
        { envelope_id: 'food', mode: 'add', percent: 75 },
        { envelope_id: 'rent', mode: 'set', percent: 100 },
      ],
    });
  });

  it('rows with a zero percent are dropped; none left is refused', async () => {
    await editCard('Plan share');
    setValue(rows()[0].querySelector('.split-pct'), '0');
    setValue(rows()[1].querySelector('.split-pct'), '0');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.needAssignment'));
    expect(state.envelopeTemplates).toEqual([dyn]);
  });

  it('the same envelope twice is refused', async () => {
    await editCard('Plan share');
    // The picker disables taken envelopes, so force the value a stale row could hold.
    rows()[1].querySelector('.split-env').value = 'food';
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.envelopeOnceDynamic'));
  });

  it('an empty name is refused', async () => {
    await editCard('Plan share');
    setValue(sheet().querySelector('input[type="text"]'), '   ');
    // requestSubmit would stop at the native `required` check; dispatch the submit itself.
    sheet().querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.nameRequired'));
  });

  it('renaming to another template\'s name is shown on the name field, and nothing is written', async () => {
    state.envelopeTemplates = [dyn, { id: 'other', name: 'Other', kind: 'manual', lines: [{ envelope_id: 'fun', mode: 'add', amount: 5 }] }];
    await openPage();
    await editCard('Plan share');
    const nameIn = sheet().querySelector('input[type="text"]');
    setValue(nameIn, 'other');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(nameIn.closest('.field').querySelector('.field-hint').textContent).toBe(t('templatesPage.nameTaken')('other'));
    expect(sheetIsOpen()).toBe(true);
  });

  it('a failed save leaves the list as it was, reports the error and keeps the sheet open', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    await editCard('Plan share');
    setValue(rows()[0].querySelector('.split-pct'), '10');
    await submit();
    expect(state.envelopeTemplates).toEqual([dyn]);
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(sheetIsOpen()).toBe(true);
    expect(toastTexts()).not.toContain(t('templatesPage.saved'));
  });
});

describe('schedule section', () => {
  async function newManual() {
    await newTemplate('manual');
    setValue(sheet().querySelector('input[type="text"]'), 'Monthly');
    const row = sheet().querySelector('.split-row');
    setValue(row.querySelector('.split-env'), 'fun', ['change']);
    setValue(row.querySelector('.split-amt'), '25');
  }

  it('is off by default: the options are hidden and no schedule is saved', async () => {
    await newManual();
    expect(enableBox().checked).toBe(false);
    expect(enableBox().closest('.field').lastElementChild.style.display).toBe('none');
    await submit();
    expect(savedTemplates().at(-1).schedule).toBeUndefined();
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('enabled with the defaults: every month, day 1, exact, since today', async () => {
    await newManual();
    enable();
    expect(enableBox().closest('.field').lastElementChild.style.display).toBe('flex');
    await submit();

    // FIXED_NOW is 15 Sep 2026: starting today backfills nothing this month.
    expect(savedTemplates().at(-1).schedule).toEqual({
      enabled: true, payment_day: 1, day_type: 'exact', months: every(), since: '2026-09-15',
    });
    // A newly scheduled template can already be due: materialise now and refresh the bars.
    expect(runDueScheduled).toHaveBeenCalledTimes(1);
    expect(updateStatusBar).toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
    // Nothing posted: the plain saved toast.
    expect(toastTexts()).toContain(t('templatesPage.saved'));
  });

  it('says how many fills the save posted', async () => {
    runDueScheduled.mockResolvedValueOnce({ emitted: 3, posted: 3 });
    await newManual();
    enable();
    setValue(ctl(t('templatesPage.scheduleSince')), '2026-07-01');
    await submit();
    expect(savedTemplates().at(-1).schedule.since).toBe('2026-07-01');
    expect(toastTexts()).toContain(t('templatesPage.savedPosted')(3));
    expect(t('templatesPage.savedPosted')(3)).toBe('Template saved · 3 fills posted');
    expect(t('templatesPage.savedPosted')(1)).toBe('Template saved · 1 fill posted');
    expect(toastTexts()).not.toContain(t('templatesPage.saved'));
  });

  it('writes the chosen months, payment day, day type, bounds and funding source', async () => {
    await newManual();
    enable();
    for (const mon of MONTHS) if (mon !== 'Mar' && mon !== 'Sep') monthCell(mon).click();
    setValue(ctl(t('templatesPage.schedulePayDay')), '15');
    setValue(ctl(t('templatesPage.scheduleDayType')), 'next_work_day', ['change']);
    setValue(ctl(t('templatesPage.scheduleSince')), '2026-03-01');
    setValue(ctl(t('templatesPage.scheduleUntil')), '2027-03-01');
    setValue(ctl(t('templatesPage.scheduleSource')), 'rent', ['change']);
    setValue(ctl(t('templatesPage.scheduleSourceSince')), '2026-04-01');
    await submit();

    expect(savedTemplates().at(-1).schedule).toEqual({
      enabled: true, payment_day: 15, day_type: 'next_work_day', months: { Mar: true, Sep: true },
      since: '2026-03-01', until: '2027-03-01', source_envelope_id: 'rent', source_since: '2026-04-01',
    });
  });

  it('the source-since field only shows once a source is chosen, and is not saved without one', async () => {
    await newManual();
    enable();
    const sinceField = ctl(t('templatesPage.scheduleSourceSince')).closest('.field');
    expect(sinceField.style.display).toBe('none');
    setValue(ctl(t('templatesPage.scheduleSource')), 'rent', ['change']);
    expect(sinceField.style.display).toBe('');
    setValue(ctl(t('templatesPage.scheduleSourceSince')), '2026-04-01');
    setValue(ctl(t('templatesPage.scheduleSource')), '', ['change']);
    await submit();
    expect(savedTemplates().at(-1).schedule.source_envelope_id).toBeUndefined();
    expect(savedTemplates().at(-1).schedule.source_since).toBeUndefined();
  });

  it('a payment day above 31 is clamped to 31 (the input\'s max stops it in a browser; this is the backstop)', async () => {
    await newManual();
    enable();
    setValue(ctl(t('templatesPage.schedulePayDay')), '45');
    sheet().querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(savedTemplates().at(-1).schedule.payment_day).toBe(31);
  });

  it('every month switched off is refused', async () => {
    await newManual();
    enable();
    for (const mon of MONTHS) monthCell(mon).click();
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.scheduleNeedMonth'));
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('an end date before the start date is refused', async () => {
    await newManual();
    enable();
    setValue(ctl(t('templatesPage.scheduleSince')), '2026-06-01');
    setValue(ctl(t('templatesPage.scheduleUntil')), '2026-05-31');
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.scheduleUntilBeforeSince'));
  });

  it('a funding source that is also a target line is refused, for manual and dynamic templates', async () => {
    await newManual();
    enable();
    setValue(ctl(t('templatesPage.scheduleSource')), 'fun', ['change']);
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.scheduleSourceIsTarget'));

    await openPage();
    await editCard('Plan share');
    enable();
    setValue(ctl(t('templatesPage.scheduleSource')), 'food', ['change']);
    await submit();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(hostText()).toContain(t('templatesPage.scheduleSourceIsTarget'));
  });

  it('a dynamic template can be scheduled, funded from an envelope it does not target', async () => {
    await editCard('Plan share');
    enable();
    setValue(ctl(t('templatesPage.scheduleSource')), 'fun', ['change']);
    await submit();
    expect(savedTemplates()[0].kind).toBe('dynamic');
    expect(savedTemplates()[0].schedule).toMatchObject({ enabled: true, source_envelope_id: 'fun', months: every() });
    expect(runDueScheduled).toHaveBeenCalledTimes(1);
  });

  it('unchecking an existing schedule pauses it: the configuration is kept, enabled is false', async () => {
    const sched = {
      enabled: true, payment_day: 25, day_type: 'prev_work_day', months: { Jan: true, Jul: true },
      since: '2026-01-01', until: '2027-12-31', source_envelope_id: 'fun', skipped: ['2026-09'],
    };
    state.envelopeTemplates = [{ ...dyn, schedule: sched }];
    await openPage();
    await editCard('Plan share');
    // The form shows what was saved.
    expect(enableBox().checked).toBe(true);
    expect(ctl(t('templatesPage.schedulePayDay')).value).toBe('25');
    expect(ctl(t('templatesPage.scheduleDayType')).value).toBe('prev_work_day');
    expect(ctl(t('templatesPage.scheduleUntil')).value).toBe('2027-12-31');
    expect(ctl(t('templatesPage.scheduleSource')).value).toBe('fun');
    expect(monthCell('Jan').classList.contains('active')).toBe(true);
    expect(monthCell('Feb').classList.contains('active')).toBe(false);

    enableBox().checked = false;
    enableBox().dispatchEvent(new Event('change', { bubbles: true }));
    await submit();
    expect(savedTemplates()[0].schedule).toEqual({ ...sched, enabled: false });
    expect(runDueScheduled).not.toHaveBeenCalled();
  });

  it('editing an enabled schedule keeps the months already skipped and drops malformed keys', async () => {
    const sched = { enabled: true, payment_day: 5, day_type: 'exact', months: every(), since: '2026-01-01', skipped: ['2026-09', 'junk'] };
    state.envelopeTemplates = [{ ...dyn, schedule: sched }];
    await openPage();
    await editCard('Plan share');
    setValue(ctl(t('templatesPage.schedulePayDay')), '6');
    await submit();
    expect(savedTemplates()[0].schedule).toEqual({ ...sched, payment_day: 6, skipped: ['2026-09'] });
  });

  it('an archived source stays listed (tagged) so the setting is visible, and survives a save', async () => {
    state.envelopes.push({ id: 'old', name: 'Old pot', category: 'living', archived: true });
    state.envelopeTemplates = [{
      ...dyn, schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every(), since: '2026-01-01', source_envelope_id: 'old' },
    }];
    await openPage();
    await editCard('Plan share');
    const src = ctl(t('templatesPage.scheduleSource'));
    expect(src.value).toBe('old');
    expect([...src.options].find(o => o.value === 'old').textContent).toContain(t('templatesPage.scheduleSourceArchivedTag'));
    // An unchanged save writes nothing, so change something else.
    setValue(ctl(t('templatesPage.schedulePayDay')), '2');
    await submit();
    expect(savedTemplates()[0].schedule.source_envelope_id).toBe('old');
  });

  it('a failure while materialising the due fill does not lose the save', async () => {
    runDueScheduled.mockRejectedValueOnce(new Error('boom'));
    await editCard('Plan share');
    enable();
    await submit();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toContain(t('templatesPage.saved'));
  });
});

describe('dynamic template assignment groups', () => {
  it('groups scattered assignments while preserving their execution order on save', async () => {
    state.envelopes.find(e => e.id === 'food').category = 'Daily';
    state.envelopes.find(e => e.id === 'rent').category = 'Home';
    state.envelopes.find(e => e.id === 'fun').category = 'Daily';
    dyn.assignments.push({ envelope_id: 'fun', mode: 'add', percent: 75 });
    await editCard('Plan share');
    const groups = [...sheet().querySelectorAll('.tpl-assignment-group')];
    expect(groups.map(g => g.querySelector('h3').textContent)).toEqual(['Daily', 'Home']);
    expect([...groups[0].querySelectorAll('.split-env')].map(s => s.value)).toEqual(['food', 'fun']);
    expect([...groups[1].querySelectorAll('.split-env')].map(s => s.value)).toEqual(['rent']);
    setValue(sheet().querySelector('input[type="text"]'), 'Grouped plan');
    await submit();
    expect(savedTemplates()[0].assignments).toEqual(dyn.assignments);
  });

  it('moves an assignment to its new group and removes empty groups', async () => {
    state.envelopes.find(e => e.id === 'food').category = 'Daily';
    state.envelopes.find(e => e.id === 'rent').category = 'Home';
    state.envelopes.find(e => e.id === 'fun').category = 'Daily';
    await editCard('Plan share');
    const rentRow = rows().find(r => r.querySelector('.split-env').value === 'rent');
    pick(rentRow, 'fun', 60);
    expect([...sheet().querySelectorAll('.tpl-assignment-group-title')].map(h => h.textContent)).toEqual(['Daily']);
    expect(rows()).toHaveLength(2);
    rentRow.querySelector('.line-rm').click();
    await submit();
    expect(savedTemplates()[0].assignments).toEqual([{ envelope_id: 'food', mode: 'add', percent: 50 }]);
  });
});

 it('supports keyboard reordering within a dynamic assignment group', async () => {
    state.envelopes.forEach(e => { e.category = 'Daily'; });
    await editCard('Plan share');
    rows()[1].querySelector('.drag-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(rows().map(r => r.querySelector('.split-env').value)).toEqual(['rent', 'food']);
    await submit();
    expect(savedTemplates()[0].assignments.map(a => a.envelope_id)).toEqual(['rent', 'food']);
  });
