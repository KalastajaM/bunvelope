// tests/server-csp.test.js — pins the Content-Security-Policy entries that
// break features only on cloud deploys (static/FSAPI mode serves no CSP, so
// these regressions never show up locally). No DB needed: server/csp.js is
// a pure module, unlike server/index.js which boots on import.

import { describe, it, expect } from 'vitest';
import { cspDirectives } from '../server/csp.js';

describe('cspDirectives', () => {
  const d = cspDirectives();

  it('keeps the baseline locked to self', () => {
    expect(d.defaultSrc).toEqual(["'self'"]);
    expect(d.objectSrc).toEqual(["'none'"]);
    expect(d.frameAncestors).toEqual(["'none'"]);
    expect(d.baseUri).toEqual(["'self'"]);
    expect(d.formAction).toEqual(["'self'"]);
  });

  it('keeps connect-src same-origin only (quote fetches are server-side now)', () => {
    // js/state/investments.js used to fetch Stooq and Yahoo directly from
    // the page; both stopped serving CORS headers to arbitrary origins, so
    // quote fetches now go through the same-origin /api/price-fetch/quote
    // proxy and no third-party connect-src entry is needed.
    expect(d.connectSrc).toEqual(["'self'"]);
  });

  it('serves fonts from self only (they are self-hosted)', () => {
    expect(d.fontSrc).toEqual(["'self'"]);
    expect(d.styleSrc.filter((v) => /^https?:/.test(v))).toEqual([]);
  });

  it('emits the per-request nonce for the inline mode-marker script', () => {
    const nonceFn = d.scriptSrc.find((v) => typeof v === 'function');
    expect(nonceFn).toBeTypeOf('function');
    expect(nonceFn(null, { locals: { cspNonce: 'abc123' } })).toBe("'nonce-abc123'");
  });
});
