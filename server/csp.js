// server/csp.js — Content-Security-Policy directives for the cloud server.
// Extracted from index.js so the policy is unit-testable without booting
// the app (index.js connects to Postgres and starts listening on import).
// tests/server-csp.test.js pins the entries that have bitten us in
// production-like deploys: fonts and the browser-side quote fetches.

export function cspDirectives() {
  return {
    defaultSrc: ["'self'"],
    // 'self' covers the static module graph; the nonce covers the
    // server-injected <script id="bv-mode"> block in /.
    scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
    // Pages set inline style="..." attributes in many places. Until
    // those are migrated to classes, keep style-src permissive but
    // explicit.
    // Fonts are self-hosted (css/fonts.css, fonts/), so no third-party
    // style or font host is allowed.
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'"],
    // AI is relayed server-side. The investments quote refresh (ticker and
    // ISIN lookups, both via Yahoo Finance) and priceUrl overrides (Danske
    // Invest / FT.com) all go through the same-origin /api/price-fetch
    // proxy, so no third-party connect-src entries are needed here.
    // (Stooq and a direct-from-browser Yahoo fetch used to need one each,
    // but both providers stopped serving CORS headers to arbitrary
    // origins — see js/state/investments.js.)
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
  };
}
