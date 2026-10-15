// @vitest-environment jsdom
// Templates page: what "Apply" writes (one allocation.fill; run early, the
// same commit also skips the month on the template) and what saving /
// deleting a template commits (template.create / update / delete, delete with
// Undo). Drives the real js/pages/templates.js through the real browser
// session (tests/_fakes/pageApp.js); the session's write (writeBatch) is the
// fake that records what would be written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/templates.js';
import { runInvariantCheck } from '../js/engine/insights.js';
import { fmtDateLang, t } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import {
  state, session, writeBatch, runDueScheduled, updateStatusBar, navigate, resetState, mountHosts, flush, setValue,
  sheetIsOpen, topOverlay, dialogOk, dialogButton, toastTexts,
} from './_fakes/pageApp.js';

// The topmost OPEN sheet: a closed dialog lingers in the DOM until its slide-out ends.
const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const cards = () => [...document.querySelectorAll('.tpl-card')];
const card = (name) => cards().find(c => c.querySelector('.tpl-name').textContent === name);
const actionBtn = (name, which) => card(name).querySelectorAll('.tpl-actions button')[which === 'edit' ? 0 : 1];
const acctSel = () => sheet().querySelector('select');
const applyBtn = () => sheet().querySelector('button[type="submit"]');
const sheetBtn = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const toastButton = () => document.querySelector('#toast-host .toast-action');
// What the session's last write committed, per file.
const lastBatch = () => writeBatch.mock.calls.at(-1)?.[1] ?? [];
const fileData = (name) => lastBatch().find(i => i.filename === name)?.data;
const written = () => fileData('transactions.json');
const savedTemplates = () => fileData('envelope-templates.json');

const allMonths = {
  Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true,
  Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true,
};

let manual, scheduled;

afterEach(() => vi.restoreAllMocks());

async function openPage() {
  mountHosts();
  await render(document.getElementById('app-root'));
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState({
    transactions: [
      // Food holds 300 (income credited to it); the rest hold nothing.
      { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 300, envelope_id: 'food', account: 'chk', status: 'posted' },
    ],
  });
  manual = {
    id: 'weekly', name: 'Weekly top-up', kind: 'manual',
    lines: [
      { envelope_id: 'fun', mode: 'add', amount: 40 },
      { envelope_id: 'food', mode: 'set', amount: 350 },
    ],
  };
  scheduled = {
    id: 'payday', name: 'Payday split', kind: 'manual',
    lines: [{ envelope_id: 'fun', mode: 'add', amount: 60 }, { envelope_id: 'rent', mode: 'add', amount: 500 }],
    schedule: { enabled: true, payment_day: 25, day_type: 'exact', since: '2026-01-01', months: allMonths },
  };
  state.envelopeTemplates = [manual];
  runDueScheduled.mockClear();
  await openPage();
});

describe('apply a template', () => {
  it('previews real Set deltas without writing and refreshes when budget data changes', async () => {
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain('Food: ' + fmt(300) + ' → ' + fmt(350));
    expect(sheet().textContent).toContain(fmt(50, { signed:true }));
    state.transactions = [...state.transactions, { id:'later', type:'income', date:'2026-09-15', amount:20, envelope_id:'food', account:'chk', status:'posted' }];
    applyBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain('Food: ' + fmt(320) + ' → ' + fmt(350));
    applyBtn().click();
    await flush();
    expect(written().at(-1).lines.find(l => l.envelope_id === 'food').amount).toBe(30);
  });

  it('disables confirmation while recalculating an edited date', async () => {
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    setValue(sheet().querySelector('input[type="date"]'), '2026-09-20');
    expect(applyBtn().disabled).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
    await flush();
    expect(applyBtn().disabled).toBe(false);
  });

  it('combines template search with the scheduled/manual filter without writing', async () => {
    state.envelopeTemplates = [manual, scheduled];
    await openPage();
    const filter = document.querySelector('select[aria-label="' + t('workspace.views') + '"]');
    setValue(filter, 'scheduled', ['change']);
    expect(cards().map(c => c.querySelector('.tpl-name').textContent)).toEqual(['Payday split']);
    const search = document.querySelector('input[type="search"]');
    setValue(search, 'weekly', ['input']);
    expect(cards()).toHaveLength(0);
    setValue(filter, 'manual', ['change']);
    expect(cards().map(c => c.querySelector('.tpl-name').textContent)).toEqual(['Weekly top-up']);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('lists the template', () => {
    expect(cards()).toHaveLength(1);
    expect(card('Weekly top-up')).toBeTruthy();
  });

  it('commits one posted pool_distribute fill, with set lines resolved to deltas', async () => {
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    expect(sheet()).toBeTruthy();

    setValue(acctSel(), 'chk', ['change']);
    await flush();
    applyBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    // A one-off apply leaves the template itself alone.
    expect(lastBatch().map(i => i.filename)).toEqual(['transactions.json', 'budget-meta.json']);
    expect(written()).toHaveLength(2);
    expect(state.transactions).toEqual(written());
    const fill = written().at(-1);
    expect(fill).toMatchObject({
      type: 'fill', date: '2026-09-15', status: 'posted', source: 'pool_distribute',
      source_account: 'chk', payee: 'Weekly top-up', template_id: 'weekly',
    });
    // Food is at 300: "set to 350" is stored as +50, never as an absolute set.
    expect(fill.lines).toEqual([
      { envelope_id: 'fun', amount: 40, mode: 'add' },
      { envelope_id: 'food', amount: 50, mode: 'add', set_target: 350 },
    ]);
    // Not a scheduled template: no occurrence key.
    expect(fill.from_budget).toBeUndefined();
    expect(fill.id).toBeTruthy();
    expect(updateStatusBar).toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toContain(t('templatesPage.applied'));
  });

  it('takes the date as typed and an empty source account as null', async () => {
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    setValue(sheet().querySelector('input[type="date"]'), '2026-09-20');
    await flush();
    applyBtn().click();
    await flush();
    expect(written().at(-1)).toMatchObject({ date: '2026-09-20', source_account: null });
  });

  it('a second plain apply in the same month is allowed', async () => {
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    applyBtn().click();
    await flush();
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    applyBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions.filter(x => x.template_id === 'weekly')).toHaveLength(2);
  });

  it('a template whose set lines are already met has nothing to fund: a notice, no write', async () => {
    state.envelopeTemplates = [{ id: 'met', name: 'Met', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'set', amount: 300 }] }];
    await openPage();
    actionBtn('Met', 'apply').click();
    await flush();
    applyBtn().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.querySelector('#sheet-host').textContent).toContain('Nothing to fund');
  });

  it('cancel writes nothing', async () => {
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    sheetBtn(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
  });

  it('a template that resolves to no lines gets a notice and no form', async () => {
    state.envelopeTemplates = [{ id: 'empty', name: 'Empty', kind: 'manual', lines: [] }];
    await openPage();
    actionBtn('Empty', 'apply').click();
    await flush();
    expect(sheet().textContent).toContain(t('templatesPage.applyNoLines'));
    expect(sheet().querySelector('form')).toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a failed write keeps the sheet open, the transactions as they were, and reports the error', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const before = state.transactions;
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    applyBtn().click();
    await flush();
    expect(state.transactions).toBe(before);
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(sheetIsOpen()).toBe(true);
    expect(updateStatusBar).not.toHaveBeenCalled();
    expect(toastTexts()).not.toContain(t('templatesPage.applied'));
  });
});

describe('template query integration', () => {
  it('renders the query total/count but previews effects from the actual fill command', async () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const r = real(name, input);
      if (name !== 'templates.summary' || !r.ok) return r;
      return { ...r, value: { templates: r.value.templates.map(row => ({
        ...row, total: 999.12, lineCount: 7,
        resolvedLines: [{ envelope_id: 'fun', mode: 'add', amount: 23 }],
      })) } };
    });
    await openPage();
    expect(card('Weekly top-up').textContent).toContain(t('templatesPage.linesMeta')(7, fmt(999.12)));
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    expect(sheet().textContent).toContain('Fun: ' + fmt(0) + ' → ' + fmt(40));
    expect(spy.mock.calls.filter(([name]) => name === 'templates.summary')).toEqual([
      ['templates.summary', { date: '2026-09-15' }],
      ['templates.summary', { date: '2026-09-15', templates: ['weekly'] }],
    ]);
  });

  it('re-queries at action open when a fill or template edit has landed since the card rendered', async () => {
    state.envelopeTemplates = [scheduled];
    await openPage();
    expect(card('Payday split').textContent).toContain(t('templatesPage.nextRun')(fmtDateLang('2026-09-25')));
    state.transactions = [...state.transactions, { id: 'f0', type: 'fill', from_budget: 'tpl:payday:2026-09', date: '2026-09-25', lines: [] }];
    state.envelopeTemplates = [{ ...scheduled, lines: [{ envelope_id: 'fun', mode: 'add', amount: 80 }] }];
    actionBtn('Payday split', 'apply').click();
    await flush();
    expect(sheet().textContent).toContain(t('templatesPage.earlyAskEarly')(fmtDateLang('2026-10-25')));
    dialogOk().click();
    await flush();
    expect(sheet().textContent).toContain('Fun: ' + fmt(0) + ' → ' + fmt(80));
  });

  it('shows an annual pending fill and excludes a deleted occurrence on the card', async () => {
    state.envelopeTemplates = [{ ...scheduled, schedule: { ...scheduled.schedule, payment_day: 5, months: { Sep: true } } }];
    await openPage();
    expect(card('Payday split').textContent).toContain(t('templatesPage.nextRun')(fmtDateLang('2027-09-05')));
    state.envelopeTemplates = [scheduled];
    state.meta = { ...state.meta, scheduledTombstones: ['tpl:payday:2026-09'] };
    await openPage();
    expect(card('Payday split').textContent).toContain(t('templatesPage.nextRun')(fmtDateLang('2026-10-25')));
  });

  it('does not open an apply sheet for a template deleted since the card rendered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.envelopeTemplates = [];
    actionBtn('Weekly top-up', 'apply').click();
    await flush();
    expect(sheetIsOpen()).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('omits query figures and disables apply on failure, without an engine fallback', async () => {
    const real = session.query.bind(session);
    vi.spyOn(session, 'query').mockImplementation((name, input) => name === 'templates.summary'
      ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openPage();
    expect(card('Weekly top-up').querySelector('.tpl-meta').textContent).toBe('');
    expect(actionBtn('Weekly top-up', 'apply').disabled).toBe(true);
    expect(actionBtn('Weekly top-up', 'edit').disabled).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('apply a scheduled template', () => {
  async function openApply() {
    await openPage();
    actionBtn('Payday split', 'apply').click();
    await flush();
  }

  beforeEach(async () => {
    state.envelopeTemplates = [scheduled];
    await openApply();
  });

  it('asks whether this is extra or the next fill brought forward', () => {
    expect(document.querySelector('#sheet-host').textContent).toContain(t('templatesPage.earlyAskTitle'));
  });

  it('dismissing the question writes nothing and opens no apply sheet', async () => {
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
  });

  it('extra money: one fill, and the schedule is not touched', async () => {
    dialogButton(t('templatesPage.earlyAskExtra')).click();
    await flush();
    applyBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(lastBatch().map(i => i.filename)).toEqual(['transactions.json', 'budget-meta.json']);
    expect(written().at(-1)).toMatchObject({ type: 'fill', template_id: 'payday', source: 'pool_distribute' });
    // Not a stand-in for the 25 Sep occurrence: unkeyed, so it still posts.
    expect(written().at(-1)).not.toHaveProperty('from_budget');
    expect(written().at(-1).source_envelope_id).toBeUndefined();
    expect(state.envelopeTemplates[0].schedule.skipped).toBeUndefined();
    expect(toastTexts()).toContain(t('templatesPage.applied'));
  });

  it('extra money draws on no source envelope, even when the schedule has one', async () => {
    state.envelopeTemplates = [{ ...scheduled, schedule: { ...scheduled.schedule, source_envelope_id: 'food' } }];
    await openApply();
    dialogButton(t('templatesPage.earlyAskExtra')).click();
    await flush();
    applyBtn().click();
    await flush();
    const fill = written().at(-1);
    expect(fill).not.toHaveProperty('source_envelope_id');
    expect(fill.lines.map(l => l.envelope_id)).toEqual(['fun', 'rent']);
  });

  it('extra money goes through even when the template already filled this month', async () => {
    resetState({
      transactions: [{
        id: 'f0', type: 'fill', date: '2026-09-03', status: 'posted', source: 'pool_distribute', template_id: 'payday',
        lines: [{ envelope_id: 'fun', mode: 'add', amount: 60 }],
      }],
    });
    state.envelopeTemplates = [scheduled];
    await openApply();
    dialogButton(t('templatesPage.earlyAskExtra')).click();
    await flush();
    applyBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(written().filter(x => x.template_id === 'payday')).toHaveLength(2);
  });

  it('brought forward: one commit writes the fill and skips that month on the template', async () => {
    dialogOk().click();
    await flush();
    applyBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(lastBatch().map(i => i.filename).sort()).toEqual(['budget-meta.json', 'envelope-templates.json', 'transactions.json']);
    const fill = written().at(-1);
    expect(fill).toMatchObject({
      type: 'fill', template_id: 'payday', status: 'posted', date: '2026-09-15', source: 'pool_distribute',
    });
    // The skipped month records the occurrence; the fill carries no key.
    expect(fill).not.toHaveProperty('from_budget');
    expect(runInvariantCheck(state).totalProblems).toBe(0);
    expect(fill.lines).toEqual([
      { envelope_id: 'fun', amount: 60, mode: 'add' },
      { envelope_id: 'rent', amount: 500, mode: 'add' },
    ]);
    // The fill stands in for the 25 Sep occurrence: it is skipped, so the
    // envelopes are not filled twice.
    expect(savedTemplates()).toHaveLength(1);
    expect(savedTemplates()[0].schedule.skipped).toEqual(['2026-09']);
    expect(savedTemplates()[0].schedule.enabled).toBe(true);
    expect(state.envelopeTemplates).toEqual(savedTemplates());
    expect(toastTexts()).toContain(t('templatesPage.appliedEarly')(fmtDateLang('2026-09-25')));
    expect(card('Payday split').textContent).toContain(t('templatesPage.nextRun')(fmtDateLang('2026-10-25')));
  });

  it('extra money, then the same month\'s fill brought forward: both go through', async () => {
    dialogButton(t('templatesPage.earlyAskExtra')).click();
    await flush();
    applyBtn().click();
    await flush();
    // The extra fill does not take the 25 Sep occurrence, so it is still offered early.
    actionBtn('Payday split', 'apply').click();
    await flush();
    dialogOk().click();
    await flush();
    applyBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(state.transactions.filter(x => x.template_id === 'payday')).toHaveLength(2);
    expect(state.envelopeTemplates[0].schedule.skipped).toEqual(['2026-09']);
    expect(toastTexts()).toContain(t('templatesPage.appliedEarly')(fmtDateLang('2026-09-25')));
  });

  it('brought forward past a month already filled: the fill skips the next occurrence', async () => {
    resetState({
      transactions: [{
        id: 'f0', type: 'fill', date: '2026-09-25', status: 'posted', source: 'allocation', template_id: 'payday',
        from_budget: 'tpl:payday:2026-09', lines: [{ envelope_id: 'fun', mode: 'add', amount: 60 }],
      }],
    });
    state.envelopeTemplates = [scheduled];
    await openApply();
    dialogOk().click();
    await flush();
    applyBtn().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(written().at(-1)).toMatchObject({ date: '2026-09-15' });
    expect(written().at(-1)).not.toHaveProperty('from_budget');
    expect(savedTemplates()[0].schedule.skipped).toEqual(['2026-10']);
    expect(runInvariantCheck(state).totalProblems).toBe(0);
  });

  it('brought forward from a funding envelope: adds the offsetting source leg', async () => {
    state.envelopeTemplates = [{ ...scheduled, schedule: { ...scheduled.schedule, source_envelope_id: 'food' } }];
    await openApply();
    dialogOk().click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain(t('workspace.sourceWarning'));
    expect(sheet().textContent).toContain('Food: ' + fmt(300) + ' → ' + fmt(-260));
    applyBtn().click();
    await flush();
    const fill = written().at(-1);
    expect(fill.source_envelope_id).toBe('food');
    expect(fill.lines.at(-1)).toEqual({ envelope_id: 'food', mode: 'add', amount: -560 });
  });

  it('a failed write leaves both the transactions and the template as they were', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('disk full'); });
    const txs = state.transactions;
    const tpls = state.envelopeTemplates;
    dialogOk().click();
    await flush();
    applyBtn().click();
    await flush();
    expect(state.transactions).toBe(txs);
    expect(state.envelopeTemplates).toBe(tpls);
    expect(toastTexts().some(x => x.includes('disk full'))).toBe(true);
    expect(sheetIsOpen()).toBe(true);
  });
});

describe('save and delete a template', () => {
  it('delete asks first; cancelling writes nothing', async () => {
    actionBtn('Weekly top-up', 'edit').click();
    await flush();
    sheetBtn(t('common.delete')).click();
    await flush();
    dialogButton(t('common.cancel')).click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.envelopeTemplates).toHaveLength(1);
  });

  it('confirming delete writes the list without the template and offers Undo', async () => {
    state.envelopeTemplates = [manual, scheduled];
    await openPage();
    actionBtn('Weekly top-up', 'edit').click();
    await flush();
    sheetBtn(t('common.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(savedTemplates().map(x => x.id)).toEqual(['payday']);
    expect(state.envelopeTemplates.map(x => x.id)).toEqual(['payday']);
    expect(sheetIsOpen()).toBe(false);
    expect(cards()).toHaveLength(1);
    expect(toastTexts()).toContain(t('templatesPage.deleted'));
    expect(toastButton().textContent).toBe(t('common.undo'));
  });

  it('Undo puts the template back where it was', async () => {
    state.envelopeTemplates = [manual, scheduled];
    await openPage();
    actionBtn('Weekly top-up', 'edit').click();
    await flush();
    sheetBtn(t('common.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    toastButton().click();
    await flush();
    expect(state.envelopeTemplates).toEqual([manual, scheduled]);
    expect(savedTemplates()).toEqual([manual, scheduled]);
    expect(toastTexts()).toContain(t('common.restored'));
    expect(navigate).toHaveBeenCalledWith('templates');
  });

  it('a failed delete keeps the template, says so and keeps the editor open', async () => {
    writeBatch.mockImplementationOnce(async () => { throw new Error('nope'); });
    actionBtn('Weekly top-up', 'edit').click();
    await flush();
    sheetBtn(t('common.delete')).click();
    await flush();
    dialogOk().click();
    await flush();
    expect(state.envelopeTemplates).toEqual([manual]);
    expect(toastTexts().some(x => x.includes('nope'))).toBe(true);
    expect(toastTexts()).not.toContain(t('templatesPage.deleted'));
    expect(sheetIsOpen()).toBe(true);
  });

  it('editing a template saves the changed line under the same id', async () => {
    actionBtn('Weekly top-up', 'edit').click();
    await flush();
    const rows = [...sheet().querySelectorAll('.split-row')];
    setValue(rows[0].querySelector('.split-amt'), '45');
    sheet().querySelector('form').requestSubmit();
    await flush();
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(savedTemplates()).toHaveLength(1);
    expect(savedTemplates()[0]).toMatchObject({ id: 'weekly', name: 'Weekly top-up', kind: 'manual' });
    expect(savedTemplates()[0].lines[0]).toEqual({ envelope_id: 'fun', mode: 'add', amount: 45 });
    expect(state.envelopeTemplates).toEqual(savedTemplates());
    expect(runDueScheduled).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
    expect(toastTexts()).toContain(t('templatesPage.saved'));
  });

  it('editing keeps a top-level field the editor does not render', async () => {
    state.envelopeTemplates = [{ ...manual, origin: 'income-linked' }];
    await openPage();
    actionBtn('Weekly top-up', 'edit').click();
    await flush();
    setValue([...sheet().querySelectorAll('.split-row')][0].querySelector('.split-amt'), '45');
    sheet().querySelector('form').requestSubmit();
    await flush();
    expect(savedTemplates()[0].origin).toBe('income-linked');
  });

  it('a new template with no usable line is refused', async () => {
    document.querySelector('.page-head .btn-accent').click();
    await flush();
    sheet().querySelector('.tpl-kind-card').click();
    await flush();
    setValue(sheet().querySelector('input[type="text"]'), 'Fresh');
    sheet().querySelector('form').requestSubmit();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(document.querySelector('#sheet-host').textContent).toContain(t('templatesPage.needLine'));
  });

  it('a new template gets a slug id and is appended to the list', async () => {
    document.querySelector('.page-head .btn-accent').click();
    await flush();
    sheet().querySelector('.tpl-kind-card').click();
    await flush();
    setValue(sheet().querySelector('input[type="text"]'), 'Holiday Pot');
    const row = sheet().querySelector('.split-row');
    setValue(row.querySelector('.split-env'), 'fun', ['change']);
    setValue(row.querySelector('.split-amt'), '25');
    sheet().querySelector('form').requestSubmit();
    await flush();
    expect(savedTemplates().map(x => x.id)).toEqual(['weekly', 'holiday-pot']);
    expect(savedTemplates()[1]).toEqual({
      id: 'holiday-pot', name: 'Holiday Pot', kind: 'manual', description: null,
      lines: [{ envelope_id: 'fun', mode: 'add', amount: 25 }],
    });
    expect(state.envelopeTemplates).toEqual(savedTemplates());
    expect(cards()).toHaveLength(2);
  });

  it('a name another template has (any case) is shown on the name field, and nothing is written', async () => {
    document.querySelector('.page-head .btn-accent').click();
    await flush();
    sheet().querySelector('.tpl-kind-card').click();
    await flush();
    const nameIn = sheet().querySelector('input[type="text"]');
    setValue(nameIn, 'weekly TOP-UP');
    const row = sheet().querySelector('.split-row');
    setValue(row.querySelector('.split-env'), 'fun', ['change']);
    setValue(row.querySelector('.split-amt'), '25');
    sheet().querySelector('form').requestSubmit();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    const nameField = nameIn.closest('.field');
    expect(nameField.classList.contains('has-error')).toBe(true);
    expect(nameField.querySelector('.field-hint').textContent).toBe(t('templatesPage.nameTaken')('weekly TOP-UP'));
    expect(sheetIsOpen()).toBe(true);
    // Typing clears the hint.
    setValue(nameIn, 'Weekly two');
    expect(nameField.classList.contains('has-error')).toBe(false);
  });
});
