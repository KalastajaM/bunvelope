// Presentation preferences only: never gate commands, setup, or scheduled work.
export const FEATURES = [
  { id: 'detailed-insights', label: 'nav.detailedInsights', simple: true },
  { id: 'templates', label: 'nav.templates' },
  { id: 'net-worth', label: 'nav.netWorth' },
  { id: 'recurring-costs', label: 'recurring.nav', simple: true },
  { id: 'review', label: 'nav.review' },
  { id: 'stress', label: 'nav.stress' },
  { id: 'investments', label: 'nav.investments' },
  { id: 'reports', label: 'nav.reports' },
  { id: 'flow', label: 'nav.flow', requires: ['reports'] },
  { id: 'insights', label: 'nav.insights' },
  { id: 'balance-views', label: 'lens.label' },
];

export function normalizeFeatures(selection) {
  const enabled = new Set();
  function add(id) {
    const feature = FEATURES.find(f => f.id === id);
    if (!feature || enabled.has(id)) return;
    enabled.add(id);
    for (const dependency of feature.requires || []) add(dependency);
  }
  for (const id of Array.isArray(selection) ? selection : []) add(id);
  return FEATURES.filter(f => enabled.has(f.id)).map(f => f.id);
}

export function enabledFeatures(prefs) {
  if (prefs.uiMode === 'simple') return FEATURES.filter(f => f.simple).map(f => f.id);
  if (prefs.uiMode === 'advanced') return normalizeFeatures(prefs.uiFeatures);
  return FEATURES.map(f => f.id);
}

export function featureEnabled(prefs, id) {
  return !FEATURES.some(f => f.id === id) || enabledFeatures(prefs).includes(id);
}

export function requiredBy(selection, id) {
  return FEATURES.filter(f => f.id !== id && selection.includes(f.id)
    && normalizeFeatures([f.id]).includes(id));
}
