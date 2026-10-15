// js/pages/reports-envelope-picker.js — the "Envelopes…" sheet for Reports'
// Envelope balance over time: checkboxes grouped by category, a search box,
// at most MAX_PICKED_ENVELOPES picked. Apply hands the picked ids (in
// envelope order) back to the page, which saves them and re-renders.

import { openSheet } from '../ui/sheet.js';
import { t, trEnv, trCat } from '../ui/i18n.js';
import { foldText } from '../ui/option-filter.js';
import { MAX_PICKED_ENVELOPES } from './reports-prefs.js';

/**
 * @param {{ envelopes: any[], picked: string[], onApply: (ids: string[]) => void }} o
 */
export function openEnvelopePicker({ envelopes, picked, onApply }) {
  const active = envelopes.filter(e => e && !e.archived);
  const chosen = new Set(picked);
  const content = document.createElement('div');
  content.className = 'reports-env-picker';

  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = t('reports.envelopesHint')(MAX_PICKED_ENVELOPES);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'input';
  search.placeholder = t('reports.envelopesSearch');
  search.setAttribute('aria-label', t('reports.envelopesSearch'));

  const list = document.createElement('div');
  list.className = 'reports-env-picker-list';
  /** @type {HTMLInputElement[]} */
  const boxes = [];
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const env of active) {
    const cat = env.category || '';
    if (!groups.has(cat)) groups.set(cat, []);
    /** @type {any[]} */ (groups.get(cat)).push(env);
  }
  const syncLimit = () => {
    for (const b of boxes) b.disabled = !b.checked && chosen.size >= MAX_PICKED_ENVELOPES;
  };
  for (const [cat, envs] of groups) {
    const group = document.createElement('section');
    group.className = 'reports-env-picker-group';
    // An envelope with no category still gets a heading ("Unassigned") when
    // that key exists, rather than a blank <h4>; if it ever doesn't, omit
    // the heading entirely instead of showing nothing under an empty label.
    const headingText = cat ? trCat(cat) : t('common.unassigned');
    if (headingText) {
      const h = document.createElement('h4');
      h.textContent = headingText;
      group.append(h);
    }
    for (const env of envs) {
      const row = document.createElement('label');
      row.className = 'reports-env-picker-row';
      row.dataset.search = foldText(`${cat ? trCat(cat) : ''} ${trEnv(env)}`);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = env.id;
      box.checked = chosen.has(env.id);
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(env.id);
        else chosen.delete(env.id);
        syncLimit();
      });
      boxes.push(box);
      const name = document.createElement('span');
      name.textContent = trEnv(env);
      row.append(box, name);
      group.append(row);
    }
    list.append(group);
  }
  syncLimit();

  search.addEventListener('input', () => {
    const q = foldText(search.value);
    for (const group of list.children) {
      let any = false;
      for (const row of group.querySelectorAll('.reports-env-picker-row')) {
        const show = !q || /** @type {HTMLElement} */ (row).dataset.search.includes(q);
        /** @type {HTMLElement} */ (row).hidden = !show;
        any = any || show;
      }
      /** @type {HTMLElement} */ (group).hidden = !any;
    }
  });

  const actions = document.createElement('div');
  actions.dataset.sheetActions = '';
  actions.className = 'reports-env-picker-actions';
  // Declared ahead of the buttons below so their handlers (assigned before
  // `handle` itself is) read a `let`, not a forward reference to a `const`.
  let handle;
  const mk = (text, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  const clear = mk(t('reports.envelopesClear'), 'btn btn-ghost', () => {
    chosen.clear();
    for (const b of boxes) b.checked = false;
    syncLimit();
  });
  const cancel = mk(t('common.cancel'), 'btn btn-ghost', () => handle.close());
  const apply = mk(t('common.apply'), 'btn btn-accent', () => {
    handle.close();
    onApply(active.filter(e => chosen.has(e.id)).map(e => e.id));
  });
  actions.append(clear, cancel, apply);

  content.append(hint, search, list, actions);
  handle = openSheet({ title: t('reports.envelopesTitle'), content, narrow: true, initialFocus: search });
}
