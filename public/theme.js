// Appearance (light/dark/system) — applied before first paint to avoid a
// flash of the wrong theme.
//
// Storage model:
//   - localStorage ("mc-theme") is the fast, synchronous cache this script
//     reads immediately, before the DOM or CSS have even loaded.
//   - D1 (users.theme_preference) is the durable, cross-device source of
//     truth once the user is signed in — /api/auth/session returns it, and
//     the Appearance section in Admin writes it via PUT /api/auth/theme.
//   - After session data loads, reconcileWithServer() below mirrors the D1
//     value back into localStorage so the *next* page load already has it,
//     and re-applies the theme immediately if it differs from the cached
//     guess (e.g. the user changed it on another device).
//
// This file is a plain classic script (no type="module"), loaded first in
// <head>, before any stylesheet — that's what makes it block long enough to
// set data-theme ahead of the first paint.
(function () {
  var STORAGE_KEY = 'mc-theme';
  var root = document.documentElement;

  function systemPrefersDark() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function resolve(preference) {
    return preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;
  }

  function readStoredPreference() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
    } catch {
      /* localStorage unavailable (private mode, etc.) — fall through to default */
    }
    return 'system';
  }

  function apply(preference) {
    var resolved = resolve(preference);
    root.setAttribute('data-theme', resolved);
    root.dataset.themePreference = preference;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#141416' : '#ffffff');
    return resolved;
  }

  function setPreference(preference) {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* best-effort only */
    }
    apply(preference);
    window.dispatchEvent(new CustomEvent('mc-theme-change', { detail: { preference: preference, resolved: resolve(preference) } }));
  }

  // Applied synchronously, immediately, before anything else on the page.
  apply(readStoredPreference());

  // Keep 'system' mode live if the OS preference changes while the tab is open.
  if (typeof window.matchMedia === 'function') {
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemChange = function () {
      if (readStoredPreference() === 'system') apply('system');
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  // Pulls the signed-in user's D1 preference (from /api/auth/session, already
  // fetched by app.js/admin.js/etc.) into local storage + re-applies it. Safe
  // to call multiple times; a no-op if the value already matches.
  function reconcileWithServer(themePreference) {
    if (themePreference !== 'light' && themePreference !== 'dark' && themePreference !== 'system') return;
    if (readStoredPreference() === themePreference) return;
    setPreference(themePreference);
  }

  window.MCTheme = {
    get: readStoredPreference,
    set: setPreference,
    resolve: resolve,
    reconcileWithServer: reconcileWithServer
  };
})();
