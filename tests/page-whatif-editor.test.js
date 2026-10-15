// @vitest-environment jsdom
// What-if editor: a scenario needs a name and at least one change. With no
// change Save is disabled (and a submit anyway is refused inline); adding a
// change enables it and the scenario reaches onSave. Drives the real
// js/pages/whatif-editor.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openWhatIfEditor } from '../js/pages/whatif-editor.js';
import { t } from '../js/ui/i18n.js';
import { resetState, mountHosts, flush, setValue, topOverlay } from './_fakes/pageApp.js';

const sheet = () => topOverlay()?.querySelector('.sheet') ?? null;
const btn = (label) => [...sheet().querySelectorAll('button')].find(b => b.textContent === label);
const accounts = [{ id: 'chk', name: 'Checking', type: 'bank' }, { id: 'sav', name: 'Savings', type: 'savings' }];

let onSave;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState({});
  mountHosts();
  onSave = vi.fn(async () => true);
  openWhatIfEditor({ scenario: null, accounts, budgetItems: [], today: new Date(2026, 9, 5), onSave });
});

describe('what-if editor', () => {
  it('Cancel and Save sit in the fixed header, regular size', () => {
    expect(sheet().querySelector('[id^="sheet-title-"] button')).toBeNull();
    const end = sheet().querySelector('.sheet-header .sheet-footer-actions .sheet-footer-actions-end');
    expect([...end.querySelectorAll('button')].map(b => b.textContent)).toEqual([t('common.cancel'), t('common.save')]);
    expect(btn(t('common.save')).classList.contains('btn-sm')).toBe(false);
  });

  it('a new scenario with no change cannot be saved', async () => {
    setValue(sheet().querySelector('input[type="text"]'), 'Job loss');
    const save = btn(t('common.save'));
    expect(save.disabled).toBe(true);
    expect(sheet().querySelector('.whatif-change-empty').style.display).toBe('');
    // A submit regardless (Enter in the name field) is refused inline.
    sheet().querySelector('form').requestSubmit();
    await flush();
    expect(onSave).not.toHaveBeenCalled();
    expect(sheet().textContent).toContain(t('whatIfEditor.errEmpty'));
  });

  it('adding a change enables Save, and the scenario is saved with it', async () => {
    setValue(sheet().querySelector('input[type="text"]'), 'Job loss');
    btn(t('whatIfEditor.addStress')).click();
    const save = btn(t('common.save'));
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: 'Job loss' });
    expect(onSave.mock.calls[0][0].changes).toHaveLength(1);
  });

  it('removing the only change disables Save again', () => {
    btn(t('whatIfEditor.addStress')).click();
    expect(btn(t('common.save')).disabled).toBe(false);
    sheet().querySelector('.whatif-change-list button').click();
    expect(btn(t('common.save')).disabled).toBe(true);
  });
});
