// js/ui/exclude-picker-model.js — pure view logic for one section of the
// "Exclude…" sheet (js/ui/exclude-picker.js): what rows to render for the
// current search query, with an optional pinned "already excluded" group and
// an optional cap on how many non-pinned rows show at once. No DOM; the
// picker rebuilds a section's panel from this on every tab switch and search
// keystroke.

import { foldText } from './option-filter.js';

/**
 * @typedef {{ id: string, label: string }} PickerItem
 * @typedef {{ label: string, items: PickerItem[] }} PickerGroup
 * @typedef {{
 *   groups: PickerGroup[],
 *   pinSelected?: boolean,
 *   cap?: number,
 * }} PickerSection
 */

/**
 * What one picker section shows for a query.
 * @param {PickerSection} section
 * @param {Set<string>} chosen   ids currently excluded in this section
 * @param {string} query        already folded with foldText ('' = not searching)
 * @param {string} pinnedLabel  heading for the pinned group
 * @returns {{ groups: PickerGroup[], hidden: number, total: number }}
 */
export function sectionView(section, chosen, query, pinnedLabel) {
  const total = section.groups.reduce((sum, g) => sum + g.items.length, 0);

  if (query) {
    const groups = [];
    for (const g of section.groups) {
      const items = g.items.filter(item => foldText(`${g.label} ${item.label}`).includes(query));
      if (items.length) groups.push({ label: g.label, items });
    }
    return { groups, hidden: 0, total };
  }

  // Not searching: pull the pinned group out first (if any), then cap the
  // rest (if any). Pinned items never count against the cap.
  let rest = section.groups.map(g => ({ label: g.label, items: g.items }));
  const out = [];
  if (section.pinSelected) {
    const pinnedItems = [];
    rest = rest.map(g => {
      const keep = [];
      for (const item of g.items) {
        if (chosen.has(item.id)) pinnedItems.push(item);
        else keep.push(item);
      }
      return { label: g.label, items: keep };
    });
    if (pinnedItems.length) out.push({ label: pinnedLabel, items: pinnedItems });
  }

  let hidden = 0;
  if (Number.isFinite(section.cap)) {
    let remaining = section.cap;
    const capped = [];
    for (const g of rest) {
      if (remaining <= 0) { hidden += g.items.length; continue; }
      if (g.items.length <= remaining) {
        capped.push(g);
        remaining -= g.items.length;
      } else {
        capped.push({ label: g.label, items: g.items.slice(0, remaining) });
        hidden += g.items.length - remaining;
        remaining = 0;
      }
    }
    rest = capped;
  }

  out.push(...rest.filter(g => g.items.length > 0));
  return { groups: out, hidden, total };
}
