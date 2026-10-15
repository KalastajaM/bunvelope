// Shared editor feedback. Financial/domain validation stays with the caller.
import { attachFieldHint, setFieldHint } from './field-hint.js';
import { t } from './i18n.js';

let fieldSequence = 0;
function visibleControl(control) {
  return control.tagName === 'SELECT' && control.hidden
    ? control.closest('.combo')?.querySelector('input[role="combobox"]') || control : control;
}

export function markRequired(control, required = true) {
  control = visibleControl(control);
  control.setAttribute('aria-required', String(required));
  const label = control.closest('.field')?.querySelector('label');
  if (!label) return;
  if (!control.id) control.id = `validation-field-${++fieldSequence}`;
  label.htmlFor = control.id;
  let marker = label.querySelector('.required-marker');
  if (!marker) {
    marker = document.createElement('span');
    marker.className = 'required-marker';
    marker.title = t('common.fieldRequired');
    marker.setAttribute('aria-hidden', 'true');
    label.append(marker);
  }
  marker.hidden = !required;
}

export function fieldError(control, message, focus = false) {
  if (!control) return;
  control = visibleControl(control);
  const wrap = control.closest('.field') || control.parentElement;
  attachFieldHint(wrap, control);
  setFieldHint(wrap, message);
  if (message && focus) focusField(control);
}

export function focusField(control) {
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  const target = visibleControl(control);
  target.focus();
}

export function focusFirstError(form) {
  const field = form.querySelector('.has-error');
  const control = field?.querySelector('[aria-invalid="true"]');
  if (control) focusField(control);
}

function available(control, form) {
  if (control.disabled) return false;
  // A closed disclosure still contains applicable fields; a hidden type panel does not.
  for (let el = control; el && el !== form; el = el.parentElement) {
    if (el.hidden || (el.style.display === 'none' && el !== control)) return false;
  }
  return true;
}

export function setupFormValidation(form, { required = true } = {}) {
  form.noValidate = true;
  for (const control of form.querySelectorAll('[required]')) markRequired(control);
  form.addEventListener('submit', e => {
    if (!required) return;
    let valid = true;
    for (const control of form.querySelectorAll('[required], [aria-required="true"]')) {
      if (!available(control, form)) continue;
      if (!control.value.trim()) {
        fieldError(control, t(control.type === 'date' ? 'common.dateRequired' : 'common.fieldRequired'));
        valid = false;
      }
    }
    if (!valid) {
      e.preventDefault();
      e.stopImmediatePropagation();
      focusFirstError(form);
    }
  }, true);
  const clear = e => {
    const wrap = e.target.closest('.has-error');
    if (wrap) setFieldHint(wrap, '');
  };
  form.addEventListener('input', clear);
  form.addEventListener('change', clear);
}
