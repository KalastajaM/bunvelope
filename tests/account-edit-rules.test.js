// The account editor's crisis-cash storing rule.
import { describe, it, expect } from 'vitest';
import { crisisCashToStore } from '../js/pages/account-edit-rules.js';

describe('crisisCashToStore', () => {
  it('is null for an asset account, whatever the checkbox says', () => {
    expect(crisisCashToStore({ isAsset: true, spending: false, crisisChecked: true, type: 'savings' })).toBeNull();
    expect(crisisCashToStore({ isAsset: true, spending: false, crisisChecked: false, type: 'bank' })).toBeNull();
  });

  it('is null for a spending account, whatever the checkbox says', () => {
    expect(crisisCashToStore({ isAsset: false, spending: true, crisisChecked: true, type: 'bank' })).toBeNull();
    expect(crisisCashToStore({ isAsset: false, spending: true, crisisChecked: false, type: 'savings' })).toBeNull();
  });

  it('is null when the checkbox matches the type default (savings=true, else false)', () => {
    expect(crisisCashToStore({ isAsset: false, spending: false, crisisChecked: true, type: 'savings' })).toBeNull();
    expect(crisisCashToStore({ isAsset: false, spending: false, crisisChecked: false, type: 'bank' })).toBeNull();
  });

  it('stores the explicit boolean when it differs from the type default', () => {
    expect(crisisCashToStore({ isAsset: false, spending: false, crisisChecked: false, type: 'savings' })).toBe(false);
    expect(crisisCashToStore({ isAsset: false, spending: false, crisisChecked: true, type: 'bank' })).toBe(true);
  });
});
