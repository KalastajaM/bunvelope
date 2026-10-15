// js/storage/crypto.js — WebCrypto wrappers for admin-blind blob encryption.
//
// Key derivation: PBKDF2-SHA-256, 600k iterations, 16-byte random salt (stored
// per user on the server). Output: 256-bit AES-GCM key, held in memory only.
//
// Wire format (stored in budget_blobs.data):
//   { __enc: 1, iv: "<base64 12-byte nonce>", ct: "<base64 ciphertext+tag>" }
// Plaintext blobs (legacy) are raw JSON without the __enc marker.

const PBKDF2_ITERATIONS = 600_000;
const VERIFIER_PLAINTEXT = 'bunvelope-ok';

const te = new TextEncoder();
const td = new TextDecoder();

function subtle() {
  const c = (typeof globalThis !== 'undefined' ? globalThis.crypto : null)
    ?? (typeof window !== 'undefined' ? window.crypto : null);
  if (!c?.subtle) throw new Error('WebCrypto is not available in this environment');
  return c;
}

function b64encode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  subtle().getRandomValues(out);
  return out;
}

export function bytesToBase64(bytes) { return b64encode(bytes); }
export function base64ToBytes(str) { return b64decode(str); }

/**
 * Derive a 256-bit AES-GCM key from a passphrase and salt. Deterministic for
 * a given (passphrase, salt) pair.
 */
export async function deriveKey(passphrase, salt, extractable = false) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('passphrase required');
  }
  const saltBytes = salt instanceof Uint8Array ? salt : base64ToBytes(salt);
  const baseKey = await subtle().subtle.importKey(
    'raw',
    te.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return subtle().subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/** @returns {{__enc:1, iv:string, ct:string}} */
export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const plaintext = te.encode(JSON.stringify(value));
  const ct = await subtle().subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { __enc: 1, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

/** Throws if wrapper is malformed, wrong key, or ciphertext tampered. */
export async function decryptJson(key, wrapper) {
  if (!isEncrypted(wrapper)) throw new Error('not an encrypted wrapper');
  const iv = b64decode(wrapper.iv);
  const ct = b64decode(wrapper.ct);
  const plain = await subtle().subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(td.decode(plain));
}

export function isEncrypted(x) {
  return !!x && typeof x === 'object' && x.__enc === 1
    && typeof x.iv === 'string' && typeof x.ct === 'string';
}

export async function buildVerifier(key) {
  return encryptJson(key, VERIFIER_PLAINTEXT);
}

/** @returns {Promise<boolean>} true if the verifier decrypts to the sentinel. */
export async function checkVerifier(key, verifier) {
  try {
    const v = await decryptJson(key, verifier);
    return v === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}
