import { describe, expect, it } from 'vitest';
import { FEATURES, enabledFeatures, featureEnabled, normalizeFeatures, requiredBy } from '../js/ui/features.js';

describe('optional views', () => {
  it('preserves existing presets and keeps core setup available with every option off', () => {
    expect(enabledFeatures({})).toHaveLength(FEATURES.length);
    expect(enabledFeatures({ uiMode: 'simple' })).toEqual(['detailed-insights', 'recurring-costs']);
    const prefs = { uiMode: 'advanced', uiFeatures: [] };
    expect(enabledFeatures(prefs)).toEqual([]);
    for (const page of ['dashboard', 'accounts', 'envelopes', 'transactions', 'budget-plan', 'settings']) {
      expect(featureEnabled(prefs, page)).toBe(true);
    }
  });

  it('enables dependencies for saved or newly chosen features, without duplicates or unknown IDs', () => {
    expect(normalizeFeatures(['flow', 'flow', 'unknown'])).toEqual(['reports', 'flow']);
    expect(enabledFeatures({ uiMode: 'advanced', uiFeatures: ['flow'] })).toEqual(['reports', 'flow']);
    expect(requiredBy(['reports', 'flow'], 'reports').map(f => f.id)).toEqual(['flow']);
    expect(requiredBy(['reports'], 'reports')).toEqual([]);
    expect(normalizeFeatures(null)).toEqual([]);
  });

  it('does not require optional setup to use another independent view', () => {
    for (const feature of FEATURES.filter(f => !f.requires)) {
      expect(normalizeFeatures([feature.id])).toEqual([feature.id]);
    }
  });
});
