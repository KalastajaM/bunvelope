// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { openAccountEdit } from '../js/pages/account-edit.js';
import { openEnvelopeEdit } from '../js/pages/envelope-edit.js';
import { state, resetState, mountHosts, topOverlay, setValue, flush, sheetIsOpen, writeBatch } from './_fakes/pageApp.js';
import { t } from '../js/ui/i18n.js';

beforeEach(() => {
  resetState(); mountHosts();
  state.accounts = [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 0, code: 'BA01' }];
  state.envelopes = [{ id: 'food', name: 'Food', category: 'Essentials', code: 'FO01' }];
});

describe.each([
  ['accounts', openAccountEdit, 'FO01'], ['envelopes', openEnvelopeEdit, 'BA01'],
])('%s code editor', (collection, open, duplicate) => {
  it('shows an inline duplicate error, preserves the sheet, then saves a corrected code', async () => {
    const originalId = state[collection][0].id;
    open(state[collection][0]);
    const form = topOverlay().querySelector('form');
    const input = form.querySelector('input[name="code"]');
    expect(input.value).toBe(state[collection][0].code);
    setValue(input, duplicate.toLowerCase());
    form.requestSubmit(); await flush();
    expect(sheetIsOpen()).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(form.textContent).toContain(t('coreError.codeTaken'));
    expect(document.activeElement).toBe(input);
    setValue(input, 'AB12');
    form.requestSubmit(); await flush();
    expect(sheetIsOpen()).toBe(false);
    expect(state[collection][0]).toMatchObject({ id: originalId, code: 'AB12' });
  });
  it('generates a missing legacy code on save', async () => {
    delete state[collection][0].code;
    open(state[collection][0]);
    topOverlay().querySelector('form').requestSubmit(); await flush();
    expect(sheetIsOpen()).toBe(false);
    expect(state[collection][0].code).toMatch(/^[A-Z0-9]{4}$/);
  });
});
