import { describe, it, expect } from 'vitest';
import { validCipher } from '../server/encrypted-payload.js';
import { assertBlob } from '../server/services/budget-store.js';

const cipher = (bytes = 16) => ({
  __enc: 1, iv: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(bytes).toString('base64'),
});

describe('encrypted wire format', () => {
  it('accepts large encrypted saves without overflowing the regexp stack', () => {
    const value = cipher(16 * 1024 * 1024);
    expect(validCipher(value)).toBe(true);
    expect(() => assertBlob('meta', value)).not.toThrow();
    expect(validCipher({ ...value, ct: value.ct + '!' })).toBe(false);
  });

  it('accepts each padding length and rejects truncated authentication tags', () => {
    for (const size of [16, 17, 18]) expect(validCipher(cipher(size))).toBe(true);
    expect(validCipher(cipher(15))).toBe(false);
  });

  it('refuses malformed envelopes and non-base64 input', () => {
    for (const value of [null, [], {}, { ...cipher(), __enc: 2 },
      { ...cipher(), iv: Buffer.alloc(11).toString('base64') }]) {
      expect(validCipher(value)).toBe(false);
    }
    for (const ct of ['', 'AAAA=', 'AAAA===', '====', 'AA=A', '____',
      cipher().ct + '\n', ' ' + cipher().ct, cipher().ct.replace('A', '!')]) {
      expect(validCipher({ ...cipher(), ct })).toBe(false);
    }
  });
});
