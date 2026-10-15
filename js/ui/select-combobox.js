// js/ui/select-combobox.js — a type-to-filter front for a grouped <select>.
//
// The <select> stays in the DOM (hidden) as the only source of truth, so
// every existing `select.value` read and `change` listener keeps working.
// Options are re-read from the select each time the list opens, so a caller
// that repopulates it needs nothing special. Programmatic `select.value = x`
// (payee → envelope autofill) is caught by an instance-level setter; an
// innerHTML swap or `option.selected = true` is not, so call the returned
// `sync()` after one.
//
// Call it once the select is in the DOM: the wrapper takes the select's place.

import { filterOptionGroups } from './option-filter.js';

let seq = 0;

/**
 * True when there isn't enough room below the input for the list to open
 * downward, but there is more room above than below — the two conditions for
 * flipping it to open upward instead (BACKLOG: `.combo-list` is
 * `position: absolute` inside whatever scrolls, e.g. a sheet's own
 * `overflow-y: auto`, and only ever opened downward, so a combo box near the
 * bottom could show a dropdown clipped by that ancestor's bounds). Pure, so
 * it is unit-testable without a DOM.
 * @param {number} spaceAbove
 * @param {number} spaceBelow
 * @param {number} neededHeight
 */
export function shouldOpenUpward(spaceAbove, spaceBelow, neededHeight) {
  return spaceBelow < neededHeight && spaceAbove > spaceBelow;
}

function readGroups(select) {
  const groups = [];
  let loose = null;
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      // A disabled option cannot be chosen (the template editor disables an
      // envelope another line already has), so the list leaves it out.
      groups.push({ label: child.label, options: [...child.children].filter(o => !o.disabled).map(o => ({ value: o.value, text: o.textContent })) });
    } else if (child.tagName === 'OPTION' && child.value && !child.disabled) {
      if (!loose) { loose = { label: '', options: [] }; groups.push(loose); }
      loose.options.push({ value: child.value, text: child.textContent });
    }
  }
  return groups;
}

/**
 * @param {HTMLSelectElement} select
 * @param {{ placeholder?: string, noMatch?: string }} [opts]
 * @returns {{ sync(): void }}
 */
export function enhanceSelectWithSearch(select, { placeholder = '', noMatch = '' } = {}) {
  const id = `combo-${++seq}`;
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = placeholder;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${id}-list`);
  if (placeholder) input.setAttribute('aria-label', placeholder);
  if (select.id) { input.id = select.id + '-search'; }
  const list = document.createElement('ul');
  list.id = `${id}-list`;
  list.className = 'combo-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  select.before(wrap);
  wrap.append(input, list, select);
  select.hidden = true;
  select.tabIndex = -1;

  let flat = [];
  let active = -1;

  function selectedText() {
    const o = select.selectedOptions[0];
    return o && o.value ? o.textContent : '';
  }
  function sync() { input.value = selectedText(); }

  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); sync(); },
  });

  function render(query) {
    const groups = filterOptionGroups(readGroups(select), query);
    list.replaceChildren();
    flat = [];
    for (const g of groups) {
      if (g.label) {
        const h = document.createElement('li');
        h.className = 'combo-group';
        h.setAttribute('role', 'presentation');
        h.textContent = g.label;
        list.append(h);
      }
      for (const o of g.options) {
        const li = document.createElement('li');
        li.className = 'combo-opt';
        li.id = `${id}-o${flat.length}`;
        li.setAttribute('role', 'option');
        li.textContent = o.text;
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(o.value); });
        list.append(li);
        flat.push({ li, value: o.value });
      }
    }
    if (!flat.length && noMatch) {
      const li = document.createElement('li');
      li.className = 'combo-empty';
      li.textContent = noMatch;
      list.append(li);
    }
    setActive(flat.length ? 0 : -1);
  }
  function setActive(i) {
    active = i;
    flat.forEach((f, j) => f.li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) { input.setAttribute('aria-activedescendant', flat[i].li.id); flat[i].li.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function open(query) {
    const wasHidden = list.hidden;
    render(query);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    // Decided once per open (when the list goes from hidden to shown), not on
    // every keystroke re-render, so the list doesn't jump between up and down
    // as the filtered result count changes.
    if (!wasHidden) return;
    const rect = input.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const needed = Math.min(list.scrollHeight || 0, 280); // .combo-list's max-height
    list.classList.toggle('combo-list--up', shouldOpenUpward(spaceAbove, spaceBelow, needed));
  }
  function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); }
  function choose(value) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  }

  // A mousedown anywhere in the list (a group heading, the scrollbar) would
  // otherwise blur the input, and blur closes the list.
  list.addEventListener('mousedown', (e) => e.preventDefault());

  input.addEventListener('focus', () => {
    input.select();
    // Validation focuses the field to expose its hint, not cover it with a list.
    if (input.getAttribute('aria-invalid') !== 'true') open('');
  });
  input.addEventListener('click', () => { if (list.hidden) open(''); });
  // The search text is not a form value: only a choice, which the hidden
  // select announces with its own `change`, is an edit. Left to bubble, the
  // input's `input` (each keystroke) and `change` (on blur after typing)
  // reach the sheet's dirty tracker, and closing asks to discard nothing.
  input.addEventListener('input', (e) => { e.stopPropagation(); open(input.value); });
  input.addEventListener('change', (e) => e.stopPropagation());
  input.addEventListener('blur', () => { close(); sync(); });
  // Bubble phase is enough for Escape: the sheet listens on `document` in
  // the bubble phase (js/ui/sheet.js), so stopping propagation here closes
  // only the list and leaves the sheet open.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(''); else setActive(Math.min(active + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp' && !list.hidden) { e.preventDefault(); if (flat.length) setActive(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); choose(flat[active].value); }
    else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); sync(); }
  });

  sync();
  return { sync };
}
