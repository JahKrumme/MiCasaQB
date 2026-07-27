// Service worker for the Mi Casa QuickBooks Companion PWA.
//
// Caching policy (deliberately conservative):
//   - Only the static app shell (HTML/CSS/JS/icons/manifest) is ever cached.
//   - Anything under /api/ — QuickBooks data, auth, OAuth callbacks, chat,
//     admin — is NEVER cached and NEVER intercepted. Those requests are left
//     completely untouched so the browser handles them natively.
//
// Update lifecycle (see public/update.js for the page-side half):
//   - BUILD_VERSION is stamped into this exact file by
//     scripts/stamp-build-version.mjs during the CI deploy, so the file's
//     bytes — and therefore its cache name — change on every deploy. That's
//     what makes the browser detect a new worker via `updatefound` at all;
//     if this file were byte-identical across deploys the browser would
//     never see it as "new".
//   - This worker does NOT call self.skipWaiting() on install. A newly
//     installed worker sits in "waiting" until the page explicitly asks it
//     to take over (SKIP_WAITING message), which only happens after the user
//     clicks "Update App" in the UI. That's what keeps an update from ever
//     force-refreshing someone mid-task.
const BUILD_VERSION = 'dev';
const CACHE_PREFIX = 'mc-qb-shell-';
const CACHE_NAME = CACHE_PREFIX + BUILD_VERSION;

const APP_SHELL = [
  '/index.html',
  '/login.html',
  '/admin.html',
  '/invite.html',
  '/change-password.html',
  '/terms.html',
  '/privacy.html',
  '/offline.html',
  '/styles.css',
  '/app.js',
  '/update.js',
  '/login.js',
  '/admin.js',
  '/invite.js',
  '/change-password.js',
  '/year.js',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/assets/brand/mi-casa-logo-full-black.png',
  '/assets/brand/mi-casa-logo-full-white.png',
  '/assets/brand/mi-casa-icon-black.png',
  '/assets/brand/mi-casa-icon-white.png',
  '/assets/brand/access-mental-health-logo.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never touch API calls — no caching, no offline fallback, no interception.
  if (isApiRequest(url) || url.origin !== self.location.origin) return;

  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match('/offline.html')).then(res => res || Response.error()))
    );
    return;
  }

  // Static shell assets: network-first, falling back to the cache only when
  // the network is unavailable. This is what actually fixes stale HTML/CSS/
  // JS/icons after a deploy — the old cache-first-with-background-refresh
  // strategy could keep serving yesterday's bytes indefinitely on a page
  // that never got a fresh network round-trip.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
