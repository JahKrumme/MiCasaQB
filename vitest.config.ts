import { defineConfig } from 'vitest/config';

// Plain Node test environment (no Miniflare/vitest-pool-workers). Everything
// under src/ only touches Web Crypto, fetch, and the D1Database query
// interface — all standard APIs available in Node — so tests run against a
// real SQLite-backed D1 fake (test/helpers/fakeD1.ts) instead of simulating
// the full Workers runtime. wrangler dev / deploy still run on the real
// Workers runtime; this only affects the test harness.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
