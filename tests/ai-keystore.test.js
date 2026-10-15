// tests/ai-keystore.test.js — static-mode API key storage.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getLocalKey, setLocalKey, clearLocalKey, hasLocalKey, maskKey,
} from '../js/ai/keystore.js';

function installStorage(impl) {
  globalThis.localStorage = impl;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

describe('keystore', () => {
  beforeEach(() => { installStorage(memoryStorage()); });
  afterEach(() => { delete globalThis.localStorage; });

  it('round-trips a key', () => {
    expect(getLocalKey()).toBe(null);
    expect(hasLocalKey()).toBe(false);

    setLocalKey('sk-ant-abc123');
    expect(getLocalKey()).toBe('sk-ant-abc123');
    expect(hasLocalKey()).toBe(true);

    clearLocalKey();
    expect(getLocalKey()).toBe(null);
    expect(hasLocalKey()).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    setLocalKey('  sk-ant-abc123\n');
    expect(getLocalKey()).toBe('sk-ant-abc123');
  });

  it('treats an all-whitespace key as unset', () => {
    setLocalKey('   ');
    expect(getLocalKey()).toBe(null);
    expect(hasLocalKey()).toBe(false);
  });

  it('survives a localStorage that throws', () => {
    // Safari private mode: property access itself throws.
    installStorage({
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
      removeItem() { throw new Error('denied'); },
    });
    expect(() => setLocalKey('sk-ant-x')).not.toThrow();
    expect(getLocalKey()).toBe(null);
    expect(hasLocalKey()).toBe(false);
    expect(() => clearLocalKey()).not.toThrow();
  });

  it('survives no localStorage at all', () => {
    delete globalThis.localStorage;
    expect(getLocalKey()).toBe(null);
    expect(() => setLocalKey('sk-ant-x')).not.toThrow();
  });

  it('masks a key for display without revealing it', () => {
    expect(maskKey('sk-ant-api03-longsecretvalue-9999')).toBe('sk-ant-…9999');
    expect(maskKey('short')).toBe('•••••');
    expect(maskKey('')).toBe('');
    expect(maskKey(null)).toBe('');
  });
});
