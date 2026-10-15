// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { setupFormValidation, markRequired, fieldError } from '../js/ui/form-validation.js';
import { enhanceSelectWithSearch } from '../js/ui/select-combobox.js';

beforeEach(() => { document.body.replaceChildren(); Element.prototype.scrollIntoView = () => {}; });
function fixture() {
  const form = document.createElement('form');
  const wrap = document.createElement('div'); wrap.className = 'field';
  const label = document.createElement('label'); label.textContent = 'Name';
  const input = document.createElement('input');
  input.setAttribute('aria-describedby', 'explanation');
  wrap.append(label, input); form.append(wrap); document.body.append(form);
  return { form, wrap, input, label };
}

it('retains existing descriptions and exposes a required error without a native validation popup', () => {
  const { form, wrap, input, label } = fixture();
  markRequired(input); setupFormValidation(form);
  const save = vi.fn(e => e.preventDefault()); form.addEventListener('submit', save);
  form.requestSubmit();
  expect(save).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  expect(label.htmlFor).toBe(input.id);
  const hint = wrap.querySelector('.field-hint');
  expect(input.getAttribute('aria-describedby').split(' ')).toEqual(['explanation', hint.id]);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  input.value = 'Valid'; input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(input.getAttribute('aria-invalid')).toBe('false');
  form.requestSubmit(); expect(save).toHaveBeenCalledTimes(1);
});

it('opens a collapsed disclosure to focus its invalid field', () => {
  const { form, wrap, input } = fixture();
  const details = document.createElement('details'); form.append(details); details.append(wrap);
  markRequired(input); setupFormValidation(form); form.requestSubmit();
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(input);
});

it('ignores required controls in an inapplicable type panel', () => {
  const { form, wrap, input } = fixture();
  const panel = document.createElement('div'); panel.hidden = true; form.append(panel); panel.append(wrap);
  markRequired(input); setupFormValidation(form);
  const save = vi.fn(e => e.preventDefault()); form.addEventListener('submit', save);
  form.requestSubmit(); expect(save).toHaveBeenCalledTimes(1);
  expect(wrap.classList.contains('has-error')).toBe(false);
});

it('links select errors to the visible searchable input and preserves informational hints', () => {
  const { form, wrap, input } = fixture(); input.remove();
  const select = document.createElement('select'); select.id = 'destination';
  select.append(new Option('Choose', ''), new Option('Food', 'food')); wrap.append(select);
  const info = document.createElement('p'); info.className = 'field-hint field-hint--info'; info.textContent = 'Existing guidance'; wrap.append(info);
  enhanceSelectWithSearch(select); markRequired(select); setupFormValidation(form);
  fieldError(select, 'Choose a destination', true);
  const search = wrap.querySelector('[role="combobox"]');
  expect(document.activeElement).toBe(search);
  expect(search.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(search.getAttribute('aria-describedby')).textContent).toBe('Choose a destination');
  expect(info.textContent).toBe('Existing guidance');
  expect(search.getAttribute('aria-expanded')).toBe('false');
  search.click();
  expect(search.getAttribute('aria-expanded')).toBe('true');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(search.getAttribute('aria-expanded')).toBe('false');
  search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(search.getAttribute('aria-expanded')).toBe('true');
});
