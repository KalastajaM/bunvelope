// server/proxy.js — Express `trust proxy` from the TRUST_PROXY env var.
//
// The server used to trust one proxy hop unconditionally, which was right
// behind a hosting edge that terminates TLS. Run directly (locally, or in a
// container with no proxy in front), trusting X-Forwarded-For lets any client
// choose its own req.ip, and so its own rate-limit key on the login and API
// limiters. Now nothing is trusted unless the operator says a proxy exists.

/**
 * @param {string|undefined} value  TRUST_PROXY: unset/''/'0'/'false' → false;
 *   a positive integer → that many hops; anything else (e.g. 'loopback',
 *   '10.0.0.0/8') is passed to Express as-is.
 * @returns {boolean|number|string}
 */
export function trustProxySetting(value) {
  const v = String(value ?? '').trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
