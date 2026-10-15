import { describe, it, expect } from 'vitest';
import { trustProxySetting } from '../server/proxy.js';

describe('trustProxySetting', () => {
  it('trusts no proxy unless one is configured', () => {
    for (const v of [undefined, '', ' ', '0', 'false', 'FALSE']) {
      expect(trustProxySetting(v), String(v)).toBe(false);
    }
  });

  it('reads a hop count', () => {
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting(' 2 ')).toBe(2);
  });

  it('passes named and CIDR settings through to Express', () => {
    expect(trustProxySetting('loopback')).toBe('loopback');
    expect(trustProxySetting('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
