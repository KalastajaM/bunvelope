// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openSheet } from '../js/ui/sheet.js';
import { t } from '../js/ui/i18n.js';

let handles;
beforeEach(() => {
  document.body.innerHTML = '<div id="sheet-host"></div>';
  handles = [];
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
});
afterEach(() => {
  handles.forEach(h => h.close());
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const open = opts => { const h = openSheet(opts); handles.push(h); return h; };

it('ignores outside clicks without calling the discard guard', () => {
  const confirmClose = vi.fn(() => true);
  open({ title: 'Details', content: document.createElement('div'), confirmClose });
  const overlay = document.querySelector('.sheet-overlay');
  overlay.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  overlay.click();
  expect(overlay.dataset.sheetOpen).toBe('true');
  expect(confirmClose).not.toHaveBeenCalled();
});

it('supplies Close without a title or actions and respects the discard guard', async () => {
  const confirmClose = vi.fn(() => false);
  open({ content: document.createElement('div'), confirmClose });
  const button = document.querySelector('.sheet-header button');
  expect(button.textContent).toBe(t('common.close'));
  button.click();
  await Promise.resolve();
  expect(confirmClose).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-sheet-open]')).not.toBeNull();
});

it('keeps moved submit buttons attached to their form and validates before submitting', () => {
  const content = document.createElement('form');
  const input = document.createElement('input'); input.required = true;
  const actions = document.createElement('div'); actions.dataset.sheetActions = '';
  const save = document.createElement('button'); save.type = 'submit';
  actions.append(save); content.append(input, actions);
  const submit = vi.fn(e => e.preventDefault()); content.addEventListener('submit', submit);
  open({ title: 'Edit', content });
  expect(save.closest('.sheet-header')).not.toBeNull();
  expect(save.closest('.sheet-body')).toBeNull();
  expect(save.form).toBe(content);
  save.click(); expect(submit).not.toHaveBeenCalled();
  input.value = 'Valid'; save.click(); expect(submit).toHaveBeenCalledOnce();
});

it('replaces phase actions without leaving stale buttons in the header', () => {
  const handle = open({ title: 'Import', content: document.createElement('div') });
  const first = document.createElement('button');
  const next = document.createElement('button');
  handle.setHeaderActions(first);
  handle.setHeaderActions(next);
  expect(first.isConnected).toBe(false);
  expect(document.querySelector('.sheet-header-actions').firstElementChild).toBe(next);
});
