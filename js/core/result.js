// js/core/result.js — the Result shape every command, query and session returns.
// Domain failures are values, never thrown: an adapter (UI, CLI, AI) decides how
// to show one. Exceptions are for programmer errors only.

/** @typedef {{ code: string, params: Record<string, any> }} DomainError */
/** @typedef {{ ok: true, value: any } | { ok: false, error: DomainError }} Result */

/**
 * @param {any} value
 * @returns {{ ok: true, value: any }}
 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * @param {string} code
 * @param {Record<string, any>} [params]
 * @returns {{ ok: false, error: DomainError }}
 */
export function fail(code, params = {}) {
  return { ok: false, error: { code, params } };
}
