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
