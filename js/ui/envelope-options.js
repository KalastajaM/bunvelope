// js/ui/envelope-options.js — envelope <option>s grouped by category.
//
// The transaction sheets offered every envelope in one flat <select>, in
// array order, so finding one among 38 meant reading the whole list
// (ux-review U16). Grouping them in <optgroup>s by category, in the order the
// Envelopes page shows the categories, makes the list scannable, and the
// browser's type-to-jump still works inside it.

import { escHtml } from '../utils.js';
import { trCat, t } from './i18n.js';

/**
 * Envelopes grouped by category, categories in the order they first appear
 * (the Envelopes page's order). Archived envelopes go in a last group of their
 * own. Pure; `envelopes` is the already-filtered list to offer.
 *
 * @param {Array<{ id: string, category?: string, archived?: boolean }>} envelopes
 * @returns {Array<{ label: string, envelopes: any[] }>}
 */
export function groupEnvelopesForSelect(envelopes) {
  /** @type {Map<string, any[]>} */
  const byCat = new Map();
  const archived = [];
  for (const e of envelopes || []) {
    if (e.archived) { archived.push(e); continue; }
    const cat = e.category || 'other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(e);
  }
  const groups = [...byCat].map(([cat, list]) => ({ label: trCat(cat), envelopes: list }));
  if (archived.length) groups.push({ label: t('addTx.archivedGroup'), envelopes: archived });
  return groups;
}

/**
 * Append grouped envelope options to `select`.
 *
 * @param {HTMLSelectElement} select
 * @param {any[]} envelopes
 * @param {(e: any) => string} labelFn
 * @param {string} [selectedId]
 */
export function appendEnvelopeOptions(select, envelopes, labelFn, selectedId = '') {
  for (const g of groupEnvelopesForSelect(envelopes)) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const e of g.envelopes) {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = labelFn(e);
      if (selectedId && e.id === selectedId) o.selected = true;
      og.append(o);
    }
    select.append(og);
  }
}

/**
 * The same options as an HTML string, every value escaped, for callers that
 * build a <select> with innerHTML.
 *
 * @param {any[]} envelopes
 * @param {(e: any) => string} labelFn
 * @param {string} [selectedId]
 * @returns {string}
 */
export function envelopeOptionsHtml(envelopes, labelFn, selectedId = '') {
  return groupEnvelopesForSelect(envelopes).map(g =>
    `<optgroup label="${escHtml(g.label)}">${g.envelopes.map(e =>
      `<option value="${escHtml(e.id)}"${e.id === selectedId ? ' selected' : ''}>${escHtml(labelFn(e))}</option>`,
    ).join('')}</optgroup>`,
  ).join('');
}
