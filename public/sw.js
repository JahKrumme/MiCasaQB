// Service worker for the Mi Casa QuickBooks Companion PWA.
//
// Caching policy (deliberately conservative):
//   - Only the static app shell (HTML/CSS/JS/icons/manifest) is ever cached.
//   - Anything under /api/ — QuickBooks data, auth, OAuth callbacks, chat,
//     admin — is NEVER cached and NEVER intercepted. Those requests are left
//     completely untouched so the browser handles them natively.
const CACHE_NAME = 'mc-qb-shell-v2';

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
  '/assets/brand/mi-casa-icon-white.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
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

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/offline.html').then(res => res || Response.error()))
    );
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
