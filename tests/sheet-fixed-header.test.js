// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { openSheet } from '../js/ui/sheet.js';

it('header submit buttons retain form validation and reveal a collapsed invalid field', () => {
  const host = document.createElement('div'); host.id = 'sheet-host'; document.body.append(host);
  vi.stubGlobal('requestAnimationFrame', () => {});
  const form = document.createElement('form');
  const details = document.createElement('details');
  const input = document.createElement('input'); input.required = true;
  details.append(input); form.append(details);
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save';
  const submit = vi.fn(e => e.preventDefault()); form.addEventListener('submit', submit);
  const handle = openSheet({title:'Edit account',content:form,headerActions:save});
  expect(save.form).toBe(form);
  expect(form.contains(save)).toBe(false);
  save.click();
  expect(details.open).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  input.value = 'Savings'; save.click();
  expect(submit).toHaveBeenCalledTimes(1);
  const dialog = host.querySelector('.sheet');
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Edit account');
  handle.close(); host.remove(); vi.unstubAllGlobals();
});
