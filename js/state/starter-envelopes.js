// js/state/starter-envelopes.js — the envelopes the setup wizard offers a new
// budget that starts without an import.
//
// A blank Envelopes page is the hardest place to start: it asks a newcomer to
// know what an envelope budget usually holds. These are the common ones,
// named in the language the wizard runs in. They are plain envelopes once
// created, to rename, archive or add to like any other.

import { t } from '../ui/i18n.js';
import { slugify, uniqueId } from '../utils.js';

/** Offered in this order, grouped by category; every one starts ticked. */
export const STARTER_ENVELOPES = [
  { key: 'housing',   category: 'essentials' },
  { key: 'groceries', category: 'essentials' },
  { key: 'utilities', category: 'essentials' },
  { key: 'transport', category: 'essentials' },
  { key: 'eatingOut', category: 'lifestyle' },
  { key: 'fun',       category: 'lifestyle' },
  { key: 'emergency', category: 'savings' },
  { key: 'holidays',  category: 'savings' },
];

export const starterName = (key) => t(`setup.starter.names.${key}`);
export const starterCategory = (category) => t(`setup.starter.categories.${category}`);

/**
 * Envelope records for the picked starter keys, in STARTER_ENVELOPES order.
 * Ids follow the Envelopes page's rule (category-name slug, made unique), and
 * a name already present (an AI suggestion, say) is not added twice.
 *
 * @param {Iterable<string>} keys
 * @param {{ id: string, name?: string }[]} [existing]
 */
export function buildStarterEnvelopes(keys, existing = []) {
  const picked = new Set(keys);
  const taken = new Set(existing.map(e => e.id));
  const names = new Set(existing.map(e => String(e.name || '').toLowerCase()));
  const out = [];
  for (const s of STARTER_ENVELOPES) {
    if (!picked.has(s.key)) continue;
    const name = starterName(s.key);
    if (names.has(name.toLowerCase())) continue;
    const category = starterCategory(s.category);
    const id = uniqueId(slugify(`${category}-${name}`) || 'envelope', taken);
    taken.add(id);
    names.add(name.toLowerCase());
    out.push({ id, name, category, archived: false });
  }
  return out;
}
