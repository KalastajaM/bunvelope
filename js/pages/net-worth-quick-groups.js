// js/pages/net-worth-quick-groups.js — quick-filter button labels for the
// Net worth exclude picker's asset groups. Pure; no DOM, so it is testable
// without the page.

/**
 * Labels for the asset-group quick-filter buttons, disambiguated where one
 * collides with another quick button's label. An asset group can carry the
 * same name as an account "part" (e.g. an asset group named "Savings"
 * beside the "Savings" accounts part) — when that happens, the two buttons
 * read identically, so suffix the asset group's one with the asset-kind
 * label. Groups whose name is unique among `otherLabels` keep it as-is.
 * @param {{ label: string, ids: string[] }[]} assetGroups
 * @param {string[]} otherLabels - labels of the other quick buttons (e.g. account parts)
 * @param {string} assetKindLabel - t('netWorth.type.asset')
 * @returns {{ label: string, ids: string[] }[]}
 */
export function assetGroupQuickLabels(assetGroups, otherLabels, assetKindLabel) {
  const other = new Set(otherLabels);
  return assetGroups.map(g => (
    other.has(g.label) ? { ...g, label: `${g.label} · ${assetKindLabel}` } : g
  ));
}
