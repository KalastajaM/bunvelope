// Shared wire-format validation for encrypted collections and key verifiers.
// Do not repeat a multi-character group over the payload: V8's regexp stack
// overflows on valid multi-megabyte budgets. A character-class scan is bounded
// by input length and needs no decoded copy of the ciphertext.
function base64ByteLength(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

/** Validate the AES-GCM envelope shape, not its authenticity (decryption does that). */
export function validCipher(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.__enc === 1 && base64ByteLength(value.iv) === 12
    && base64ByteLength(value.ct) >= 16;
}
