import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swSource = readFileSync(path.join(__dirname, '../public/sw.js'), 'utf-8');

describe('service worker caching policy', () => {
  it('never lists an /api/ path in the precached app shell', () => {
    const appShellMatch = swSource.match(/APP_SHELL\s*=\s*\[([\s\S]*?)\]/);
    expect(appShellMatch).toBeTruthy();
    expect(appShellMatch![1]).not.toMatch(/\/api\//);
  });

  it('explicitly bails out of the fetch handler for /api/ requests before any cache logic runs', () => {
    const fetchHandlerMatch = swSource.match(/addEventListener\(['"]fetch['"][\s\S]*?\n\}\);/);
    expect(fetchHandlerMatch).toBeTruthy();
    const handlerBody = fetchHandlerMatch![0];

    // The isApiRequest() early-return must appear before any caches.match/caches.open call.
    const guardIndex = handlerBody.indexOf('isApiRequest(url)');
    const firstCacheCallIndex = handlerBody.search(/caches\.(match|open)/);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(firstCacheCallIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstCacheCallIndex);
  });

  it('defines isApiRequest to match any /api/ prefixed path', () => {
    expect(swSource).toMatch(/pathname\.startsWith\(['"]\/api\/['"]\)/);
  });
});

describe('service worker update lifecycle', () => {
  it('does not call self.skipWaiting() unconditionally on install (new workers must wait for consent)', () => {
    const installHandlerMatch = swSource.match(/addEventListener\(['"]install['"][\s\S]*?\n\}\);/);
    expect(installHandlerMatch).toBeTruthy();
    expect(installHandlerMatch![0]).not.toMatch(/skipWaiting/);
  });

  it('only calls self.skipWaiting() in response to a SKIP_WAITING message from the page', () => {
    const messageHandlerMatch = swSource.match(/addEventListener\(['"]message['"][\s\S]*?\n\}\);/);
    expect(messageHandlerMatch).toBeTruthy();
    const handlerBody = messageHandlerMatch![0];
    expect(handlerBody).toMatch(/SKIP_WAITING/);
    expect(handlerBody).toMatch(/skipWaiting\(\)/);
  });

  it('ties the cache name to a build version so every deploy gets a fresh cache', () => {
    expect(swSource).toMatch(/const CACHE_PREFIX = ['"]mc-qb-shell-['"];/);
    expect(swSource).toMatch(/const CACHE_NAME = CACHE_PREFIX \+ BUILD_VERSION;/);
  });

  it('deletes obsolete shell caches (any prior BUILD_VERSION) on activate, then claims clients', () => {
    const activateHandlerMatch = swSource.match(/addEventListener\(['"]activate['"][\s\S]*?\n\}\);/);
    expect(activateHandlerMatch).toBeTruthy();
    const handlerBody = activateHandlerMatch![0];
    expect(handlerBody).toMatch(/caches\.delete/);
    expect(handlerBody).toMatch(/key !== CACHE_NAME/);
    expect(handlerBody).toMatch(/clients\.claim\(\)/);
  });

  it('caches static shell assets network-first (fetches before falling back to cache)', () => {
    const fetchHandlerMatch = swSource.match(/addEventListener\(['"]fetch['"][\s\S]*?\n\}\);/);
    const handlerBody = fetchHandlerMatch![0];
    // The tail of the handler (the static-asset branch) should try fetch()
    // first and only fall back to caches.match() in .catch().
    const staticBranch = handlerBody.slice(handlerBody.lastIndexOf('event.respondWith('));
    expect(staticBranch).toMatch(/fetch\(event\.request\)[\s\S]*\.catch\(\(\) => caches\.match\(event\.request\)\)/);
  });
});
