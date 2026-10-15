// js/theme-boot.js — sets <html data-theme> before first paint.
//
// A CLASSIC script, loaded blocking from <head> (no type="module", no defer):
// modules are deferred, so anything they set lands after the first paint and
// a dark-mode user would see a white flash on every load. It is an external
// file rather than an inline <script> because the cloud server's CSP
// (server/csp.js) only allows 'self' plus the one nonce'd mode marker.
//
// The theme preference is per browser (localStorage `bv-theme`:
// light | dark | system, default system), deliberately NOT in savePrefs,
// which syncs to the account: a phone and a desktop can want different themes.
//
// The resolution rule is duplicated from js/ui/theme.js (a classic script
// cannot import a module); tests/theme.test.js runs this file against
// resolveTheme() for every input so the two cannot drift apart.
(function () {
  var KEY = 'bv-theme';
  var root = document.documentElement;
  var mq = null;
  try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch { mq = null; }

  function readPref() {
    var v = null;
    try { v = window.localStorage.getItem(KEY); } catch { v = null; }
    return v === 'light' || v === 'dark' ? v : 'system';
  }

  function apply() {
    var pref = readPref();
    var theme = pref === 'system' ? (mq && mq.matches ? 'dark' : 'light') : pref;
    root.dataset.theme = theme;
  }

  apply();

  // Keep following the OS while the preference is System. apply() re-reads
  // the preference, so after an explicit Light/Dark choice an OS flip is a
  // no-op without having to unsubscribe.
  if (mq) {
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
    else if (typeof mq.addListener === 'function') mq.addListener(apply);
  }

  // A choice made in another open tab: `storage` fires in every OTHER
  // same-origin tab when localStorage changes. Only our key matters.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', function (e) {
      if (e && e.key === KEY) apply();
    });
  }
})();
