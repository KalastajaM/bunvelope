// js/ui/option-filter.js — filter grouped <select> options by typed text.
// DOM-free so it runs under the node test environment; the combobox in
// js/ui/select-combobox.js reads the groups from the <select> and renders.

/** Lower-case, accents stripped, trimmed. */
export function foldText(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * @param {Array<{ label: string, options: Array<{ value: string, text: string }> }>} groups
 * @param {string} query
 */
export function filterOptionGroups(groups, query) {
  const q = foldText(query);
  if (!q) return groups;
  const out = [];
  for (const g of groups) {
    if (foldText(g.label).includes(q)) { out.push(g); continue; }
    const options = g.options.filter(o => foldText(o.text).includes(q));
    if (options.length) out.push({ label: g.label, options });
  }
  return out;
}
