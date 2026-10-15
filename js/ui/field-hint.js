// js/ui/field-hint.js — inline validation hint under a `.field` wrapper.
// Standardized rule: field-level problems show here, next to the input;
// operation failures (storage/API errors) go to an assertive toast instead.
//
//   attachFieldHint(fieldEl);          // once, at build time
//   setFieldHint(fieldEl, message);    // '' or null clears
//
// Styling comes from .field-hint / .field.has-error in css/app.css.
let _hintSeq = 0;
const controls = new WeakMap();

export function attachFieldHint(fieldEl, input = fieldEl.querySelector('input')) {
  controls.set(fieldEl, input);
  if (fieldEl.querySelector('.field-hint:not(.field-hint--info)')) return;
  const hint = document.createElement('div');
  hint.className = 'field-hint';
  hint.id = `field-hint-${++_hintSeq}`;
  hint.setAttribute('aria-live', 'polite');
  if (input) input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), hint.id].filter(Boolean).join(' '));
  fieldEl.append(hint);
}

export function setFieldHint(fieldEl, message) {
  const hint = fieldEl.querySelector('.field-hint:not(.field-hint--info)');
  if (!hint) return;
  hint.textContent = message || '';
  fieldEl.classList.toggle('has-error', !!message);
  const input = controls.get(fieldEl) || fieldEl.querySelector('input, select, textarea');
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}
